import * as THREE from 'three';
import { offsetLatLon, type LatLon } from '../geo';
import type { MapLabel, Preset } from '../world/types';
import {
  Batch, box, cylinder, extrude, flat, frameFromOutlines, loft, merge, placeOnWall, planarUV,
  roundArchPoints, type Ring,
} from './geometry';
import { M, NIGHT_GLOW } from './materials';

// 羅森堡宮（Rosenborg Slot，哥本哈根）精細模型：荷蘭文藝復興式紅磚城堡、護城河、格林橋與國王花園入口。
//
// 建模座標：u 沿主樓長軸指向東南（方位 129.6°），v 指向東北花園側（方位 39.6°）；原點＝主樓中心。
// 模型空間 X = u、Z = −v、Y 朝上，整組再旋轉 −39.6° 對齊真實方位。
// 尺寸來源：OpenStreetMap building:part（way 383465247–383510583，含各塔高度、屋頂形式、材質顏色；
// 經 Overture Maps 2026-09-23 版取得）、護城河 way 86370283、河岸牆 way 1362802362、Grønne Bro way 26177232、
// 兩尊臥獅 way 1364009061/2；立面細部（窗距、山牆、塔頂層次）依照片與維基百科描述估計。

const DEG = Math.PI / 180;

export const ROSENBORG_ANCHOR: LatLon = { lat: 55.685687, lon: 12.577433 };
const AXIS_BEARING = 129.6;
const SU = Math.sin(AXIS_BEARING * DEG);
const CU = Math.cos(AXIS_BEARING * DEG);
const SV = Math.sin((AXIS_BEARING - 90) * DEG);
const CV = Math.cos((AXIS_BEARING - 90) * DEG);

/** (u, v) → 相對主樓中心的（東、北）公尺 */
function uvToEN(u: number, v: number): [number, number] {
  return [u * SU + v * SV, u * CU + v * CV];
}

export function rosenborgLatLon(u: number, v: number): LatLon {
  const [e, n] = uvToEN(u, v);
  return offsetLatLon(ROSENBORG_ANCHOR, e, n);
}

/** 自建模型涵蓋範圍：城堡、前庭草坪、護城河（至北側花園邊）、格林橋與花園入口的臥獅 */
const MASK_UV: [number, number][] = [
  [-28, 22], [-28, -26.5], [-23.5, -27.6], [-22.5, -56], [62, -56], [62, -6], [65, -6], [65, 9], [61, 9], [59, 22],
];
export const ROSENBORG_MASK: LatLon[] = MASK_UV.map(([u, v]) => rosenborgLatLon(u, v));

export const ROSENBORG = {
  /** 主塔塔尖（OSM way 383465284） */
  towerTop: 50.6,
  eave: 13.8,
  ridge: 20.4,
};

// ---- 材質與貼圖（羅森堡專用；名稱會帶進 GLB，Unity 版依名稱調整 HDRP 材質） ----

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 可重現的偽亂數（貼圖每次產生都一樣） */
function prng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

/** 紅磚（荷蘭式砌法：順磚與丁磚交替），貼圖涵蓋 2 m × 2 m：磚長 23 cm、層高 6.9 cm */
const brickTex = canvasTexture(1024, (ctx, s) => {
  const rnd = prng(1606);
  ctx.fillStyle = '#a99d8a';
  ctx.fillRect(0, 0, s, s);
  const rows = 29;
  const rh = s / rows;
  for (let r = 0; r < rows; r++) {
    const header = r % 2 === 1;
    const bw = header ? s / 17.4 : s / 8.7;
    const off = header ? bw / 2 : r % 4 === 0 ? 0 : bw / 4;
    for (let x = -off; x < s; x += bw) {
      const k = rnd();
      const base = header ? [116, 46, 36] : [136, 56, 42];
      const d = (k - 0.5) * 34;
      ctx.fillStyle = `rgb(${base[0] + d},${base[1] + d * 0.45},${base[2] + d * 0.35})`;
      ctx.fillRect(x + 1.5, r * rh + 1.5, bw - 3, rh - 3);
      if (k > 0.9) {
        ctx.fillStyle = 'rgba(40,20,15,0.25)';
        ctx.fillRect(x + 1.5, r * rh + 1.5, bw - 3, rh - 3);
      }
    }
  }
});

/** 砂岩：細微層理與斑點 */
const sandstoneTex = canvasTexture(256, (ctx, s) => {
  const rnd = prng(1624);
  ctx.fillStyle = '#d2c3a2';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 2200; i++) {
    const v = rnd();
    ctx.fillStyle = v > 0.5 ? 'rgba(120,100,70,0.08)' : 'rgba(255,250,235,0.1)';
    ctx.fillRect(rnd() * s, rnd() * s, 2 + rnd() * 6, 1 + rnd() * 2);
  }
  ctx.fillStyle = 'rgba(90,75,55,0.18)';
  for (let y = 0; y < s; y += s / 4) ctx.fillRect(0, y, s, 1.5);
});

/** 銅板屋面（綠色銅鏽）：立縫間距 0.6 m，雨痕與色差；貼圖涵蓋 2.4 m */
const copperTex = canvasTexture(512, (ctx, s) => {
  const rnd = prng(1634);
  ctx.fillStyle = '#6f9c86';
  ctx.fillRect(0, 0, s, s);
  const seams = 4;
  for (let i = 0; i < seams; i++) {
    const x0 = (i * s) / seams;
    const v = (rnd() - 0.5) * 24;
    ctx.fillStyle = `rgb(${111 + v},${156 + v},${134 + v * 0.8})`;
    ctx.fillRect(x0 + 3, 0, s / seams - 6, s);
    for (let k = 0; k < 60; k++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(40,70,60,0.12)' : 'rgba(200,230,215,0.12)';
      ctx.fillRect(x0 + 4 + rnd() * (s / seams - 8), rnd() * s, 1 + rnd() * 3, 20 + rnd() * 90);
    }
    ctx.fillStyle = 'rgba(30,55,45,0.55)';
    ctx.fillRect(x0, 0, 3, s);
    ctx.fillStyle = 'rgba(210,235,220,0.35)';
    ctx.fillRect(x0 + 3, 0, 1.5, s);
  }
  for (let y = 0; y < s; y += s / 6) {
    ctx.fillStyle = 'rgba(40,70,60,0.18)';
    ctx.fillRect(0, y, s, 1.5);
  }
});

/** 鉛條窗格（小方格）：貼圖對應一個窗扇 */
const leadedTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#2a3238';
  ctx.fillRect(0, 0, s, s);
  const g = ctx.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, 'rgba(160,185,200,0.35)');
  g.addColorStop(1, 'rgba(40,50,60,0.1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#11161a';
  ctx.lineWidth = 3;
  const n = 6;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath();
    ctx.moveTo((i * s) / n, 0);
    ctx.lineTo((i * s) / n, s);
    ctx.moveTo(0, (i * s) / n);
    ctx.lineTo(s, (i * s) / n);
    ctx.stroke();
  }
});

/** 碎石步道 */
const gravelTex = canvasTexture(256, (ctx, s) => {
  const rnd = prng(1610);
  ctx.fillStyle = '#bcae93';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 9000; i++) {
    const v = 140 + rnd() * 90;
    ctx.fillStyle = `rgba(${v},${v * 0.93},${v * 0.8},0.55)`;
    ctx.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 2.5, 1 + rnd() * 2.5);
  }
});

const std = (name: string, p: THREE.MeshStandardMaterialParameters) => {
  const m = new THREE.MeshStandardMaterial(p);
  m.name = name;
  return m;
};

