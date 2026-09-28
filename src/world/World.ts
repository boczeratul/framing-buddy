import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { curvatureDrop, getOrigin, setOrigin, toLatLon, type LatLon } from '../geo';
import { googleKey } from '../config';
import { Environment } from '../scene/environment';
import { FAR_RING, NEAR_RING, ringEye } from '../scene/ringmask';
import { LandmarkLayer } from './landmarks';
import { OsmLayer, type OsmStatus } from './osm/OsmLayer';
import { NamedTargets } from './osm/named';
import { PhotorealLayer } from './photoreal';
import { HORIZON, TerrainLayer } from './terrain';
import { PeakTargets } from './peaks';
import { MountainLayer } from './mountains';
import { setMasks } from '../scene/regionmask';
import type { MapLabel, Target } from './types';

// 大量網格的射線偵測（遮擋判定、站立面）改用 BVH 加速。
// BVH 在射線第一次經過該網格的包圍球時才建立，避免每塊圖磚載入時都付出成本。
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
const _sphere = new THREE.Sphere();
THREE.Mesh.prototype.raycast = function (this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
  const g = this.geometry;
  if (!g.boundsTree && g.getAttribute('position')) {
    if (!g.boundingSphere) g.computeBoundingSphere();
    _sphere.copy(g.boundingSphere!).applyMatrix4(this.matrixWorld);
    if (!raycaster.ray.intersectsSphere(_sphere)) return;
    g.computeBoundsTree();
  }
  acceleratedRaycast.call(this, raycaster, intersects);
};

export interface WorldStatus {
  terrain: 'loading' | 'ready' | 'flat';
  photoreal: 'off' | 'loading' | 'ready' | 'error';
  photorealError: string | null;
  osm: OsmStatus;
}

export interface ViewParams {
  eye: THREE.Vector3;
  azimuth: number;
  hfov: number;
  /** 遠景範圍（公尺） */
  range: number;
  /** 近景半徑（公尺） */
  near: number;
  photoreal: boolean;
}

