import * as THREE from 'three';
import { curvatureDrop, toLatLon } from '../geo';
import { loadGoogle, hasGoogle } from '../google';
import { M } from '../scene/materials';

// 地形：以 Google Elevation 服務取兩層高程網格（內圈較密、外圈涵蓋整個可視範圍），
// 合成一張不等間距的網格。場景 y＝0 定義為原點地面海拔；遠處再扣掉地球曲率下沉。
// 沒有金鑰時為平面。

interface Grid {
  half: number;
  n: number;
  /** n×n，列優先（z 由北到南、x 由西到東），相對原點海拔 */
  h: Float32Array;
}

const INNER = { half: 2000, n: 25 };
const OUTER_N = 33;

export class TerrainLayer {
  readonly group = new THREE.Group();
  /** 原點地面的海拔（公尺） */
  originElevation = 0;
  ready = false;
  private inner: Grid | null = null;
  private outer: Grid | null = null;
  private token = 0;

  constructor() {
    this.group.name = 'terrain';
  }

  /** 重新載入（原點或範圍改變時）；回傳是否成功取得高程 */
  async load(radius: number): Promise<boolean> {
    const token = ++this.token;
    this.ready = false;
    this.clear();
    if (!hasGoogle()) {
      this.inner = this.outer = null;
      this.build(radius);
      this.ready = true;
      return false;
    }
    try {
      const { ElevationService } = await loadGoogle('elevation');
      const svc = new ElevationService();
      const outerHalf = Math.max(radius * 1.25, INNER.half * 2);
      const specs = [
        { half: INNER.half, n: INNER.n },
        { half: outerHalf, n: OUTER_N },
      ];
      const pts: google.maps.LatLngLiteral[] = [];
      for (const g of specs)
        for (let j = 0; j < g.n; j++)
          for (let i = 0; i < g.n; i++) {
            const x = -g.half + (2 * g.half * i) / (g.n - 1);
            const z = -g.half + (2 * g.half * j) / (g.n - 1);
            const p = toLatLon(x, z);
            pts.push({ lat: p.lat, lng: p.lon });
          }
      const heights: number[] = [];
      // 金鑰無效時服務可能永遠不回應，加上逾時
      const timeout = <T>(p: Promise<T>) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('高程服務逾時')), 10000))]);
      for (let k = 0; k < pts.length; k += 500) {
        const res = await timeout(svc.getElevationForLocations({ locations: pts.slice(k, k + 500) }));
        for (const r of res.results) heights.push(r.elevation);
        if (token !== this.token) return false;
      }
      const n0 = INNER.n * INNER.n;
      const center = heights[Math.floor(n0 / 2)];
      this.originElevation = center;
      const toGrid = (g: { half: number; n: number }, from: number): Grid => ({
        half: g.half,
        n: g.n,
        h: Float32Array.from(heights.slice(from, from + g.n * g.n), (v) => v - center),
      });
      this.inner = toGrid(specs[0], 0);
      this.outer = toGrid(specs[1], n0);
      this.build(radius);
      this.ready = true;
      return true;
    } catch (e) {
      console.warn('[terrain] 高程取得失敗，改用平面', e);
      if (token !== this.token) return false;
      this.inner = this.outer = null;
      this.build(radius);
      this.ready = true;
      return false;
    }
  }

  /** 地形高度（場景 y，已含曲率下沉） */
  heightAt(x: number, z: number): number {
    return this.rawHeight(x, z) - curvatureDrop(Math.hypot(x, z));
  }

  private rawHeight(x: number, z: number): number {
    const g = this.inner && Math.abs(x) <= this.inner.half && Math.abs(z) <= this.inner.half ? this.inner : this.outer;
    if (!g) return 0;
    const fx = ((Math.min(Math.max(x, -g.half), g.half) + g.half) / (2 * g.half)) * (g.n - 1);
    const fz = ((Math.min(Math.max(z, -g.half), g.half) + g.half) / (2 * g.half)) * (g.n - 1);
    const i = Math.min(g.n - 2, Math.floor(fx));
    const j = Math.min(g.n - 2, Math.floor(fz));
    const tx = fx - i;
    const tz = fz - j;
    const at = (a: number, b: number) => g.h[b * g.n + a];
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz;
  }

  private clear() {
    for (const c of this.group.children) (c as THREE.Mesh).geometry?.dispose();
    this.group.clear();
  }

  /** 不等間距網格：內圈細、外圈粗，外面再接一圈平地延伸到地平線 */
  private build(radius: number) {
    const outerHalf = this.outer?.half ?? Math.max(radius * 1.25, INNER.half * 2);
    const lines = new Set<number>();
    const coarse = 32;
    for (let i = 0; i <= coarse; i++) lines.add(Math.round(-outerHalf + (2 * outerHalf * i) / coarse));
    const fine = 40;
    for (let i = 0; i <= fine; i++) lines.add(Math.round(-INNER.half + (2 * INNER.half * i) / fine));
    const axis = [...lines].sort((a, b) => a - b);
    const n = axis.length;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = axis[i];
        const z = axis[j];
        const k = j * n + i;
        pos.set([x, this.heightAt(x, z) - 0.3, z], k * 3);
        uv.set([x / 60, -z / 60], k * 2);
      }
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, M.urban);
    mesh.receiveShadow = true;
    mesh.name = 'terrain-grid';
    this.group.add(mesh);

    // 地平線外的平地（避免看到天空盒下半部）
    const ring = new THREE.Mesh(new THREE.RingGeometry(outerHalf * 0.9, 80000, 64, 1).rotateX(-Math.PI / 2), M.urban);
    ring.position.y = -curvatureDrop(outerHalf) - 2;
    this.group.add(ring);
  }
}
