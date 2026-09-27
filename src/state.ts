import { ASPECTS, type AspectId, FOCAL_MAX, FOCAL_MIN } from './lens';

export interface ShotState {
  /** 場景座標（公尺，+X 東、+Z 南） */
  x: number;
  z: number;
  /** 相機離站立面的高度（公尺） */
  height: number;
  /** true：站在地面／台階／平台上；false：以地面 0 m 起算（空拍） */
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
  /** 台北時間日期 YYYY-MM-DD */
  date: string;
  /** 台北時間，當日第幾分鐘 */
  minutes: number;
  /** 雲量 0–1 */
  clouds: number;
  /** 能見度 km */
  visibility: number;
  /** 曝光補償 EV */
  ev: number;
  trees: boolean;
  grid: boolean;
}

export type StateKey = keyof ShotState;
type Listener = (s: ShotState, changed: Set<StateKey>) => void;

const TAIPEI_OFFSET_MIN = 8 * 60;

export function taipeiNow(): { date: string; minutes: number } {
  const t = new Date(Date.now() + TAIPEI_OFFSET_MIN * 60_000);
  return {
    date: t.toISOString().slice(0, 10),
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

/** 台北時間 → UTC 瞬間 */
export function toInstant(date: string, minutes: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, minutes - TAIPEI_OFFSET_MIN));
}

/** UTC 瞬間 → 台北時間當日分鐘數（跨日時回傳相對 date 的偏移） */
export function toTaipeiMinutes(instant: Date, date: string): number {
  const base = toInstant(date, 0).getTime();
  return Math.round((instant.getTime() - base) / 60_000);
}

export function formatMinutes(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const now = taipeiNow();

// 預設：自由廣場中央，望向紀念堂（主軸方位 118.3°）
export const DEFAULT_STATE: ShotState = {
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
};

const wrap360 = (v: number) => ((v % 360) + 360) % 360;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function sanitize(s: ShotState): ShotState {
  s.azimuth = wrap360(s.azimuth);
  s.pitch = clamp(s.pitch, -90, 90);
  s.roll = clamp(s.roll, -90, 90);
  s.focal = clamp(s.focal, FOCAL_MIN, FOCAL_MAX);
  s.height = clamp(s.height, 0, 600);
  s.clouds = clamp(s.clouds, 0, 1);
  s.visibility = clamp(s.visibility, 1, 60);
  s.ev = clamp(s.ev, -5, 5);
  s.minutes = clamp(Math.round(s.minutes), 0, 1439);
  if (!(s.aspect in ASPECTS)) s.aspect = '3:2';
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
  x: 'x', z: 'z', h: 'height', s: 'snap', az: 'azimuth', p: 'pitch', r: 'roll',
  f: 'focal', ar: 'aspect', o: 'portrait', d: 'date', t: 'minutes', c: 'clouds', v: 'visibility', ev: 'ev',
};

export function encodeHash(s: ShotState): string {
  const q = new URLSearchParams();
  for (const [short, key] of Object.entries(HASH_KEYS)) {
    const v = s[key];
    if (typeof v === 'number') q.set(short, String(Math.round(v * 100) / 100));
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
  return out as Partial<ShotState>;
}

export const store = new Store({ ...DEFAULT_STATE, ...decodeHash(location.hash) });
