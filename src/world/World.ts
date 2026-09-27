import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { getOrigin, setOrigin, toLatLon, type LatLon } from '../geo';
import { googleKey } from '../config';
import { Environment } from '../scene/environment';
import { FAR_RING, LANDMARK_RING, NEAR_RING, ringEye } from '../scene/ringmask';
import { LandmarkLayer } from './landmarks';
import { OsmLayer, type OsmStatus } from './osm/OsmLayer';
import { NamedTargets } from './osm/named';
import { PhotorealLayer } from './photoreal';
import { TerrainLayer } from './terrain';
import type { MapLabel, Target } from './types';

// 大量網格的射線偵測（遮擋判定、站立面）改用 BVH 加速
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

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
 * 場景總成：環境光線、地形、地標手工模型（遠景）、OSM 程序化建物（遠景／近景備援）、
 * Google 實景 3D 圖磚（近景）。原點改變時整體重建。
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly env: Environment;
  readonly terrain = new TerrainLayer();
  readonly landmarks: LandmarkLayer;
  readonly osm: OsmLayer;
  readonly photoreal: PhotorealLayer | null;
  readonly named = new NamedTargets();
  private namedCache: Target[] = [];
  private namedVersion = -1;
  /** 內容改變時遞增，視圖據此重新渲染 */
  version = 0;
  private terrainState: WorldStatus['terrain'] = 'loading';
  private treesVisible = true;
  private photorealOn = false;
  private near = 1000;
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
    this.landmarks = new LandmarkLayer(heightAt);
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
    const ok = await this.terrain.load(rangeM);
    if (token !== this.rebaseToken) return;
    this.terrainState = ok ? 'ready' : 'flat';
    this.landmarks.update(origin, rangeM, true);
    this.osm.rebase();
    this.photoreal?.setGroundReference(ok ? (x, z) => this.terrain.heightAt(x, z) : null);
    this.rebasing = false;
    this.version++;
    this.named.load(origin, rangeM, (p) => this.landmarks.excluded(p)).then(() => this.version++);
  }

  /** 可視範圍改變時地形要涵蓋更大範圍 */
  async reloadTerrain(rangeM: number) {
    await this.rebase(getOrigin(), rangeM);
  }

  get photorealActive(): boolean {
    return this.photorealOn;
  }

  /** 每幀呼叫：依相機更新近／遠景內容 */
  update(v: ViewParams, cameras: { camera: THREE.Camera; renderer: THREE.WebGLRenderer }[]) {
    this.near = v.near;
    this.photorealOn = Boolean(v.photoreal && this.photoreal && !this.photoreal.failed);
    ringEye.copy(v.eye);
    // 近景內容就緒後，遠景與地標才讓出近景範圍（避免載入期間出現空洞）
    const photoReady = this.photorealOn && Boolean(this.photoreal?.calibrated);
    const nearReady = photoReady || (!this.photorealOn && this.osm.nearComplete());
    FAR_RING.uRingCut.value = nearReady ? v.near : 0;
    NEAR_RING.uRingCut.value = v.near;
    LANDMARK_RING.uRingCut.value = photoReady ? v.near : 0;

    const eyeLL = toLatLon(v.eye.x, v.eye.z);
    if (this.terrain.ready) this.landmarks.update(eyeLL, v.range);
    this.landmarks.setShadowCasting(v.eye, v.near, this.photorealOn);

    this.osm.nearEnabled = !this.photorealOn;
    this.osm.update(eyeLL, v.azimuth, v.hfov, v.range, v.near);
    this.osm.frame();

    if (this.photoreal) {
      this.photoreal.root.visible = this.photorealOn;
      if (this.photorealOn) {
        this.photoreal.setCameras(cameras);
        this.photoreal.update(v.eye, v.near);
      }
    }
    if (this.env.setFocus(v.eye)) this.version++;

    const versions = `${this.osm.version}|${this.landmarks.version}|${this.photorealOn}`;
    if (versions !== this.lastVersions) {
      this.lastVersions = versions;
      this.version++;
    }
  }

  setTrees(v: boolean) {
    this.treesVisible = v;
    this.landmarks.setTrees(v);
    this.version++;
  }

  setRelight(v: boolean) {
    this.photoreal?.setRelight(v);
  }

  /** 會遮擋視線的物件 */
  occluders(): THREE.Object3D[] {
    const list = [...this.landmarks.solids(this.treesVisible), ...this.osm.solids];
    if (this.photorealOn && this.photoreal) list.push(this.photoreal.tiles.group);
    return list;
  }

  targets(): Target[] {
    if (this.named.version !== this.namedVersion) {
      this.namedVersion = this.named.version;
      this.namedCache = this.named.targets((x, z) => this.terrain.heightAt(x, z));
    }
    const out = this.landmarks.targets();
    const seen = new Set(out.map((t) => t.label));
    for (const t of [...this.namedCache, ...this.osm.targets]) {
      if (seen.has(t.label)) continue;
      seen.add(t.label);
      out.push(t);
    }
    return out;
  }

  labels(): MapLabel[] {
    const out = this.landmarks.labels();
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
  surfaceAt(x: number, z: number, fromY = Infinity, eye?: THREE.Vector3): { y: number; solid: boolean } {
    const terrain = this.terrain.heightAt(x, z);
    const start = Number.isFinite(fromY) ? fromY : terrain + 3000;
    const rc = new THREE.Raycaster(new THREE.Vector3(x, start, z), new THREE.Vector3(0, -1, 0), 0, start - terrain + 60);
    rc.firstHitOnly = true;
    const pick = (hits: THREE.Intersection[]) => (hits.length ? hits[0].point.y : null);
    const inNear = !eye || Math.hypot(x - eye.x, z - eye.z) < this.near;
    if (this.photorealOn && this.photoreal && inNear) {
      if (!this.photoreal.calibrated) return { y: terrain, solid: false };
      const y = pick(this.photoreal.raycast(rc));
      return y === null ? { y: terrain, solid: false } : { y, solid: true };
    }
    let y = terrain;
    let solid = this.terrain.ready;
    const lm = this.landmarks.surfaceAt(x, z);
    if (lm !== null && lm <= start + 0.01) y = Math.max(y, lm);
    const hy = pick(rc.intersectObjects(this.osm.solids, false));
    if (hy !== null && lm === null) y = Math.max(y, hy);
    if (hy !== null) solid = true;
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
