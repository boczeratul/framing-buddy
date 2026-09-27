import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { LatLon } from '../../geo';
import { pointInRing, type Feature } from './parse';
import { tileBounds, type Bounds, type TileId } from './tiles';

// 遠景資料：OpenFreeMap 提供的 OpenMapTiles 向量圖磚（全球 OSM 建物，含 render_height），
// 走 CDN、不需金鑰，比 Overpass 快且穩定。只保留高於門檻的建物，並把跨圖磚的多邊形裁到圖磚範圍內。

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const MIN_HEIGHT = 25;
/** 高於此高度的建物會嘗試用 POI 名稱命名（當作可對準的目標） */
const NAMED_HEIGHT = 120;

interface Poi {
  at: LatLon;
  name: string;
  score: number;
}

/** POI 是否像是「整棟建物」的名稱（而不是裡面的店家） */
function poiScore(name: string, cls: string, sub: string): number {
  let s = 0;
  if (cls === 'attraction' || /tower|viewpoint|monument/.test(sub)) s += 3;
  if (/大樓|大廈|大厦|摩天|中心|廣場|塔|タワー|ビル|Tower|Building|Center|Centre|Plaza/i.test(name)) s += 2;
  if (cls === 'office' || cls === 'town_hall' || cls === 'lodging') s += 1;
  return s;
}

let template: Promise<string> | null = null;

function tileTemplate(): Promise<string> {
  template ??= fetch(TILEJSON)
    .then((r) => r.json())
    .then((j: { tiles: string[] }) => j.tiles[0])
    .catch((e) => {
      template = null;
      throw e;
    });
  return template;
}

/** Sutherland–Hodgman：把環裁到經緯度矩形內 */
function clipRing(ring: LatLon[], b: Bounds): LatLon[] {
  const edges: [(p: LatLon) => boolean, (a: LatLon, c: LatLon) => LatLon][] = [
    [(p) => p.lon >= b.w, (a, c) => ({ lat: a.lat + ((c.lat - a.lat) * (b.w - a.lon)) / (c.lon - a.lon), lon: b.w })],
    [(p) => p.lon <= b.e, (a, c) => ({ lat: a.lat + ((c.lat - a.lat) * (b.e - a.lon)) / (c.lon - a.lon), lon: b.e })],
    [(p) => p.lat >= b.s, (a, c) => ({ lat: b.s, lon: a.lon + ((c.lon - a.lon) * (b.s - a.lat)) / (c.lat - a.lat) })],
    [(p) => p.lat <= b.n, (a, c) => ({ lat: b.n, lon: a.lon + ((c.lon - a.lon) * (b.n - a.lat)) / (c.lat - a.lat) })],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cut(prev, cur));
    }
    if (out.length < 3) return [];
  }
  return out;
}

export async function fetchFarBuildings(t: TileId, signal?: AbortSignal): Promise<Feature[]> {
  const url = (await tileTemplate()).replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const vt = new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer())));
  const layer = vt.layers.building;
  const out: Feature[] = [];
  if (!layer) return out;
  const b = tileBounds(t);

  const pois: Poi[] = [];
  const poiLayer = vt.layers.poi;
  for (let i = 0; poiLayer && i < poiLayer.length; i++) {
    const f = poiLayer.feature(i);
    const p = f.properties as Record<string, unknown>;
    const name = String(p['name:zh'] ?? p.name ?? '');
    if (!name || f.type !== 1) continue;
    const score = poiScore(name, String(p.class ?? ''), String(p.subclass ?? ''));
    if (score < 2) continue;
    const g = f.toGeoJSON(t.x, t.y, t.z).geometry;
    if (g.type === 'Point') pois.push({ at: { lon: g.coordinates[0], lat: g.coordinates[1] }, name, score });
  }
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const p = f.properties as Record<string, unknown>;
    const h = Number(p.render_height ?? 0);
    if (h < MIN_HEIGHT || p.hide_3d === true) continue;
    const gj = f.toGeoJSON(t.x, t.y, t.z).geometry;
    const polys = gj.type === 'Polygon' ? [gj.coordinates] : gj.type === 'MultiPolygon' ? gj.coordinates : [];
    polys.forEach((poly, k) => {
      const rings = poly
        .map((ring) => clipRing(ring.slice(0, -1).map(([lon, lat]) => ({ lat, lon })), b))
        .filter((r) => r.length >= 3);
      if (!rings.length) return;
      const tags: Record<string, string> = { building: 'yes', height: String(h), min_height: String(Number(p.render_min_height ?? 0)) };
      if (typeof p.colour === 'string') tags['building:colour'] = p.colour;
      if (h >= NAMED_HEIGHT && pois.length) {
        let best: Poi | null = null;
        for (const q of pois) if ((!best || q.score > best.score) && pointInRing(q.at, rings[0])) best = q;
        if (best) tags.name = best.name;
      }
      out.push({ id: `mvt/${t.z}/${t.x}/${t.y}/${i}/${k}`, kind: 'building', tags, rings });
    });
  }
  return out;
}
