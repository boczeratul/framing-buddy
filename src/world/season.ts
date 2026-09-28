// 季節與緯度相關的地表估算（雪線、林線），供地形與精細山體上色

/** 季節雪線（公尺）：依緯度估算夏季雪線，冬季下降約 2500 m；南半球季節相反 */
export function snowLine(month: number, lat: number): number {
  const summer = Math.max(600, 4800 - 55 * Math.max(0, Math.abs(lat) - 20));
  const winter = summer - 2500;
  const phase = lat >= 0 ? month - 1.5 : month - 7.5;
  const w = 0.5 + 0.5 * Math.cos((phase * Math.PI) / 6);
  return summer + (winter - summer) * w;
}

/** 林線（公尺） */
export function treeLine(lat: number): number {
  return Math.max(300, 3700 - 70 * Math.max(0, Math.abs(lat) - 20));
}