const R = {
  brick: std('brick', { color: 0xffffff, roughness: 0.88, map: brickTex }),
  sandstone: std('sandstone', { color: 0xffffff, roughness: 0.75, map: sandstoneTex }),
  copper: std('copper', { color: 0xffffff, roughness: 0.6, metalness: 0.3, map: copperTex, side: THREE.DoubleSide }),
  leadedGlass: std('leadedGlass', { color: 0xffffff, roughness: 0.12, metalness: 0.3, map: leadedTex }),
  gravel: std('gravel', { color: 0xffffff, roughness: 0.95, map: gravelTex }),
  ironGreen: std('ironGreen', { color: 0x2f4a3a, roughness: 0.5, metalness: 0.5 }),
  darkStone: std('darkStone', { color: 0x6b6a66, roughness: 0.85 }),
  lionStone: std('lionStone', { color: 0xb9ad98, roughness: 0.8 }),
  /** 台基：厄蘭島石灰岩（ølandssten） */
  olandStone: std('olandStone', { color: 0x9a8d80, roughness: 0.8 }),
  /** 凸窗與附屬塔的鉛皮屋頂 */
  lead: std('lead', { color: 0x5a5f63, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }),
  timber: std('timber', { color: 0x6b5a45, roughness: 0.85 }),
};

// 夜間：城堡立面投光（暖色）、窗內燈光
NIGHT_GLOW.push(
  { material: R.brick, color: 0xffd9b0, intensity: 0.07 },
  { material: R.sandstone, color: 0xfff0d0, intensity: 0.1 },
  { material: R.copper, color: 0xd8fff0, intensity: 0.05 },
  { material: R.leadedGlass, color: 0xffcf8a, intensity: 0.45 },
);

// ---- 座標工具 ----

const V = (u: number, y: number, v: number) => new THREE.Vector3(u, y, -v);
/** 立面朝外方向（模型空間） */
const N_SW = new THREE.Vector3(0, 0, 1);
const N_NE = new THREE.Vector3(0, 0, -1);
const N_SE = new THREE.Vector3(1, 0, 0);
const N_NW = new THREE.Vector3(-1, 0, 0);

function boxUV(u0: number, u1: number, v0: number, v1: number, y0: number, y1: number): THREE.BufferGeometry {
  return box(u1 - u0, y1 - y0, v1 - v0, (u0 + u1) / 2, y0, -(v0 + v1) / 2);
}

function prismUV(pts: [number, number][], y0: number, y1: number): THREE.BufferGeometry {
  return extrude(pts.map(([u, v]) => [u, -v] as [number, number]), y0, y1);
}

function flatUV(pts: [number, number][], y: number): THREE.BufferGeometry {
  return flat(pts.map(([u, v]) => [u, -v] as [number, number]), y);
}

const brick = (b: Batch, g: THREE.BufferGeometry) => b.add(R.brick, planarUV(g, 2));
const stone = (b: Batch, g: THREE.BufferGeometry) => b.add(R.sandstone, planarUV(g, 1.5));
const copper = (b: Batch, g: THREE.BufferGeometry) => b.add(R.copper, g);
const plinth = (b: Batch, g: THREE.BufferGeometry) => b.add(R.olandStone, planarUV(g, 1.5));

/** 地基往下延伸，放在略有起伏的地面上也不會懸空 */
const G = -2;
/** 樓層分隔（砂岩腰線）高度：半地下室台基 0–1.2 m，其上三層樓，簷口 13.8 m */
const FLOORS = [1.2, 5.3, 9.3, ROSENBORG.eave];
/** 砂岩腰線（位於上層窗台下）與簷口 */
const BANDS = [5.75, 9.75, ROSENBORG.eave];
/** 窗：各層窗台高度與窗高 */
const WIN = [
  { sill: 2.0, h: 2.4 },
  { sill: 6.0, h: 2.4 },
  { sill: 10.0, h: 2.3 },
];
const WIN_W = 1.4;
/** 長立面 14 開間（Trap Danmark：2×14 fag），間距 3.2 m、對稱於中線 */
const AXES = Array.from({ length: 14 }, (_, k) => -20.8 + 3.2 * k);

// ---- 立面元件（皆在 XY 平面建立、+Z 朝外，再以 placeOnWall 貼到牆面） ----

function rectPts(x0: number, y0: number, x1: number, y1: number): THREE.Vector2[] {
  return [new THREE.Vector2(x0, y0), new THREE.Vector2(x1, y0), new THREE.Vector2(x1, y1), new THREE.Vector2(x0, y1)];
}

/**
 * 十字窗：鉛條玻璃、砂岩窗框與十字窗櫺、窗台；窗頂為砂岩三角山花，山花內有圓形頭像浮雕（Trap Danmark）。
 * pos 為窗底中央（牆面上）。
 */
function crossWindow(b: Batch, w: number, h: number, pos: THREE.Vector3, n: THREE.Vector3, pediment = true) {
  const at = (g: THREE.BufferGeometry) => placeOnWall(g, pos.clone(), n);
  const glass = new THREE.PlaneGeometry(w, h);
  glass.translate(0, h / 2, 0.03);
  // 十字分成四扇，每扇一格鉛條貼圖
  const uv = glass.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 2.4);
  b.add(R.leadedGlass, at(glass));
  const fw = 0.2;
  stone(b, at(frameFromOutlines(rectPts(-w / 2 - fw, -fw, w / 2 + fw, h + fw), rectPts(-w / 2, 0, w / 2, h), 0.14)));
  stone(b, at(merge([box(0.12, h, 0.1, 0, 0, 0.02), box(w, 0.12, 0.1, 0, h * 0.64, 0.02)])));
  stone(b, at(box(w + 0.7, 0.14, 0.26, 0, -0.34, 0.02)));
  if (!pediment) return;
  const y0 = h + fw;
  const hw = w / 2 + 0.45;
  stone(b, at(box(2 * hw, 0.16, 0.24, 0, y0, 0.02)));
  const tri = new THREE.Shape([new THREE.Vector2(-hw, 0), new THREE.Vector2(hw, 0), new THREE.Vector2(0, 0.6)]);
  const hole = new THREE.Path([new THREE.Vector2(-hw + 0.34, 0.1), new THREE.Vector2(0, 0.44), new THREE.Vector2(hw - 0.34, 0.1)]);
  tri.holes.push(hole);
  stone(b, at(new THREE.ExtrudeGeometry(tri, { depth: 0.2, bevelEnabled: false }).translate(0, y0 + 0.16, 0.02)));
  const head = new THREE.SphereGeometry(0.11, 8, 6);
  head.scale(1, 1.2, 0.6);
  head.translate(0, y0 + 0.33, 0.05);
  stone(b, at(head));
}

/** 牆面上的一排窗（沿牆的位置 ts，每層一扇） */
function windowColumn(b: Batch, at: (t: number, y: number) => THREE.Vector3, n: THREE.Vector3, ts: number[], floors = [0, 1, 2]) {
  for (const t of ts) for (const f of floors) crossWindow(b, WIN_W, WIN[f].h, at(t, WIN[f].sill), n);
}

/** 牆面腰線（砂岩帶），沿牆的區段 [t0, t1] */
function bandsOnWall(b: Batch, at: (t: number, y: number) => THREE.Vector3, n: THREE.Vector3, t0: number, t1: number, ys: number[], big = false) {
  for (const y of ys) {
    const top = y === ROSENBORG.eave;
    const h = top ? 0.45 : big ? 0.4 : 0.28;
    const d = top ? 0.32 : 0.1;
    const g = new THREE.BoxGeometry(t1 - t0 + (top ? 0.64 : 0.2), h, d);
    g.translate(0, (top ? -h : -h / 2) + (top ? 0.05 : 0), d / 2);
    stone(b, placeOnWall(g, at((t0 + t1) / 2, y), n));
  }
}

// ---- 荷蘭式山牆 ----

/** 山牆輪廓（XY，底邊中央為原點）：底段直立至 s0，其上兩道渦卷內收、頂部半圓山花 */
function gableOutline(W: number, H: number, s0: number): { pts: THREE.Vector2[]; levels: number[]; xs: number[] } {
  const L = (k: number) => (s0 + (1 - s0) * k) * H;
  const levels = [s0 * H, L(0.23), L(0.46), L(0.64), L(0.82), H];
  const xs = [W / 2, 0.34 * W, 0.21 * W];
  const half: THREE.Vector2[] = [new THREE.Vector2(xs[0], 0), new THREE.Vector2(xs[0], levels[0])];
  const scroll = (xa: number, xb: number, ya: number, yb: number) => {
    for (let i = 1; i <= 8; i++) {
      const t = (i / 8) * Math.PI / 2;
      half.push(new THREE.Vector2(xb + (xa - xb) * Math.cos(t), ya + (yb - ya) * Math.sin(t)));
    }
  };
  scroll(xs[0], xs[1], levels[0], levels[1]);
  half.push(new THREE.Vector2(xs[1], levels[2]));
  scroll(xs[1], xs[2], levels[2], levels[3]);
  half.push(new THREE.Vector2(xs[2], levels[4]));
  for (let i = 1; i < 10; i++) {
    const t = (i / 10) * Math.PI / 2;
    half.push(new THREE.Vector2(xs[2] * Math.cos(t), levels[4] + (H - levels[4]) * Math.sin(t)));
  }
  half.push(new THREE.Vector2(0, H));
  const left = half.slice(0, -1).reverse().map((p) => new THREE.Vector2(-p.x, p.y));
  return { pts: [...half, ...left], levels, xs };
}

