import { CKS_PRESETS } from '../scene/cks';
import { hallgrimsLatLon } from '../scene/hallgrimskirkja';
import type { Preset } from './types';

// 快速位置：有自建精細模型的地標（中正紀念堂、哈爾格林姆教堂）用精確點位，
// 其他世界知名拍攝點為概略座標，可再微調。

const hg = (name: string, a: number, c: number, extra: Omit<Preset, 'name' | 'group' | 'lat' | 'lon'> = {}): Preset => ({
  name,
  group: '冰島・哈爾格林姆教堂',
  ...hallgrimsLatLon(a, c),
  ...extra,
});

/** 富士山周邊經典構圖（座標取自 OpenStreetMap；抵達後自動對準富士山） */
const fuji = (name: string, lat: number, lon: number, extra: Omit<Preset, 'name' | 'group' | 'lat' | 'lon'> = {}): Preset => ({
  name,
  group: '日本・富士山周邊',
  lat,
  lon,
  aim: 'peak:富士山',
  ...extra,
});

const FUJI: Preset[] = [
  fuji('河口湖・大石公園（湖對岸的富士山）', 35.52329, 138.74654, { state: { focal: 35 } }),
  fuji('河口湖・產屋崎（湖面倒影）', 35.51312, 138.76598, { height: 1.2, state: { focal: 24 } }),
  fuji('新倉山淺間公園・忠靈塔觀景台（五重塔＋富士山）', 35.50145, 138.80143, { state: { focal: 50, portrait: true } }),
  fuji('忍野八海（湧泉池與富士山）', 35.46024, 138.8327, { state: { focal: 35 } }),
  fuji('山中湖・長池親水公園', 35.42702, 138.87136, { state: { focal: 35 } }),
  fuji('山中湖・Panorama 台（俯瞰湖與富士山）', 35.41261, 138.90946, { state: { focal: 24 } }),
  fuji('本栖湖・中之倉峠（千圓鈔票構圖，約略位置）', 35.47568, 138.57299, { state: { focal: 35 } }),
];

export const PRESETS: Preset[] = [
  ...CKS_PRESETS,
  hg('教堂前鞦韆（網美角度：低角度直幅超廣角）', 71, 36.5, { height: 0.9, aim: 'hallgrimskirkja', state: { focal: 16, portrait: true } }),
  hg('鞦韆後方（鞦韆＋教堂同框）', 74, 39, { height: 1.5, aim: 'hallgrimskirkja', state: { focal: 20, portrait: true } }),
  hg('廣場中軸（萊夫像後方）', 72, 0, { aim: 'hallgrimskirkja', state: { focal: 24 } }),
  hg('教堂正門前', 16, 0, { height: 1.4, aim: 'hallgrimskirkja', state: { focal: 14, portrait: true } }),
  hg('Skólavörðustígur 街上（望向教堂，約略位置）', 300, 0, { aim: 'hallgrimskirkja', state: { focal: 85, portrait: true } }),
  ...FUJI,
  { group: '世界拍攝點', name: '台北・象山六巨石（望向台北 101）', lat: 25.02745, lon: 121.57635, aim: 'taipei101', state: { focal: 35 } },
  { group: '世界拍攝點', name: '巴黎・夏樂宮人權廣場（艾菲爾鐵塔）', lat: 48.86185, lon: 2.28875, state: { azimuth: 128, pitch: 8, focal: 35 } },
  { group: '世界拍攝點', name: '東京・增上寺前廣場（東京鐵塔）', lat: 35.65718, lon: 139.74925, state: { azimuth: 292, pitch: 16, focal: 24 } },
  { group: '世界拍攝點', name: '紐約・DUMBO 華盛頓街（曼哈頓橋）', lat: 40.70323, lon: -73.98968, state: { azimuth: 340, pitch: 3, focal: 50 } },
  { group: '世界拍攝點', name: '香港・尖沙咀星光大道（維港天際線）', lat: 22.2931, lon: 114.174, state: { azimuth: 215, pitch: 3, focal: 24 } },
];
