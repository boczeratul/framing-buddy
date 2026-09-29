import type { FacadeColor } from './nyhavn-materials';

// 新港各棟房屋的立面規格與停泊船隻。
// 顏色、樓層、開間、屋頂：依街景照片、攝影作品與維基百科個別建物條目整理（未查到的標為估計）。

export interface HouseSpec {
  color: FacadeColor;
  /** 地上樓層數（不含屋頂層） */
  storeys: number;
  roof?: 'gable' | 'mansard' | 'hip' | 'flat';
  tile?: 'red' | 'black' | 'slate' | 'copper';
  /** 臨運河立面的開間數（未給時依寬度估算） */
  bays?: number;
  /** 大門在第幾開間（0 起算） */
  door?: number;
  /** 正面山牆窗（gavlkvist）跨幾開間 */
  kvist?: number;
  /** 各山牆窗的起始開間（未給時置中；給多個＝雙山牆窗） */
  kvistStart?: number[];
  /** 屋頂老虎窗數 */
  dormers?: number;
  /** 半地下室（餐廳、酒館）窗 */
  cellar?: boolean;
  /** 一樓為店面大窗 */
  shop?: boolean;
  /** 餐廳遮陽篷與碼頭邊座位 */
  awning?: 'red' | 'green' | 'blue' | 'canvas';
  /** 簷口顏色：預設白色，'wall' 與牆同色 */
  trim?: 'wall';
  plinth?: number;
  groundFloor?: number;
  floor?: number;
  /** 屋頂進深上限（公尺） */
  depth?: number;
  year?: number;
}