/** 多邊形往內偏移 d（逆時針點列） */
function insetPolygon(pts: THREE.Vector2[], d: number): THREE.Vector2[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n];
    const c = pts[(i + 1) % n];
    const e0 = new THREE.Vector2().subVectors(p, a).normalize();
    const e1 = new THREE.Vector2().subVectors(c, p).normalize();
    const n0 = new THREE.Vector2(-e0.y, e0.x);
    const n1 = new THREE.Vector2(-e1.y, e1.x);
    const bis = n0.add(n1);
    const len = bis.length();
    if (len < 1e-6) return p.clone();
    bis.divideScalar(len);
    const cos = Math.max(0.35, bis.dot(new THREE.Vector2(-e1.y, e1.x)));
    return p.clone().addScaledVector(bis, d / cos);
  });
}

/** 方尖碑飾（砂岩底座＋四角錐＋小球） */
function obelisk(b: Batch, x: number, y: number, s = 1): THREE.BufferGeometry {
  const parts = [box(0.42 * s, 0.3 * s, 0.42 * s, x, y, 0)];
  const cone = new THREE.ConeGeometry(0.2 * s, 1.2 * s, 4);
  cone.rotateY(Math.PI / 4);
  cone.translate(x, y + 0.3 * s + 0.6 * s, 0);
  parts.push(cone);
  const ball = new THREE.SphereGeometry(0.1 * s, 8, 6);
  ball.translate(x, y + 1.55 * s, 0);
  parts.push(ball);
  void b;
  return merge(parts);
}

/**
 * 荷蘭式山牆：磚砌牆身（厚 depth，外皮在牆面）＋砂岩壓頂、各段腰線、方尖碑與頂端鍍金尖飾、山牆小窗。
 * pos 為山牆底邊中央（簷口高度、牆面上）。
 */
function dutchGable(b: Batch, W: number, H: number, s0: number, pos: THREE.Vector3, n: THREE.Vector3, depth: number, windows: number) {
  const { pts, levels, xs } = gableOutline(W, H, s0);
  const at = (g: THREE.BufferGeometry) => placeOnWall(g, pos.clone(), n);
  const body = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth, bevelEnabled: false, curveSegments: 1 });
  body.translate(0, 0, -depth);
  brick(b, at(body));
  const coping = frameFromOutlines(pts, insetPolygon(pts, 0.22), depth + 0.12);
  coping.translate(0, 0, -depth);
  stone(b, at(coping));
  // 腰線：各段起點
  for (const [k, x] of [[0, xs[0]], [2, xs[1]], [4, xs[2]]] as const) {
    const g = new THREE.BoxGeometry(2 * x + 0.1, 0.24, 0.12);
    g.translate(0, levels[k] - 0.12, 0.06);
    stone(b, at(g));
  }
  // 方尖碑：每段外角；頂端鍍金球與尖
  const obs: THREE.BufferGeometry[] = [];
  for (const [k, x] of [[0, xs[0]], [2, xs[1]], [4, xs[2]]] as const)
    for (const s of [-1, 1]) obs.push(obelisk(b, s * (x - 0.2), levels[k], k === 0 ? 1 : 0.8));
  const ob = merge(obs);
  ob.translate(0, 0, -0.1);
  stone(b, at(ob));
  // 渦卷眼（每道渦卷一對）
  const eyes: THREE.BufferGeometry[] = [];
  for (const [k, xo, xi] of [[0, xs[0], xs[1]], [2, xs[1], xs[2]]] as const)
    for (const s of [-1, 1]) {
      const cx = s * (xi + (xo - xi) * 0.42);
      const cy = levels[k] + (levels[k + 1] - levels[k]) * 0.3;
      const r = Math.min(0.42, (xo - xi) * 0.32);
      eyes.push(new THREE.TorusGeometry(r, 0.07, 6, 14).translate(cx, cy, 0.04));
      eyes.push(new THREE.CircleGeometry(r * 0.45, 10).translate(cx, cy, 0.06));
    }
  stone(b, at(merge(eyes)));
  // 頂端：小基座上的石雕人像與鍍金球
  const statue = merge([
    box(0.6, 0.3, 0.5, 0, H - 0.05, 0),
    new THREE.CylinderGeometry(0.17, 0.26, 0.95, 10).translate(0, H + 0.72, 0),
    new THREE.SphereGeometry(0.15, 10, 8).translate(0, H + 1.34, 0),
  ]);
  statue.translate(0, 0, -0.15);
  stone(b, at(statue));
  const tip = merge([cylinder(0.04, 0.5, 0, H + 1.45, 0, 6), new THREE.SphereGeometry(0.1, 8, 6).translate(0, H + 2.0, 0)]);
  tip.translate(0, 0, -0.15);
  b.add(M.gold, at(tip));
  // 山牆窗：底段一排、中段一扇、頂部圓窗
  const wy = Math.max(0.5, levels[0] * 0.25);
  const ww = Math.min(1.1, (2 * xs[0]) / (windows + 1.5));
  for (let i = 0; i < windows; i++) {
    const x = (i - (windows - 1) / 2) * (2 * xs[0] / (windows + 0.5));
    crossWindow(b, ww, Math.min(2.0, levels[1] - wy - 0.8), pos.clone().add(new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n).multiplyScalar(x)).setY(pos.y + wy), n, false);
  }
  crossWindow(b, 0.8, Math.min(1.5, levels[3] - levels[2] - 0.7), pos.clone().setY(pos.y + levels[2] + 0.35), n, false);
  const oculus = new THREE.CircleGeometry(0.35, 16);
  oculus.translate(0, levels[4] + (H - levels[4]) * 0.4, 0.02);
  b.add(R.leadedGlass, at(oculus));
  const oring = new THREE.TorusGeometry(0.38, 0.07, 6, 16);
  oring.translate(0, levels[4] + (H - levels[4]) * 0.4, 0.05);
  stone(b, at(oring));
}

// ---- 主樓 ----

const MAIN = { u0: -22.7, u1: 22.7, v0: -5.3, v1: 5.3 };
/** 西南立面：兩座橫向山牆（OSM 383465249、383465252）；東北立面：中央山牆（383465255） */
const CROSS_GABLES: { u0: number; u1: number; side: 1 | -1 }[] = [
  { u0: -16.6, u1: -11.5, side: -1 },
  { u0: 11.1, u1: 16.4, side: -1 },
  { u0: -2.2, u1: 3.6, side: 1 },
];
const CROSS_WALL = 17.0;

/** 牆面座標：沿西南／東北長牆（t＝u）或東南／西北端牆（t＝v） */
const onSW = (t: number, y: number) => V(t, y, MAIN.v0);
const onNE = (t: number, y: number) => V(t, y, MAIN.v1);
const onSE = (t: number, y: number) => V(MAIN.u1, y, t);
const onNW = (t: number, y: number) => V(MAIN.u0, y, t);

