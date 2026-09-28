import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin, UnloadTilesPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { LatLon } from '../geo';
import { applyMask, inMask, maskedDepthMaterial } from '../scene/regionmask';

// Google Photorealistic 3D Tiles：遠景全部使用，近景在沒有自建模型的地方使用。
// - ReorientationPlugin 把地球座標轉成以原點為中心、Y 朝上的局部座標（X 西、Z 北），
//   外層再轉 180° 對齊本專案的 X 東、Z 南。
// - 範圍外掛只載入可視範圍內的圖磚（距離越遠 LOD 越粗，由圖磚本身的幾何誤差決定）。
// - 自建模型接手的區域以多邊形遮罩挖掉（畫面、陰影、射線偵測都排除）。
// - 圖磚原本是不受光的照片貼圖，改成受光材質才能模擬不同時間的日照與陰影（可切回原始光影）。

const DEG = Math.PI / 180;

/** 只保留與相機可視範圍球體相交的圖磚 */
class RangeMaskPlugin {
  name = 'FB_RANGE_MASK';
  sphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  calculateTileViewError(tile: { engineData: { boundingVolume: { intersectsSphere(s: THREE.Sphere): boolean } } }, target: { inView: boolean; error: number; distance: number }) {
    if (tile.engineData.boundingVolume.intersectsSphere(this.sphere)) return false;
    target.inView = false;
    target.error = 0;
    target.distance = Infinity;
    return true;
  }
}

interface TileMaterials {
  lit: THREE.MeshStandardMaterial;
  unlit: THREE.MeshBasicMaterial;
}

export class PhotorealLayer {
  /** 外層：旋轉對齊本專案座標，並把原點地面校正到 y=0 */
  readonly root = new THREE.Group();
  readonly tiles: TilesRenderer;
  failed: string | null = null;
  /** 給遮擋判定用的代理物件：射線只打到畫面上顯示、且未被自建模型取代的圖磚 */
  readonly occluder: THREE.Object3D;
  /** 原點地面已校正 */
  calibrated = false;
  version = 0;
  onChange?: () => void;
  private reorient: ReorientationPlugin;
  private mask = new RangeMaskPlugin();
  private materials = new Set<TileMaterials>();
  private relight = true;
  private daylight = 1;
  private cameras = new Set<THREE.Camera>();
  /** 地形高程（場景座標）；有的話用來把實景模型的地面對齊高程資料 */
  private groundRef: ((x: number, z: number) => number) | null = null;
  private groundReady = false;

  constructor(apiKey: string, origin: LatLon) {
    this.root.name = 'photoreal';
    this.occluder = new THREE.Object3D();
    this.occluder.raycast = (rc: THREE.Raycaster, hits: THREE.Intersection[]) => {
      hits.push(...this.raycast(rc));
    };
    this.root.rotation.y = Math.PI;
    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
    // 遠景全靠 Google 模型：比建議值（20 px）更精細一些
    tiles.errorTarget = 12;
    const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new UnloadTilesPlugin());
    this.reorient = new ReorientationPlugin({ lat: origin.lat * DEG, lon: origin.lon * DEG, height: 0 });
    tiles.registerPlugin(this.reorient);
    tiles.registerPlugin(this.mask);
    tiles.autoDisableRendererCulling = false;
    this.tiles = tiles;
    this.root.add(tiles.group);

