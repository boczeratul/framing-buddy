import * as THREE from 'three';
import { curvatureDrop, toLocal } from '../geo';
import { Environment } from './environment';
import { M } from './materials';
import { buildCKS, worldToSite, type Floor } from './cks';
import { buildTaipei101, T101 } from './taipei101';
import { LANDMARKS } from './landmarks';

export interface MapLabel {
  text: string;
  x: number;
  z: number;
  /** 地圖比例（每像素公尺）小於此值才顯示 */
  minZoom?: number;
}

/** 場景總成：環境、地面、中正紀念堂園區、台北 101 */
export class World {
  readonly scene = new THREE.Scene();
  readonly env: Environment;
  readonly ground: THREE.Mesh;
  readonly trees: THREE.Object3D;
  /** 會遮擋視線的物件（101 可見度判定、3D 環視點選用） */
  readonly occluders: THREE.Object3D[] = [];
  readonly labels: MapLabel[];
  readonly tower101: { base: THREE.Vector3; top: THREE.Vector3; distance: number };
  readonly hall: { top: THREE.Vector3 };
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  private floors: Floor[];

  constructor() {
    this.env = new Environment(this.scene);
    // 天空環境光只當補光：實際晴天水平面上日光約為天光的 4–5 倍
    this.scene.environmentIntensity = 0.35;

    // 園區外的城市地面（大範圍，延伸到 101 以東）
    const ground = new THREE.Mesh(new THREE.CircleGeometry(40000, 64).rotateX(-Math.PI / 2), M.urban);
    const tex = (M.urban.map as THREE.Texture);
    tex.repeat.set(800, 800);
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.ground = ground;
    this.scene.add(ground);

    const cks = buildCKS();
    this.scene.add(cks.group);
    this.occluders.push(cks.buildings);
    this.trees = cks.trees;
    this.occluders.push(cks.trees);
    this.floors = cks.floors;
    this.labels = cks.labels;
    this.hall = { top: cks.hallTop };
    this.bounds = cks.bounds;

    // 台北 101：依經緯度換算位置，並扣除地球曲率造成的下沉
    const p = toLocal(LANDMARKS.taipei101);
    const distance = Math.hypot(p.x, p.z);
    const baseY = LANDMARKS.elevation101 - LANDMARKS.elevationCKS - curvatureDrop(distance);
    const t101 = buildTaipei101();
    t101.position.set(p.x, baseY, p.z);
    this.scene.add(t101);
    this.tower101 = {
      base: new THREE.Vector3(p.x, baseY, p.z),
      top: new THREE.Vector3(p.x, baseY + T101.spireTip, p.z),
      distance,
    };
    this.labels.push({ text: '台北 101', x: p.x, z: p.z });

    this.scene.updateMatrixWorld(true);
  }

  setTrees(v: boolean) {
    this.trees.visible = v;
    const i = this.occluders.indexOf(this.trees);
    if (v && i < 0) this.occluders.push(this.trees);
    if (!v && i >= 0) this.occluders.splice(i, 1);
  }

  /** 站立面高度：地面、台基、階梯、平台（站立面以園區座標定義） */
  surfaceAt(x: number, z: number): number {
    const { u, v } = worldToSite(x, z);
    let y = 0;
    for (const f of this.floors) {
      const h = floorHeight(f, u, v);
      if (h !== null && h > y) y = h;
    }
    return y;
  }
}

function floorHeight(f: Floor, x: number, z: number): number | null {
  if (f.kind === 'rect') {
    if (Math.abs(x - f.cx) <= f.hw && Math.abs(z - f.cz) <= f.hd) return f.y;
    return null;
  }
  // 階梯：沿 axis 方向由 y0 升至 y1
  const along = f.axis === 'x' ? x : z;
  const across = f.axis === 'x' ? z : x;
  const [a0, a1] = [Math.min(f.from, f.to), Math.max(f.from, f.to)];
  if (along < a0 || along > a1 || Math.abs(across - f.center) > f.halfWidth) return null;
  const t = (along - f.from) / (f.to - f.from);
  const step = Math.min(f.steps - 1, Math.floor(t * f.steps));
  return f.y0 + ((step + 1) / f.steps) * (f.y1 - f.y0);
}
