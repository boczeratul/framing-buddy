import * as THREE from 'three';
import { Batch, cylinder, loft, merge, type Ring } from './geometry';
import { M, windowLightTex } from './materials';

// 台北 101 精細模型（近景用）。
// 結構：塔基（1–25F，內收約 5°）＋ 26F 轉換層 ＋ 8 節花瓣（27–90F，每節 8 層、外張約 7°）
// ＋ 頂部（91–101F 縮小花瓣）＋ 階梯冠頂 ＋ 塔尖基座 ＋ 分節塔尖。
// 平面為四角雙重內凹（鋸齒角）的正方形。每層樓有玻璃帶與樓板凸緣，立面有垂直窗框鰭板；
// 每節轉角有如意裝飾、各面中央有雲紋裝飾；塔基頂部四面各一枚古錢幣。
// 尺寸：屋頂 449.2 m、塔尖 508 m、101F 樓板 438 m、91F 391.8 m；
// 塔基地面寬約 62 m → 26F 約 42 m，每節花瓣由 42 m 張開到 50 m。原點在塔基中心地面，+X 東、+Z 南。

export const T101 = {
  roof: 449.2,
  spireTip: 508,
  baseTop: 115.5,
  segmentStart: 119.5,
  segmentHeight: 33.6,
  segments: 8,
};

/** 自建模型涵蓋範圍（相對塔心，東、北公尺）：塔身＋購物中心裙樓，Google 模型在此挖空 */
export const TAIPEI101_FOOTPRINT: [number, number][] = [[-106, -40], [40, -40], [40, 106], [-106, 106]];

/**
 * 裙樓（台北 101 購物中心）：依 Google 3D 俯視量測，商場呈 L 形位於塔的西側與北側，
 * 塔身位於整個基地的東南角；西半部屋頂為大片玻璃弧形天窗。輪廓為相對塔心（東、北公尺），從上方看逆時針。
 */
const PODIUM: { poly: [number, number][]; height: number }[] = [
  { poly: [[-31, -24], [-31, 98], [-98, 98], [-98, -24]], height: 30 },
  { poly: [[28, 31], [28, 98], [-31, 98], [-31, 31]], height: 30 },
];

const NOTCH = 0.1;

/** 四角雙重內凹的方形環；a＝半寬 */
function notchedRing(a: number, y: number, k = NOTCH): Ring {
  const n = a * k;
  const quarter: [number, number][] = [
    [a, a - 2 * n], [a - n, a - 2 * n], [a - n, a - n], [a - 2 * n, a - n], [a - 2 * n, a],
  ];
  const pts: Ring = [];
  for (let q = 0; q < 4; q++) {
    const ang = (q * Math.PI) / 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (const [u, v] of quarter) pts.push(new THREE.Vector3(u * c - v * s, y, -(u * s + v * c)));
  }
  return pts;
}

/** 單層樓的玻璃帶：UV 的 v 位移到第 floor 層，讓每層的夜間窗燈圖樣不同 */
function glassBand(y0: number, y1: number, a0: number, a1: number, floor: number): THREE.BufferGeometry {
  const g = loft([notchedRing(a0, y0), notchedRing(a1, y1)], { uvScale: 4.2 });
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const span = y1 - y0;
  for (let i = 0; i < uv.count; i++) uv.setY(i, (uv.getY(i) * 4.2) / span + floor);
  return g;
}

/** 樓板凸緣：外凸 out、厚 t 的一圈 */
function ledge(y: number, a: number, out: number, t: number): THREE.BufferGeometry[] {
  const inner0 = notchedRing(a - 0.2, y - t);
  const outer0 = notchedRing(a + out, y - t);
  const outer1 = notchedRing(a + out, y);
  const inner1 = notchedRing(a - 0.2, y);
  return [loft([inner0, outer0]), loft([outer0, outer1]), loft([outer1, inner1])];
}

/** 花瓣或塔基：逐層玻璃帶＋凸緣，半寬 a 隨高度線性變化 */
function stack(b: Batch, y0: number, heights: number[], a0: number, a1: number, floor0: number, ledgeOut = 0.45) {
  const total = heights.reduce((s, h) => s + h, 0);
  const aAt = (y: number) => a0 + ((a1 - a0) * (y - y0)) / total;
  let y = y0;
  heights.forEach((hgt, i) => {
    const ya = y;
    const yb = y + hgt;
    b.add(M.glass101, glassBand(ya, yb, aAt(ya) - 0.25, aAt(yb) - 0.25, floor0 + i));
    for (const g of ledge(yb, aAt(yb), ledgeOut, 0.32)) b.add(M.frame101, g);
    y = yb;
  });
}

