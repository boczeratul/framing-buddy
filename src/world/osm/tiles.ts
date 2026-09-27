import { distanceLatLon, type LatLon } from '../../geo';

// Web Mercator 圖磚（slippy map）工具：OSM 資料以圖磚為單位查詢與快取。

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export interface Bounds {
  s: number;
  w: number;
  n: number;
  e: number;
}

const DEG = Math.PI / 180;

export const tileKey = (t: TileId) => `${t.z}/${t.x}/${t.y}`;

export function lonToX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToY(lat: number, z: number): number {
  const r = lat * DEG;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export function tileBounds(t: TileId): Bounds {
  const n = 2 ** t.z;
  const lon = (x: number) => (x / n) * 360 - 180;
  const lat = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG;
  return { w: lon(t.x), e: lon(t.x + 1), n: lat(t.y), s: lat(t.y + 1) };
}

/** 點到圖磚矩形的最短距離（公尺） */
export function distanceToTile(p: LatLon, b: Bounds): number {
  const q = { lat: Math.min(Math.max(p.lat, b.s), b.n), lon: Math.min(Math.max(p.lon, b.w), b.e) };
  return distanceLatLon(p, q);
}

/** 與圓形範圍相交的所有圖磚 */
export function tilesAround(p: LatLon, radius: number, z: number): TileId[] {
  const dLat = radius / 111000;
  const dLon = radius / (111000 * Math.max(0.05, Math.cos(p.lat * DEG)));
  const x0 = lonToX(p.lon - dLon, z);
  const x1 = lonToX(p.lon + dLon, z);
  const y0 = latToY(p.lat + dLat, z);
  const y1 = latToY(p.lat - dLat, z);
  const out: TileId[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const t = { z, x, y };
      if (distanceToTile(p, tileBounds(t)) <= radius) out.push(t);
    }
  return out;
}
