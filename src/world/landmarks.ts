import * as THREE from 'three';
import { distanceLatLon, toLocal, offsetLatLon, type LatLon } from '../geo';
import { buildCKS, CKS_ANCHOR, CKS_EXCLUSION, HALL, localToSite, type Floor } from '../scene/cks';
import { buildTaipei101, T101 } from '../scene/taipei101';
import { LANDMARKS } from '../scene/landmarks';
import { M } from '../scene/materials';
import { applyRing, LANDMARK_RING } from '../scene/ringmask';
import { pointInRing } from './osm/parse';
import type { MapLabel, Target } from './types';

// 地標：手工程序化模型（中正紀念堂園區、台北 101），在可視範圍內時放進場景。
// 屬於「遠景」精細度；近景使用實景圖磚時，半徑內的部分會在 shader 中讓出。

for (const m of Object.values(M)) applyRing(m, 'far', LANDMARK_RING);

interface LocalTarget {
  id: string;
  label: string;
  base: THREE.Vector3;
  top: THREE.Vector3;
  aimAt: number;
  radius: number;
}

interface Instance {
  group: THREE.Group;
  solids: THREE.Object3D[];
  trees?: THREE.Object3D;
  labels: MapLabel[];
  targets: LocalTarget[];
  /** 區域座標（地標錨點為原點）的站立面高度 */
  surface?: (x: number, z: number) => number | null;
}

interface LandmarkDef {
  id: string;
  name: string;
  anchor: LatLon;
  /** 模型大致半徑（公尺） */
  radius: number;
  exclusion: LatLon[];
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

const box101 = (() => {
  const a = LANDMARKS.taipei101;
  const c = (e: number, n: number) => offsetLatLon(a, e, n);
  return [c(-60, 40), c(95, 40), c(95, -110), c(-60, -110)];
})();

export const LANDMARK_DEFS: LandmarkDef[] = [
  {
    id: 'cks',
    name: '中正紀念堂',
    anchor: CKS_ANCHOR,
    radius: 600,
    exclusion: CKS_EXCLUSION,
    create() {
      const cks = buildCKS();
      return {
        group: cks.group,
        solids: [cks.buildings],
        trees: cks.trees,
        labels: cks.labels,
        targets: [{ id: 'cks-hall', label: '中正紀念堂', base: new THREE.Vector3(0, 0, 0), top: new THREE.Vector3(0, HALL.top, 0), aimAt: 0.55, radius: 90 }],
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
    radius: 150,
    exclusion: box101,
    create() {
      const g = buildTaipei101();
      const group = new THREE.Group();
      group.add(g);
      return {
        group,
        solids: [g],
        labels: [{ text: '台北 101', x: 0, z: 0 }],
        targets: [{ id: 'taipei101', label: '台北 101', base: new THREE.Vector3(0, 0, 0), top: new THREE.Vector3(0, T101.spireTip, 0), aimAt: 0.5, radius: 34 }],
      };
    },
  },
];

interface Placed {
  def: LandmarkDef;
  inst: Instance;
  offset: THREE.Vector3;
}

export class LandmarkLayer {
  readonly group = new THREE.Group();
  private cache = new Map<string, Instance>();
  private placed = new Map<string, Placed>();
  version = 0;

  constructor(private heightAt: (x: number, z: number) => number) {
    this.group.name = 'landmarks';
  }

  /** 是否落在任何地標範圍內（避免 OSM 建物與手工模型重疊） */
  excluded(p: LatLon): boolean {
    for (const d of LANDMARK_DEFS) {
      if (distanceLatLon(p, d.anchor) > d.radius * 1.6) continue;
      if (pointInRing(p, d.exclusion)) return true;
    }
    return false;
  }

  /** 依相機位置決定要放進場景的地標 */
  update(eye: LatLon, range: number, force = false) {
    let changed = false;
    for (const d of LANDMARK_DEFS) {
      const want = distanceLatLon(eye, d.anchor) < range + d.radius;
      const has = this.placed.get(d.id);
      if (want && (!has || force)) {
        if (has) this.group.remove(has.inst.group);
        let inst = this.cache.get(d.id);
        if (!inst) {
          inst = d.create();
          this.cache.set(d.id, inst);
        }
        const l = toLocal(d.anchor);
        const offset = new THREE.Vector3(l.x, this.heightAt(l.x, l.z), l.z);
        inst.group.position.copy(offset);
        inst.group.updateMatrixWorld(true);
        this.group.add(inst.group);
        this.placed.set(d.id, { def: d, inst, offset });
        changed = true;
      } else if (!want && has) {
        this.group.remove(has.inst.group);
        this.placed.delete(d.id);
        changed = true;
      }
    }
    if (changed) this.version++;
  }

  setTrees(v: boolean) {
    for (const inst of this.cache.values()) if (inst.trees) inst.trees.visible = v;
  }

  /**
   * 近景使用實景圖磚時，陰影由圖磚負責；離相機近的地標不再投影，避免雙重陰影。
   */
  setShadowCasting(eye: THREE.Vector3, nearRadius: number, photoreal: boolean) {
    for (const p of this.placed.values()) {
      const d = Math.hypot(p.offset.x - eye.x, p.offset.z - eye.z);
      const cast = !photoreal || d > nearRadius + p.def.radius;
      p.inst.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = cast;
      });
    }
  }

  solids(treesVisible: boolean): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const p of this.placed.values()) {
      out.push(...p.inst.solids);
      if (p.inst.trees && treesVisible) out.push(p.inst.trees);
    }
    return out;
  }

  labels(): MapLabel[] {
    const out: MapLabel[] = [];
    for (const p of this.placed.values())
      for (const l of p.inst.labels) out.push({ ...l, x: l.x + p.offset.x, z: l.z + p.offset.z });
    return out;
  }

  targets(): Target[] {
    const out: Target[] = [];
    for (const p of this.placed.values())
      for (const t of p.inst.targets)
        out.push({ id: t.id, label: t.label, base: t.base.clone().add(p.offset), top: t.top.clone().add(p.offset), aimAt: t.aimAt, radius: t.radius, self: p.def.id === 'taipei101' ? p.inst.group : undefined });
    return out;
  }

  /** 手工模型的站立面（台基、台階、平台）；不在任何地標範圍時回傳 null */
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