    tiles.addEventListener('load-model', (e: { scene: THREE.Object3D }) => this.prepare(e.scene));
    tiles.addEventListener('dispose-model', (e: { scene: THREE.Object3D }) => this.release(e.scene));
    tiles.addEventListener('needs-update', () => this.changed());
    tiles.addEventListener('tiles-load-end', () => this.changed());
    tiles.addEventListener('load-error', (e: { error: Error; tile: unknown }) => {
      // 根節點失敗（金鑰無效、未啟用 Map Tiles API、配額用盡）才視為整體失敗
      if (!e.tile) {
        this.failed = e.error?.message ?? '無法載入 Google 3D 圖磚';
        this.changed();
      }
    });
  }

  private changed() {
    this.version++;
    this.onChange?.();
  }

  setOrigin(p: LatLon) {
    // 型別宣告沒有列出 lat/lon，但外掛在根節點載入時會讀取它們
    Object.assign(this.reorient, { lat: p.lat * DEG, lon: p.lon * DEG });
    if (this.tiles.root) this.reorient.transformLatLonHeightToOrigin(p.lat * DEG, p.lon * DEG, 0);
    this.root.position.y = 0;
    this.calibrated = false;
    this.groundReady = false;
    this.changed();
  }

  /** 新原點的地形載入後呼叫；null 表示沒有高程資料 */
  setGroundReference(fn: ((x: number, z: number) => number) | null) {
    this.groundRef = fn;
    this.groundReady = true;
    this.calibrated = false;
  }

  setCameras(list: { camera: THREE.Camera; renderer: THREE.WebGLRenderer }[]) {
    const want = new Set(list.map((c) => c.camera));
    for (const c of this.cameras) if (!want.has(c)) this.tiles.deleteCamera(c);
    for (const { camera, renderer } of list) {
      this.tiles.setCamera(camera);
      this.tiles.setResolutionFromRenderer(camera, renderer);
    }
    this.cameras = want;
  }

  /** 每幀呼叫：更新可視範圍並讓圖磚依相機載入／卸載 */
  update(eye: THREE.Vector3, range: number) {
    if (this.failed) return;
    this.root.updateMatrixWorld(true);
    const local = this.tiles.group.worldToLocal(eye.clone());
    this.mask.sphere.center.copy(local);
    this.mask.sphere.radius = range * 1.1;
    this.tiles.update();
    if (!this.calibrated) this.calibrate();
  }

  /**
   * 把實景模型的地面對齊場景高程。
   * 圖磚使用橢球高，與高程資料（海拔）相差一個大地水準面差（台灣約 +20 m），且隨地點而異。
   * 在原點周圍取多點往下打射線，比對實景表面與地形高程；表面常是屋頂或樹冠（只會偏高），
   * 所以取低百分位數當作兩者的差。沒有高程資料時退而求其次：以附近最低的表面當地面。
   */
  private calibrate() {
    if (this.tiles.visibleTiles.size < 25 || !this.groundReady) return;
    const rc = new THREE.Raycaster();
    rc.firstHitOnly = true;
    const diffs: number[] = [];
    const R = this.groundRef ? 300 : 70;
    const N = this.groundRef ? 7 : 5;
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const x = -R + (2 * R * i) / (N - 1);
        const z = -R + (2 * R * j) / (N - 1);
        rc.set(new THREE.Vector3(x, 9000, z), new THREE.Vector3(0, -1, 0));
        rc.far = 20000;
        const hit = this.raycast(rc)[0];
        if (hit) diffs.push(hit.point.y - (this.groundRef ? this.groundRef(x, z) : 0));
      }
    if (diffs.length < N) return;
    diffs.sort((a, b) => a - b);
    const offset = this.groundRef ? diffs[Math.floor(diffs.length * 0.2)] : diffs[0];
    this.root.position.y -= offset;
    this.root.updateMatrixWorld(true);
    this.calibrated = true;
    this.changed();
  }

  /** 只計算目前實際顯示的圖磚（已載入但被更精細層級取代的圖磚會重疊，需排除） */
  raycast(raycaster: THREE.Raycaster): THREE.Intersection[] {
    if (this.failed) return [];
    const hits: THREE.Intersection[] = [];
    const firstOnly = raycaster.firstHitOnly;
    raycaster.firstHitOnly = false;
    this.tiles.group.raycast(raycaster, hits);
    raycaster.firstHitOnly = firstOnly;
    const group = this.tiles.group;
    // 顯示中的圖磚才會掛在 group 底下且 visible
    const shown = (o: THREE.Object3D | null): boolean => {
      let n = o;
      for (; n && n !== group; n = n.parent) if (!n.visible) return false;
      return n === group;
    };
    // 被自建模型取代的區域不算
    const out = hits.filter((h) => shown(h.object) && !inMask(h.point.x, h.point.z)).sort((a, b) => a.distance - b.distance);
    return firstOnly ? out.slice(0, 1) : out;
  }

  setRelight(on: boolean) {
    this.relight = on;
    for (const m of this.materials) this.swap(m);
    this.changed();
  }

  /** 照片貼圖本身已含白天光影：白天加一點自發光保留原色調，夜晚則交給模擬光源 */
  setDaylight(day: number) {
    this.daylight = day;
    for (const m of this.materials) m.lit.emissiveIntensity = 0.45 * day;
  }

  private swap(m: TileMaterials) {
    const mesh = (m.lit.userData.mesh as THREE.Mesh | undefined) ?? null;
    if (mesh) mesh.material = this.relight ? m.lit : m.unlit;
  }

  private prepare(scene: THREE.Object3D) {
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = mesh.material as THREE.MeshBasicMaterial;
      const map = old.map ?? null;
      const lit = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.45 * this.daylight });
      const unlit = new THREE.MeshBasicMaterial({ map });
      applyMask(lit);
      applyMask(unlit);
      mesh.customDepthMaterial = maskedDepthMaterial;
      old.dispose();
      lit.userData.mesh = mesh;
      const entry = { lit, unlit };
      this.materials.add(entry);
      mesh.userData.fbMaterials = entry;
      if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.swap(entry);
    });
    this.changed();
  }

  private release(scene: THREE.Object3D) {
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const entry = mesh.userData?.fbMaterials as TileMaterials | undefined;
      if (!entry) return;
      entry.lit.dispose();
      entry.unlit.dispose();
      this.materials.delete(entry);
      mesh.geometry.disposeBoundsTree?.();
    });
  }

  /** Google 要求顯示的著作權標示 */
  attributions(): string {
    const list = this.tiles.getAttributions();
    return list
      .filter((a) => a.type === 'string')
      .map((a) => String(a.value))
      .join('; ');
  }

  dispose() {
    this.tiles.dispose();
  }
}
