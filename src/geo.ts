// 經緯度 ↔ 場景座標。
// 場景座標：原點＝紀念堂中心，+X 朝東、+Z 朝南、+Y 朝上，單位公尺。
// 5 km 以內用局部切平面（依 WGS84 子午圈／卯酉圈曲率半徑）即可，誤差遠小於 1 m。

export interface LatLon {
  lat: number;
  lon: number;
}

const A = 6378137; // WGS84 長半軸
const E2 = 0.00669437999014; // 第一偏心率平方
const DEG = Math.PI / 180;

/** 場景原點：中正紀念堂主建築中心（OSM way 1052759757 形心） */
export const ORIGIN: LatLon = { lat: 25.034638, lon: 121.521821 };

const sinLat = Math.sin(ORIGIN.lat * DEG);
const w = 1 - E2 * sinLat * sinLat;
const M = (A * (1 - E2)) / Math.pow(w, 1.5); // 子午圈曲率半徑
const N = A / Math.sqrt(w); // 卯酉圈曲率半徑
const M_PER_DEG_LAT = M * DEG;
const M_PER_DEG_LON = N * Math.cos(ORIGIN.lat * DEG) * DEG;

export function toLocal(p: LatLon): { x: number; z: number } {
  return {
    x: (p.lon - ORIGIN.lon) * M_PER_DEG_LON,
    z: -(p.lat - ORIGIN.lat) * M_PER_DEG_LAT,
  };
}

export function toLatLon(x: number, z: number): LatLon {
  return {
    lat: ORIGIN.lat - z / M_PER_DEG_LAT,
    lon: ORIGIN.lon + x / M_PER_DEG_LON,
  };
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