/** 立面垂直鰭板：沿主要立面（兩個內凹之間）等距排列，隨收分／外張傾斜 */
function fins(b: Batch, y0: number, y1: number, a0: number, a1: number, spacing = 2.1) {
  const parts: THREE.BufferGeometry[] = [];
  const half0 = a0 * (1 - 2 * NOTCH);
  const n = Math.max(2, Math.floor((2 * half0) / spacing));
  const w = 0.09 / half0;
  const dOut = 0.35;
  for (let face = 0; face < 4; face++) {
    const ang = (face * Math.PI) / 2;
    const p = (a: number, y: number, d: number, s: number) => {
      const u = a + d;
      const v = a * (1 - 2 * NOTCH) * s;
      return new THREE.Vector3(u * Math.cos(ang) - v * Math.sin(ang), y, -(u * Math.sin(ang) + v * Math.cos(ang)));
    };
    for (let i = 1; i < n; i++) {
      const t = -1 + (2 * i) / n;
      const q = [
        p(a0, y0, 0, t - w), p(a0, y0, 0, t + w), p(a1, y1, 0, t + w), p(a1, y1, 0, t - w),
        p(a0, y0, dOut, t - w), p(a0, y0, dOut, t + w), p(a1, y1, dOut, t + w), p(a1, y1, dOut, t - w),
      ];
      // 正面與兩側（背面貼著玻璃不需要）
      const idx = [4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(idx.flatMap((k) => q[k].toArray()), 3));
      g.computeVertexNormals();
      parts.push(g);
    }
  }
  b.add(M.frame101, merge(parts));
}

/** 如意雲頭：三瓣輪廓（中央鏤空），擠出成有斜角的厚片 */
function ruyiShape(size: number): THREE.Shape {
  const s = new THREE.Shape();
  const N = 42;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const r = size * (0.62 + 0.28 * Math.cos(3 * t + Math.PI / 2) + 0.06 * Math.cos(6 * t));
    const x = r * Math.cos(t);
    const y = r * Math.sin(t) * 0.9 + size * 0.1;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  const hole = new THREE.Path();
  for (let i = 0; i <= 24; i++) {
    const t = -(i / 24) * Math.PI * 2;
    const x = size * 0.18 * Math.cos(t);
    const y = size * 0.18 * Math.sin(t) + size * 0.12;
    if (i === 0) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  }
  s.holes.push(hole);
  return s;
}

