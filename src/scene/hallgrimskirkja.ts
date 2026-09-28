import * as THREE from 'three';
import { offsetLatLon, type LatLon } from '../geo';
import type { MapLabel } from '../world/types';
import {
  Batch, box, cylinder, extrude, flat, frameFromOutlines, loft, merge, placeOnWall, planarUV,
  pointedArchPoints, type Ring,
} from './geometry';
import { M } from './materials';

// 哈爾格林姆教堂（Hallgrímskirkja，冰島雷克雅維克）精細模型，含前方廣場、萊夫·艾瑞克森像與星形鞦韆。
//
// 建模座標：a 沿主軸指向教堂正面（方位 328.5°，北北西），c 指向東北側（方位 58.5°）；原點＝塔身中心。
// 模型空間 X = c、Z = −a、Y 朝上，整組再旋轉 31.5° 對齊真實方位。
// 尺寸來源：OpenStreetMap relation 6184378（126 個 building:part）、正面與側面照片量測、
// 英文／冰島文維基（塔高 74.5 m）。鞦韆：OSM way 1382897190（playground=swing，5 座）與現場照片。

const DEG = Math.PI / 180;

export const HALLGRIMS_ANCHOR: LatLon = { lat: 64.141941, lon: -21.926912 };
const FRONT_BEARING = 328.5;
const SA = Math.sin(FRONT_BEARING * DEG);
const CA = Math.cos(FRONT_BEARING * DEG);
const SC = Math.sin((FRONT_BEARING + 90) * DEG);
const CC = Math.cos((FRONT_BEARING + 90) * DEG);

export const HALLGRIMS = { towerTop: 74.5 };

/** (a, c) → 相對塔心的（東、北）公尺 */
function acToEN(a: number, c: number): [number, number] {
  return [a * SA + c * SC, a * CA + c * CC];
}

export function hallgrimsLatLon(a: number, c: number): LatLon {
  const [e, n] = acToEN(a, c);
  return offsetLatLon(HALLGRIMS_ANCHOR, e, n);
}

/** 自建模型涵蓋範圍：教堂、廣場、兩側草坪與鞦韆 */
export const HALLGRIMS_MASK: LatLon[] = [
  [-64, -44], [-64, 44], [40, 46], [88, 46], [92, 0], [88, -46], [40, -46],
].map(([a, c]) => hallgrimsLatLon(a, c));

// ---- 座標工具 ----

const V = (a: number, y: number, c: number) => new THREE.Vector3(c, y, -a);
const FRONT = new THREE.Vector3(0, 0, -1);
const BACK = new THREE.Vector3(0, 0, 1);
const SIDE = (sign: number) => new THREE.Vector3(sign, 0, 0);

/** 以 (a, c) 範圍建立方塊 */
function boxAC(a0: number, a1: number, c0: number, c1: number, y0: number, y1: number): THREE.BufferGeometry {
  return box(c1 - c0, y1 - y0, a1 - a0, (c0 + c1) / 2, y0, -(a0 + a1) / 2);
}

/** 以 (a, c) 點列擠出 */
function prismAC(pts: [number, number][], y0: number, y1: number): THREE.BufferGeometry {
  return extrude(pts.map(([a, c]) => [c, -a] as [number, number]), y0, y1);
}

