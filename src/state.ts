import { ASPECTS, type AspectId, FOCAL_MAX, FOCAL_MIN } from './lens';
import { DEFAULT_ORIGIN } from './geo';
import { isValidZone, nowInZone } from './time';

export interface ShotState {
  /** 場景原點（經緯度）；選擇新地點時移動 */
  lat0: number;
  lon0: number;
  /** 拍攝地點的 IANA 時區 */
  tz: string;
  /** 相對原點的場景座標（公尺，+X 東、+Z 南） */
  x: number;
  z: number;
  /** 相機離站立面的高度（公尺） */
  height: number;
  /** true：站在地面／屋頂／平台上；false：以原點地面 0 m 起算（空拍） */
  snap: boolean;
  /** 方位角，0°＝北、順時針 */
  azimuth: number;
  /** 俯仰角，正值抬頭 */
  pitch: number;
  /** 滾轉（水平傾斜），正值順時針 */
  roll: number;
  /** 全片幅等效焦段 mm */
  focal: number;
  aspect: AspectId;
  portrait: boolean;
  /** 當地日期 YYYY-MM-DD */
  date: string;
  /** 當地時間，當日第幾分鐘 */
  minutes: number;
  /** 雲量 0–1 */
  clouds: number;
  /** 能見度 km */
  visibility: number;
  /** 曝光補償 EV */
  ev: number;
  trees: boolean;
  grid: boolean;
  /** 遠景載入半徑 km */
  range: number;
  /** 近景（精細模型）半徑 m */
  near: number;
  /** 近景使用 Google 實景 3D 圖磚 */
  photoreal: boolean;
  /** 近景套用模擬日照（false：保留照片原始光影） */
  relight: boolean;
  /** 資訊列追蹤的目標 id */
  target: string;
}

export type StateKey = keyof ShotState;
type Listener = (s: ShotState, changed: Set<StateKey>) => void;

const TZ0 = 'Asia/Taipei';
const now = nowInZone(TZ0);

// 預設：中正紀念堂自由廣場中央，望向紀念堂（主軸方位 118.3°）
export const DEFAULT_STATE: ShotState = {
  lat0: DEFAULT_ORIGIN.lat,
  lon0: DEFAULT_ORIGIN.lon,
  tz: TZ0,
  x: -312.6,
  z: -168.3,
  height: 1.6,
  snap: true,
  azimuth: 118.3,
  pitch: 5,
  roll: 0,
  focal: 35,
  aspect: '3:2',
  portrait: false,
  date: now.date,
  minutes: 17 * 60 + 30,
  clouds: 0.25,
  visibility: 12,
  ev: 0,
  trees: true,
  grid: true,
  range: 6,
  near: 1000,
  photoreal: true,
  relight: true,
  target: 'taipei101',
};

const wrap360 = (v: number) => ((v % 360) + 360) % 360;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function sanitize(s: ShotState): ShotState {
  s.lat0 = clamp(s.lat0, -85, 85);
  s.lon0 = ((((s.lon0 + 180) % 360) + 360) % 360) - 180;
  s.azimuth = wrap360(s.azimuth);
  s.pitch = clamp(s.pitch, -90, 90);
  s.roll = clamp(s.roll, -90, 90);
  s.focal = clamp(s.focal, FOCAL_MIN, FOCAL_MAX);
  s.height = clamp(s.height, 0, 2000);
  s.clouds = clamp(s.clouds, 0, 1);
  s.visibility = clamp(s.visibility, 1, 80);
  s.ev = clamp(s.ev, -5, 5);
  s.minutes = clamp(Math.round(s.minutes), 0, 1439);
  s.range = clamp(s.range, 1, 20);
  s.near = clamp(s.near, 200, 3000);
  if (!(s.aspect in ASPECTS)) s.aspect = '3:2';
  if (!isValidZone(s.tz)) s.tz = TZ0;
  return s;
}

class Store {
  state: ShotState;
  private listeners: Listener[] = [];

  constructor(initial: ShotState) {
    this.state = sanitize({ ...initial });
  }

  set(patch: Partial<ShotState>) {
    const changed = new Set<StateKey>();
    const next = sanitize({ ...this.state, ...patch });
    for (const k of Object.keys(next) as StateKey[]) {
      if (next[k] !== this.state[k]) changed.add(k);
    }
    if (!changed.size) return;
    this.state = next;
    for (const l of this.listeners) l(this.state, changed);
  }

  subscribe(l: Listener) {
    this.listeners.push(l);
    l(this.state, new Set(Object.keys(this.state) as StateKey[]));
  }
}

// ---- 分享連結：把拍攝設定編碼進 URL hash ----

const HASH_KEYS: Record<string, StateKey> = {
  la: 'lat0', lo: 'lon0', tz: 'tz',
  x: 'x', z: 'z', h: 'height', s: 'snap', az: 'azimuth', p: 'pitch', r: 'roll',
  f: 'focal', ar: 'aspect', o: 'portrait', d: 'date', t: 'minutes', c: 'clouds', v: 'visibility', ev: 'ev',
  rg: 'range', nr: 'near', pr: 'photoreal', rl: 'relight', tg: 'target',
};

export function encodeHash(s: ShotState): string {
  const q = new URLSearchParams();
  for (const [short, key] of Object.entries(HASH_KEYS)) {
    const v = s[key];
    if (key === 'lat0' || key === 'lon0') q.set(short, (v as number).toFixed(6));
    else if (typeof v === 'number') q.set(short, String(Math.round(v * 100) / 100));
    else if (typeof v === 'boolean') q.set(short, v ? '1' : '0');
    else q.set(short, String(v));
  }
  return q.toString();
}

export function decodeHash(hash: string): Partial<ShotState> {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const out: Record<string, unknown> = {};
  for (const [short, key] of Object.entries(HASH_KEYS)) {
    const raw = q.get(short);
    if (raw == null) continue;
    const def = DEFAULT_STATE[key];
    if (typeof def === 'number') {
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = n;
    } else if (typeof def === 'boolean') out[key] = raw === '1';
    else if (key !== 'date' || /^\d{4}-\d{2}-\d{2}$/.test(raw)) out[key] = raw;
  }
  // 舊版連結沒有 la/lo：沿用預設原點（中正紀念堂），座標依然正確
  return out as Partial<ShotState>;
}

export const store = new Store({ ...DEFAULT_STATE, ...decodeHash(location.hash) });
