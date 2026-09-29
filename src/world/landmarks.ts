import * as THREE from 'three';
import { distanceLatLon, toLocal, offsetLatLon, type LatLon } from '../geo';
import { buildCKS, CKS_ANCHOR, CKS_EXCLUSION, HALL, localToSite, type Floor } from '../scene/cks';
import { buildTaipei101, T101, TAIPEI101_FOOTPRINT } from '../scene/taipei101';
import { buildHallgrimskirkja, HALLGRIMS_ANCHOR, HALLGRIMS_MASK, HALLGRIMS } from '../scene/hallgrimskirkja';
import { buildRosenborg, ROSENBORG, ROSENBORG_ANCHOR, ROSENBORG_MASK } from '../scene/rosenborg';
import { buildNyhavn, NYHAVN, NYHAVN_ANCHOR, NYHAVN_MASK } from '../scene/nyhavn';
import { LANDMARKS } from '../scene/landmarks';
import { pointInRing } from './osm/parse';
import type { MapLabel, Target } from './types';

// 地標：自建的精細模型（中正紀念堂園區、台北 101、哈爾格林姆教堂、羅森堡宮、新港）。
// - 有 Google 圖磚時：地標進入近景範圍才換成自建模型，並把該區域的 Google 模型挖掉；
//   遠離時隱藏，由 Google 模型呈現。
// - 沒有 Google 時：可視範圍內一律顯示自建模型。

interface TargetSpec {
  id: string;
  label: string;
  /** 相對錨點的頂部高度 */
  top: number;
  aimAt: number;
  radius: number;
  /** 相對錨點的水平位移（公尺，東、南） */
  dx?: number;
  dz?: number;
}

interface Instance {
  group: THREE.Group;
  solids: THREE.Object3D[];
  trees?: THREE.Object3D;
  labels: MapLabel[];
  /** 區域座標（錨點為原點）的站立面高度（台基、台階等精確值） */
  surface?: (x: number, z: number) => number | null;
  /** 只在沒有 Google 時顯示的附屬物（例如示意的周邊道路） */
  fallbackOnly?: THREE.Object3D[];
}

interface LandmarkDef {
  id: string;
  name: string;
  anchor: LatLon;
  /** 模型大致半徑（公尺） */
  radius: number;
  /** 自建模型涵蓋的範圍：OSM 建物不重複生成、Google 模型在此挖空 */
  exclusion: LatLon[];
  targets: TargetSpec[];
  create(): Instance;
}

function floorHeight(f: Floor, x: number, z: number): number | null {
  if (f.kind === 'rect') {
    if (Math.abs(x - f.cx) <= f.hw && Math.abs(z - f.cz) <= f.hd) return f.y;
    return null;
  }
  const along = f.axis === 'x' ? x : z;
  const across = f.axis === 'x' ? z : x;
  const [a0, a1] = [Math.min(f.from, f.to), Math.max(f.from, f.to)];
  if (along < a0 || along > a1 || Math.abs(across - f.center) > f.halfWidth) return null;
  const t = (along - f.from) / (f.to - f.from);
  const step = Math.min(f.steps - 1, Math.floor(t * f.steps));
  return f.y0 + ((step + 1) / f.steps) * (f.y1 - f.y0);
}

const around = (a: LatLon, pts: [number, number][]) => pts.map(([e, n]) => offsetLatLon(a, e, n));