/** 以 `${側}${門牌}` 為鍵（N＝北岸奇數號、S＝南岸偶數號）。顏色未查到來源者為估計值。 */
export const HOUSES: Record<string, HouseSpec> = {
  // ---- 北岸（由國王新廣場往港口）----
  N1: { color: 'orange', storeys: 3, bays: 6, dormers: 3, cellar: true, awning: 'red', year: 1753 },
  N3: { color: 'oxblood', storeys: 3, bays: 5, dormers: 2, cellar: true, awning: 'green', year: 1776 },
  N5: { color: 'lightBlue', storeys: 4, bays: 5, dormers: 3, cellar: true, awning: 'canvas' },
  N7: { color: 'yellow', storeys: 3, bays: 4, dormers: 2, cellar: true, awning: 'red', year: 1846 },
  N9: { color: 'paleBlue', storeys: 2, bays: 5, kvist: 3, cellar: true, awning: 'green', year: 1681 },
  N11: { color: 'orange', storeys: 4, bays: 5, dormers: 4, door: 0, year: 1836 },
  N13: { color: 'paleGreen', storeys: 4, bays: 4, dormers: 2, cellar: true, awning: 'canvas', year: 1842 },
  N15: { color: 'blue', storeys: 3, bays: 4, dormers: 2, cellar: true, awning: 'red' },
  N17: { color: 'red', storeys: 3, bays: 6, dormers: 2, cellar: true, awning: 'canvas', year: 1768 },
  N19: { color: 'terracotta', storeys: 3, bays: 4, cellar: true, awning: 'green' },
  N21: { color: 'lightBlue', storeys: 3, bays: 5, door: 0, cellar: true, awning: 'red', year: 1790 },
  N23: { color: 'white', storeys: 4, bays: 4, cellar: true, awning: 'blue', year: 1803 },
  N25: { color: 'yellow', storeys: 3, bays: 5, dormers: 2, cellar: true, awning: 'red' },
  N27: { color: 'paleYellow', storeys: 3, bays: 6, roof: 'mansard', kvist: 2, cellar: true, awning: 'green', year: 1784 },
  N29: { color: 'paleRed', storeys: 3, bays: 4, dormers: 2, cellar: true, awning: 'canvas', year: 1755 },
  N31: { color: 'cream', storeys: 3, bays: 5, dormers: 2, cellar: true, awning: 'red', year: 1799 },
  N33: { color: 'orange', storeys: 4, bays: 5, dormers: 2, cellar: true, awning: 'blue', year: 1850 },
  N35: { color: 'ochre', storeys: 4, bays: 5, year: 1855 },
  N37: { color: 'red', storeys: 3, bays: 4, kvist: 4, cellar: true, awning: 'canvas' },
  N39: { color: 'yellow', storeys: 4, bays: 4, cellar: true, awning: 'green', year: 1850 },
  N41: { color: 'lightBlue', storeys: 3, bays: 5, kvist: 3, cellar: true, awning: 'red', year: 1753 },
  N43: { color: 'oxblood', storeys: 3, bays: 6, tile: 'black', dormers: 3, cellar: true, plinth: 1.4, awning: 'canvas', year: 1788 },
  N45: { color: 'ochre', storeys: 3, bays: 4, roof: 'mansard', dormers: 2, cellar: true, awning: 'blue', year: 1794 },
  N47: { color: 'paleYellow', storeys: 3, bays: 4, cellar: true, awning: 'red', year: 1845 },
  N49: { color: 'ochre', storeys: 5, bays: 5, cellar: true, shop: true, year: 1887 },
  N51: { color: 'blueGrey', storeys: 3, bays: 3, kvist: 2, cellar: true, awning: 'green', year: 1766 },
  N53: { color: 'red', storeys: 4, bays: 5, tile: 'black', door: 4, cellar: true, year: 1874 },
  N55: { color: 'yellow', storeys: 3, bays: 3, roof: 'mansard', dormers: 2, shop: true, cellar: true, year: 1906 },
  N57: { color: 'pink', storeys: 3, bays: 3, dormers: 1, cellar: true, awning: 'canvas' },
  N59: { color: 'blueGrey', storeys: 4, bays: 4, cellar: true, year: 1889 },
  N61: { color: 'yellow', storeys: 4, bays: 4, roof: 'mansard', cellar: true, year: 1858 },
  N63: { color: 'brick', storeys: 3, bays: 5, dormers: 2, door: 0, cellar: true, plinth: 1.4, year: 1756 },
  N65: { color: 'ochre', storeys: 4, bays: 9, kvist: 3, cellar: true, year: 1739 },
  N67: { color: 'salmon', storeys: 5, bays: 3, cellar: true, plinth: 1.4, year: 1838 },
  N69: { color: 'sand', storeys: 3, bays: 6, tile: 'slate', groundFloor: 3.6, floor: 3.2, year: 1886 },
  N71: { color: 'brick', storeys: 4, bays: 14, dormers: 2, cellar: true, trim: 'wall', floor: 3.0, depth: 13, year: 1805 },
  // ---- 南岸 ----
  S4: { color: 'sand', storeys: 5, tile: 'slate', groundFloor: 3.5, floor: 3.1, year: 1877 },
  S6: { color: 'paleYellow', storeys: 4, bays: 6, tile: 'black', door: 0, cellar: true, year: 1829 },
  S8: { color: 'brick', storeys: 4, bays: 5, roof: 'hip', cellar: true, year: 1846 },
  S10: { color: 'ochre', storeys: 4, bays: 5, cellar: true, year: 1850 },
  S12: { color: 'white', storeys: 3, bays: 6, roof: 'mansard', kvist: 3, shop: true, cellar: true },
  S14: { color: 'red', storeys: 4, bays: 5, cellar: true, year: 1775 },
  S16: { color: 'yellow', storeys: 3, bays: 4, dormers: 2, cellar: true, awning: 'red', year: 1775 },
  S18: { color: 'paleBlue', storeys: 4, bays: 6, dormers: 3, cellar: true, year: 1846 },
  S20: { color: 'paleYellow', storeys: 3, bays: 10, kvist: 3, kvistStart: [1, 6], cellar: true, year: 1779 },
  S22: { color: 'yellow', storeys: 3, bays: 9, kvist: 3, dormers: 2, door: 0, cellar: true, year: 1779 },
  S24: { color: 'terracotta', storeys: 5, tile: 'slate', groundFloor: 3.5, floor: 3.1, year: 1906 },
  S38: { color: 'brick', storeys: 5, bays: 9, tile: 'slate', groundFloor: 3.6, floor: 3.2, cellar: true, year: 1880 },
  S40: { color: 'grey', storeys: 5, bays: 3, tile: 'slate', groundFloor: 3.6, floor: 3.2, year: 1873 },
  S42: { color: 'cream', storeys: 5, bays: 7, tile: 'slate', groundFloor: 3.6, floor: 3.2, year: 1872 },
  S44: { color: 'sand', storeys: 5, bays: 11, tile: 'slate', groundFloor: 3.6, floor: 3.2, year: 1874 },
};

/** 需要沿 a 切開的建物輪廓（OSM 把兩棟畫成一個）：鍵為原門牌，值為 [切線 a, 東側門牌] */
export const SPLITS: Record<string, [number, string]> = {
  N59: [123.8, '61'],
};

export interface ShipSpec {
  name?: string;
  /** 船中心沿運河位置 */
  a: number;
  side: 'N' | 'S';
  len: number;
  beam?: number;
  freeboard?: number;
  kind: 'galleass' | 'schooner' | 'ketch' | 'cutter' | 'lightship' | 'barge' | 'motor';
  hull: 'black' | 'white' | 'green' | 'blue' | 'red' | 'tar';
  /** 舷緣色帶 */
  band?: 'white' | 'red' | 'green' | 'wood';
  cabin?: 'white' | 'wood';
  /** 桅杆：[距船中心的比例（+ 往船首）, 甲板以上高度] */
  masts?: [number, number][];
  bow: 'east' | 'west';
}

