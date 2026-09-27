import type { LatLon } from '../geo';

// 地標經緯度與地面海拔（WGS84）。場景原點（紀念堂中心）定義在 geo.ts 的 ORIGIN。
// 來源：OpenStreetMap 建物輪廓形心（2026-09 查詢）、中正紀念堂管理處「環境介紹」。

export const LANDMARKS = {
  /** 台北 101 塔身中心（OSM tower parts 198637969 / 615183623） */
  taipei101: { lat: 25.033668, lon: 121.56481 } as LatLon,
};