export const LANDMARK_DEFS: LandmarkDef[] = [
  {
    id: 'cks',
    name: '中正紀念堂',
    anchor: CKS_ANCHOR,
    radius: 600,
    exclusion: CKS_EXCLUSION,
    targets: [{ id: 'cks-hall', label: '中正紀念堂', top: HALL.top, aimAt: 0.55, radius: 90 }],
    create() {
      const cks = buildCKS();
      return {
        group: cks.group,
        solids: [cks.buildings, cks.ground],
        trees: cks.trees,
        labels: cks.labels,
        fallbackOnly: [cks.roads],
        surface: (x, z) => {
          const { u, v } = localToSite(x, z);
          let y: number | null = null;
          for (const f of cks.floors) {
            const h = floorHeight(f, u, v);
            if (h !== null && (y === null || h > y)) y = h;
          }
          return y;
        },
      };
    },
  },
  {
    id: 'taipei101',
    name: '台北 101',
    anchor: LANDMARKS.taipei101,
    radius: 160,
    exclusion: around(LANDMARKS.taipei101, TAIPEI101_FOOTPRINT),
    targets: [{ id: 'taipei101', label: '台北 101', top: T101.spireTip, aimAt: 0.5, radius: 34 }],
    create() {
      const m = buildTaipei101();
      return { group: m.group, solids: [m.group], labels: [{ text: '台北 101', x: 0, z: 0 }] };
    },
  },
  {
    id: 'hallgrimskirkja',
    name: '哈爾格林姆教堂',
    anchor: HALLGRIMS_ANCHOR,
    radius: 120,
    exclusion: HALLGRIMS_MASK,
    targets: [{ id: 'hallgrimskirkja', label: '哈爾格林姆教堂', top: HALLGRIMS.towerTop, aimAt: 0.55, radius: 30 }],
    create() {
      const m = buildHallgrimskirkja();
      return { group: m.group, solids: [m.group], labels: m.labels };
    },
  },
  {
    id: 'rosenborg',
    name: '羅森堡宮',
    anchor: ROSENBORG_ANCHOR,
    radius: 100,
    exclusion: ROSENBORG_MASK,
    targets: [{ id: 'rosenborg', label: '羅森堡宮', top: ROSENBORG.towerTop, aimAt: 0.4, radius: 26 }],
    create() {
      const m = buildRosenborg();
      return { group: m.group, solids: [m.group], labels: m.labels };
    },
  },
  {
    id: 'nyhavn',
    name: '新港',
    anchor: NYHAVN_ANCHOR,
    radius: 240,
    exclusion: NYHAVN_MASK,
    targets: [{ id: 'nyhavn', label: '新港北岸屋列', top: NYHAVN.rowTop, aimAt: 0.45, radius: 12, dx: NYHAVN.dx, dz: NYHAVN.dz }],
    create() {
      const m = buildNyhavn();
      return { group: m.group, solids: [m.group], labels: m.labels };
    },
  },
];

interface Placed {
  def: LandmarkDef;
  inst: Instance;
  offset: THREE.Vector3;
  probedAt: number;
}

export interface LandmarkPolicy {
  range: number;
  near: number;
  /** Google 圖磚可用：自建模型只在近景接手 */
  google: boolean;
  /** 地面高度來源：地形（高程）與 Google 圖磚表面（取得不到時回傳 null） */
  terrainAt: (x: number, z: number) => number;
  googleAt?: (x: number, z: number) => number | null;
}

export class LandmarkLayer {
  readonly group = new THREE.Group();
  private cache = new Map<string, Instance>();
  private placed = new Map<string, Placed>();
  private treesVisible = true;
  version = 0;
  /** 目前需要挖空 Google 模型的範圍（場景座標） */
  masks: { x: number; z: number }[][] = [];

  constructor() {
    this.group.name = 'landmarks';
  }

  /** 是否落在任何地標範圍內（避免 OSM 建物與自建模型重疊） */
  excluded(p: LatLon): boolean {
    for (const d of LANDMARK_DEFS) {
      if (distanceLatLon(p, d.anchor) > d.radius * 1.6) continue;
      if (pointInRing(p, d.exclusion)) return true;
    }
    return false;
  }

  /** 依相機位置決定哪些地標以自建模型呈現 */
  update(eye: LatLon, p: LandmarkPolicy, force = false) {
    let changed = false;
    const now = performance.now();
    const masks: { x: number; z: number }[][] = [];
    for (const d of LANDMARK_DEFS) {
      const dist = distanceLatLon(eye, d.anchor);
      const want = dist < (p.google ? p.near : p.range) + d.radius;
      let has = this.placed.get(d.id);
      if (want && (!has || force)) {
        if (has) this.group.remove(has.inst.group);
        let inst = this.cache.get(d.id);
        if (!inst) {
          inst = d.create();
          this.cache.set(d.id, inst);
          if (inst.trees) inst.trees.visible = this.treesVisible;
        }
        const l = toLocal(d.anchor);
        has = { def: d, inst, offset: new THREE.Vector3(l.x, p.terrainAt(l.x, l.z), l.z), probedAt: -Infinity };
        this.group.add(inst.group);
        this.placed.set(d.id, has);
        changed = true;
      } else if (!want && has) {
        this.group.remove(has.inst.group);
        this.placed.delete(d.id);
        has = undefined;
        changed = true;
      }
      if (!has) continue;
      for (const o of has.inst.fallbackOnly ?? []) o.visible = !p.google;
      // Google 模式：底座高度對齊周圍 Google 地面，接縫才平整（圖磚持續載入，定期重算）
      if (p.google && p.googleAt) {
        if (now - has.probedAt > 2000) {
          has.probedAt = now;
          const y = this.probeGround(d, p.googleAt);
          if (y !== null && Math.abs(y - has.offset.y) > 0.25) {
            has.offset.y = y;
            changed = true;
          }
        }
      } else if (has.probedAt !== -Infinity) {
        has.offset.y = p.terrainAt(has.offset.x, has.offset.z);
        has.probedAt = -Infinity;
        changed = true;
      }
      has.inst.group.position.copy(has.offset);
      has.inst.group.updateMatrixWorld(true);
      if (p.google) masks.push(d.exclusion.map((q) => toLocal(q)));
    }
    this.masks = masks;
    if (changed) this.version++;
  }