function buildMain(b: Batch) {
  const { u0, u1, v0, v1 } = MAIN;
  const { eave, ridge } = ROSENBORG;
  // 台基（砂岩，微凸）與磚牆
  plinth(b, boxUV(u0 - 0.12, u1 + 0.12, v0 - 0.12, v1 + 0.12, G, FLOORS[0]));
  brick(b, boxUV(u0, u1, v0, v1, FLOORS[0], eave));
  stone(b, boxUV(u0 - 0.2, u1 + 0.2, v0 - 0.2, v1 + 0.2, FLOORS[0] - 0.05, FLOORS[0] + 0.2));
  // 腰線與簷口（東北面在塔與角樓之間也連續，被遮住的部分不影響）
  bandsOnWall(b, onSW, N_SW, u0, u1, BANDS);
  bandsOnWall(b, onNE, N_NE, u0, u1, BANDS);
  bandsOnWall(b, onSE, N_SE, v0, v1, BANDS);
  bandsOnWall(b, onNW, N_NW, v0, v1, BANDS);
  // 砂岩隅石（主樓四角）
  for (const [u, v] of [[u0, v0], [u0, v1], [u1, v0], [u1, v1]]) {
    for (let y = FLOORS[0] + 0.2; y < eave - 0.6; y += 0.9) {
      const long = Math.round((y - FLOORS[0]) / 0.9) % 2 === 0;
      const du = long ? 0.75 : 0.45;
      const dv = long ? 0.45 : 0.75;
      stone(b, boxUV(u < 0 ? u - 0.03 : u - du, u < 0 ? u + du : u + 0.03, v < 0 ? v - 0.03 : v - dv, v < 0 ? v + dv : v + 0.03, y, y + 0.45));
    }
  }

  // 窗：西南面（塔與側翼之間不開窗）、東北面（避開兩座樓梯塔與中央八角塔）
  const sw = AXES.filter((u) => u < -6 || u > 6).concat([5.0]);
  windowColumn(b, onSW, N_SW, sw);
  windowColumn(b, onNE, N_NE, [-20.8, -8.0, -4.8, 4.8, 7.7, 17.6, 20.8]);
  // 半地下室小窗
  for (const [on, n, us] of [[onSW, N_SW, sw], [onNE, N_NE, [-20.8, -8.0, -4.8, 4.8, 7.7, 17.6, 20.8]]] as const) {
    for (const u of us) {
      const g = new THREE.PlaneGeometry(0.9, 0.5);
      g.translate(0, 0.25, 0.14);
      b.add(M.darkInterior, placeOnWall(g, on(u, 0.4), n));
    }
  }
  // 西南立面一樓窗下的 12 尊青銅皇帝胸像（腓特烈四世購置），置於窗間托架上
  const busts: THREE.BufferGeometry[] = [];
  const consoles: THREE.BufferGeometry[] = [];
  for (const u of [-19.2, -16.0, -12.8, -9.6, -6.4, 6.5, 9.6, 12.8, 16.0, 19.2]) {
    const p = onSW(u, 3.7);
    consoles.push(box(0.5, 0.18, 0.35, p.x, p.y - 0.18, p.z + 0.17));
    busts.push(new THREE.CylinderGeometry(0.16, 0.24, 0.32, 10).translate(p.x, p.y + 0.16, p.z + 0.18));
    busts.push(new THREE.SphereGeometry(0.13, 10, 8).scale(1, 1.2, 1).translate(p.x, p.y + 0.46, p.z + 0.18));
  }
  stone(b, merge(consoles));
  b.add(M.bronze, merge(busts));
  // 端牆：兩座凸窗之間與外側
  for (const [on, n] of [[onSE, N_SE], [onNW, N_NW]] as const) windowColumn(b, on, n, [0.2], [0, 1, 2]);

  // 屋頂：雙坡銅板屋面，出簷 0.3 m
  const ov = 0.3;
  const slope = (s: 1 | -1) => {
    const ve = s * (v1 + ov);
    const ye = eave - ov * ((ridge - eave) / v1);
    const q = [V(u0 + 0.3, ye, ve), V(u1 - 0.3, ye, ve), V(u1 - 0.3, ridge, 0), V(u0 + 0.3, ridge, 0)];
    const g = new THREE.BufferGeometry().setFromPoints(s > 0 ? [q[0], q[2], q[1], q[0], q[3], q[2]] : [q[0], q[1], q[2], q[0], q[2], q[3]]);
    g.computeVertexNormals();
    b.add(R.copper, planarUV(g, 2.4));
  };
  slope(1);
  slope(-1);
  copper(b, planarUV(boxUV(u0 + 0.3, u1 - 0.3, -0.16, 0.16, ridge - 0.1, ridge + 0.14), 2.4));

  // 屋頂老虎窗（小型銅皮老虎窗，兩側各一排）
  for (const s of [1, -1] as const) {
    for (const u of s < 0 ? [-19, -6.5, 5.5, 19] : [-19.5, -5, 6.2, 19]) {
      const vv = s * 2.6;
      const y = eave + (ridge - eave) * (1 - Math.abs(vv) / v1);
      const n = s > 0 ? N_NE : N_SW;
      const face = new THREE.BoxGeometry(1.1, 1.3, 1.6);
      face.translate(u, y - 0.2 + 0.65, -vv + (s > 0 ? -0.3 : 0.3));
      copper(b, planarUV(face, 2.4));
      const cap = new THREE.CylinderGeometry(0.62, 0.62, 1.7, 10, 1, false, 0, Math.PI);
      cap.rotateZ(Math.PI / 2);
      cap.rotateY(Math.PI / 2);
      cap.translate(u, y + 1.1, -vv + (s > 0 ? -0.3 : 0.3));
      copper(b, cap);
      const g = new THREE.PlaneGeometry(0.7, 0.8);
      g.translate(0, 0.45, 0.02);
      b.add(R.leadedGlass, placeOnWall(g, V(u, y - 0.2, vv + s * 0.52), n));
    }
  }

  // 端牆山牆（東南、西北）
  dutchGable(b, v1 - v0, 8.6, 0.22, V(u1, eave, 0), N_SE, 0.7, 2);
  dutchGable(b, v1 - v0, 8.6, 0.22, V(u0, eave, 0), N_NW, 0.7, 2);

  // 橫向山牆：牆身升到 17 m，雙坡屋頂接主屋脊，立面為荷蘭式山牆
  for (const c of CROSS_GABLES) {
    const w = c.u1 - c.u0;
    const um = (c.u0 + c.u1) / 2;
    const face = c.side > 0 ? v1 : v0;
    const n = c.side > 0 ? N_NE : N_SW;
    brick(b, boxUV(c.u0, c.u1, c.side > 0 ? 0 : face, c.side > 0 ? face : 0, eave - 0.5, CROSS_WALL));
    const hw = w / 2 + 0.25;
    const pts = [V(um - hw, CROSS_WALL, 0), V(um + hw, CROSS_WALL, 0), V(um, ridge, 0)];
    const roof = (dirU: 1 | -1) => {
      const a = V(um + dirU * hw, CROSS_WALL, face - c.side * 0.3);
      const bb = V(um + dirU * hw, CROSS_WALL, 0);
      const r0 = V(um, ridge, 0);
      const r1 = V(um, ridge, face - c.side * 0.3);
      const tri = [a, bb, r0, a, r0, r1];
      const g = new THREE.BufferGeometry().setFromPoints(tri);
      g.computeVertexNormals();
      b.add(R.copper, planarUV(g, 2.4));
    };
    roof(1);
    roof(-1);
    void pts;
    const at = c.side > 0 ? onNE : onSW;
    bandsOnWall(b, at, n, c.u0, c.u1, [CROSS_WALL - 0.2]);
    dutchGable(b, w, 8.0, 0.42, at(um, eave), n, 0.6, 2);
  }

  // 端牆凸窗（砂岩，OSM 383465256/258/265/267）：五邊形平面，簷口高度收小銅頂
  const oriels: [number, number][][] = [
    [[22.7, 1.3], [23.6, 2.0], [23.6, 3.4], [22.7, 4.1]],
    [[22.7, -0.9], [23.6, -1.4], [23.6, -3.3], [22.7, -3.8]],
    [[-22.7, 1.2], [-23.3, 1.6], [-23.3, 3.6], [-22.7, 4.1]],
    [[-22.7, -1.0], [-23.3, -1.4], [-23.3, -3.6], [-22.7, -4.1]],
  ];
  for (const o of oriels) {
    const sgn = o[1][0] > 0 ? 1 : -1;
    const poly = o.map(([u, v]) => [u - sgn * 0.3, v] as [number, number]);
    stone(b, prismUV(poly, G, eave));
    const vm = (o[1][1] + o[2][1]) / 2;
    const uf = o[1][0];
    const n = sgn > 0 ? N_SE : N_NW;
    for (const f of [0, 1, 2]) crossWindow(b, 0.9, WIN[f].h, V(uf, WIN[f].sill, vm), n, false);
    for (let k = 1; k < 4; k++) stone(b, prismUV(poly.map(([u, v]) => [u + sgn * 0.08, v] as [number, number]), BANDS[k - 1] - 0.25, BANDS[k - 1]));
    const top: Ring = [...o.map(([u, v]) => V(u + sgn * 0.12, eave, v))];
    const c = top.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(top.length);
    const cap = merge(top.map((p, i) => {
      const q = top[(i + 1) % top.length];
      return new THREE.BufferGeometry().setFromPoints([p, q, c.clone().setY(eave + 1.2)]);
    }));
    cap.computeVertexNormals();
    b.add(R.lead, cap);
  }

  // 煙囪（OSM 1 m 見方、高 22.5 m）
  for (const u of [-22.2, -8.55, -2.55, 2.65, 8.45, 21.45]) {
    brick(b, boxUV(u - 0.45, u + 0.45, -0.45, 0.45, ridge - 2, 22.3));
    stone(b, boxUV(u - 0.58, u + 0.58, -0.58, 0.58, 22.3, 22.55));
  }
}

