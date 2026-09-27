// 經緯度 ↔ 場景座標。
// 場景座標：原點＝目前選定的地點（可移動），+X 朝東、+Z 朝南、+Y 朝上，單位公尺。
// 選擇新地點時整個場景會以新原點重建，讓座標值保持在數公里內、避免浮點誤差。
// 20 km 以內用局部切平面（依 WGS84 子午圈／卯酉圈曲率半徑），誤差遠小於模型精度。

export interface LatLon {
  lat: number;
  lon: number;
}

const A = 6378137; // WGS84 長半軸
const E2 = 0.00669437999014; // 第一偏心率平方
const DEG = Math.PI / 180;

/** 預設原點：中正紀念堂主建築中心（OSM way 1052759757 形心） */
export const DEFAULT_ORIGIN: LatLon = { lat: 25.034638, lon: 121.521821 };

let origin: LatLon = { ...DEFAULT_ORIGIN };
let mPerDegLat = 0;
let mPerDegLon = 0;

function scales(lat: number) {
  const s = Math.sin(lat * DEG);
  const w = 1 - E2 * s * s;
  const M = (A * (1 - E2)) / Math.pow(w, 1.5); // 子午圈曲率半徑
  const N = A / Math.sqrt(w); // 卯酉圈曲率半徑
  return { lat: M * DEG, lon: N * Math.cos(lat * DEG) * DEG };
}

export function setOrigin(p: LatLon) {
  origin = { lat: p.lat, lon: p.lon };
  const s = scales(p.lat);
  mPerDegLat = s.lat;
  mPerDegLon = s.lon;
}
setOrigin(DEFAULT_ORIGIN);

export function getOrigin(): LatLon {
  return origin;
}

export function toLocal(p: LatLon): { x: number; z: number } {
  return {
    x: (p.lon - origin.lon) * mPerDegLon,
    z: -(p.lat - origin.lat) * mPerDegLat,
  };
}

export function toLatLon(x: number, z: number): LatLon {
  return {
    lat: origin.lat - z / mPerDegLat,
    lon: origin.lon + x / mPerDegLon,
  };
}

/** 以 p 為切點，往東 east 公尺、往北 north 公尺後的經緯度（與目前原點無關） */
export function offsetLatLon(p: LatLon, east: number, north: number): LatLon {
  const s = scales(p.lat);
  return { lat: p.lat + north / s.lat, lon: p.lon + east / s.lon };
}

/** 大圓距離（公尺） */
export function distanceLatLon(a: LatLon, b: LatLon): number {
  const R = 6371008.8;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 地球曲率造成的視線下沉（含大氣折射係數 k≈0.13） */
export function curvatureDrop(distance: number): number {
  const k = 0.13;
  return ((distance * distance) / (2 * A)) * (1 - k);
}

/** 由 (x,z) 指向 (tx,tz) 的方位角，0°＝北、順時針 */
export function bearing(x: number, z: number, tx: number, tz: number): number {
  const deg = Math.atan2(tx - x, -(tz - z)) / DEG;
  return (deg + 360) % 360;
}

const COMPASS = ['北', '北北東', '東北', '東北東', '東', '東南東', '東南', '南南東', '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西'];

export function compassName(azimuth: number): string {
  return COMPASS[Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16];
}

export function formatLatLon(p: LatLon, digits = 6): string {
  return `${p.lat.toFixed(digits)}, ${p.lon.toFixed(digits)}`;
}

/** 解析「25.0346, 121.5218」這類文字 */
export function parseLatLon(text: string): LatLon | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