/** 兩點之間的方柱（鞦韆框架、旗杆拉索等） */
function beam(p0: THREE.Vector3, p1: THREE.Vector3, t: number): THREE.BufferGeometry {
  const len = p0.distanceTo(p1);
  const g = new THREE.BoxGeometry(t, t, len);
  const m = new THREE.Matrix4().lookAt(p0, p1, new THREE.Vector3(0, 1, 0));
  g.applyMatrix4(m);
  g.translate((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (p0.z + p1.z) / 2);
  return g;
}

const concrete = (b: Batch, g: THREE.BufferGeometry, mat = M.concrete) => b.add(mat, planarUV(g, 4));

/** 地基往下延伸，放在斜坡上也不會懸空 */
const G = -3;

// ---- 塔 ----

const TW = 4.75;
const SHAFT_TOP = 53.5;

function lancetGlass(w: number, h: number): THREE.BufferGeometry {
  return new THREE.ShapeGeometry(new THREE.Shape(pointedArchPoints(w, h)));
}

/** 尖拱窗：深色玻璃＋白色窗框＋中央窗櫺與橫檔，建在 XY 平面、+Z 朝外 */
function lancetWindow(b: Batch, w: number, h: number, pos: THREE.Vector3, normal: THREE.Vector3, mullions = 1) {
  const glass = lancetGlass(w, h);
  glass.translate(0, 0, 0.02);
  b.add(M.glassDark, placeOnWall(glass, pos.clone(), normal));
  const frame = frameFromOutlines(pointedArchPoints(w + 0.3, h + 0.2), pointedArchPoints(w, h).map((p) => p.clone().setY(p.y + 0.03)), 0.14);
  b.add(M.whiteTrim, placeOnWall(frame, pos.clone(), normal));
  const spring = h - Math.sqrt(w * w * 0.75);
  for (let k = 1; k <= mullions; k++) {
    const x = -w / 2 + (w * k) / (mullions + 1);
    const m = new THREE.BoxGeometry(0.08, spring + (h - spring) * 0.55, 0.1);
    m.translate(x, (spring + (h - spring) * 0.55) / 2, 0.06);
    b.add(M.whiteTrim, placeOnWall(m, pos.clone(), normal));
  }
  const tr = new THREE.BoxGeometry(w, 0.08, 0.1);
  tr.translate(0, spring * 0.62, 0.06);
  b.add(M.whiteTrim, placeOnWall(tr, pos.clone(), normal));
}

function buildTower(b: Batch) {
  // 正面牆：底部有尖拱凹入口（寬 3.8 m、高 18.5 m）
  const arch = pointedArchPoints(3.8, 18.5);
  const notch = [new THREE.Vector2(-1.9, 0), ...arch.slice(2).reverse(), new THREE.Vector2(1.9, 0)];
  const outline = [new THREE.Vector2(-TW, G), new THREE.Vector2(-1.9, G), ...notch, new THREE.Vector2(1.9, G), new THREE.Vector2(TW, G), new THREE.Vector2(TW, SHAFT_TOP), new THREE.Vector2(-TW, SHAFT_TOP)];
  const front = new THREE.ExtrudeGeometry(new THREE.Shape(outline), { depth: 1, bevelEnabled: false });
  concrete(b, placeOnWall(front, V(TW - 1, 0, 0), FRONT));
  concrete(b, boxAC(-TW, -TW + 1, -TW, TW, G, SHAFT_TOP));
  concrete(b, boxAC(-TW, TW - 1, TW - 1, TW, G, SHAFT_TOP));
  concrete(b, boxAC(-TW, TW - 1, -TW, -TW + 1, G, SHAFT_TOP));
  concrete(b, boxAC(-TW, TW, -TW, TW, SHAFT_TOP - 0.6, SHAFT_TOP));

  // 入口凹龕：兩層退縮的尖拱框、後牆、銅門、紅色圓形玻璃、題字石板、三聯尖拱窗
  const back = TW - 1;
  concrete(b, boxAC(back - 0.2, back, -2, 2, G, 18.6));
  const steps: [number, number, number][] = [[3.8, 18.5, 0.67], [3.3, 18.0, 0.34]];
  for (let i = 0; i < steps.length; i++) {
    const [w, h, depth] = steps[i];
    const [w2, h2] = i + 1 < steps.length ? [steps[i + 1][0], steps[i + 1][1]] : [2.8, 17.5];
    const ring = frameFromOutlines(pointedArchPoints(w, h), pointedArchPoints(w2, h2).map((p) => p.clone().setY(p.y + 0.02)), depth);
    concrete(b, placeOnWall(ring, V(back, 0, 0), FRONT));
  }
  b.add(M.bronze, boxAC(back, back + 0.08, -1.0, 1.0, 0, 3.1));
  for (const cc of [-0.5, 0.5]) b.add(M.anthracite, boxAC(back + 0.08, back + 0.1, cc - 0.02, cc + 0.02, 0.1, 3.0));
  const emblem = new THREE.CircleGeometry(0.34, 32);
  b.add(M.churchRed, placeOnWall(emblem, V(back + 0.11, 2.1, 0), FRONT));
  b.add(M.whiteTrim, boxAC(back, back + 0.06, -0.9, 0.9, 3.45, 4.15));
  lancetWindow(b, 1.6, 7, V(back + 0.02, 8.6, 0), FRONT, 2);

  // 細長窗：塔身四面各 6 個
  const slits = [23, 27.6, 32.2, 36.8, 41.4, 46];
  const faces: { n: THREE.Vector3; at: (y: number) => THREE.Vector3 }[] = [
    { n: FRONT, at: (y) => V(TW, y, 0) },
    { n: BACK, at: (y) => V(-TW, y, 0) },
    { n: SIDE(1), at: (y) => V(0, y, TW) },
    { n: SIDE(-1), at: (y) => V(0, y, -TW) },
  ];
  for (const f of faces) {
    for (const y of slits) {
      const g = new THREE.BoxGeometry(0.34, 1.05, 0.06);
      g.translate(0, 0.52, 0.02);
      b.add(M.glassDark, placeOnWall(g, f.at(y), f.n));
      const fr = frameFromOutlines(
        [new THREE.Vector2(-0.3, -0.12), new THREE.Vector2(0.3, -0.12), new THREE.Vector2(0.3, 1.17), new THREE.Vector2(-0.3, 1.17)],
        [new THREE.Vector2(-0.17, 0), new THREE.Vector2(0.17, 0), new THREE.Vector2(0.17, 1.05), new THREE.Vector2(-0.17, 1.05)],
        0.1,
      );
      b.add(M.whiteTrim, placeOnWall(fr, f.at(y), f.n));
    }
    // 時鐘（直徑約 2.7 m，中心 50 m）
    const clock = new THREE.CircleGeometry(1.35, 48);
    clock.translate(0, 1.35, 0.04);
    b.add(M.clockFace, placeOnWall(clock, f.at(48.65), f.n));
    const rim = new THREE.TorusGeometry(1.35, 0.08, 6, 48);
    rim.translate(0, 1.35, 0.06);
    b.add(M.whiteTrim, placeOnWall(rim, f.at(48.65), f.n));
    for (let k = 0; k < 12; k++) {
      const t = (k / 12) * Math.PI * 2;
      const m = new THREE.BoxGeometry(0.07, k % 3 ? 0.18 : 0.3, 0.04);
      m.rotateZ(-t);
      m.translate(Math.sin(t) * 1.1, 1.35 + Math.cos(t) * 1.1, 0.07);
      b.add(M.whiteTrim, placeOnWall(m, f.at(48.65), f.n));
    }
    const hour = new THREE.BoxGeometry(0.08, 0.7, 0.03);
    hour.translate(0, 0.35, 0);
    hour.rotateZ(-2.2);
    hour.translate(0, 1.35, 0.09);
    const minute = new THREE.BoxGeometry(0.06, 1.05, 0.03);
    minute.translate(0, 0.52, 0);
    minute.rotateZ(0.5);
    minute.translate(0, 1.35, 0.1);
    b.add(M.whiteTrim, placeOnWall(hour, f.at(48.65), f.n));
    b.add(M.whiteTrim, placeOnWall(minute, f.at(48.65), f.n));
  }

  // 鐘樓層 53.5–60：每面三個尖拱百葉開口
  const BW = 4.45;
  concrete(b, loft([ringSquare(TW + 0.12, SHAFT_TOP - 0.3), ringSquare(TW + 0.12, SHAFT_TOP + 0.1)], { capTop: true }));
  b.add(M.basalt, boxAC(-3.5, 3.5, -3.5, 3.5, SHAFT_TOP, 60));
  const belfryFaces: { n: THREE.Vector3; p: THREE.Vector3 }[] = [
    { n: FRONT, p: V(BW - 0.7, SHAFT_TOP, 0) },
    { n: BACK, p: V(-BW + 0.7, SHAFT_TOP, 0) },
    { n: SIDE(1), p: V(0, SHAFT_TOP, BW - 0.7) },
    { n: SIDE(-1), p: V(0, SHAFT_TOP, -BW + 0.7) },
  ];
  for (const f of belfryFaces) {
    const s = new THREE.Shape([new THREE.Vector2(-BW, 0), new THREE.Vector2(BW, 0), new THREE.Vector2(BW, 6.5), new THREE.Vector2(-BW, 6.5)]);
    for (const x of [-2.4, 0, 2.4]) s.holes.push(new THREE.Path(pointedArchPoints(0.95, 4.8, false).map((p) => new THREE.Vector2(p.x + x, p.y + 0.8))));
    concrete(b, placeOnWall(new THREE.ExtrudeGeometry(s, { depth: 0.7, bevelEnabled: false, curveSegments: 1 }), f.p.clone(), f.n));
    // 百葉
    for (const x of [-2.4, 0, 2.4])
      for (let k = 0; k < 7; k++) {
        const slat = new THREE.BoxGeometry(0.9, 0.06, 0.25);
        slat.rotateX(-0.6);
        slat.translate(x, 1.3 + k * 0.55, 0.1);
        b.add(M.anthracite, placeOnWall(slat, f.p.clone(), f.n));
      }
  }

  // 塔尖 58.5–72.7：內核錐體（略凹）＋ 一層層向內收的小尖塔（夜間打燈）
  const y0 = 58.5;
  const layers = 11;
  const coreRings: Ring[] = [];
  for (let k = 0; k <= layers; k++) {
    const t = k / layers;
    coreRings.push(ringSquare(0.35 + 3.9 * Math.pow(1 - t, 1.25), y0 + 13.7 * t));
  }
  concrete(b, loft(coreRings, { capTop: true }), M.concreteGlow);
  concrete(b, loft([ringSquare(4.6, 59.8), ringSquare(4.6, 60.2)], { capTop: true }));
  for (let k = 0; k < layers; k++) {
    const t = k / layers;
    const y = y0 + 1.5 + 12.2 * t;
    const hw = 0.55 + 3.95 * Math.pow(1 - t, 1.25);
    const ph = 2.3 - 0.9 * t;
    for (let face = 0; face < 4; face++) {
      const n = Math.max(1, Math.floor((2 * hw - 0.5) / 0.7));
      for (let i = 0; i <= n; i++) {
        const s0 = -hw + 0.25 + ((2 * hw - 0.5) * i) / n;
        const g = new THREE.BoxGeometry(0.46, ph, 0.55);
        g.translate(s0, ph / 2, hw - 0.18);
        const cap = new THREE.ConeGeometry(0.33, 0.6, 4);
        cap.rotateY(Math.PI / 4);
        cap.translate(s0, ph + 0.3, hw - 0.18);
        for (const part of [g, cap]) {
          part.rotateY((face * Math.PI) / 2);
          part.translate(0, y, 0);
          concrete(b, part, M.concreteGlow);
        }
      }
    }
  }
  b.add(M.whiteTrim, box(0.5, 0.7, 0.5, 0, 72.2, 0));
  b.add(M.whiteTrim, box(0.16, 1.6, 0.16, 0, 72.9, 0));
  b.add(M.whiteTrim, box(0.9, 0.16, 0.16, 0, 73.85, 0));
}

function ringSquare(hw: number, y: number): Ring {
  return [new THREE.Vector3(hw, y, hw), new THREE.Vector3(hw, y, -hw), new THREE.Vector3(-hw, y, -hw), new THREE.Vector3(-hw, y, hw)];
}

// ---- 兩翼：玄武岩柱狀的階梯柱列 ----

/** 正面柱高（由塔往外，照片量測），共 31 根，間距 0.645 m */
const FRONT_H = (() => {
  const h = [51, 47, 44, 40, 35, 31, 26, 22, 19, 16, 14, 12.7, 11.7, 10.9, 10.3, 9.7, 9.3, 8.9];
  for (let i = 0; i < 13; i++) h.push(8.6 - (1.6 * i) / 12);
  return h;
})();
const COL_SPACING = 0.645;

/** 兩翼屋頂高度（OSM 深色屋面，由塔往外遞減的凹曲線） */
function wingRoof(c: number): number {
  const pts: [number, number][] = [
    [4.7, 12.8], [5.55, 12.3], [6.1, 11.8], [6.65, 11.3], [7.15, 10.9], [7.65, 10.5], [8.2, 10], [8.8, 9.5], [9.35, 9.2],
    [9.95, 8.8], [10.65, 8.4], [11.35, 8], [12.15, 7.6], [13.3, 7.1], [14.65, 6.6], [15.95, 6.2], [17.3, 5.9], [18.8, 5.6], [20.9, 5.3], [24.7, 5.0],
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    const [c0, h0] = pts[i];
    const [c1, h1] = pts[i + 1];
    if (c <= c1) return h0 + ((h1 - h0) * (c - c0)) / (c1 - c0);
  }
  return 5;
}

/** 正面柱列的前緣位置：靠近塔處較後、往外逐漸前凸 */
function frontEdge(c: number): number {
  return Math.min(7.9, 6.1 + Math.max(0, c - 5.1) * 0.75);
}

function column(c: number, a1: number, depth: number, h: number, facing: 1 | -1): THREE.BufferGeometry {
  // 平面：寬 0.5 m，外側兩角切角，呈玄武岩柱般的稜面
  const w = 0.25;
  const ch = 0.12;
  const f = a1;
  const r = a1 - depth * facing;
  const pts: [number, number][] =
    facing === 1
      ? [[r, c - w], [r, c + w], [f - ch, c + w], [f, c + w - ch], [f, c - w + ch], [f - ch, c - w]]
      : [[r, c + w], [r, c - w], [f + ch, c - w], [f, c - w + ch], [f, c + w - ch], [f + ch, c + w]];
  return prismAC(pts, G, h);
}

function buildWings(b: Batch) {
  for (const side of [1, -1]) {
    FRONT_H.forEach((hf, i) => {
      const c = TW + COL_SPACING * (i + 0.5);
      const a1 = frontEdge(c);
      concrete(b, column(side * c, a1, 1.2, hf, 1));
      // 背面柱列較矮
      const hr = Math.max(6.2, hf * 0.88);
      concrete(b, column(side * c, -4.8, 1.1, hr, -1));
      // 柱列之間的翼體與深色凹曲屋面（逐格階梯近似）
      const rh = wingRoof(c);
      const c0 = side * (c - COL_SPACING / 2);
      const c1 = side * (c + COL_SPACING / 2);
      concrete(b, boxAC(-4.3, a1 - 0.7, Math.min(c0, c1), Math.max(c0, c1), G, rh - 0.15));
      b.add(M.darkRoof, boxAC(-4.3, a1 - 0.7, Math.min(c0, c1), Math.max(c0, c1), rh - 0.15, rh + 0.02));
    });
    // 翼端牆
    const cEnd = TW + COL_SPACING * FRONT_H.length;
    concrete(b, boxAC(-4.8, 7.9, Math.min(side * cEnd, side * (cEnd + 0.45)), Math.max(side * cEnd, side * (cEnd + 0.45)), G, 6.2));
  }
}

// ---- 中殿與後殿 ----

const NAVE = { a0: -46.2, a1: -TW, hw: 8.25, eave: 17.9, ridge: 26.9 };

function buildNave(b: Batch) {
  concrete(b, boxAC(NAVE.a0, NAVE.a1, -NAVE.hw, NAVE.hw, G, NAVE.eave));
  // 側廊（4.5 m）與小方窗
  for (const s of [1, -1]) {
    concrete(b, boxAC(NAVE.a0 + 0.1, NAVE.a1, Math.min(s * NAVE.hw, s * 10.3), Math.max(s * NAVE.hw, s * 10.3), G, 4.5));
    b.add(M.whiteTrim, boxAC(NAVE.a0 + 0.1, NAVE.a1, Math.min(s * NAVE.hw, s * 10.45), Math.max(s * NAVE.hw, s * 10.45), 4.5, 4.7));
    for (let a = NAVE.a1 - 1.2; a > NAVE.a0 + 1; a -= 1.45) {
      const g = new THREE.BoxGeometry(0.7, 0.9, 0.06);
      g.translate(0, 0.45, 0.02);
      b.add(M.glassDark, placeOnWall(g, V(a, 2.1, s * 10.3), SIDE(s)));
    }
  }

  // 屋頂：雙坡，深色金屬立縫
  const ov = 0.35;
  const slope = (s: number) => {
    const eave = V(0, NAVE.eave, s * (NAVE.hw + ov));
    const ridge = V(0, NAVE.ridge, 0);
    const pos: number[] = [];
    const a0 = NAVE.a0 - 0.2;
    const a1 = NAVE.a1 + 0.3;
    const q = [
      new THREE.Vector3(eave.x, eave.y, -a0), new THREE.Vector3(eave.x, eave.y, -a1),
      new THREE.Vector3(ridge.x, ridge.y, -a1), new THREE.Vector3(ridge.x, ridge.y, -a0),
    ];
    for (const k of [0, 1, 2, 0, 2, 3]) pos.push(q[k].x, q[k].y, q[k].z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    b.add(M.darkRoof, g);
    // 立縫
    const seams: THREE.BufferGeometry[] = [];
    for (let a = a1 - 0.3; a > a0; a -= 0.55)
      seams.push(beam(new THREE.Vector3(eave.x, eave.y + 0.04, -a), new THREE.Vector3(0, NAVE.ridge + 0.04, -a), 0.06));
    b.add(M.darkRoof, merge(seams));
    b.add(M.whiteTrim, boxAC(a0, a1, Math.min(s * (NAVE.hw + ov), s * (NAVE.hw + ov + 0.15)), Math.max(s * (NAVE.hw + ov), s * (NAVE.hw + ov + 0.15)), NAVE.eave - 0.3, NAVE.eave + 0.05));
  };
  slope(1);
  slope(-1);
  b.add(M.darkRoof, boxAC(NAVE.a0 - 0.2, NAVE.a1 + 0.3, -0.18, 0.18, NAVE.ridge - 0.1, NAVE.ridge + 0.2));

  // 側窗與階梯狀扶壁
  for (const s of [1, -1]) {
    for (let i = 0; i < 9; i++) lancetWindow(b, 1.7, 9.2, V(-8.7 - i * 4.35, 5.6, s * NAVE.hw), SIDE(s), 1);
    for (let k = 0; k < 10; k++) {
      const a = -6.5 - k * 4.35;
      const fin = (out: number, top: number) =>
        concrete(b, boxAC(a - 0.35, a + 0.35, Math.min(s * NAVE.hw, s * (NAVE.hw + out)), Math.max(s * NAVE.hw, s * (NAVE.hw + out)), G, top));
      fin(0.9, NAVE.eave + 0.5);
      fin(1.5, 9);
      fin(2.1, 6.5);
    }
  }

  // 中殿與後殿之間的階梯山牆
  for (let j = 0; j < 8; j++) {
    const hw = NAVE.hw + 0.3 - j * 1.07;
    concrete(b, boxAC(NAVE.a0 - 0.7, NAVE.a0 + 0.4, -hw, hw, NAVE.eave - 0.5 + j * 1.18, NAVE.eave + (j + 1) * 1.18 + 0.2));
  }
}

function buildApse(b: Batch) {
  const ca = -52.4;
  const center = (y: number) => V(ca, y, 0);
  const base = new THREE.CylinderGeometry(8.4, 8.4, 4.5 - G, 64);
  base.translate(0, (4.5 + G) / 2, 0);
  base.translate(center(0).x, 0, center(0).z);
  concrete(b, base);
  const drum = new THREE.CylinderGeometry(6.9, 6.9, 17.6 - G, 72);
  drum.translate(center(0).x, (17.6 + G) / 2, center(0).z);
  concrete(b, drum);
  b.add(M.whiteTrim, cylinder(7.05, 0.35, center(0).x, 17.4, center(0).z, 72));

  // 圓頂：略帶尖頂的盔形
  const prof = [
    [0, 17.6], [6.95, 17.6], [6.95, 18.6], [6.75, 20.4], [6.25, 22.3], [5.5, 24.1], [4.5, 25.7],
    [3.3, 27.0], [2.1, 28.0], [1.0, 28.8], [0.35, 29.5], [0, 30.2],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const dome = new THREE.LatheGeometry(prof, 72);
  dome.translate(center(0).x, 0, center(0).z);
  concrete(b, dome);
  b.add(M.whiteTrim, cylinder(0.22, 1.9, center(0).x, 30.1, center(0).z, 12, 0.02));

  // 後殿尖拱窗（7 扇）與其間的階梯扶壁，避開連接中殿的一側
  const stepDeg = 160 / 6;
  for (let i = 0; i < 7; i++) {
    const t = (-80 + i * stepDeg) * DEG;
    const dir = new THREE.Vector3(Math.sin(t), 0, Math.cos(t));
    lancetWindow(b, 1.25, 7.6, center(7.2).add(dir.clone().multiplyScalar(6.9)), dir, 1);
  }
  for (let j = 0; j < 8; j++) {
    const tt = (-80 - stepDeg / 2 + j * stepDeg) * DEG;
    const fin = (w: number, h: number, d: number) => {
      const g = new THREE.BoxGeometry(w, h - G, d);
      g.translate(0, (h + G) / 2, 6.9 + d / 2 - 0.2);
      g.rotateY(tt);
      g.translate(center(0).x, 0, center(0).z);
      concrete(b, g);
    };
    fin(0.6, 17.9, 1.4);
    fin(0.6, 8, 2.4);
  }
}

// ---- 廣場、萊夫像、草坪與鞦韆 ----

const PLAZA: [number, number][] = [[8, -26], [8, 26], [40, 24], [86, 12], [86, -12], [40, -24]];
const NE_LAWN: [number, number][] = [[14, 26.5], [40, 24.5], [86, 12.5], [86, 30], [74, 44], [14, 44]];
const SW_LAWN: [number, number][] = NE_LAWN.map(([a, c]) => [a, -c] as [number, number]).reverse();
const LAWN_H = 0.6;
const SWING = { a: 66, c: 33 };
const LEIF = { a: 54, c: 0 };

function flatAC(pts: [number, number][], y: number) {
  return flat(pts.map(([a, c]) => [c, -a] as [number, number]), y);
}

function buildSite(b: Batch) {
  // 整個範圍的底面（Google 模型在此挖空，需要自己的地面）
  const all: [number, number][] = [[-64, -44], [-64, 44], [40, 46], [88, 46], [92, 0], [88, -46], [40, -46]];
  b.add(M.path, planarUV(flatAC(all, 0), 6));
  b.add(M.plaza, planarUV(flatAC(PLAZA, 0.03), 12));
  b.add(M.grass, planarUV(flatAC(SW_LAWN, 0.04), 8));
  // 東北側草坪抬高，外緣為玄武岩擋土牆
  b.add(M.basalt, planarUV(prismAC(NE_LAWN, -0.4, LAWN_H - 0.02), 2));
  b.add(M.grass, planarUV(flatAC(NE_LAWN, LAWN_H), 8));

  // 萊夫·艾瑞克森像：圓形低台＋船首形紅色花崗岩基座（4.6 m）＋青銅像（約 3 m）
  const L = V(LEIF.a, 0, LEIF.c);
  b.add(M.granite, cylinder(6.4, 0.4, L.x, 0, L.z, 64, 5.6));
  for (let k = 0; k < 5; k++) {
    const y0 = 0.4 + k * 0.92;
    const tip = 2.3 + k * 0.22;
    const inset = k * 0.06;
    const pts: [number, number][] = [
      [LEIF.a - 2.0 + inset, -1.6 + inset], [LEIF.a + 0.9, -1.6 + inset], [LEIF.a + tip, 0],
      [LEIF.a + 0.9, 1.6 - inset], [LEIF.a - 2.0 + inset, 1.6 - inset],
    ];
    b.add(M.redGranite, prismAC(pts, y0, y0 + 0.9));
    b.add(M.redGranite, prismAC(pts.map(([a, c]) => [a + (a > LEIF.a ? 0.05 : -0.05), c * 1.03] as [number, number]), y0 + 0.86, y0 + 0.92));
  }
  b.add(M.whiteTrim, boxAC(LEIF.a - 2.06, LEIF.a - 1.98, -0.9, 0.9, 1.6, 3.2));
  buildLeif(b, V(LEIF.a, 5.0, LEIF.c));

  // 草坪上的旗杆與一圈矮方柱
  for (let k = 0; k < 5; k++) {
    const p = V(55 + k * 1.6, LAWN_H, 25.5 + k * 1.4);
    b.add(M.whiteTrim, cylinder(0.07, 9, p.x, p.y, p.z, 10, 0.04));
    b.add(M.whiteTrim, cylinder(0.2, 0.3, p.x, p.y, p.z, 10));
  }
  for (let k = 0; k < 24; k++) {
    const t = (k / 24) * Math.PI * 2;
    const p = V(47 + Math.cos(t) * 8, LAWN_H, 33 + Math.sin(t) * 7);
    b.add(M.granite, box(0.35, 0.55, 0.35, p.x, p.y, p.z));
  }

  // 幾棵北國針葉樹
  const conifers: [number, number, number][] = [[20, 40, 7], [26, 41, 8], [32, 40, 6.5], [18, -40, 7.5], [25, -41, 6], [-20, 30, 9], [-30, 31, 8], [-20, -30, 8.5]];
  for (const [a, c, h] of conifers) {
    const p = V(a, a > 10 && c > 0 ? LAWN_H : 0, c);
    b.add(M.trunk, cylinder(0.14, h * 0.3, p.x, p.y, p.z, 6));
    for (let k = 0; k < 3; k++) b.add(M.foliage, cylinder(h * (0.28 - k * 0.07), h * 0.45, p.x, p.y + h * (0.22 + k * 0.22), p.z, 8, 0.05));
  }

  buildSwing(b, V(SWING.a, LAWN_H, SWING.c));
}

/** 萊夫·艾瑞克森青銅像（朝向正面 +a） */
function buildLeif(b: Batch, base: THREE.Vector3) {
  const parts: THREE.BufferGeometry[] = [];
  const at = (g: THREE.BufferGeometry, a: number, y: number, c: number) => {
    g.translate(c, y, -a);
    parts.push(g);
  };
  for (const c of [-0.16, 0.16]) at(new THREE.CylinderGeometry(0.12, 0.15, 1.35, 10), c * 0.2, 0.68, c);
  at(new THREE.BoxGeometry(0.34, 0.12, 0.5), 0.08, 0.06, -0.16);
  at(new THREE.BoxGeometry(0.34, 0.12, 0.5), 0.08, 0.06, 0.16);
  at(new THREE.CylinderGeometry(0.3, 0.26, 0.55, 14), 0, 1.6, 0); // 鎖子甲下擺
  at(new THREE.CylinderGeometry(0.33, 0.3, 0.6, 14), 0, 2.05, 0);
  const cloak = new THREE.CylinderGeometry(0.42, 0.62, 2.1, 20, 1, true, -Math.PI * 0.45, Math.PI * 0.9);
  at(cloak, -0.05, 1.3, 0);
  at(new THREE.SphereGeometry(0.17, 16, 12), 0, 2.58, 0);
  const helm = new THREE.SphereGeometry(0.185, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  at(helm, 0, 2.62, 0);
  at(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 16), 0, 2.62, 0);
  // 手臂與斧頭
  for (const c of [-0.42, 0.42]) {
    const arm = new THREE.CylinderGeometry(0.075, 0.09, 0.85, 8);
    arm.rotateX(c > 0 ? -0.35 : 0.15);
    at(arm, 0.1, 1.9, c);
  }
  at(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), 0.3, 1.5, 0.5);
  at(new THREE.BoxGeometry(0.04, 0.3, 0.28), 0.3, 2.25, 0.62);
  const sword = new THREE.BoxGeometry(0.08, 0.03, 1.1);
  at(sword, 0.4, 0.03, -0.35);
  const g = merge(parts);
  g.translate(base.x, base.y, base.z);
  b.add(M.bronze, g);
}

/** 星形鞦韆：中央立柱、五支放射橫樑、外側斜腳，每支橫樑下吊一座橡膠帶鞦韆 */
function buildSwing(b: Batch, o: THREE.Vector3) {
  const mat = new THREE.CircleGeometry(4.6, 5);
  mat.rotateX(-Math.PI / 2);
  mat.rotateY(Math.PI / 10);
  mat.translate(o.x, o.y + 0.02, o.z);
  b.add(M.rubberMat, planarUV(mat, 1.5));

  const frame: THREE.BufferGeometry[] = [];
  const top = 2.55;
  frame.push(box(0.16, top + 0.12, 0.16, o.x, o.y, o.z));
  const chain: THREE.BufferGeometry[] = [];
  const seats: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) {
    const t = (k / 5) * Math.PI * 2 + Math.PI / 10;
    const d = new THREE.Vector3(Math.cos(t), 0, Math.sin(t));
    const end = o.clone().addScaledVector(d, 3.1).setY(o.y + top);
    frame.push(beam(o.clone().setY(o.y + top), end, 0.13));
    frame.push(beam(end, o.clone().addScaledVector(d, 3.75).setY(o.y), 0.11));
    // 兩條鏈子掛在橫樑上（間距 0.5 m），座椅沿橫樑方向
    for (const r of [1.45, 1.95]) {
      const p = o.clone().addScaledVector(d, r);
      const links = 36;
      for (let i = 0; i < links; i++) {
        const link = new THREE.TorusGeometry(0.022, 0.006, 4, 8);
        link.scale(1, 1.6, 1);
        if (i % 2) link.rotateY(Math.PI / 2);
        link.rotateY(-t);
        link.translate(p.x, o.y + top - 0.05 - i * 0.055, p.z);
        chain.push(link);
      }
    }
    const seat = new THREE.BoxGeometry(0.62, 0.04, 0.17);
    seat.rotateY(-t);
    const mid = o.clone().addScaledVector(d, 1.7);
    seat.translate(mid.x, o.y + top - 0.05 - 36 * 0.055, mid.z);
    seats.push(seat);
  }
  b.add(M.anthracite, merge(frame));
  b.add(M.steel, merge(chain));
  b.add(M.rubber, merge(seats));
}

export function buildHallgrimskirkja(): { group: THREE.Group; labels: MapLabel[] } {
  const b = new Batch();
  buildTower(b);
  buildWings(b);
  buildNave(b);
  buildApse(b);
  buildSite(b);
  const inner = b.build('hallgrimskirkja', { castShadow: true, receiveShadow: true });
  inner.rotation.y = (360 - FRONT_BEARING) * DEG;
  const group = new THREE.Group();
  group.name = 'hallgrimskirkja';
  group.add(inner);
  const lab = (text: string, a: number, c: number, minZoom?: number): MapLabel => {
    const [e, n] = acToEN(a, c);
    return { text, x: e, z: -n, minZoom };
  };
  return {
    group,
    labels: [lab('哈爾格林姆教堂', -20, 0), lab('萊夫·艾瑞克森像', LEIF.a, LEIF.c, 1), lab('鞦韆', SWING.a, SWING.c, 1)],
  };
}