// ---- 塔 ----

/** 八角銅頂：以 (半徑, 高度) 剖面車削（8 等分＝八角形） */
function octLathe(profile: [number, number][], u: number, v: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 8, Math.PI / 8);
  g.translate(u, 0, -v);
  return g;
}

/** 開放式小燈籠亭：八根柱、柱頂圈梁、內部暗色芯 */
function lantern(b: Batch, u: number, v: number, r: number, y0: number, y1: number) {
  const posts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const p = V(u + Math.cos(a) * r * 0.92, y0, v + Math.sin(a) * r * 0.92);
    posts.push(box(0.16 * r + 0.06, y1 - y0, 0.16 * r + 0.06, p.x, y0, p.z));
  }
  copper(b, merge(posts));
  b.add(M.darkInterior, cylinder(r * 0.55, y1 - y0, u, y0, -v, 8));
  copper(b, octLathe([[0, y0 - 0.1], [r * 1.08, y0 - 0.1], [r * 1.08, y0 + 0.12], [r, y0 + 0.12], [r, y0 + 0.14], [0, y0 + 0.14]], u, v));
  copper(b, octLathe([[0, y1 - 0.2], [r * 1.12, y1 - 0.2], [r * 1.12, y1], [0, y1]], u, v));
}

/** 鍍金尖頂：球、王冠形飾與風向旗 */
function gildedTip(b: Batch, u: number, v: number, y: number, s = 1) {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(cylinder(0.05 * s, 2.2 * s, u, y, -v, 6));
  parts.push(new THREE.SphereGeometry(0.28 * s, 12, 8).translate(u, y + 0.5 * s, -v));
  parts.push(new THREE.TorusGeometry(0.2 * s, 0.05 * s, 6, 12).rotateX(Math.PI / 2).translate(u, y + 1.05 * s, -v));
  parts.push(new THREE.BoxGeometry(0.7 * s, 0.35 * s, 0.03).translate(u + 0.35 * s, y + 1.75 * s, -v));
  b.add(M.gold, merge(parts));
}

/** 方塔身：磚牆、砂岩腰線與隅石；faces 決定哪幾面開窗 */
function squareShaft(
  b: Batch, u0: number, u1: number, v0: number, v1: number, top: number, bands: number[],
  faces: { n: THREE.Vector3; at: (t: number, y: number) => THREE.Vector3; t: number; win: { sill: number; h: number; w?: number }[] }[],
) {
  brick(b, boxUV(u0, u1, v0, v1, G, top));
  plinth(b, boxUV(u0 - 0.1, u1 + 0.1, v0 - 0.1, v1 + 0.1, G, FLOORS[0]));
  for (const y of bands) stone(b, boxUV(u0 - 0.1, u1 + 0.1, v0 - 0.1, v1 + 0.1, y - 0.28, y));
  stone(b, boxUV(u0 - 0.3, u1 + 0.3, v0 - 0.3, v1 + 0.3, top - 0.5, top));
  for (const [u, v] of [[u0, v0], [u0, v1], [u1, v0], [u1, v1]]) {
    for (let y = FLOORS[0] + 0.2; y < top - 1; y += 0.9) {
      const long = Math.round((y - FLOORS[0]) / 0.9) % 2 === 0;
      const du = long ? 0.7 : 0.4;
      const dv = long ? 0.4 : 0.7;
      stone(b, boxUV(u === u0 ? u - 0.03 : u - du, u === u0 ? u + du : u + 0.03, v === v0 ? v - 0.03 : v - dv, v === v0 ? v + dv : v + 0.03, y, y + 0.45));
    }
  }
  for (const f of faces) for (const w of f.win) crossWindow(b, w.w ?? WIN_W, w.h, f.at(f.t, w.sill), f.n, w.sill < ROSENBORG.eave);
}

const TOWER = { u0: -3.15, u1: 3.45, v0: -11.85, v1: -5.25, top: 25.4 };

