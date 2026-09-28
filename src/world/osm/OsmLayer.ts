import * as THREE from 'three';
import type { LatLon } from '../../geo';
import type { Target } from '../types';
import { buildTile, type TileContent } from './mesh';
import { nearQuery, overpass } from './overpass';
import { parseElements, type Feature } from './parse';
import { fetchFarBuildings } from './vectortiles';
import { distanceToTile, tileBounds, tileKey, tilesAround, type Bounds, type TileId } from './tiles';

// OSM 圖層：依相機位置、朝向、視角與可視範圍動態載入圖磚。
// 遠景 z14（約 2 km 見方）：OpenFreeMap 向量圖磚中的高樓；
// 近景備援 z15（約 1 km 見方）：Overpass 取全部建物、屋頂形狀、樹木與綠地。
// 視野方向內、較近的圖磚優先；離開範圍一段時間的圖磚會釋放。

const FAR_Z = 14;
const NEAR_Z = 15;
const MAX_INFLIGHT = { far: 4, near: 1 };
const KEEP_MS = 45_000;
const DEG = Math.PI / 180;

type Kind = 'far' | 'near';

interface TileState {
  key: string;
  kind: Kind;
  id: TileId;
  bounds: Bounds;
  status: 'idle' | 'loading' | 'data' | 'built' | 'error';
  data?: Feature[];
  content?: TileContent;
  cancel?: () => void;
  priority: number;
  lastWanted: number;
}

export interface OsmStatus {
  far: { built: number; wanted: number };
  near: { built: number; wanted: number };
  loading: number;
  errors: number;
}

export interface OsmContext {
  heightAt: (x: number, z: number) => number;
  excluded: (p: LatLon) => boolean;
  ready: () => boolean;
}

/** 以 eye 為原點的局部平面近似（東、北，公尺） */
function localOf(eye: LatLon, p: LatLon): [number, number] {
  return [(p.lon - eye.lon) * 111320 * Math.cos(eye.lat * DEG), (p.lat - eye.lat) * 110574];
}

function angleDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** 圖磚是否落在方位角 az ± half 的扇形內 */
function inWedge(eye: LatLon, b: Bounds, az: number, half: number): boolean {
  if (eye.lat >= b.s && eye.lat <= b.n && eye.lon >= b.w && eye.lon <= b.e) return true;
  const corners = [
    { lat: b.s, lon: b.w }, { lat: b.s, lon: b.e }, { lat: b.n, lon: b.w }, { lat: b.n, lon: b.e },
    { lat: (b.s + b.n) / 2, lon: (b.w + b.e) / 2 },
  ].map((p) => localOf(eye, p));
  for (const [e, n] of corners) if (angleDiff(Math.atan2(e, n) / DEG, az) <= half) return true;
  // 窄視角時扇形可能整個穿過圖磚中間：做射線與矩形的相交測試
  const [e0, n0] = corners[0];
  const [e1, n1] = corners[3];
  for (const a of [az - half, az, az + half]) {
    const dx = Math.sin(a * DEG);
    const dy = Math.cos(a * DEG);
    let tmin = 0;
    let tmax = Infinity;
    for (const [o0, o1, d] of [[e0, e1, dx], [n0, n1, dy]] as const) {
      if (Math.abs(d) < 1e-9) {
        if (0 < Math.min(o0, o1) || 0 > Math.max(o0, o1)) tmax = -1;
      } else {
        const t0 = Math.min(o0 / d, o1 / d);
        const t1 = Math.max(o0 / d, o1 / d);
        tmin = Math.max(tmin, t0);
        tmax = Math.min(tmax, t1);
      }
    }
    if (tmax >= tmin && tmax > 0) return true;
  }
  return false;
}

export class OsmLayer {
  readonly group = new THREE.Group();
  targets: Target[] = [];
  solids: THREE.Object3D[] = [];
  /** 內容改變時遞增（供重新渲染、重新計算站立面） */
  version = 0;
  nearEnabled = false;
  /** 遠景：'mesh' 建模（沒有 Google 時）／'names' 只取有名稱的高樓當目標 */
  farMode: 'mesh' | 'names' = 'mesh';
  errors = 0;
  private tiles = new Map<string, TileState>();
  /** 目前選取（需要）的圖磚 */
  private selection = new Set<string>();
  private lastSel = { lat: NaN, lon: NaN, az: NaN, fov: NaN, range: NaN, near: NaN, nearOn: false, farMode: '' };

  constructor(private ctx: OsmContext) {
    this.group.name = 'osm';
  }

  status(): OsmStatus {
    const s: OsmStatus = { far: { built: 0, wanted: 0 }, near: { built: 0, wanted: 0 }, loading: 0, errors: this.errors };
    for (const t of this.tiles.values()) {
      const bucket = s[t.kind];
      if (this.selection.has(t.key)) {
        bucket.wanted++;
        if (t.status === 'built') bucket.built++;
      }
      if (t.status === 'loading') s.loading++;
    }
    return s;
  }

  /** 近景備援的圖磚是否都已建好（建好前遠景模型不讓出近景範圍，避免出現空洞） */
  nearComplete(): boolean {
    let wanted = 0;
    for (const key of this.selection) {
      const t = this.tiles.get(key);
      if (!t || t.kind !== 'near') continue;
      wanted++;
      if (t.status !== 'built' && t.status !== 'error') return false;
    }
    return wanted > 0;
  }

