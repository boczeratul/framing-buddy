import * as THREE from 'three';
import { curvatureDrop, toLatLon } from '../geo';
import { snowLine } from './season';

// 地形：AWS Terrain Tiles（Mapzen Terrarium 編碼的全球 DEM，免金鑰、支援 CORS）。
// 分三圈精細度，涵蓋到地平線（約 90 km），遠方的山（例如從河口湖看富士山）才看得到：
//   內圈 ±6 km：100 m 網格（DEM z12，約 30 m／像素）
//   中圈 ±25 km：400 m 網格（DEM z10）
//   外圈 ±90 km：1.5 km 網格（DEM z8）
// 場景 y＝0 為原點地面海拔；遠處再扣掉地球曲率下沉。有 Google 實景圖磚時，此地形只在圖磚載入前暫代地面。

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const HORIZON = 90000;

interface Level {
  half: number;
  step: number;
  zoom: number;
}

const LEVELS: Level[] = [
  { half: 6000, step: 100, zoom: 12 },
  { half: 25000, step: 400, zoom: 10 },
  { half: HORIZON, step: 1500, zoom: 8 },
];

interface Grid {
  half: number;
  n: number;
  /** n×n，列優先（z 由北到南、x 由西到東），海拔（公尺） */
  h: Float32Array;
}

// ---- DEM 圖磚 ----

const DEG = Math.PI / 180;
const demCache = new Map<string, Promise<Float32Array | null>>();

function demTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  let p = demCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(DEM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
        if (!r.ok) return null;
        const bmp = await createImageBitmap(await r.blob());
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, 256, 256).data;
        const out = new Float32Array(256 * 256);
        for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        return out;
      } catch {
        return null;
      }
    })();
    demCache.set(key, p);
  }
  return p;
}

/** 經緯度 → 指定縮放等級的全域像素座標 */
function pixelOf(lat: number, lon: number, z: number): [number, number] {
  const n = 256 * 2 ** z;
  const r = lat * DEG;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}

/** 取樣一個縮放等級的 DEM：先下載涵蓋範圍內所有圖磚，再逐點雙線性內插 */
export async function sampleDEM(points: { lat: number; lon: number }[], z: number): Promise<Float32Array> {
  const px = points.map((p) => pixelOf(p.lat, p.lon, z));
  const tiles = new Map<string, Promise<Float32Array | null>>();
  for (const [x, y] of px) {
    const tx = Math.floor(x / 256);
    const ty = Math.floor(y / 256);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const k = `${tx + dx}/${ty + dy}`;
      if (!tiles.has(k)) tiles.set(k, demTile(z, tx + dx, ty + dy));
    }
  }
  const loaded = new Map<string, Float32Array | null>();
  await Promise.all([...tiles].map(async ([k, p]) => loaded.set(k, await p)));
  if (![...loaded.values()].some(Boolean)) throw new Error('DEM 圖磚無法取得');
  const at = (gx: number, gy: number): number => {
    const t = loaded.get(`${Math.floor(gx / 256)}/${Math.floor(gy / 256)}`);
    if (!t) return 0;
    return t[(gy & 255) * 256 + (gx & 255)];
  };
  const out = new Float32Array(points.length);
  px.forEach(([x, y], i) => {
    const x0 = Math.floor(x - 0.5);
    const y0 = Math.floor(y - 0.5);
    const fx = x - 0.5 - x0;
    const fy = y - 0.5 - y0;
    const v = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    out[i] = Math.max(v, -50); // 海面（負值多為海底測深）
  });
  return out;
}

// ---- 地形圖層 ----

export class TerrainLayer {
  readonly group = new THREE.Group();
  /** 原點地面的海拔（公尺） */
  originElevation = 0;
  ready = false;
  private grids: Grid[] = [];
  private token = 0;
  private material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  private snowLine = 3000;
  /** 由精細山體取代的範圍：地形往下壓，避免重疊 */
  private sinks: { x: number; z: number; r: number }[] = [];

  constructor() {
    this.group.name = 'terrain';
  }

  /** 依季節設定雪線；回傳是否需要重建 */
  setSeason(month: number, lat: number): boolean {
    const line = Math.round(snowLine(month, lat) / 50) * 50;
    if (line === this.snowLine) return false;
    this.snowLine = line;
    if (this.ready) this.build();
    return true;
  }

  setSinks(sinks: { x: number; z: number; r: number }[]) {
    this.sinks = sinks;
    if (this.ready) this.build();
  }

  /** 重新載入（原點改變時）；回傳是否成功取得高程 */
  async load(): Promise<boolean> {
    const token = ++this.token;
    this.ready = false;
    try {
      const grids: Grid[] = [];
      for (const lv of LEVELS) {
        const n = Math.round((2 * lv.half) / lv.step) + 1;
        const pts: { lat: number; lon: number }[] = [];
        for (let j = 0; j < n; j++)
          for (let i = 0; i < n; i++) pts.push(toLatLon(-lv.half + i * lv.step, -lv.half + j * lv.step));
        const h = await sampleDEM(pts, lv.zoom);
        if (token !== this.token) return false;
        grids.push({ half: lv.half, n, h });
      }
      const inner = grids[0];
      this.originElevation = inner.h[Math.floor((inner.n * inner.n) / 2)];
      this.grids = grids;
      this.sinks = [];
      this.build();
      this.ready = true;
      return true;
    } catch (e) {
      console.warn('[terrain] 地形載入失敗，改用平面', e);
      if (token !== this.token) return false;
      this.grids = [];
      this.originElevation = 0;
      this.build();
      this.ready = true;
      return false;
    }
  }