export const SHIPS: ShipSpec[] = [
  // 北岸（新港橋以西，傳統木船港）
  { name: 'Svalan af Nyhavn', a: -150, side: 'N', len: 20, kind: 'galleass', hull: 'black', band: 'white', masts: [[0.2, 18], [-0.25, 14]], bow: 'east' },
  { name: 'Lotte Brinch', a: -126, side: 'N', len: 14, kind: 'cutter', hull: 'tar', band: 'wood', masts: [[0.1, 14]], bow: 'west' },
  { a: -103, side: 'N', len: 18, kind: 'galleass', hull: 'green', band: 'wood', masts: [[0.2, 16], [-0.25, 12]], bow: 'east' },
  { name: 'MA-RI', a: -80, side: 'N', len: 17, kind: 'ketch', hull: 'blue', band: 'white', masts: [[0.15, 15], [-0.3, 10]], bow: 'west' },
  { a: -56, side: 'N', len: 21, kind: 'schooner', hull: 'white', band: 'green', masts: [[0.2, 18], [-0.12, 20]], bow: 'east' },
  { a: -33, side: 'N', len: 12, kind: 'cutter', hull: 'black', band: 'red', masts: [[0.05, 12]], bow: 'west' },
  { a: -12, side: 'N', len: 19, kind: 'galleass', hull: 'black', band: 'wood', masts: [[0.2, 17], [-0.25, 13]], bow: 'east' },
  { a: 12, side: 'N', len: 15, kind: 'ketch', hull: 'tar', band: 'white', masts: [[0.15, 14], [-0.3, 9]], bow: 'west' },
  { a: 36, side: 'N', len: 11, kind: 'motor', hull: 'white', band: 'wood', cabin: 'white', bow: 'west' },
  // 北岸（橋以東）
  { a: 96, side: 'N', len: 22, beam: 5.2, kind: 'schooner', hull: 'black', band: 'green', masts: [[0.2, 19], [-0.12, 21]], bow: 'east' },
  { name: 'Mira', a: 150, side: 'N', len: 27.5, beam: 6.2, kind: 'schooner', hull: 'black', band: 'white', masts: [[0.22, 23], [-0.12, 24]], bow: 'west' },
  { a: 198, side: 'N', len: 18, kind: 'galleass', hull: 'green', band: 'white', masts: [[0.2, 16], [-0.25, 12]], bow: 'east' },
  // 南岸
  { a: -150, side: 'S', len: 16, kind: 'galleass', hull: 'black', band: 'wood', masts: [[0.2, 15], [-0.25, 11]], bow: 'west' },
  { a: -126, side: 'S', len: 11, kind: 'cutter', hull: 'white', band: 'white', masts: [[0.05, 11]], bow: 'east' },
  { a: -84, side: 'S', len: 15, kind: 'ketch', hull: 'green', band: 'white', masts: [[0.15, 14], [-0.3, 9]], bow: 'west' },
  { a: -58, side: 'S', len: 10, kind: 'motor', hull: 'blue', band: 'white', cabin: 'wood', bow: 'east' },
  { a: -34, side: 'S', len: 13, kind: 'cutter', hull: 'tar', band: 'wood', masts: [[0.05, 13]], bow: 'west' },
  { name: 'Bådteatret', a: 4.2, side: 'S', len: 28, beam: 6.2, freeboard: 0.9, kind: 'barge', hull: 'black', band: 'wood', bow: 'east' },
  { name: 'Fyrskib XVII Gedser Rev', a: 35, side: 'S', len: 32, beam: 6.6, freeboard: 1.8, kind: 'lightship', hull: 'red', band: 'white', cabin: 'white', masts: [[0.25, 16], [-0.35, 9]], bow: 'east' },
  { a: 92, side: 'S', len: 18, kind: 'galleass', hull: 'black', band: 'white', masts: [[0.2, 16], [-0.25, 12]], bow: 'west' },
  { a: 122, side: 'S', len: 15, kind: 'ketch', hull: 'blue', band: 'wood', masts: [[0.15, 14], [-0.3, 9]], bow: 'east' },
  { a: 165, side: 'S', len: 20, kind: 'schooner', hull: 'black', band: 'red', masts: [[0.2, 17], [-0.12, 19]], bow: 'west' },
  { a: 205, side: 'S', len: 16, kind: 'motor', hull: 'white', band: 'wood', cabin: 'white', bow: 'east' },
];