function ruyi(size: number, depth: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(ruyiShape(size), {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.25,
    bevelSize: size * 0.05,
    bevelSegments: 2,
    curveSegments: 12,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** 古錢幣：圓盤（方孔）＋外緣環＋方孔框，正面朝 +Z */
function coin(radius: number): THREE.BufferGeometry[] {
  const h = radius * 0.3;
  const square = (half: number) => {
    const p = new THREE.Path();
    p.moveTo(-half, -half); p.lineTo(-half, half); p.lineTo(half, half); p.lineTo(half, -half); p.lineTo(-half, -half);
    return p;
  };
  const shape = new THREE.Shape();
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
  shape.holes.push(square(h));
  const disc = new THREE.ExtrudeGeometry(shape, { depth: 1.0, bevelEnabled: true, bevelThickness: 0.35, bevelSize: 0.3, bevelSegments: 3, curveSegments: 64 });
  const rim = new THREE.TorusGeometry(radius - 0.3, 0.45, 10, 96);
  rim.translate(0, 0, 1.4);
  const hi = h + 0.9;
  const inner = new THREE.Shape();
  inner.moveTo(-hi, -hi); inner.lineTo(hi, -hi); inner.lineTo(hi, hi); inner.lineTo(-hi, hi); inner.lineTo(-hi, -hi);
  inner.holes.push(square(h));
  const frame = new THREE.ExtrudeGeometry(inner, { depth: 0.6, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.15, bevelSegments: 2 });
  frame.translate(0, 0, 1.2);
  return [disc, rim, frame];
}

/** 把在面座標（+Z 朝外）建好的幾何放到第 face 面，距中心 dist */
function onFace(g: THREE.BufferGeometry, face: number, dist: number, y: number) {
  g.translate(0, y, dist);
  g.rotateY((face * Math.PI) / 2);
  return g;
}

/** 轉角如意：四角各一，斜向外、略為下垂 */
function cornerRuyi(b: Batch, y: number, a: number, size: number) {
  for (let q = 0; q < 4; q++) {
    const g = ruyi(size, size * 0.27);
    g.rotateX(-0.25);
    const ang = Math.PI / 4 + (q * Math.PI) / 2;
    g.rotateY(ang - Math.PI / 2);
    const r = a * Math.SQRT2 * (1 - NOTCH * 1.5);
    g.translate(Math.cos(ang) * r, y, -Math.sin(ang) * r);
    b.add(M.ornament101, g);
  }
}

export function buildTaipei101(): { group: THREE.Group } {
  const b = new Batch();
  windowLightTex.repeat.set(1 / 16, 1 / 16);

  // ---- 塔基 1–25F：前 5 層 6.3 m（商場樓層），其餘 4.2 m ----
  const baseFloors = [...Array(5).fill(6.3), ...Array(20).fill(4.2)] as number[];
  stack(b, 0, baseFloors, 31, 21, 0, 0.55);
  fins(b, 0, T101.baseTop, 30.8, 20.8, 2.4);
  // 石材基座
  b.add(M.granite, loft([notchedRing(32.2, 0), notchedRing(31.6, 3.2)], { capTop: false }));

  // 26F 轉換層（加寬腰帶）
  for (const g of ledge(T101.baseTop + 0.6, 21.8, 0.6, 0.6)) b.add(M.frame101, g);
  b.add(M.frame101, loft([notchedRing(21.4, T101.baseTop + 0.6), notchedRing(21.4, T101.segmentStart - 0.4)]));
  for (const g of ledge(T101.segmentStart, 22, 0.5, 0.4)) b.add(M.frame101, g);

  // 古錢幣：塔基頂部四面中央（貼在內收的立面上）
  const coinY = T101.baseTop - 11;
  const faceAt = 31 - (10 * coinY) / T101.baseTop;
  for (let face = 0; face < 4; face++) for (const g of coin(6.4)) b.add(M.gold, onFace(g, face, faceAt, coinY));

  // ---- 8 節花瓣 ----
  const segFloors = Array(8).fill(4.2) as number[];
  for (let i = 0; i < T101.segments; i++) {
    const y0 = T101.segmentStart + i * T101.segmentHeight;
    const y1 = y0 + T101.segmentHeight;
    stack(b, y0, segFloors, 21, 25, 26 + i * 8);
    fins(b, y0, y1, 20.9, 24.9);
    // 節頂外挑的簷口與節間收進的平台
    for (const g of ledge(y1, 25.2, 1.1, 0.9)) b.add(M.frame101, g);
    if (i < T101.segments - 1) b.add(M.frame101, loft([notchedRing(26.2, y1 + 0.01), notchedRing(21.2, y1 + 0.01)]));
    cornerRuyi(b, y1 - 2.4, 25.6, 2.6);
    for (let face = 0; face < 4; face++) b.add(M.ornament101, onFace(ruyi(1.9, 0.5), face, 21.6, y0 + 3.2));
  }

  // ---- 頂部 ----
  const t0 = T101.segmentStart + T101.segments * T101.segmentHeight; // ≈388.3
  // 89–91F 觀景層與戶外觀景台欄杆
  stack(b, t0, [3.5, 3.5], 21.2, 21.2, 90, 0.35);
  for (const g of ledge(t0 + 7.4, 22.4, 1.4, 0.6)) b.add(M.frame101, g);
  const rails: THREE.BufferGeometry[] = [];
  const railRing = notchedRing(23.4, t0 + 7.4);
  for (let i = 0; i < railRing.length; i++) {
    const p = railRing[i];
    const q = railRing[(i + 1) % railRing.length];
    const len = p.distanceTo(q);
    const n = Math.max(1, Math.round(len / 1.2));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      rails.push(cylinder(0.05, 1.2, p.x + (q.x - p.x) * t, t0 + 7.4, p.z + (q.z - p.z) * t, 4));
    }
    const rail = new THREE.BoxGeometry(len, 0.08, 0.08);
    rail.rotateY(-Math.atan2(q.z - p.z, q.x - p.x));
    rail.translate((p.x + q.x) / 2, t0 + 8.6, (p.z + q.z) / 2);
    rails.push(rail);
  }
  b.add(M.steel, merge(rails));

  // 92–101F 縮小花瓣（外張）
  stack(b, t0 + 7.4, Array(10).fill(4.2), 16, 19.2, 92);
  fins(b, t0 + 7.4, 438, 15.9, 19.1, 1.8);
  for (const g of ledge(438, 19.6, 1.2, 0.8)) b.add(M.frame101, g);
  cornerRuyi(b, 436, 20, 2.2);

  // 階梯冠頂 438–449.2
  const tiers: [number, number, number][] = [[438, 441.5, 16], [441.5, 444.5, 13], [444.5, 447, 10.5], [447, T101.roof, 8]];
  for (const [ya, yb, a] of tiers) {
    b.add(M.frame101, loft([notchedRing(a, ya), notchedRing(a * 0.97, yb)], { capTop: true }));
    for (const g of ledge(yb, a * 0.97, 0.4, 0.3)) b.add(M.frame101, g);
  }

  // 塔尖基座（方塊＋外擴帽簷）
  const pinTop = T101.roof + 12;
  b.add(M.steel, loft([notchedRing(5.4, T101.roof), notchedRing(4.6, pinTop)], { capTop: true }));
  for (let k = 1; k <= 4; k++) for (const g of ledge(T101.roof + k * 2.4, 5.4 - k * 0.16, 0.25, 0.2)) b.add(M.frame101, g);
  b.add(M.steel, cylinder(7.2, 1.6, 0, pinTop, 0, 32, 5.2));
  b.add(M.frame101, cylinder(5.4, 0.8, 0, pinTop + 1.6, 0, 32, 4.8));

  // 分節塔尖：八角錐＋環箍
  const spire0 = pinTop + 2.4;
  const spireH = T101.spireTip - spire0;
  const sections = 6;
  for (let i = 0; i < sections; i++) {
    const ya = spire0 + (i / sections) * spireH * 0.92;
    const yb = spire0 + ((i + 1) / sections) * spireH * 0.92;
    const ra = 2.3 * (1 - (i / sections) * 0.78);
    const rb = 2.3 * (1 - ((i + 1) / sections) * 0.78);
    b.add(M.steel, cylinder(ra, yb - ya, 0, ya, 0, 8, rb));
    b.add(M.frame101, cylinder(ra + 0.25, 0.5, 0, ya, 0, 16, ra + 0.15));
  }
  b.add(M.steel, cylinder(0.3, spireH * 0.08, 0, spire0 + spireH * 0.92, 0, 8, 0.05));

  // ---- 裙樓（購物中心）與地面 ----
  for (const p of PODIUM) buildPodium(b, p.poly, p.height);
  // 西側商場的玻璃弧形天窗（南北向）
  const vault = new THREE.CylinderGeometry(20, 20, 96, 32, 1, true, -Math.PI / 2, Math.PI);
  vault.rotateX(Math.PI / 2);
  vault.scale(1, 0.45, 1);
  vault.translate(-64, 30, -37);
  b.add(M.glass101, vault);
  const ribs: THREE.BufferGeometry[] = [];
  for (let k = 0; k <= 16; k++) {
    const r = new THREE.TorusGeometry(20, 0.25, 4, 24, Math.PI);
    r.rotateY(Math.PI / 2);
    r.scale(1, 0.45, 1);
    r.translate(-64, 30, -37 - 48 + k * 6);
    ribs.push(r);
  }
  b.add(M.frame101, merge(ribs));
  const plate = new THREE.Shape(TAIPEI101_FOOTPRINT.map(([e, n]) => new THREE.Vector2(e, n)));
  const plateGeo = new THREE.ShapeGeometry(plate);
  plateGeo.rotateX(-Math.PI / 2);
  plateGeo.translate(0, 0.05, 0);
  b.add(M.paving, plateGeo);

  return { group: b.build('taipei-101', { castShadow: true, receiveShadow: true }) };
}

/** 裙樓：6 層商場，立面分樓層並有頂部女兒牆；poly 為（東、北）且從上方看逆時針 */
function buildPodium(b: Batch, poly: [number, number][], height: number) {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cn = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  const ring = (inset: number, y: number): Ring =>
    poly.map(([e, n]) => {
      const dx = e - cx;
      const dn = n - cn;
      const l = Math.hypot(dx, dn) || 1;
      return new THREE.Vector3(e - (dx / l) * inset, y, -(n - (dn / l) * inset));
    });
  const floors = 6;
  const fh = height / floors;
  // 立面：米灰色石材層間帶＋每層一道玻璃窗帶
  for (let f = 0; f < floors; f++) {
    const y0 = f * fh;
    if (f === 0) b.add(M.granite, loft([ring(0.2, y0), ring(0.2, y0 + fh - 1.2)]));
    else b.add(M.glass101, loft([ring(0.5, y0), ring(0.5, y0 + fh * 0.55)], { uvScale: 4.2 }));
    b.add(M.marbleShade, loft([ring(0, y0 + (f === 0 ? fh - 1.2 : fh * 0.55)), ring(0, y0 + fh)]));
  }
  b.add(M.frame101, loft([ring(0, height), ring(0, height + 1.4)]));
  b.add(M.frame101, loft([ring(0.6, height + 0.3), ring(0.6, height + 0.31)], { capTop: true }));
}