  /** 地形高度（場景 y：相對原點地面，已含曲率下沉） */
  heightAt(x: number, z: number): number {
    return this.elevationAt(x, z) - this.originElevation - curvatureDrop(Math.hypot(x, z));
  }

  /** 海拔（公尺），取涵蓋該點的最精細網格 */
  elevationAt(x: number, z: number): number {
    const g = this.grids.find((gr) => Math.abs(x) <= gr.half && Math.abs(z) <= gr.half) ?? this.grids[this.grids.length - 1];
    if (!g) return this.originElevation;
    const step = (2 * g.half) / (g.n - 1);
    const fx = (Math.min(Math.max(x, -g.half), g.half) + g.half) / step;
    const fz = (Math.min(Math.max(z, -g.half), g.half) + g.half) / step;
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

  private colorOf(ele: number, slope: number, out: THREE.Color) {
    if (ele <= 0.5) return out.setRGB(0.16, 0.24, 0.3); // 海面
    if (ele > this.snowLine + (slope > 0.9 ? 300 : 0)) return out.setRGB(0.92, 0.93, 0.95);
    const rock = new THREE.Color(0.42, 0.38, 0.34);
    out.setRGB(0.36, 0.42, 0.28).lerp(new THREE.Color(0.3, 0.36, 0.24), Math.min(1, ele / 1500));
    out.lerp(rock, Math.min(1, Math.max(0, (ele - 1500) / 1200)));
    return out.lerp(rock, Math.min(1, slope * 0.6));
  }

  /** 三圈網格：外圈略過內圈範圍，交界處外圈往下壓一點，避免重疊閃爍 */
  private build() {
    this.clear();
    if (!this.grids.length) {
      const g = new THREE.CircleGeometry(HORIZON * 1.5, 64).rotateX(-Math.PI / 2);
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(0.5), 3));
      const flat = new THREE.Mesh(g, this.material);
      flat.position.y = -0.3;
      flat.receiveShadow = true;
      this.group.add(flat);
      return;
    }
    const c = new THREE.Color();
    this.grids.forEach((g, level) => {
      const inner = level > 0 ? this.grids[level - 1].half : 0;
      const step = (2 * g.half) / (g.n - 1);
      const pos = new Float32Array(g.n * g.n * 3);
      const col = new Float32Array(g.n * g.n * 3);
      for (let j = 0; j < g.n; j++)
        for (let i = 0; i < g.n; i++) {
          const x = -g.half + i * step;
          const z = -g.half + j * step;
          const k = j * g.n + i;
          const ele = g.h[k];
          const dx = (g.h[j * g.n + Math.min(g.n - 1, i + 1)] - g.h[j * g.n + Math.max(0, i - 1)]) / (2 * step);
          const dz = (g.h[Math.min(g.n - 1, j + 1) * g.n + i] - g.h[Math.max(0, j - 1) * g.n + i]) / (2 * step);
          const insideInner = inner > 0 && Math.abs(x) < inner + step && Math.abs(z) < inner + step;
          const sunk = this.sinks.some((k) => Math.hypot(x - k.x, z - k.z) < k.r + step) ? 120 : 0;
          const y = ele - this.originElevation - curvatureDrop(Math.hypot(x, z)) - (insideInner ? 6 + step * 0.01 : 0) - 0.3 - sunk;
          pos.set([x, y, z], k * 3);
          this.colorOf(ele, Math.hypot(dx, dz), c);
          col.set([c.r, c.g, c.b], k * 3);
        }
      const idx: number[] = [];
      const skip = inner - step;
      for (let j = 0; j < g.n - 1; j++)
        for (let i = 0; i < g.n - 1; i++) {
          const x0 = -g.half + i * step;
          const z0 = -g.half + j * step;
          if (inner > 0 && x0 >= -skip && x0 + step <= skip && z0 >= -skip && z0 + step <= skip) continue;
          const a = j * g.n + i;
          const b = a + 1;
          const d = a + g.n;
          idx.push(a, d, b, b, d, d + 1);
        }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.receiveShadow = level === 0;
      mesh.name = `terrain-${level}`;
      this.group.add(mesh);
    });
    // 地平線外：海平面高度的平面
    const ringGeo = new THREE.RingGeometry(HORIZON * 0.95, HORIZON * 3, 64, 1).rotateX(-Math.PI / 2);
    ringGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ringGeo.getAttribute('position').count * 3).fill(0.3), 3));
    const ring = new THREE.Mesh(ringGeo, this.material);
    ring.position.y = -this.originElevation - curvatureDrop(HORIZON) - 5;
    this.group.add(ring);
  }
}