/**
 * 場景總成。有 Google 圖磚時：近景優先使用自建精細模型（地標），其餘近景與全部遠景使用 Google；
 * 沒有 Google 時：地標自建模型＋OSM 程序化建物（遠景高樓、近景精細建物）＋高程地形。
 * 原點改變時整體重建。
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly env: Environment;
  readonly terrain = new TerrainLayer();
  readonly landmarks: LandmarkLayer;
  readonly osm: OsmLayer;
  readonly photoreal: PhotorealLayer | null;
  readonly named = new NamedTargets();
  readonly peaks = new PeakTargets();
  readonly mountains: MountainLayer;
  private namedCache: Target[] = [];
  private namedVersion = '';
  /** 內容改變時遞增，視圖據此重新渲染 */
  version = 0;
  private terrainState: WorldStatus['terrain'] = 'loading';
  private photorealOn = false;
  private near = 1000;
  private range = 6000;
  private eyeLL: LatLon = getOrigin();
  private rebaseToken = 0;
  /** 換原點進行中（地形、地標尚未就緒） */
  rebasing = false;
  private lastVersions = '';

  constructor() {
    this.env = new Environment(this.scene);
    // 天空環境光只當補光：實際晴天水平面上日光約為天光的 4–5 倍
    this.scene.environmentIntensity = 0.35;
    this.scene.add(this.terrain.group);

    const heightAt = (x: number, z: number) => this.terrain.heightAt(x, z);
    this.mountains = new MountainLayer(this.env.sunDir, this.env.sunUniforms);
    this.scene.add(this.mountains.group);
    this.landmarks = new LandmarkLayer();
    this.scene.add(this.landmarks.group);

    this.osm = new OsmLayer({
      heightAt,
      excluded: (p) => this.landmarks.excluded(p),
      ready: () => this.terrain.ready,
    });
    this.scene.add(this.osm.group);

    const key = googleKey();
    this.photoreal = key ? new PhotorealLayer(key, getOrigin()) : null;
    if (this.photoreal) {
      this.scene.add(this.photoreal.root);
      this.photoreal.onChange = () => this.version++;
    }
  }

  /** 換原點：地形重抓、地標與 OSM 依新原點重建、實景圖磚重新定位 */
  async rebase(origin: LatLon, rangeM: number) {
    const token = ++this.rebaseToken;
    this.rebasing = true;
    setOrigin(origin);
    this.terrainState = 'loading';
    this.osm.rebase();
    this.photoreal?.setOrigin(origin);
    const ok = await this.terrain.load();
    if (token !== this.rebaseToken) return;
    this.terrainState = ok ? 'ready' : 'flat';
    if (!(import.meta.env.DEV && location.search.includes('nolm'))) this.landmarks.update(origin, this.landmarkPolicy(), true);
    this.osm.rebase();
    this.photoreal?.setGroundReference(ok ? (x, z) => this.terrain.heightAt(x, z) : null);
    this.rebasing = false;
    this.version++;
    this.named.load(origin, rangeM, (p) => this.landmarks.excluded(p)).then(() => this.version++);
    // 地平線內的主要山峰（例如從河口湖、山中湖望向富士山）
    this.peaks
      .load(origin, HORIZON, this.terrain.originElevation)
      .then(() => this.mountains.load(this.peaks.list, origin, this.terrain.originElevation))
      .then(() => {
        if (token !== this.rebaseToken) return;
        this.terrain.setSinks(this.mountains.sinks());
        this.version++;
      });
  }

  /** 遠景範圍改變：重新查詢範圍內有名稱的高樓（地形與 Google 模型本來就載入到地平線） */
  setRange(rangeM: number) {
    this.named.load(getOrigin(), rangeM, (p) => this.landmarks.excluded(p)).then(() => this.version++);
  }

  /** 日期改變時更新雪線 */
  setSeason(month: number) {
    this.mountains.setSeason(month, getOrigin().lat);
    this.terrain.setSeason(month, getOrigin().lat);
    this.version++;
  }

  get photorealActive(): boolean {
    return this.photorealOn;
  }

  private landmarkPolicy() {
    const p = this.photoreal;
    return {
      range: this.range,
      near: this.near,
      google: this.photorealOn,
      terrainAt: (x: number, z: number) => this.terrain.heightAt(x, z),
      googleAt:
        p && this.photorealOn
          ? (x: number, z: number) => {
              if (!p.calibrated) return null;
              const rc = new THREE.Raycaster(new THREE.Vector3(x, this.terrain.heightAt(x, z) + 2000, z), new THREE.Vector3(0, -1, 0), 0, 2200);
              rc.firstHitOnly = true;
              return p.raycast(rc)[0]?.point.y ?? null;
            }
          : undefined,
    };
  }

  /** 每幀呼叫：依相機更新近／遠景內容 */
  update(v: ViewParams, cameras: { camera: THREE.Camera; renderer: THREE.WebGLRenderer }[]) {
    this.near = v.near;
    this.range = v.range;
    this.photorealOn = Boolean(v.photoreal && this.photoreal && !this.photoreal.failed);
    const google = this.photorealOn;
    const photoReady = google && Boolean(this.photoreal?.calibrated);
    this.eyeLL = toLatLon(v.eye.x, v.eye.z);

    // 沒有 Google 時：OSM 近景精細建物就緒後，遠景高樓才讓出近景範圍（避免空洞）
    ringEye.copy(v.eye);
    FAR_RING.uRingCut.value = !google && this.osm.nearComplete() ? v.near : 0;
    NEAR_RING.uRingCut.value = v.near;
    // Google 圖磚含地形；載入完成前先顯示高程地形當地面
    this.terrain.group.visible = !photoReady;

    // 開發用：網址加 ?nolm 可暫停自建模型，直接看 Google 模型
    const noLandmarks = import.meta.env.DEV && location.search.includes('nolm');
    if (this.terrain.ready && !this.rebasing && !noLandmarks) this.landmarks.update(this.eyeLL, this.landmarkPolicy());
    // Google 模型挖空：近景自建地標＋精細山體（最多 4 塊）
    setMasks(google ? [...this.mountains.masks(), ...this.landmarks.masks] : []);

    this.osm.farMode = google ? 'names' : 'mesh';
    this.osm.nearEnabled = !google;
    this.osm.update(this.eyeLL, v.azimuth, v.hfov, v.range, v.near);
    this.osm.frame();

    if (this.photoreal) {
      this.photoreal.root.visible = google;
      if (google) {
        this.photoreal.setCameras(cameras);
        // Google 模型一律載入到地平線：遠方的山（例如富士山）也要看得到
        this.photoreal.update(v.eye, HORIZON);
      }
    }
    if (this.env.setFocus(v.eye)) this.version++;

    const versions = `${this.osm.version}|${this.landmarks.version}|${this.mountains.version}|${google}`;
    if (versions !== this.lastVersions) {
      this.lastVersions = versions;
      this.version++;
    }
  }

  setTrees(v: boolean) {
    this.landmarks.setTrees(v);
    this.version++;
  }

  setRelight(v: boolean) {
    this.photoreal?.setRelight(v);
  }

  /** 會遮擋視線的物件 */
  occluders(): THREE.Object3D[] {
    const list = [...this.landmarks.solids(), ...this.osm.solids, ...this.mountains.solids()];
    if (this.photorealOn && this.photoreal) list.push(this.photoreal.occluder);
    return list;
  }

  targets(): Target[] {
    const versions = `${this.named.version}|${this.peaks.version}`;
    if (versions !== this.namedVersion) {
      this.namedVersion = versions;
      this.namedCache = [
        ...this.peaks.targets(this.terrain.originElevation, (x, z) => curvatureDrop(Math.hypot(x, z))),
        ...this.named.targets((x, z) => this.terrain.heightAt(x, z)),
      ];
    }
    const out = this.landmarks.targets(this.eyeLL, this.range, (x, z) => this.terrain.heightAt(x, z));
    const seen = new Set(out.map((t) => t.label));
    for (const t of [...this.namedCache, ...this.osm.targets]) {
      if (seen.has(t.label)) continue;
      seen.add(t.label);
      out.push(t);
    }
    return out;
  }

  labels(): MapLabel[] {
    const out = this.landmarks.labels(this.eyeLL, this.range);
    const seen = new Set(out.map((l) => l.text));
    for (const t of this.targets()) if (!seen.has(t.label)) out.push({ text: t.label, x: t.base.x, z: t.base.z });
    return out;
  }

  /**
   * 站立面高度：從 fromY 往下找第一個表面。
   * - 小步移動：fromY＝目前高度上方 2.5 m，可以走上台階、不會跳到頭頂的屋簷或樹冠上。
   * - 瞬間移動（fromY = Infinity）：從高空往下，落在最上層的表面（點在建物上就站上屋頂）。
   *   實景模型是攝影測量網格，同一點常有多層內部表面，所以只取最上層才可靠。
   * solid＝確實打到模型（模型尚未載入時為 false，呼叫端應稍後重算）。
   */
  surfaceAt(x: number, z: number, fromY = Infinity, _eye?: THREE.Vector3): { y: number; solid: boolean } {
    const terrain = this.terrain.heightAt(x, z);
    const start = Number.isFinite(fromY) ? fromY : terrain + 3000;
    const rc = new THREE.Raycaster(new THREE.Vector3(x, start, z), new THREE.Vector3(0, -1, 0), 0, start - terrain + 60);
    rc.firstHitOnly = true;

    // 自建模型範圍內：台基台階等精確站立面優先，其次是模型表面
    if (this.landmarks.activeAt(x, z)) {
      const lm = this.landmarks.surfaceAt(x, z);
      if (lm !== null && lm <= start + 0.01) return { y: lm, solid: true };
      const hit = rc.intersectObjects(this.landmarks.solids(), true)[0];
      if (hit) return { y: hit.point.y, solid: true };
    }
    if (this.photorealOn && this.photoreal) {
      if (!this.photoreal.calibrated) return { y: terrain, solid: false };
      if (Number.isFinite(fromY)) {
        const hit = this.photoreal.raycast(rc)[0];
        return hit ? { y: hit.point.y, solid: true } : { y: terrain, solid: false };
      }
      // 瞬間移動：實景模型是 2.5D 表面（樹冠、屋頂下方沒有地面），而 DEM 在陡坡上可能差十幾公尺，
      // 所以一律站在實景表面上，避免相機落到模型內部。若該點是樹冠，改找周圍 5 m 內樹冠間隙露出的地面。
      const top = (px: number, pz: number) => {
        rc.set(new THREE.Vector3(px, start, pz), new THREE.Vector3(0, -1, 0));
        return this.photoreal!.raycast(rc)[0]?.point.y ?? null;
      };
      const here = top(x, z);
      if (here === null) return { y: terrain, solid: false };
      let low = here;
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const y = top(x + Math.cos(a) * 5, z + Math.sin(a) * 5);
        if (y !== null) low = Math.min(low, y);
      }
      rc.set(new THREE.Vector3(x, start, z), new THREE.Vector3(0, -1, 0));
      return { y: here - low > 6 && low > terrain - 25 ? low : here, solid: true };
    }
    let y = terrain;
    let solid = this.terrain.ready;
    const lm = this.landmarks.surfaceAt(x, z);
    if (lm !== null && lm <= start + 0.01) y = Math.max(y, lm);
    const hit = rc.intersectObjects(this.osm.solids, false)[0];
    if (hit && lm === null) y = Math.max(y, hit.point.y);
    if (hit) solid = true;
    return { y, solid };
  }

  status(): WorldStatus {
    const p = this.photoreal;
    return {
      terrain: this.terrainState,
      photoreal: !p || !this.photorealOn ? (p?.failed ? 'error' : 'off') : p.calibrated ? 'ready' : 'loading',
      photorealError: p?.failed ?? null,
      osm: this.osm.status(),
    };
  }

  attributions(): string {
    const parts: string[] = [];
    if (this.photorealOn && this.photoreal) {
      const a = this.photoreal.attributions();
      parts.push(`Google${a ? ` · ${a}` : ''}`);
    }
    parts.push('© OpenStreetMap contributors');
    return parts.join('　');
  }
}
