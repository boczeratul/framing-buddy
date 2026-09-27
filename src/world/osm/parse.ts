import type { LatLon } from '../../geo';
import type { OverpassElement } from './overpass';

// Overpass JSON → 幾何特徵。multipolygon relation 會把成員 way 串成封閉環，內環歸到包含它的外環。

export type FeatureKind = 'building' | 'part' | 'tower' | 'tree' | 'water' | 'green' | 'wood';

export interface Feature {
  id: string;
  kind: FeatureKind;
  tags: Record<string, string>;
  /** [外環, ...內環]，不含重複的收尾點 */
  rings: LatLon[][];
  point?: LatLon;
}

const same = (a: LatLon, b: LatLon) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;

function toRing(geom: { lat: number; lon: number }[]): LatLon[] | null {
  if (geom.length < 4 || !same(geom[0], geom[geom.length - 1])) return null;
  return geom.slice(0, -1).map((p) => ({ lat: p.lat, lon: p.lon }));
}

function assemble(ways: LatLon[][]): LatLon[][] {
  const pool = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings: LatLon[][] = [];
  while (pool.length) {
    let ring = pool.shift()!;
    for (let guard = 0; guard < 2000 && !same(ring[0], ring[ring.length - 1]); guard++) {
      const end = ring[ring.length - 1];
      const i = pool.findIndex((w) => same(w[0], end) || same(w[w.length - 1], end));
      if (i < 0) break;
      const w = pool.splice(i, 1)[0];
      ring = same(w[0], end) ? ring.concat(w.slice(1)) : ring.concat(w.slice(0, -1).reverse());
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) rings.push(ring.slice(0, -1));
  }
  return rings;
}

export function pointInRing(p: LatLon, ring: LatLon[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) hit = !hit;
  }
  return hit;
}

export function centroid(ring: LatLon[]): LatLon {
  let lat = 0;
  let lon = 0;
  for (const p of ring) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

function classify(tags: Record<string, string>): FeatureKind | null {
  if (tags['building:part']) return 'part';
  if (tags.building) return 'building';
  if (tags.man_made && /^(tower|mast|chimney)$/.test(tags.man_made)) return 'tower';
  if (tags.natural === 'tree') return 'tree';
  if (tags.natural === 'water') return 'water';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'wood';
  if (tags.landuse || tags.leisure) return 'green';
  return null;
}

export function parseElements(elements: OverpassElement[]): Feature[] {
  const out: Feature[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const kind = classify(tags);
    if (!kind) continue;
    const id = `${el.type}/${el.id}`;
    if (el.type === 'node') {
      if (el.lat != null && el.lon != null) out.push({ id, kind, tags, rings: [], point: { lat: el.lat, lon: el.lon } });
    } else if (el.type === 'way' && el.geometry) {
      const ring = toRing(el.geometry);
      if (ring) out.push({ id, kind, tags, rings: [ring] });
    } else if (el.type === 'relation' && el.members) {
      const outerWays: LatLon[][] = [];
      const innerWays: LatLon[][] = [];
      for (const m of el.members) {
        if (m.type !== 'way' || !m.geometry) continue;
        (m.role === 'inner' ? innerWays : outerWays).push(m.geometry.map((p) => ({ lat: p.lat, lon: p.lon })));
      }
      const outers = assemble(outerWays);
      const inners = assemble(innerWays);
      outers.forEach((outer, k) => {
        const holes = inners.filter((r) => pointInRing(r[0], outer));
        out.push({ id: `${id}#${k}`, kind, tags, rings: [outer, ...holes] });
      });
    }
  }
  return out;
}

// ---- 高度與屋頂 ----

export function parseLength(v?: string): number | undefined {
  if (!v) return undefined;
  const m = v.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*(m|meters?|ft|feet|')?/i);
  if (!m) return undefined;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  return m[2] && /^(ft|feet|')$/i.test(m[2]) ? n * 0.3048 : n;
}

const DEFAULT_LEVELS: Record<string, number> = {
  house: 2, detached: 2, residential: 4, apartments: 6, terrace: 3, commercial: 4, retail: 2, office: 8,
  industrial: 2, warehouse: 2, garage: 1, garages: 1, shed: 1, hut: 1, roof: 1, kiosk: 1, carport: 1,
  school: 4, university: 5, hospital: 6, hotel: 10, church: 3, temple: 2, train_station: 2,
};

export interface BuildingShape {
  /** 牆底、屋簷、屋頂最高點（離地公尺） */
  base: number;
  eave: number;
  top: number;
  levels: number;
  roofShape: string;
}

export function buildingShape(tags: Record<string, string>): BuildingShape {
  const levels = Number(tags['building:levels']) || undefined;
  const roofLevels = Number(tags['roof:levels']) || 0;
  const roofShape = (tags['roof:shape'] ?? 'flat').toLowerCase();
  const height = parseLength(tags.height) ?? parseLength(tags['building:height']);
  const minHeight = parseLength(tags.min_height) ?? (Number(tags['building:min_level']) || 0) * 3.2;
  const lv = levels ?? DEFAULT_LEVELS[tags.building ?? ''] ?? 3;
  let roofH = parseLength(tags['roof:height']) ?? (roofLevels ? roofLevels * 3 : undefined);
  const top = height ?? lv * 3.2 + (roofH ?? 0) + minHeight;
  if (roofH === undefined) roofH = roofShape === 'flat' ? 0 : Math.min(8, Math.max(2, (top - minHeight) * 0.2));
  roofH = Math.min(roofH, Math.max(0, top - minHeight - 0.5));
  return { base: minHeight, eave: top - roofH, top, levels: levels ?? Math.max(1, Math.round((top - minHeight - roofH) / 3.2)), roofShape };
}

const NAMED: Record<string, string> = {
  white: '#f2f0ea', black: '#2d2d2d', grey: '#9a9a9a', gray: '#9a9a9a', red: '#a8423a', brown: '#7b5a44',
  yellow: '#d9c27a', beige: '#d8cbb0', blue: '#51708f', green: '#5f7f5a', orange: '#c9824a', silver: '#b8bec4',
  tan: '#c8b18b', cream: '#eee4c8', maroon: '#6e2f2f', lightgrey: '#c4c4c4', darkgrey: '#5e5e5e',
};

/** OSM 顏色標籤（色名或 #hex）→ 十六進位字串；無法解析時回傳 null */
export function osmColour(v?: string): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return NAMED[s] ?? null;
}