function buildMainTower(b: Batch) {
  const { u0, u1, v0, v1, top } = TOWER;
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  // 大塔 7 層：主樓三層以上再四層
  const upper = [{ sill: 14.6, h: 2.0, w: 1.1 }, { sill: 17.3, h: 2.0, w: 1.1 }, { sill: 20.2, h: 1.9, w: 1.0 }, { sill: 22.9, h: 1.6, w: 0.9 }];
  squareShaft(b, u0, u1, v0, v1, top, [...BANDS, 16.8, 19.7, 22.5], [
    { n: N_SW, at: (t, y) => V(t, y, v0), t: uc, win: [WIN[1], WIN[2], ...upper] },
    { n: N_SE, at: (t, y) => V(u1, y, t), t: -9.9, win: [...WIN, ...upper.map((w) => ({ ...w }))] },
    { n: N_NW, at: (t, y) => V(u0, y, t), t: -10.0, win: [...WIN, ...upper] },
  ]);
  // 主入口：砂岩門框、半圓拱門楣、兩側壁柱與山花；門前台階
  const door = V(uc, 0, v0);
  const at = (g: THREE.BufferGeometry) => placeOnWall(g, door.clone(), N_SW);
  b.add(M.darkInterior, at(box(1.9, 3.4, 0.05, 0, 1.2, 0.01)));
  b.add(R.ironGreen, at(box(1.7, 2.6, 0.08, 0, 1.2, 0.03)));
  stone(b, at(frameFromOutlines(roundArchPoints(2.9, 4.9), roundArchPoints(1.9, 4.5), 0.25).translate(0, 0, 0)));
  for (const x of [-1.75, 1.75]) stone(b, at(box(0.45, 4.9, 0.45, x, 0, 0.1)));
  stone(b, at(box(4.2, 0.35, 0.55, 0, 4.9, 0.1)));
  const ped = new THREE.Shape([new THREE.Vector2(-2.1, 0), new THREE.Vector2(2.1, 0), new THREE.Vector2(0, 1.2)]);
  stone(b, at(new THREE.ExtrudeGeometry(ped, { depth: 0.3, bevelEnabled: false }).translate(0, 5.25, 0.1)));
  for (let k = 0; k < 4; k++) stone(b, at(box(3.6 - k * 0.2, 0.3, 0.4 * (4 - k), 0, k * 0.3, 0.2 * (4 - k))));

  // 方塔頂 → 八角鼓座：銅皮過渡面
  const skirt: Ring[] = [];
  const sq = (h: number, y: number): Ring => [V(uc + h, y, vc + h), V(uc - h, y, vc + h), V(uc - h, y, vc - h), V(uc + h, y, vc - h)];
  const oct = (r: number, y: number): Ring =>
    Array.from({ length: 8 }, (_, k) => {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      return V(uc + Math.cos(a) * r, y, vc + Math.sin(a) * r);
    });
  const sq8 = (h: number, y: number): Ring => {
    const s = sq(h, y);
    return s.flatMap((p, i) => [p.clone().lerp(s[(i + 1) % 4], 0.35), p.clone().lerp(s[(i + 1) % 4], 0.65)]);
  };
  skirt.push(sq8(3.55, top), oct(3.2, top + 1.0));
  const sk = loft([sq8(3.55, top - 0.02), oct(3.15, top + 1.0)].map((r) => r.slice()), { capBottom: true });
  copper(b, planarUV(sk, 2.4));
  void skirt;
  // 八角鼓座（磚、砂岩角柱），每面一扇窗
  const r8 = 3.0;
  const drumY0 = top + 0.9;
  const drumY1 = 29.5;
  brick(b, octLathe([[0, drumY0], [r8, drumY0], [r8, drumY1], [0, drumY1]], uc, vc));
  const pil: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const p = V(uc + Math.cos(a) * r8 * 0.99, drumY0, vc + Math.sin(a) * r8 * 0.99);
    const g = box(0.35, drumY1 - drumY0, 0.35, 0, 0, 0);
    g.rotateY(-a);
    g.translate(p.x, drumY0, p.z);
    pil.push(g);
  }
  stone(b, merge(pil));
  stone(b, octLathe([[0, drumY1 - 0.3], [r8 + 0.25, drumY1 - 0.3], [r8 + 0.25, drumY1], [0, drumY1]], uc, vc));
  const ap = r8 * Math.cos(Math.PI / 8);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const dir = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const p = V(uc, 0, vc).add(dir.clone().multiplyScalar(ap)).setY(drumY0 + 0.6);
    crossWindow(b, 0.8, 1.8, p.clone(), dir, false);
  }
  // 銅頂：鐘形頂 → 燈籠亭 → 洋蔥頂 → 燈籠亭 → 小洋蔥頂 → 燈籠亭 → 尖針與鍍金球（OSM 各層高度）
  copper(b, octLathe([[0, drumY1], [3.35, drumY1], [3.3, 30.1], [2.9, 30.9], [2.3, 31.7], [1.85, 32.4], [1.75, 32.8], [0, 32.8]], uc, vc));
  lantern(b, uc, vc, 1.7, 32.8, 35.0);
  copper(b, octLathe([[0, 35.0], [2.0, 35.0], [2.1, 35.5], [1.95, 36.3], [1.45, 37.2], [1.05, 37.9], [0.95, 38.2], [0, 38.2]], uc, vc));
  lantern(b, uc, vc, 1.1, 38.2, 39.9);
  copper(b, octLathe([[0, 39.9], [1.35, 39.9], [1.4, 40.25], [1.1, 40.7], [0.75, 41.0], [0, 41.0]], uc, vc));
  lantern(b, uc, vc, 0.7, 41.0, 42.3);
  copper(b, octLathe([[0, 42.3], [0.85, 42.3], [0.9, 42.6], [0.6, 43.1], [0.32, 43.6], [0.18, 45.5], [0.1, 47.6], [0, 47.8]], uc, vc));
  copper(b, octLathe([[0, 47.7], [0.24, 47.8], [0.3, 48.1], [0.24, 48.4], [0, 48.5]], uc, vc));
  gildedTip(b, uc, vc, 48.4, 1);
}

/** 東北側兩座方形樓梯塔（OSM 383465251、383465253）：塔身至 23.2 m、四坡銅頂、八角燈籠與尖針 */
function buildStairTower(b: Batch, u0: number, u1: number, v1: number) {
  const v0 = MAIN.v1;
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2 + 0.2;
  const top = 23.2;
  const upper = [{ sill: 14.6, h: 2.1, w: 1.0 }, { sill: 18.3, h: 2.1, w: 1.0 }];
  squareShaft(b, u0, u1, v0, v1, top, [...BANDS, 17.6, 21.2], [
    { n: N_NE, at: (t, y) => V(t, y, v1), t: uc, win: [...WIN, ...upper] },
    { n: N_SE, at: (t, y) => V(u1, y, t), t: (v0 + v1) / 2, win: [{ sill: 3.8, h: 1.8, w: 0.9 }, { sill: 7.8, h: 1.8, w: 0.9 }, { sill: 11.8, h: 1.8, w: 0.9 }, ...upper] },
    { n: N_NW, at: (t, y) => V(u0, y, t), t: (v0 + v1) / 2, win: [{ sill: 3.8, h: 1.8, w: 0.9 }, { sill: 7.8, h: 1.8, w: 0.9 }, { sill: 11.8, h: 1.8, w: 0.9 }, ...upper] },
  ]);
  // 四坡屋頂
  const hu = (u1 - u0) / 2 + 0.25;
  const hv = (v1 - v0) / 2 + 0.25;
  const rh = 2.8;
  const ring0: Ring = [V(uc + hu, top, vc + hv), V(uc - hu, top, vc + hv), V(uc - hu, top, vc - hv), V(uc + hu, top, vc - hv)];
  const ridgeHalf = Math.max(0.05, hu - hv);
  const ring1: Ring = [V(uc + ridgeHalf, top + rh, vc), V(uc - ridgeHalf, top + rh, vc), V(uc - ridgeHalf, top + rh, vc - 0.01), V(uc + ridgeHalf, top + rh, vc - 0.01)];
  copper(b, planarUV(loft([ring0, ring1]), 2.4));
  // 八角燈籠（OSM 383465280：r≈1.35、頂 28.6）＋ 小燈籠（383465275）＋ 尖針（383510582，36.2 m）
  const cu = uc;
  const cv = (v0 + v1) / 2 + 0.2;
  // 雙層開放式燈籠亭（Trap Danmark：dobbelt åben lanternespir）
  copper(b, octLathe([[0, top + rh - 1.3], [1.5, top + rh - 1.3], [1.5, top + rh - 1.1], [0, top + rh - 1.1]], cu, cv));
  lantern(b, cu, cv, 1.35, top + rh - 1.1, 26.6);
  // 塔頂兩支煙囪
  for (const du of [-2.3, 2.3]) {
    brick(b, boxUV(uc + du - 0.35, uc + du + 0.35, vc - 0.35, vc + 0.35, top, top + rh + 0.6));
    stone(b, boxUV(uc + du - 0.45, uc + du + 0.45, vc - 0.45, vc + 0.45, top + rh + 0.6, top + rh + 0.8));
  }
  copper(b, octLathe([[0, 26.6], [1.55, 26.6], [1.5, 26.9], [1.2, 27.5], [0.8, 28.2], [0.62, 28.6], [0, 28.6]], cu, cv));
  lantern(b, cu, cv, 0.55, 28.6, 29.6);
  copper(b, octLathe([[0, 29.6], [0.7, 29.6], [0.62, 30.1], [0.3, 30.5], [0.14, 32.5], [0.06, 34.9], [0, 35.0]], cu, cv));
  gildedTip(b, cu, cv, 34.9, 0.6);
}

/** 東北立面中央的八角樓梯塔（OSM 383465277/278/285）：牆至 15.7 m、圓頂、燈籠頂 */
function buildOctTurret(b: Batch) {
  const uc = 0.4;
  const vc = 8.95;
  const r = 2.6;
  brick(b, octLathe([[0, G], [r, G], [r, 15.7], [0, 15.7]], uc, vc));
  plinth(b, octLathe([[0, G], [r + 0.1, G], [r + 0.1, FLOORS[0]], [0, FLOORS[0]]], uc, vc));
  for (const y of [...BANDS, 15.7]) {
    const t = y === 15.7 ? 0.5 : 0.28;
    stone(b, octLathe([[0, y - t], [r + (y === 15.7 ? 0.3 : 0.1), y - t], [r + (y === 15.7 ? 0.3 : 0.1), y], [0, y]], uc, vc));
  }
  brick(b, boxUV(-0.5, 1.5, MAIN.v1 - 0.2, 6.9, G, 14.9));
  const ap = r * Math.cos(Math.PI / 8);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const dir = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    if (dir.z > 0.3) continue; // 靠主樓的三面不開窗
    // 螺旋梯：窗位逐面升高
    for (let f = 0; f < 3; f++) crossWindow(b, 0.8, 1.9, V(uc, 0, vc).add(dir.clone().multiplyScalar(ap)).setY(2.4 + f * 4.1 + k * 0.35), dir, false);
  }
  copper(b, octLathe([[0, 15.7], [2.85, 15.7], [2.8, 16.2], [2.55, 16.9], [2.1, 17.6], [1.4, 18.2], [1.0, 18.5], [0, 18.5]], uc, vc));
  lantern(b, uc, vc, 0.8, 18.5, 19.5);
  copper(b, octLathe([[0, 19.5], [0.95, 19.5], [0.85, 19.8], [0.45, 20.2], [0.12, 21.4], [0, 21.5]], uc, vc));
  gildedTip(b, uc, vc, 21.4, 0.45);
}

