import type * as THREE from 'three';
import type { LatLon } from '../geo';
import type { ShotState } from '../state';

export interface MapLabel {
  text: string;
  x: number;
  z: number;
  /** 地圖比例（每像素公尺）小於此值才顯示 */
  minZoom?: number;
}

/** 可對準、可在資訊列追蹤遮擋情況的目標 */
export interface Target {
  id: string;
  label: string;
  /** 目前場景座標：底部與頂部 */
  base: THREE.Vector3;
  top: THREE.Vector3;
  /** 對準時瞄準的高度比例（0＝底、1＝頂） */
  aimAt: number;
  /** 被遮擋判定時要排除的物件（目標本身） */
  self?: THREE.Object3D;
  /** 目標水平半徑：遮擋射線在此距離前停下，避免打到目標自己 */
  radius?: number;
  /** 山峰：只判斷山頂是否被擋（山體下半部本來就會被自己的山坡擋住） */
  kind?: 'peak';
}

export interface Preset {
  name: string;
  group: string;
  lat: number;
  lon: number;
  height?: number;
  snap?: boolean;
  /** 抵達後對準的目標 id */
  aim?: string;
  state?: Partial<ShotState>;
}

export type Polygon = LatLon[];