  /** 依相機狀態更新要載入的圖磚（有明顯變化時才重算） */
  update(eye: LatLon, azimuth: number, hfov: number, range: number, near: number) {
    const L = this.lastSel;
    const moved = Math.hypot((eye.lat - L.lat) * 110574, (eye.lon - L.lon) * 111320 * Math.cos(eye.lat * DEG));
    const changed =
      !(moved < 60) || angleDiff(azimuth, L.az) > 8 || Math.abs(hfov - L.fov) > 4 ||
      range !== L.range || near !== L.near || this.nearEnabled !== L.nearOn || this.farMode !== L.farMode;
    const now = performance.now();
    if (changed) {
      if (this.farMode !== L.farMode) for (const t of this.tiles.values()) if (t.kind === 'far' && t.status === 'built') this.unbuild(t);
      Object.assign(L, { lat: eye.lat, lon: eye.lon, az: azimuth, fov: hfov, range, near, nearOn: this.nearEnabled, farMode: this.farMode });
      this.selection.clear();
      const half = Math.min(90, hfov / 2 + 25);
      const context = Math.max(near * 1.8, 2000);
      for (const id of tilesAround(eye, range, FAR_Z)) {
        const b = tileBounds(id);
        const d = distanceToTile(eye, b);
        const inView = inWedge(eye, b, azimuth, half);
        if (d > context && !inView) continue;
        this.want('far', id, b, d / 1000 + (inView ? 0 : 3), now);
      }
      if (this.nearEnabled) {
        for (const id of tilesAround(eye, near + 150, NEAR_Z)) {
          const b = tileBounds(id);
          this.want('near', id, b, distanceToTile(eye, b) / 1000 - 5, now);
        }
      }
    } else {
      for (const key of this.selection) {
        const t = this.tiles.get(key);
        if (t) t.lastWanted = now;
      }
    }
    this.pump(now);
  }

  private want(kind: Kind, id: TileId, bounds: Bounds, priority: number, now: number) {
    const key = `${kind}:${tileKey(id)}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { key, kind, id, bounds, status: 'idle', priority, lastWanted: now };
      this.tiles.set(key, t);
    }
    t.priority = priority;
    t.lastWanted = now;
    this.selection.add(key);
  }

  private pump(now: number) {
    const inflight = { far: 0, near: 0 };
    const idle: TileState[] = [];
    for (const t of this.tiles.values()) {
      const wanted = this.selection.has(t.key);
      if (t.status === 'loading') {
        if (!wanted) {
          t.cancel?.();
          t.status = 'idle';
        } else inflight[t.kind]++;
      } else if (t.status === 'idle' && wanted) idle.push(t);
      else if (t.status === 'built' && now - t.lastWanted > KEEP_MS) this.unbuild(t);
    }
    if (!this.nearEnabled) for (const t of this.tiles.values()) if (t.kind === 'near' && t.status === 'built') this.unbuild(t);
    idle.sort((a, b) => a.priority - b.priority);
    for (const t of idle) {
      if (inflight[t.kind] >= MAX_INFLIGHT[t.kind]) continue;
      inflight[t.kind]++;
      this.fetch(t);
    }
  }

  private fetch(t: TileState) {
    t.status = 'loading';
    let promise: Promise<Feature[]>;
    if (t.kind === 'far') {
      const ctrl = new AbortController();
      t.cancel = () => ctrl.abort();
      promise = fetchFarBuildings(t.id, ctrl.signal).catch((e) => {
        throw (e as Error)?.name === 'AbortError' ? new Error('cancelled') : e;
      });
    } else {
      const req = overpass(`near-v1/${tileKey(t.id)}`, nearQuery(t.bounds));
      t.cancel = req.cancel;
      promise = req.promise.then(parseElements);
    }
    promise.then(
      (features) => {
        if (t.status !== 'loading') return;
        t.data = features;
        t.status = 'data';
      },
      (e) => {
        if (t.status !== 'loading') return;
        if ((e as Error)?.message !== 'cancelled') {
          console.warn('[osm] 圖磚載入失敗', t.key, e);
          this.errors++;
          t.status = 'error';
        } else t.status = 'idle';
      },
    );
  }

  /** 每幀最多建一塊，避免卡頓 */
  frame() {
    if (!this.ctx.ready()) return;
    let best: TileState | null = null;
    for (const t of this.tiles.values()) {
      if (t.status !== 'data' || !this.selection.has(t.key)) continue;
      if (t.kind === 'near' && !this.nearEnabled) continue;
      if (!best || t.priority < best.priority) best = t;
    }
    if (!best?.data) return;
    best.content = buildTile(best.data, {
      detail: best.kind,
      namesOnly: best.kind === 'far' && this.farMode === 'names',
      heightAt: this.ctx.heightAt,
      excluded: this.ctx.excluded,
    });
    best.status = 'built';
    this.group.add(best.content.group);
    this.refresh();
  }

  private unbuild(t: TileState) {
    if (t.content) {
      this.group.remove(t.content.group);
      t.content.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) {
          m.geometry.disposeBoundsTree?.();
          m.geometry.dispose();
        }
      });
      t.content = undefined;
    }
    t.status = t.data ? 'data' : 'idle';
    this.refresh();
  }

  /** 原點改變：所有已建模型依新原點重建（資料保留） */
  rebase() {
    for (const t of this.tiles.values()) {
      if (t.status === 'built') this.unbuild(t);
      if (t.status === 'error') t.status = 'idle';
    }
    this.lastSel.lat = NaN;
  }

  private refresh() {
    const byLabel = new Map<string, Target>();
    const solids: THREE.Object3D[] = [];
    for (const t of this.tiles.values()) {
      if (!t.content) continue;
      solids.push(...t.content.solids);
      for (const g of t.content.targets) {
        const prev = byLabel.get(g.label);
        if (!prev || g.top.y > prev.top.y) byLabel.set(g.label, g);
      }
    }
    this.targets = [...byLabel.values()];
    this.solids = solids;
    this.version++;
  }
}
