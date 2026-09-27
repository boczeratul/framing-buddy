import { CKS_PRESETS } from '../scene/cks';
import type { Preset } from './types';

// 快速位置：中正紀念堂園區內的精確點位，加上幾個世界知名拍攝點（座標為概略值，可再微調）。

export const PRESETS: Preset[] = [
  ...CKS_PRESETS,
  { group: '世界拍攝點', name: '台北・象山六巨石（望向台北 101）', lat: 25.02745, lon: 121.57635, aim: 'taipei101', state: { focal: 35 } },
  { group: '世界拍攝點', name: '巴黎・夏樂宮人權廣場（艾菲爾鐵塔）', lat: 48.86185, lon: 2.28875, state: { azimuth: 128, pitch: 8, focal: 35 } },
  { group: '世界拍攝點', name: '東京・增上寺前廣場（東京鐵塔）', lat: 35.65718, lon: 139.74925, state: { azimuth: 292, pitch: 16, focal: 24 } },
  { group: '世界拍攝點', name: '紐約・DUMBO 華盛頓街（曼哈頓橋）', lat: 40.70323, lon: -73.98968, state: { azimuth: 340, pitch: 3, focal: 50 } },
  { group: '世界拍攝點', name: '香港・尖沙咀星光大道（維港天際線）', lat: 22.2931, lon: 114.174, state: { azimuth: 215, pitch: 3, focal: 24 } },
];