  /** 沿遮罩外圍一圈取樣 Google 地面，取低百分位數（樹、車、建物只會讓表面偏高） */
  private probeGround(d: LandmarkDef, googleAt: (x: number, z: number) => number | null): number | null {
    const ring = d.exclusion.map((q) => toLocal(q));
    const cx = ring.reduce((s, q) => s + q.x, 0) / ring.length;
    const cz = ring.reduce((s, q) => s + q.z, 0) / ring.length;
    const ys: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      for (const t of [0, 0.5]) {
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const len = Math.hypot(x - cx, z - cz) || 1;
        const y = googleAt(x + ((x - cx) / len) * 14, z + ((z - cz) / len) * 14);
        if (y !== null) ys.push(y);
      }
    }
    if (ys.length < 3) return null;
    ys.sort((a, b) => a - b);
    return ys[Math.floor(ys.length * 0.3)];
  }

  setTrees(v: boolean) {
    this.treesVisible = v;
    for (const inst of this.cache.values()) if (inst.trees) inst.trees.visible = v;
  }

  /** (x, z) 是否在目前以自建模型呈現的地標範圍內 */
  activeAt(x: number, z: number): boolean {
    for (const p of this.placed.values()) {
      const ring = p.def.exclusion.map((q) => toLocal(q));
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  solids(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const p of this.placed.values()) {
      out.push(...p.inst.solids);
      if (p.inst.trees && this.treesVisible) out.push(p.inst.trees);
    }
    return out;
  }

  labels(eye: LatLon, range: number): MapLabel[] {
    const out: MapLabel[] = [];
    for (const d of LANDMARK_DEFS) {
      const p = this.placed.get(d.id);
      if (p) for (const l of p.inst.labels) out.push({ ...l, x: l.x + p.offset.x, z: l.z + p.offset.z });
      else if (distanceLatLon(eye, d.anchor) < range + d.radius) out.push({ text: d.name, ...toLocal(d.anchor) });
    }
    return out;
  }

  /** 可視範圍內所有地標的目標（不論是否以自建模型呈現） */
  targets(eye: LatLon, range: number, groundAt: (x: number, z: number) => number): Target[] {
    const out: Target[] = [];
    for (const d of LANDMARK_DEFS) {
      if (distanceLatLon(eye, d.anchor) > range + d.radius) continue;
      const p = this.placed.get(d.id);
      const l = toLocal(d.anchor);
      const y = p ? p.offset.y : groundAt(l.x, l.z);
      for (const t of d.targets) {
        const base = new THREE.Vector3(l.x + (t.dx ?? 0), y, l.z + (t.dz ?? 0));
        out.push({
          id: t.id,
          label: t.label,
          base,
          top: base.clone().setY(y + t.top),
          aimAt: t.aimAt,
          radius: t.radius,
          // 園區型地標（中正紀念堂、新港）範圍內的建物、船隻本身就可能擋住目標，不排除
          self: p && d.id !== 'cks' && d.id !== 'nyhavn' ? p.inst.group : undefined,
        });
      }
    }
    return out;
  }

  /** 自建模型的精確站立面（台基、台階、平台）；不在任何地標範圍時回傳 null */
  surfaceAt(x: number, z: number): number | null {
    let y: number | null = null;
    for (const p of this.placed.values()) {
      if (!p.inst.surface) continue;
      const h = p.inst.surface(x - p.offset.x, z - p.offset.z);
      if (h !== null && (y === null || h + p.offset.y > y)) y = h + p.offset.y;
    }
    return y;
  }
}