/** 其他附屬量體：主塔西北側翼（383465270）、主塔東南小梯塔（383465257）、西北塔旁凸出（383465262） */
function buildAnnexes(b: Batch) {
  const hip = (u0: number, u1: number, v0: number, v1: number, y: number, h: number) => {
    const uc = (u0 + u1) / 2;
    const vc = (v0 + v1) / 2;
    const r0: Ring = [V(u1 + 0.2, y, v1 + 0.2), V(u0 - 0.2, y, v1 + 0.2), V(u0 - 0.2, y, v0 - 0.2), V(u1 + 0.2, y, v0 - 0.2)];
    const r1: Ring = [V(uc + 0.01, y + h, vc + 0.01), V(uc - 0.01, y + h, vc + 0.01), V(uc - 0.01, y + h, vc - 0.01), V(uc + 0.01, y + h, vc - 0.01)];
    b.add(R.lead, loft([r0, r1]));
  };
  // 主塔西北側翼
  brick(b, boxUV(-5.8, TOWER.u0, -8.1, MAIN.v0, G, ROSENBORG.eave));
  plinth(b, boxUV(-5.9, TOWER.u0, -8.2, MAIN.v0, G, FLOORS[0]));
  bandsOnWall(b, (t, y) => V(t, y, -8.1), N_SW, -5.8, TOWER.u0, BANDS);
  for (const f of [0, 1, 2]) crossWindow(b, 1.1, WIN[f].h, V(-4.45, WIN[f].sill, -8.1), N_SW);
  hip(-5.8, TOWER.u0, -8.1, MAIN.v0, ROSENBORG.eave, 2.5);
  // 主塔東南側的小梯塔
  brick(b, boxUV(TOWER.u1, 4.2, -8.0, MAIN.v0, G, 24.3));
  hip(TOWER.u1, 4.2, -8.0, MAIN.v0, 24.3, 1.0);
  for (let k = 0; k < 5; k++) crossWindow(b, 0.45, 1.1, V(4.2, 3 + k * 4.3, -6.65), N_SE, false);
  // 西北樓梯塔旁的凸出量體
  brick(b, boxUV(-18.1, -15.8, MAIN.v1 - 0.2, 7.6, G, ROSENBORG.eave));
  plinth(b, boxUV(-18.2, -15.8, MAIN.v1 - 0.2, 7.7, G, FLOORS[0]));
  bandsOnWall(b, (t, y) => V(t, y, 7.6), N_NE, -18.1, -15.8, BANDS);
  for (const f of [0, 1, 2]) crossWindow(b, 1.0, WIN[f].h, V(-16.95, WIN[f].sill, 7.6), N_NE);
  hip(-18.1, -15.8, MAIN.v1 - 0.2, 7.6, ROSENBORG.eave, 1.2);
}

// ---- 護城河、前庭、格林橋與花園入口 ----

/** 護城河水面（OSM way 86370283 與遮罩範圍的交集） */
const MOAT: [number, number][] = [
  [59.5, -53.4], [-20.0, -52.4], [-21.7, -33.7], [-22.3, -27.4], [20.6, -26.9], [20.2, -33.9], [46.2, -37.3],
  [39.2, -3.7], [36.2, 10.9], [34.1, 20.8], [40.2, 22.0], [56.1, 22.0],
];
/** 地面：遮罩範圍扣掉護城河 */
const GROUND: [number, number][] = [
  [59.0, 22.0], [61.0, 9.0], [65.0, 9.0], [65.0, -6.0], [62.0, -6.0], [62.0, -56.0], [-22.5, -56.0], [-23.5, -27.6],
  [-28.0, -26.5], [-28.0, 22.0], [40.2, 22.0], [34.1, 20.8], [36.2, 10.9], [39.2, -3.7], [46.2, -37.3], [20.2, -33.9],
  [20.6, -26.9], [-22.3, -27.4], [-21.7, -33.7], [-20.0, -52.4], [59.5, -53.4], [56.1, 22.0],
];
/** 草坪（OSM landuse=grass）：前庭五塊、東南半島一塊、東北側國王花園一角 */
const LAWNS: [number, number][][] = [
  [[-23.1, -22.3], [-17.0, -22.2], [-17.1, -10.5], [-23.1, -10.5]],
  [[-13.6, -22.2], [-7.6, -22.1], [-7.6, -10.4], [-13.7, -10.4]],
  [[-3.7, -22.1], [2.9, -22.0], [2.8, -14.1], [-3.8, -14.1]],
  [[7.3, -22.0], [13.9, -21.9], [13.8, -10.2], [7.3, -10.2]],
  [[16.7, -21.9], [23.5, -21.8], [23.5, -10.1], [16.7, -10.1]],
  [[26.7, -28.0], [38.2, -29.8], [33.9, -10.0], [26.6, -10.1]],
  [[36.2, 10.9], [34.8, 10.6], [36.2, 3.0], [31.7, 3.4], [30.5, 4.1], [26.4, 7.0], [19.2, 20.7], [-20.9, 19.4], [-23.2, 22.0], [40.2, 22.0], [34.1, 20.8]],
];
const WATER_Y = -1.7;
/** 格林橋（木橋，OSM way 26177232）：由城堡側台階到花園門柱 */
const BRIDGE = { u0: 31.5, u1: 57.2, v0: 0.6, v1: 1.6, w: 3.0 };
const bridgeV = (u: number) => BRIDGE.v0 + ((u - BRIDGE.u0) * (BRIDGE.v1 - BRIDGE.v0)) / (BRIDGE.u1 - BRIDGE.u0);

/** 點列沿邊的直牆（厚 t，y0→y1），用於護岸與矮牆 */
function wallAlong(pts: [number, number][], y0: number, y1: number, t: number, closed = false): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const [ua, va] = pts[i];
    const [ub, vb] = pts[(i + 1) % pts.length];
    const len = Math.hypot(ub - ua, vb - va);
    const g = new THREE.BoxGeometry(len + t, y1 - y0, t);
    g.rotateY(Math.atan2(vb - va, ub - ua));
    g.translate((ua + ub) / 2, (y0 + y1) / 2, -(va + vb) / 2);
    parts.push(g);
  }
  return merge(parts);
}

/** 臥獅（砂岩，1673 年前）：身長沿 v，頭朝 dir */
function restingLion(b: Batch, u: number, v: number, dir: 1 | -1) {
  const parts: THREE.BufferGeometry[] = [];
  const at = (g: THREE.BufferGeometry, du: number, y: number, dv: number) => {
    g.translate(u + du, y, -(v + dv * dir));
    parts.push(g);
  };
  const plinthG = new THREE.BoxGeometry(1.2, 0.9, 2.1);
  plinthG.translate(u, 0.45, -v);
  b.add(M.granite, planarUV(plinthG, 1));
  const body = new THREE.SphereGeometry(0.5, 14, 10);
  body.scale(0.8, 0.72, 1.45);
  at(body, 0, 1.3, -0.1);
  const mane = new THREE.SphereGeometry(0.46, 14, 10);
  mane.scale(1.0, 1.08, 0.85);
  at(mane, 0, 1.52, 0.52);
  const head = new THREE.SphereGeometry(0.27, 12, 10);
  head.scale(0.95, 1, 1.1);
  at(head, 0, 1.62, 0.82);
  const muzzle = new THREE.BoxGeometry(0.22, 0.18, 0.2);
  at(muzzle, 0, 1.5, 1.02);
  for (const s of [-1, 1]) {
    const paw = new THREE.CapsuleGeometry(0.1, 0.5, 4, 8);
    paw.rotateX(Math.PI / 2);
    at(paw, s * 0.2, 0.99, 0.85);
    const haunch = new THREE.SphereGeometry(0.3, 10, 8);
    at(haunch, s * 0.2, 1.15, -0.7);
  }
  const tail = new THREE.CapsuleGeometry(0.05, 0.7, 4, 6);
  tail.rotateZ(Math.PI / 2);
  at(tail, 0.2, 0.98, -1.0);
  b.add(R.lionStone, merge(parts));
}

