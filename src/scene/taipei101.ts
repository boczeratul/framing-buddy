import * as THREE from 'three';
import { Batch, box, cylinder, loft, type Ring } from './geometry';
import { M, windowLightTex } from './materials';

// 台北 101：塔基（1–25F 內收 5° 的截角錐）＋ 26F 轉換層 ＋ 8 節「花瓣」
// （27–90F，每節 8 層、外張 7°）＋ 頂部（91–101F）＋ 塔尖。平面為四角雙重內凹（鋸齒角）的正方形。
// 尺寸：屋頂 449.2 m、塔尖 508 m、101F 樓板 438 m、91F 391.8 m；
// 塔基地面寬約 62 m → 26F 約 42 m，每節花瓣由 42 m 張開到 50 m。原點在塔基中心地面。

export const T101 = {
  roof: 449.2,
  spireTip: 508,
  baseTop: 115,
  segmentStart: 119,
  segmentHeight: 33.6,
  segments: 8,
};

/** 四角雙重內凹的方形環；a＝半寬，notch＝每一階內凹深度 */
function notchedRing(a: number, y: number, notch: number): Ring {
  const n = notch;
  const quarter: [number, number][] = [
    [a, a - 2 * n], [a - n, a - 2 * n], [a - n, a - n], [a - 2 * n, a - n], [a - 2 * n, a],
  ];
  const pts: Ring = [];
  // 從東北角起，逆時針（從上方看）旋轉 4 次；(u, v) = (東, 北)
  for (let q = 0; q < 4; q++) {
    const ang = (q * Math.PI) / 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (const [u, v] of quarter) {
      const x = u * c - v * s;
      const north = u * s + v * c;
      pts.push(new THREE.Vector3(x, y, -north));
    }
  }
  return pts;
}

function section(batch: Batch, mat: THREE.Material, y0: number, y1: number, a0: number, a1: number, notchK = 0.1, caps = true) {
  const g = loft([notchedRing(a0, y0, a0 * notchK), notchedRing(a1, y1, a1 * notchK)], {
    capTop: caps,
    capBottom: false,
    uvScale: 4.2,
  });
  batch.add(mat, g);
}

/** 塔基上的古錢幣裝飾（圓形方孔） */
function coin(radius: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  const h = radius * 0.32;
  hole.moveTo(-h, -h); hole.lineTo(h, -h); hole.lineTo(h, h); hole.lineTo(-h, h); hole.lineTo(-h, -h);
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: false, curveSegments: 32 });
}

export function buildTaipei101(): THREE.Group {
  const b = new Batch();
  windowLightTex.repeat.set(1 / 16, 1 / 16);

  // 塔基：1–25F，由寬到窄（內收約 5°）
  section(b, M.glass101, 0, T101.baseTop, 31, 21, 0.1);
  // 26F 轉換層
  section(b, M.frame101, T101.baseTop, T101.segmentStart, 21.6, 21.6, 0.1);

  // 8 節花瓣：每節下窄上寬（外張約 7°），接縫處內收
  const segH = T101.segmentHeight;
  for (let i = 0; i < T101.segments; i++) {
    const y0 = T101.segmentStart + i * segH;
    const y1 = y0 + segH - 1.4;
    section(b, M.glass101, y0, y1, 21, 25, 0.1);
    section(b, M.frame101, y1, y1 + 1.4, 25.4, 21.2, 0.1);
  }

  // 頂部 91–101F 與屋頂冠
  const t0 = T101.segmentStart + T101.segments * segH;
  section(b, M.frame101, t0, t0 + 4, 16, 15.5, 0.1);
  section(b, M.glass101, t0 + 4, 438, 15, 11.5, 0.08);
  section(b, M.frame101, 438, T101.roof, 10.5, 7, 0.08);

  // 塔尖
  b.add(M.steel, cylinder(4.2, 14, 0, T101.roof, 0, 16, 3.6));
  b.add(M.steel, cylinder(2.8, 16, 0, T101.roof + 14, 0, 16, 2.4));
  b.add(M.steel, cylinder(1.6, 14, 0, T101.roof + 30, 0, 12, 1.2));
  b.add(M.steel, cylinder(0.6, T101.spireTip - T101.roof - 44, 0, T101.roof + 44, 0, 8, 0.25));
  for (const y of [T101.roof + 14, T101.roof + 30, T101.roof + 44]) b.add(M.frame101, cylinder(3.6, 1.2, 0, y - 0.6, 0, 16));

  // 古錢幣：四面，位於塔基頂部
  for (let q = 0; q < 4; q++) {
    const g = coin(6.5);
    g.translate(0, 0, 22.4);
    g.rotateY((q * Math.PI) / 2);
    g.translate(0, T101.baseTop - 12, 0);
    b.add(M.gold, g);
  }

  // 購物中心裙樓（6 層、約 28 m；位置為示意）
  b.add(M.frame101, box(140, 28, 70, 20, 0, 66));

  const group = b.build('taipei-101', { castShadow: false, receiveShadow: false });
  return group;
}