/** 門柱：磚砌高柱、砂岩柱頭與小天使雕像（海克力斯、馬爾斯造型，以簡化人形表示） */
function gatePier(b: Batch, u: number, v: number) {
  const g = boxUV(u - 0.6, u + 0.6, v - 0.6, v + 0.6, 0, 4.2);
  brick(b, g);
  stone(b, boxUV(u - 0.7, u + 0.7, v - 0.7, v + 0.7, 0, 0.5));
  stone(b, boxUV(u - 0.72, u + 0.72, v - 0.72, v + 0.72, 4.2, 4.55));
  stone(b, boxUV(u - 0.5, u + 0.5, v - 0.5, v + 0.5, 4.55, 4.8));
  const fig: THREE.BufferGeometry[] = [];
  const p = V(u, 4.8, v);
  fig.push(new THREE.CylinderGeometry(0.16, 0.22, 0.65, 10).translate(p.x, p.y + 0.33, p.z));
  fig.push(new THREE.SphereGeometry(0.17, 10, 8).translate(p.x, p.y + 0.8, p.z));
  fig.push(new THREE.CylinderGeometry(0.06, 0.06, 0.55, 6).rotateZ(0.6).translate(p.x + 0.25, p.y + 0.6, p.z));
  fig.push(new THREE.CylinderGeometry(0.06, 0.06, 0.55, 6).rotateZ(-0.6).translate(p.x - 0.25, p.y + 0.6, p.z));
  stone(b, merge(fig));
}

function buildSite(b: Batch) {
  b.add(R.gravel, planarUV(flatUV(GROUND, 0), 3));
  for (const l of LAWNS) {
    // 草坪略高於步道，邊緣有矮緣石
    b.add(M.grass, planarUV(prismUV(l, -0.2, 0.05), 6));
  }
  b.add(M.water, flatUV(MOAT, WATER_Y));
  // 護岸：磚牆＋砂岩壓頂，沿水面輪廓（北側遮罩切線除外）
  const edge = MOAT.slice(0, MOAT.length - 2);
  const shore = [...edge, MOAT[MOAT.length - 2]];
  brick(b, wallAlong([MOAT[MOAT.length - 1], ...shore], WATER_Y - 1.2, -0.05, 0.5));
  stone(b, wallAlong([MOAT[MOAT.length - 1], ...shore], -0.05, 0.12, 0.62));
  // 城堡側河岸矮牆（OSM way 1362802362）
  const parapet: [number, number][] = [[-22.3, -27.4], [20.6, -26.9], [20.2, -33.9], [46.2, -37.3], [39.2, -3.7], [36.2, 10.9]];
  brick(b, wallAlong(parapet, 0.1, 0.55, 0.36));
  stone(b, wallAlong(parapet, 0.55, 0.68, 0.46));

  // 格林橋：木橋面、木樁排架、兩側漆綠木欄杆；城堡端兩級台階
  const { u0, u1, w } = BRIDGE;
  const deckY = 0.25;
  const len = Math.hypot(u1 - u0, BRIDGE.v1 - BRIDGE.v0);
  const ang = Math.atan2(BRIDGE.v1 - BRIDGE.v0, u1 - u0);
  const along = (g: THREE.BufferGeometry, t: number, y: number, off: number) => {
    const u = u0 + (u1 - u0) * t;
    g.rotateY(ang);
    g.translate(u - Math.sin(ang) * off, y, -(bridgeV(u) + Math.cos(ang) * off));
    return g;
  };
  const deck = along(new THREE.BoxGeometry(len - 2, 0.3, w), 0.5 + 1 / len, deckY - 0.3, 0);
  b.add(R.timber, planarUV(deck, 1));
  const planks: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) planks.push(along(new THREE.BoxGeometry(len - 2, 0.02, 0.9), 0.5 + 1 / len, deckY, (k - 1) * 0.98));
  b.add(R.timber, planarUV(merge(planks), 1));
  const piles: THREE.BufferGeometry[] = [];
  for (let t = 0.3; t < 0.97; t += 0.14)
    for (const off of [-1.2, 0, 1.2]) piles.push(along(new THREE.CylinderGeometry(0.15, 0.15, deckY - WATER_Y + 0.8, 8), t, (deckY + WATER_Y - 0.8) / 2 - 0.3, off));
  b.add(R.timber, merge(piles));
  const rail: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    rail.push(along(new THREE.BoxGeometry(len - 3.5, 0.1, 0.1), 0.53, deckY + 1.0, s * (w / 2 - 0.05)));
    rail.push(along(new THREE.BoxGeometry(len - 3.5, 0.06, 0.06), 0.53, deckY + 0.5, s * (w / 2 - 0.05)));
    for (let t = 0.12; t < 0.97; t += 0.035) rail.push(along(new THREE.BoxGeometry(0.1, 1.0, 0.1), t, deckY + 0.5, s * (w / 2 - 0.05)));
  }
  b.add(R.ironGreen, merge(rail));
  for (let k = 0; k < 2; k++) stone(b, along(new THREE.BoxGeometry(0.4, 0.13, w + 0.4), (k * 0.4 + 0.2) / len, 0.13 * (k + 1) - 0.065, 0));
  gatePier(b, u1 + 0.4, bridgeV(u1) - w / 2 - 0.8);
  gatePier(b, u1 + 0.4, bridgeV(u1) + w / 2 + 0.8);
  restingLion(b, 61.75, -1.0, 1);
  restingLion(b, 61.65, 4.25, -1);
}

// ---- 組合 ----

export function buildRosenborg(): { group: THREE.Group; labels: MapLabel[] } {
  const b = new Batch();
  buildMain(b);
  buildMainTower(b);
  buildStairTower(b, 8.5, 15.3, 10.1);
  buildStairTower(b, -15.8, -9.4, 9.9);
  buildOctTurret(b);
  buildAnnexes(b);
  buildSite(b);
  const inner = b.build('rosenborg', { castShadow: true, receiveShadow: true });
  inner.rotation.y = -(AXIS_BEARING - 90) * DEG;
  const group = new THREE.Group();
  group.name = 'rosenborg';
  group.add(inner);
  const lab = (text: string, u: number, v: number, minZoom?: number): MapLabel => {
    const [e, n] = uvToEN(u, v);
    return { text, x: e, z: -n, minZoom };
  };
  return {
    group,
    labels: [lab('羅森堡宮', 0, 0), lab('格林橋', 46, 1, 1), lab('護城河', 10, -40, 1)],
  };
}

// ---- 快速位置（常見拍攝點；位置與焦段為估計） ----

const preset = (name: string, u: number, v: number, extra: Omit<Preset, 'name' | 'group' | 'lat' | 'lon'> = {}): Preset => ({
  name,
  group: '丹麥・羅森堡宮',
  ...rosenborgLatLon(u, v),
  aim: 'rosenborg',
  ...extra,
});

export const ROSENBORG_PRESETS: Preset[] = [
  preset('國王花園草坪（東南側，大塔＋東南山牆）', 95, -45, { state: { focal: 35 } }),
  preset('護城河對岸（西南，大塔倒影）', 2, -58, { height: 1.4, state: { focal: 16, portrait: true } }),
  preset('格林橋上（臥獅與門柱入鏡）', 64, 1.6, { height: 1.5, state: { focal: 24 } }),
  preset('前庭草坪（大塔正面）', 0, -24, { state: { focal: 14, portrait: true } }),
  preset('玫瑰園（東北立面三座塔）', 10, 72, { state: { focal: 35 } }),
];
