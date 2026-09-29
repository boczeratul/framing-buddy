import * as THREE from 'three';
import { offsetLatLon, type LatLon } from '../geo';
import type { MapLabel, Preset } from '../world/types';
import { Batch, beamBetween, box, cylinder, flat, frameFromOutlines, merge, placeOnWall, planarUV } from './geometry';
import { M } from './materials';
import { FACADE, NY } from './nyhavn-materials';
import { CANAL, FOOTPRINTS, GROUND, MASK, type Footprint, type P2 } from './nyhavn-data';
import { HOUSES, SHIPS, SPLITS, type HouseSpec, type ShipSpec } from './nyhavn-specs';

// 新港（Nyhavn，哥本哈根）精細模型：運河、兩岸碼頭、臨運河整排 17–19 世紀彩色連棟屋、
// 新港橋、紀念錨、停泊的木造帆船、餐廳遮陽篷與戶外座位。
//
// 建模座標：a 沿運河指向港口（方位 115°），c 垂直運河指向北岸（方位 25°）；原點＝nyhavn-data.ts 的原點。
// 模型空間 X = a、Z = −c、Y 朝上，整組再旋轉 −25° 對齊真實方位。
// 建物輪廓、運河岸線：OpenStreetMap（經 Overture Maps）。立面顏色、樓層、屋頂、開間數：照片與維基百科等資料
// （見 nyhavn-specs.ts）。

const DEG = Math.PI / 180;

export const NYHAVN_ANCHOR: LatLon = { lat: 55.6798, lon: 12.5903 };
const AXIS = 115;
const SA = Math.sin(AXIS * DEG);
const CA = Math.cos(AXIS * DEG);
const SC = Math.sin((AXIS - 90) * DEG);
const CC = Math.cos((AXIS - 90) * DEG);

/** (a, c) → 相對原點的（東、北）公尺 */
function acToEN(a: number, c: number): [number, number] {
  return [a * SA + c * SC, a * CA + c * CC];
}

export function nyhavnLatLon(a: number, c: number): LatLon {
  const [e, n] = acToEN(a, c);
  return offsetLatLon(NYHAVN_ANCHOR, e, n);
}

export const NYHAVN_MASK: LatLon[] = MASK.map(([a, c]) => nyhavnLatLon(a, c));

/** 北岸彩色屋列（對準目標）：中心位置（相對錨點的東、南公尺）與高度 */
export const NYHAVN = (() => {
  const [e, n] = acToEN(-40, 44);
  return { rowTop: 19, dx: e, dz: -n, bridgeA: 65.5 };
})();

const preset = (name: string, a: number, c: number, extra: Omit<Preset, 'name' | 'group' | 'lat' | 'lon'> = {}): Preset => ({
  name,
  group: '丹麥・新港（哥本哈根）',
  ...nyhavnLatLon(a, c),
  ...extra,
});

/** 快速位置：經典拍攝點（方位角 295° ＝ 沿運河往國王新廣場，115° ＝ 往港口） */
export const NYHAVN_PRESETS: Preset[] = [
  preset('新港橋上（沿運河望向北岸彩色屋）', 65.5, 13, { height: 1.9, state: { azimuth: 292, pitch: 2, focal: 24 } }),
  preset('南岸碼頭（隔運河拍北岸屋列與帆船）', -52, -8.5, { aim: 'nyhavn', state: { focal: 24 } }),
  preset('南岸 Nyhavn 18 前（望向新港橋）', 2, -9, { state: { azimuth: 88, pitch: 3, focal: 35 } }),
  preset('北岸碼頭邊（沿運河往港口）', -112, 23.8, { state: { azimuth: 115, pitch: 2, focal: 20, portrait: true } }),
  preset('紀念錨旁（運河盡頭望向港口）', -178, 12, { state: { azimuth: 115, pitch: 3, focal: 35 } }),
  preset('內港橋上（由港口望進新港，約略位置）', 262, 4, { state: { azimuth: 295, pitch: 1, focal: 50 } }),
];

// ---- 高度基準 ----

/** 碼頭地面＝0；運河水面 */
const WATER_Y = -1.6;
/** 地基往下延伸 */
const G = -1.5;
/** 勒腳（半地下室）高度、一樓層高、樓上層高 */
const PLINTH = 0.9;
const GROUND_FLOOR = 3.1;
const UPPER_FLOOR = 2.85;
const CORNICE = 0.45;

const V = (a: number, y: number, c: number) => new THREE.Vector3(a, y, -c);

function flatAC(pts: P2[], y: number) {
  return flat(pts.map(([a, c]) => [a, -c] as [number, number]), y);
}

function signedArea(p: P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

function inPoly(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ai, ci] = poly[i];
    const [aj, cj] = poly[j];
    if (ci > p[1] !== cj > p[1] && p[0] < ((aj - ai) * (p[1] - ci)) / (cj - ci) + ai) inside = !inside;
  }
  return inside;
}

/** 四邊形（依序四點）→ 兩個三角形；uv 依 (u, v) 給定 */
function quad(p: THREE.Vector3[], uv: [number, number][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const tex: number[] = [];
  for (const k of [0, 1, 2, 0, 2, 3]) {
    pos.push(p[k].x, p[k].y, p[k].z);
    tex.push(uv[k][0], uv[k][1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(tex, 2));
  g.computeVertexNormals();
  return g;
}

function tri(p: THREE.Vector3[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p.flatMap((v) => [v.x, v.y, v.z]), 3));
  g.computeVertexNormals();
  return g;
}

/** 兩點之間的細圓柱（纜繩、欄杆、桅桿） */
function rod(p0: THREE.Vector3, p1: THREE.Vector3, r: number, seg = 4, r1 = r): THREE.BufferGeometry {
  const len = p0.distanceTo(p1);
  const g = new THREE.CylinderGeometry(r1, r, len, seg, 1, true);
  g.translate(0, len / 2, 0);
  const dir = p1.clone().sub(p0).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  g.translate(p0.x, p0.y, p0.z);
  return g;
}

// ---- 窗、門 ----

interface Opening {
  /** 牆面座標：x 沿牆（中心為 0）、y 高度 */
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'window' | 'door' | 'cellar' | 'shop';
}

/** 窗框：正面環（中間挖空）＋內側四面窗樘，背面與外側貼著牆洞看不到，不建 */
function frameRing(x: number, y: number, w: number, h: number, t: number, z: number, d: number): THREE.BufferGeometry {
  const outer = new THREE.Shape([new THREE.Vector2(x - w / 2, y), new THREE.Vector2(x + w / 2, y), new THREE.Vector2(x + w / 2, y + h), new THREE.Vector2(x - w / 2, y + h)]);
  const ix0 = x - w / 2 + t;
  const ix1 = x + w / 2 - t;
  const iy0 = y + t;
  const iy1 = y + h - t;
  outer.holes.push(new THREE.Path([new THREE.Vector2(ix0, iy0), new THREE.Vector2(ix0, iy1), new THREE.Vector2(ix1, iy1), new THREE.Vector2(ix1, iy0)]));
  const front = new THREE.ShapeGeometry(outer);
  front.translate(0, 0, z + d);
  const P = (px: number, py: number, pz: number) => new THREE.Vector3(px, py, pz);
  const zb = z;
  const zf = z + d;
  const sides = [
    quad([P(ix0, iy0, zb), P(ix1, iy0, zb), P(ix1, iy0, zf), P(ix0, iy0, zf)], [[0, 0], [1, 0], [1, 1], [0, 1]]),
    quad([P(ix1, iy1, zb), P(ix0, iy1, zb), P(ix0, iy1, zf), P(ix1, iy1, zf)], [[0, 0], [1, 0], [1, 1], [0, 1]]),
    quad([P(ix0, iy1, zb), P(ix0, iy0, zb), P(ix0, iy0, zf), P(ix0, iy1, zf)], [[0, 0], [1, 0], [1, 1], [0, 1]]),
    quad([P(ix1, iy0, zb), P(ix1, iy1, zb), P(ix1, iy1, zf), P(ix1, iy0, zf)], [[0, 0], [1, 0], [1, 1], [0, 1]]),
  ];
  return merge([front, ...sides]);
}

/** 窗櫺：貼在玻璃前的細長平面 */
function bar(x0: number, y0: number, x1: number, y1: number, z: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
  return g;
}

/** 窗框（白色）＋玻璃＋窗櫺；建在 XY 平面、+Z 朝外，depth＝牆板厚度（窗退入牆面約 13 cm） */
function addWindow(b: Batch, o: Opening, depth: number, pos: THREE.Vector3, normal: THREE.Vector3) {
  const { x, y, w, h } = o;
  const zg = depth - 0.13;
  const glass = new THREE.PlaneGeometry(w, h);
  glass.translate(x, y + h / 2, zg);
  b.add(M.glassDark, placeOnWall(glass, pos.clone(), normal));
  const t = 0.07;
  const parts: THREE.BufferGeometry[] = [frameRing(x, y, w, h, t, zg, 0.07)];
  if (o.kind === 'window') {
    // 丹麥傳統窗：兩扇對開＋上方橫楣，每扇再分上下兩格
    const transom = y + h * 0.72;
    parts.push(bar(x - 0.03, y + t, x + 0.03, y + h - t, zg + 0.04));
    parts.push(bar(x - w / 2 + t, transom - 0.035, x + w / 2 - t, transom + 0.035, zg + 0.04));
    parts.push(bar(x - w / 2 + t, (y + transom) / 2 - 0.02, x + w / 2 - t, (y + transom) / 2 + 0.02, zg + 0.03));
    const sill = new THREE.BoxGeometry(w + 0.12, 0.07, 0.2);
    sill.translate(x, y - 0.035, depth - 0.04);
    parts.push(sill);
  } else if (o.kind === 'shop') {
    parts.push(bar(x - w / 2 + t, y + h - 0.58, x + w / 2 - t, y + h - 0.52, zg + 0.04));
  } else if (o.kind === 'cellar') {
    const bars: THREE.BufferGeometry[] = [];
    for (const k of [-1, 0, 1]) bars.push(bar(x + (k * w) / 4 - 0.015, y, x + (k * w) / 4 + 0.015, y + h, depth - 0.05));
    b.add(NY.iron, placeOnWall(merge(bars), pos.clone(), normal));
  }
  b.add(NY.trim, placeOnWall(merge(parts), pos.clone(), normal));
}

function addDoor(b: Batch, o: Opening, depth: number, pos: THREE.Vector3, normal: THREE.Vector3, brown: boolean) {
  const { x, y, w, h } = o;
  const fan = 0.55;
  const panel = new THREE.BoxGeometry(w, h - fan, 0.08);
  panel.translate(x, y + (h - fan) / 2, depth - 0.16);
  b.add(brown ? NY.doorBrown : NY.door, placeOnWall(panel, pos.clone(), normal));
  // 門板上的格線
  const lines: THREE.BufferGeometry[] = [];
  for (const k of [-1, 1]) {
    const l = new THREE.BoxGeometry(0.05, h - fan - 0.3, 0.03);
    l.translate(x + (k * w) / 4, y + (h - fan) / 2, depth - 0.11);
    lines.push(l);
  }
  const mid = new THREE.BoxGeometry(0.05, h - fan, 0.04);
  mid.translate(x, y + (h - fan) / 2, depth - 0.11);
  lines.push(mid);
  b.add(brown ? NY.doorBrown : NY.door, placeOnWall(merge(lines), pos.clone(), normal));
  // 上方氣窗
  addWindow(b, { x, y: y + h - fan, w, h: fan, kind: 'shop' }, depth, pos, normal);
  // 砂岩門框
  const surround = frameFromOutlines(
    [new THREE.Vector2(x - w / 2 - 0.22, y), new THREE.Vector2(x + w / 2 + 0.22, y), new THREE.Vector2(x + w / 2 + 0.22, y + h + 0.25), new THREE.Vector2(x - w / 2 - 0.22, y + h + 0.25)],
    [new THREE.Vector2(x - w / 2, y), new THREE.Vector2(x + w / 2, y), new THREE.Vector2(x + w / 2, y + h), new THREE.Vector2(x - w / 2, y + h)],
    0.06,
  );
  surround.translate(0, 0, depth);
  b.add(NY.sandstone, placeOnWall(surround, pos.clone(), normal));
  // 門前台階（門檻在勒腳上方）
  const steps = Math.max(1, Math.round(y / 0.18));
  for (let i = 0; i < steps; i++) {
    const s = new THREE.BoxGeometry(w + 0.5, (y * (i + 1)) / steps, 0.3 * (steps - i));
    s.translate(x, (y * (i + 1)) / steps / 2, depth + (0.3 * (steps - i)) / 2);
    b.add(NY.sandstone, placeOnWall(s, pos.clone(), normal));
  }
}

interface WallFrame {
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  /** 沿牆距離（由 p0 起算）→ 牆板座標（牆中心為 0） */
  map: (s: number) => number;
  len: number;
}

/** 牆線 p0→p1（a, c；多邊形逆時針，外側在右手邊）的牆面座標系 */
function wallFrame(p0: P2, p1: P2): WallFrame {
  const d = new THREE.Vector2(p1[0] - p0[0], p1[1] - p0[1]);
  const len = d.length();
  d.normalize();
  // (a, c) 平面上逆時針多邊形的外法線＝(dc, −da)
  const normal = new THREE.Vector3(d.y, 0, d.x);
  const pos = V((p0[0] + p1[0]) / 2, 0, (p0[1] + p1[1]) / 2);
  // placeOnWall 的 +X（right＝up × n）是否與 p0→p1 同向
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), normal);
  const sgn = right.dot(V(d.x, 0, d.y)) > 0 ? 1 : -1;
  return { pos, normal, len, map: (s: number) => sgn * (s - len / 2) };
}

/** 牆板（含開口，開口已換成牆板座標）：由牆線往外凸出 depth */
function wallSlab(b: Batch, mat: THREE.Material, f: WallFrame, y0: number, y1: number, openings: Opening[], depth: number) {
  const x0 = -f.len / 2;
  const x1 = f.len / 2;
  const shape = new THREE.Shape([new THREE.Vector2(x0, y0), new THREE.Vector2(x1, y0), new THREE.Vector2(x1, y1), new THREE.Vector2(x0, y1)]);
  for (const o of openings) {
    const oy0 = Math.max(o.y, y0 + 0.001);
    const oy1 = Math.min(o.y + o.h, y1 - 0.001);
    if (oy1 <= oy0) continue;
    shape.holes.push(
      new THREE.Path([new THREE.Vector2(o.x - o.w / 2, oy0), new THREE.Vector2(o.x - o.w / 2, oy1), new THREE.Vector2(o.x + o.w / 2, oy1), new THREE.Vector2(o.x + o.w / 2, oy0)]),
    );
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  b.add(mat, planarUV(placeOnWall(g, f.pos.clone(), f.normal), 4));
}

// ---- 房屋 ----

interface Edge {
  p: P2;
  q: P2;
  len: number;
  /** 外法線 (a, c) */
  n: P2;
  kind: 'front' | 'side' | 'party' | 'plain';
}

function classify(fp: Footprint, poly: P2[], others: P2[][]): Edge[] {
  const toCanal: P2 = fp.side === 'N' ? [0, -1] : [0, 1];
  const frontC = fp.side === 'N' ? Math.min(...poly.map((p) => p[1])) : Math.max(...poly.map((p) => p[1]));
  const out: Edge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const da = q[0] - p[0];
    const dc = q[1] - p[1];
    const len = Math.hypot(da, dc);
    if (len < 0.05) continue;
    const n: P2 = [dc / len, -da / len];
    const m: P2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const probe: P2 = [m[0] + n[0] * 0.7, m[1] + n[1] * 0.7];
    let kind: Edge['kind'] = 'plain';
    if (others.some((o) => inPoly(probe, o))) kind = 'party';
    else if (n[0] * toCanal[0] + n[1] * toCanal[1] > 0.8 && Math.abs(m[1] - frontC) < 2.5) kind = 'front';
    else if (Math.abs(n[0]) > 0.75 && Math.abs(m[1] - frontC) < 16) kind = 'side';
    out.push({ p, q, len, n, kind });
  }
  return out;
}

/** 多邊形沿 c 方向（由正面往內）的深度：在正面中點往內打射線 */
function depthAt(poly: P2[], a: number, c0: number, dir: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [a0, cA] = poly[i];
    const [a1, cB] = poly[(i + 1) % poly.length];
    if ((a0 - a) * (a1 - a) > 0 || a0 === a1) continue;
    const t = (a - a0) / (a1 - a0);
    const c = cA + (cB - cA) * t;
    const d = (c - c0) * dir;
    if (d > 1 && d < best) best = d;
  }
  return best === Infinity ? 10 : best;
}

const PITCH = 50 * DEG;

interface RoofBox {
  a0: number;
  a1: number;
  /** 正面線與往內方向 */
  cf: number;
  dir: number;
  depth: number;
  eave: number;
}

function roofMat(t: HouseSpec['tile']): THREE.Material {
  return t === 'black' ? NY.roofBlack : t === 'slate' ? NY.roofSlate : t === 'copper' ? NY.roofCopper : NY.roofRed;
}

/** 斜面（沿 a 延伸）：外緣 (c0, y0) → 內緣 (c1, y1)，UV 沿屋脊與坡長 */
function slope(b: Batch, mat: THREE.Material, a0: number, a1: number, c0: number, y0: number, c1: number, y1: number) {
  const L = Math.hypot(c1 - c0, y1 - y0);
  b.add(mat, quad([V(a0, y0, c0), V(a1, y0, c0), V(a1, y1, c1), V(a0, y1, c1)], [[a0 / 2, 0], [a1 / 2, 0], [a1 / 2, L / 2], [a0 / 2, L / 2]]));
}

/** 坡面（沿 c 延伸，給山牆窗用）：外緣 (a0, y0) → 內緣 (a1, y1)，由 c0 到 c1 */
function slopeC(b: Batch, mat: THREE.Material, c0: number, c1: number, a0: number, y0: number, a1: number, y1: number) {
  const L = Math.hypot(a1 - a0, y1 - y0);
  b.add(mat, quad([V(a0, y0, c0), V(a0, y0, c1), V(a1, y1, c1), V(a1, y1, c0)], [[c0 / 2, 0], [c1 / 2, 0], [c1 / 2, L / 2], [c0 / 2, L / 2]]));
}

function gableEnd(b: Batch, mat: THREE.Material, a: number, pts: [number, number][]) {
  // pts：(c, y) 輪廓，兩面都建（任一面都可能外露）
  const shape = new THREE.Shape(pts.map(([c, y]) => new THREE.Vector2(c, y)));
  const g = new THREE.ShapeGeometry(shape);
  // shape 的 x＝c、y＝高度 → 模型空間 (a, y, −c)
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).setPosition(a, 0, 0);
  g.applyMatrix4(m);
  const back = g.clone();
  const idx = back.getIndex();
  if (idx) {
    const arr = idx.array as Uint16Array;
    for (let i = 0; i < arr.length; i += 3) [arr[i + 1], arr[i + 2]] = [arr[i + 2], arr[i + 1]];
  }
  back.computeVertexNormals();
  b.add(mat, planarUV(g, 4));
  b.add(mat, planarUV(back, 4));
}

function buildRoof(b: Batch, r: RoofBox, spec: HouseSpec, wall: THREE.Material) {
  const mat = roofMat(spec.tile);
  const { a0, a1, cf, dir, depth: D, eave } = r;
  const ov = 0.35;
  const cBack = cf + dir * D;
  const type = spec.roof ?? 'gable';
  const t = Math.tan(PITCH);
  if (type === 'flat') {
    // 平頂＋女兒牆壓頂
    b.add(NY.trim, box(a1 - a0, 0.25, 0.4, (a0 + a1) / 2, eave, -(cf + dir * 0.1)));
    return;
  }
  if (type === 'mansard') {
    const low = 2.6;
    const inset = low / Math.tan(72 * DEG);
    const ridge = eave + low + (D / 2 - inset) * Math.tan(28 * DEG);
    const cm = cf + (dir * D) / 2;
    slope(b, mat, a0, a1, cf - dir * ov, eave - ov * Math.tan(72 * DEG) * 0.3, cf + dir * inset, eave + low);
    slope(b, mat, a0, a1, cf + dir * inset, eave + low, cm, ridge);
    slope(b, mat, a0, a1, cBack + dir * ov, eave - ov * 0.4, cBack - dir * inset, eave + low);
    slope(b, mat, a0, a1, cBack - dir * inset, eave + low, cm, ridge);
    const prof: [number, number][] = [[cf, eave], [cf + dir * inset, eave + low], [cm, ridge], [cBack - dir * inset, eave + low], [cBack, eave]];
    gableEnd(b, wall, a0, prof);
    gableEnd(b, wall, a1, prof);
    ridgeCap(b, a0, a1, cm, ridge);
    chimneys(b, a0, a1, cm, ridge);
    return;
  }
  const ridge = eave + (D / 2) * t;
  const cm = cf + (dir * D) / 2;
  if (type === 'hip' && a1 - a0 > 2) {
    const h = Math.min(D / 2, (a1 - a0) / 2 - 0.01);
    const ra0 = a0 + h;
    const ra1 = a1 - h;
    // 前後坡為梯形
    for (const [ce, sgn] of [[cf - dir * ov, 1], [cBack + dir * ov, -1]] as [number, number][]) {
      const y0 = eave - ov * t * 0.5;
      const P = [V(a0 - ov, y0, ce), V(a1 + ov, y0, ce), V(ra1, ridge, cm), V(ra0, ridge, cm)];
      b.add(mat, planarUV(quad(sgn > 0 ? P : [P[1], P[0], P[3], P[2]], [[0, 0], [1, 0], [1, 1], [0, 1]]), 2));
    }
    for (const [ae, ra] of [[a0 - ov, ra0], [a1 + ov, ra1]] as [number, number][]) {
      const y0 = eave - ov * t * 0.5;
      b.add(mat, planarUV(tri([V(ae, y0, cf - dir * ov), V(ae, y0, cBack + dir * ov), V(ra, ridge, cm)]), 2));
    }
    ridgeCap(b, ra0, ra1, cm, ridge);
    chimneys(b, ra0, ra1, cm, ridge);
    return;
  }
  // 雙坡（屋脊平行運河），兩端山牆
  slope(b, mat, a0, a1, cf - dir * ov, eave - ov * t, cm, ridge);
  slope(b, mat, a0, a1, cBack + dir * ov, eave - ov * t, cm, ridge);
  const prof: [number, number][] = [[cf, eave], [cm, ridge], [cBack, eave]];
  gableEnd(b, wall, a0, prof);
  gableEnd(b, wall, a1, prof);
  ridgeCap(b, a0, a1, cm, ridge);
  chimneys(b, a0, a1, cm, ridge);
}

function ridgeCap(b: Batch, a0: number, a1: number, c: number, y: number) {
  const g = new THREE.CylinderGeometry(0.13, 0.13, a1 - a0, 6, 1);
  g.rotateZ(Math.PI / 2);
  g.translate((a0 + a1) / 2, y + 0.02, -c);
  b.add(NY.roofFlat, g);
}

function chimneys(b: Batch, a0: number, a1: number, c: number, ridge: number) {
  const n = Math.max(1, Math.round((a1 - a0) / 9));
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * (i + 0.5)) / n + 0.6;
    b.add(NY.chimney, planarUV(box(0.95, 2.4, 0.6, a, ridge - 1.2, -c), 2));
    b.add(NY.plinth, box(1.1, 0.12, 0.75, a, ridge + 1.2, -c));
  }
}

/** 屋頂上的老虎窗：前牆在距正面 x0 處 */
function dormer(b: Batch, r: RoofBox, a: number, w: number, mat: THREE.Material, wall: THREE.Material) {
  const t = Math.tan(PITCH);
  const x0 = 1.1;
  const yb = r.eave + x0 * t - 0.15;
  const h = 1.75;
  const x1 = (yb + h - r.eave) / t + 0.3;
  const c0 = r.cf + r.dir * x0;
  const c1 = r.cf + r.dir * x1;
  // 兩側頰板與前牆
  for (const s of [-1, 1]) b.add(wall, planarUV(box(0.12, h, Math.abs(c1 - c0), a + (s * w) / 2, yb, -(c0 + c1) / 2), 4));
  const front = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(w / 2, h), new THREE.Vector2(-w / 2, h)]);
  front.holes.push(new THREE.Path([new THREE.Vector2(-w / 2 + 0.25, 0.25), new THREE.Vector2(-w / 2 + 0.25, h - 0.2), new THREE.Vector2(w / 2 - 0.25, h - 0.2), new THREE.Vector2(w / 2 - 0.25, 0.25)]));
  const nrm = new THREE.Vector3(0, 0, r.dir); // 朝運河
  const pos = V(a, yb, c0);
  b.add(wall, planarUV(placeOnWall(new THREE.ExtrudeGeometry(front, { depth: 0.1, bevelEnabled: false }), pos.clone(), nrm), 4));
  addWindow(b, { x: 0, y: 0.25, w: w - 0.5, h: h - 0.45, kind: 'window' }, 0.12, pos.clone(), nrm);
  // 小雙坡頂（屋脊垂直運河）
  const ry = yb + h + (w / 2 + 0.15) * Math.tan(40 * DEG);
  slopeC(b, mat, c0 - r.dir * 0.2, c1, a - w / 2 - 0.15, yb + h - 0.05, a, ry);
  slopeC(b, mat, c0 - r.dir * 0.2, c1, a + w / 2 + 0.15, yb + h - 0.05, a, ry);
  const tri0 = new THREE.Shape([new THREE.Vector2(-w / 2, h), new THREE.Vector2(w / 2, h), new THREE.Vector2(0, ry - yb)]);
  b.add(wall, planarUV(placeOnWall(new THREE.ShapeGeometry(tri0), pos.clone().add(nrm.clone().multiplyScalar(0.1)), nrm), 4));
}

interface HouseOut {
  eave: number;
  ridge: number;
  front: { p: P2; q: P2 } | null;
}

function buildHouse(b: Batch, fp: Footprint, others: P2[][]): HouseOut {
  const spec: HouseSpec = HOUSES[`${fp.side}${fp.no}`] ?? { color: 'cream', storeys: 4 };
  const poly = signedArea(fp.poly) < 0 ? fp.poly.slice().reverse() : fp.poly;
  const edges = classify(fp, poly, others);
  const wall = FACADE[spec.color];
  const storeys = spec.storeys;
  const plinth = spec.plinth ?? PLINTH;
  const gf = spec.groundFloor ?? GROUND_FLOOR;
  const uf = spec.floor ?? UPPER_FLOOR;
  const eave = plinth + gf + (storeys - 1) * uf + CORNICE;

  // 牆體：每一邊一片垂直牆（界牆也建：鄰房較矮時會露出防火牆）
  for (const e of edges) {
    const g = quad(
      [V(e.p[0], G, e.p[1]), V(e.q[0], G, e.q[1]), V(e.q[0], eave, e.q[1]), V(e.p[0], eave, e.p[1])],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    );
    b.add(e.kind === 'party' ? FACADE.grey : wall, planarUV(g, 4));
  }
  // 屋頂平面（後段、中庭側的平屋頂）
  b.add(NY.roofFlat, flatAC(poly, eave - 0.02));

  // 正面：最長的一段臨運河邊
  const fronts = edges.filter((e) => e.kind === 'front');
  const main = fronts.sort((x, y) => y.len - x.len)[0];
  let out: HouseOut = { eave, ridge: eave, front: null };
  const dir = fp.side === 'N' ? 1 : -1;

  const facade = (e: Edge, detailed: boolean) => {
    const W = e.len;
    const bays = detailed && spec.bays ? spec.bays : Math.max(1, Math.round(W / 2.35));
    const bw = W / bays;
    const ww = Math.min(1.15, bw * 0.55);
    const openings: Opening[] = [];
    const doorBay = spec.door ?? (bays % 2 ? (bays - 1) / 2 : bays - 1);
    const cellar: Opening[] = [];
    const along = (i: number) => bw * (i + 0.5);
    // 各樓層
    for (let f = 0; f < storeys; f++) {
      const base = f === 0 ? plinth : plinth + gf + (f - 1) * uf;
      const h = f === 0 ? 2.05 : f === storeys - 1 ? 1.55 : 1.75;
      const sill = f === 0 ? 0.55 : 0.75;
      for (let i = 0; i < bays; i++) {
        if (f === 0 && detailed && i === doorBay) {
          openings.push({ x: along(i), y: plinth, w: Math.min(1.3, bw * 0.62), h: 2.7, kind: 'door' });
          continue;
        }
        const shop = f === 0 && spec.shop;
        openings.push({ x: along(i), y: base + (shop ? 0.25 : sill), w: shop ? Math.min(bw * 0.72, 1.8) : ww, h: shop ? 2.35 : h, kind: shop ? 'shop' : 'window' });
      }
    }
    if (spec.cellar && detailed)
      for (let i = 0; i < bays; i++) if (i !== doorBay) cellar.push({ x: along(i), y: 0.12, w: Math.min(1.0, bw * 0.5), h: plinth - 0.3, kind: 'cellar' });
    const depth = 0.22;
    const slab = wallFrame(e.p, e.q);
    const open = openings.map((o) => ({ ...o, x: slab.map(o.x) }));
    const cel = cellar.map((o) => ({ ...o, x: slab.map(o.x) }));
    wallSlab(b, wall, slab, plinth, eave - CORNICE + 0.02, open, depth);
    wallSlab(b, NY.plinth, slab, G, plinth, cel.concat(open.filter((o) => o.kind === 'door')), depth + 0.04);
    for (const o of open) {
      if (o.kind === 'door') addDoor(b, o, depth, slab.pos, slab.normal, spec.color === 'white' || spec.color === 'cream');
      else addWindow(b, o, depth, slab.pos, slab.normal);
    }
    for (const o of cel) addWindow(b, o, depth + 0.04, slab.pos, slab.normal);
    // 簷口、腰線
    const trimMat = spec.trim === 'wall' ? wall : NY.trim;
    const L = e.len;
    const cor = new THREE.BoxGeometry(L, CORNICE, 0.42);
    cor.translate(0, eave - CORNICE / 2, 0.21);
    b.add(trimMat, placeOnWall(cor, slab.pos.clone(), slab.normal));
    const cor2 = new THREE.BoxGeometry(L, 0.12, 0.52);
    cor2.translate(0, eave - 0.06, 0.26);
    b.add(trimMat, placeOnWall(cor2, slab.pos.clone(), slab.normal));
    // 17–18 世紀房屋：牆面上的鑄鐵拉桿錨（S 形，每層樓板高度、兩側各一）
    if (detailed && (spec.year ?? 1900) < 1800) {
      const anchors: THREE.BufferGeometry[] = [];
      for (let f = 1; f < storeys; f++) {
        const y = plinth + gf + (f - 1) * uf - 0.25;
        for (const sx of [-L / 2 + 0.45, L / 2 - 0.45]) {
          anchors.push(bar(sx - 0.03, y - 0.32, sx + 0.03, y + 0.32, depth + 0.012));
          anchors.push(bar(sx - 0.14, y + 0.26, sx + 0.03, y + 0.32, depth + 0.014));
          anchors.push(bar(sx - 0.03, y - 0.32, sx + 0.14, y - 0.26, depth + 0.014));
        }
      }
      b.add(NY.iron, placeOnWall(merge(anchors), slab.pos.clone(), slab.normal));
    }
    const band = new THREE.BoxGeometry(L, 0.14, depth + 0.1);
    band.translate(0, plinth + gf - 0.1, (depth + 0.1) / 2);
    b.add(trimMat, placeOnWall(band, slab.pos.clone(), slab.normal));
    return { bays, bw };
  };

  if (main) {
    const { bays, bw } = facade(main, true);
    for (const e of fronts) if (e !== main && e.len > 1.5) facade(e, false);
    const a0 = Math.min(main.p[0], main.q[0]);
    const a1 = Math.max(main.p[0], main.q[0]);
    const cf = (main.p[1] + main.q[1]) / 2;
    const mid = (a0 + a1) / 2;
    const full = depthAt(poly, mid, cf, dir);
    const D = Math.max(4, Math.min(full, spec.depth ?? 10.5));
    const r: RoofBox = { a0, a1, cf, dir, depth: D, eave };
    buildRoof(b, r, spec, wall);
    const mat = roofMat(spec.tile);
    // 正面山牆窗（gavlkvist）：一層高、山牆朝運河，屋脊伸入主屋頂
    const kvists: number[] = [];
    if (spec.kvist && spec.kvist <= bays) {
      const k = spec.kvist;
      for (const st of spec.kvistStart ?? [(bays - k) / 2]) {
        const s0 = bw * st;
        const s1 = bw * (st + k);
        // 正面邊是 p→q；換成 a 座標
        const aAt = (t: number) => main.p[0] + ((main.q[0] - main.p[0]) * t) / main.len;
        const ka = (aAt(s0) + aAt(s1)) / 2;
        kvists.push(ka);
        const w = Math.abs(aAt(s1) - aAt(s0)) - 0.3;
        const hk = uf + 0.35;
        const ridgeK = eave + hk + (w / 2) * Math.tan(45 * DEG);
        const reach = (ridgeK - eave) / Math.tan(PITCH) + 0.3;
        const dk = Math.min(reach, D / 2);
        const pk: P2 = [ka - w / 2, cf];
        const qk: P2 = [ka + w / 2, cf];
        const [p, q] = dir === 1 ? [qk, pk] : [pk, qk];
        const slabK = wallFrame(p, q);
        const opens: Opening[] = [];
        for (let i = 0; i < k; i++) opens.push({ x: slabK.map(bw * (i + 0.5) - 0.15), y: eave + 0.45, w: Math.min(1.1, bw * 0.55), h: 1.5, kind: 'window' });
        wallSlab(b, wall, slabK, eave - CORNICE, eave + hk, opens, 0.22);
        for (const o of opens) addWindow(b, o, 0.22, slabK.pos, slabK.normal);
        for (const sg of [-1, 1]) b.add(wall, planarUV(box(0.2, hk + 0.1, dk, ka + (sg * (w - 0.2)) / 2, eave - 0.1, -(cf + (dir * dk) / 2)), 4));
        const gtri = new THREE.Shape([new THREE.Vector2(-w / 2 - 0.1, 0), new THREE.Vector2(w / 2 + 0.1, 0), new THREE.Vector2(0, ridgeK - eave - hk)]);
        b.add(wall, planarUV(placeOnWall(new THREE.ExtrudeGeometry(gtri, { depth: 0.22, bevelEnabled: false }), V(ka, eave + hk, cf), slabK.normal), 4));
        const kc = new THREE.BoxGeometry(w + 0.3, 0.25, 0.35);
        kc.translate(0, eave + hk - 0.12, 0.2);
        b.add(NY.trim, placeOnWall(kc, V(ka, 0, cf), slabK.normal));
        slopeC(b, mat, cf - dir * 0.35, cf + dir * reach, ka - w / 2 - 0.35, eave + hk - 0.3, ka, ridgeK + 0.05);
        slopeC(b, mat, cf - dir * 0.35, cf + dir * reach, ka + w / 2 + 0.35, eave + hk - 0.3, ka, ridgeK + 0.05);
      }
    }
    // 老虎窗
    const nd = spec.dormers ?? 0;
    if (nd > 0 && (spec.roof ?? 'gable') !== 'flat') {
      const skip = spec.kvist ? spec.kvist * bw + 1.2 : 0;
      const slots: number[] = [];
      for (let i = 0; i < bays; i++) {
        const a = a0 + bw * (i + 0.5);
        if (kvists.some((ka) => Math.abs(a - ka) < skip / 2)) continue;
        slots.push(a);
      }
      const pick = slots.length <= nd ? slots : Array.from({ length: nd }, (_, i) => slots[Math.round(((i + 0.5) * slots.length) / nd - 0.5)]);
      for (const a of pick) dormer(b, r, a, 1.35, mat, wall);
    }
    out = { eave, ridge: eave + (D / 2) * Math.tan(PITCH), front: { p: main.p, q: main.q } };
  }
  // 側街立面（街角）
  for (const e of edges) if (e.kind === 'side' && e.len > 2.5) facade(e, false);
  return out;
}

// ---- 碼頭 ----

function buildQuays(b: Batch) {
  // 碼頭鋪面
  b.add(NY.cobble, planarUV(flatAC(GROUND, 0), 3));
  // 水面
  b.add(M.water, flatAC(CANAL, WATER_Y));
  // 駁岸：沿運河邊的石牆＋花崗岩壓頂（東端出海口不建）
  const ring = signedArea(CANAL) < 0 ? CANAL.slice().reverse() : CANAL;
  const walls: THREE.BufferGeometry[] = [];
  const copings: THREE.BufferGeometry[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    if (p[0] > 235 && q[0] > 235) continue;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 0.05) continue;
    // 水面在多邊形內側：牆面朝內
    walls.push(quad([V(q[0], WATER_Y - 1, q[1]), V(p[0], WATER_Y - 1, p[1]), V(p[0], 0, p[1]), V(q[0], 0, q[1])], [[0, 0], [len / 4, 0], [len / 4, 0.4], [0, 0.4]]));
    const g = beamBetween(V(p[0], 0.08, p[1]), V(q[0], 0.08, q[1]), 0.62, 0.2);
    copings.push(g);
  }
  b.add(NY.quayStone, planarUV(merge(walls), 4));
  b.add(NY.coping, planarUV(merge(copings), 2));
}

/** 碼頭邊的鑄鐵繫船柱 */
function bollard(parts: THREE.BufferGeometry[], a: number, c: number) {
  const g = new THREE.CylinderGeometry(0.16, 0.2, 0.6, 10);
  g.translate(a, 0.3, -c);
  parts.push(g);
  const cap = new THREE.CylinderGeometry(0.24, 0.2, 0.12, 10);
  cap.translate(a, 0.64, -c);
  parts.push(cap);
}

/** 街燈：黑色鑄鐵燈柱＋四角燈籠 */
function lamp(b: Batch, iron: THREE.BufferGeometry[], a: number, c: number) {
  iron.push(cylinder(0.14, 0.4, a, 0, -c, 8, 0.1));
  iron.push(cylinder(0.07, 3.6, a, 0.4, -c, 8, 0.05));
  const top = 4.0;
  const lantern = new THREE.CylinderGeometry(0.28, 0.16, 0.6, 4, 1);
  lantern.rotateY(Math.PI / 4);
  lantern.translate(a, top + 0.3, -c);
  b.add(NY.lampGlass, lantern);
  const hat = new THREE.ConeGeometry(0.34, 0.3, 4);
  hat.rotateY(Math.PI / 4);
  hat.translate(a, top + 0.75, -c);
  iron.push(hat);
}

/** 北岸餐廳：遮陽篷、桌椅、方形陽傘 */
function buildTerraces(b: Batch, fronts: { fp: Footprint; out: HouseOut }[]) {
  const iron: THREE.BufferGeometry[] = [];
  const tables: THREE.BufferGeometry[] = [];
  const legs: THREE.BufferGeometry[] = [];
  const umbrellas: THREE.BufferGeometry[] = [];
  const awnings = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const { fp, out } of fronts) {
    const spec = HOUSES[`${fp.side}${fp.no}`];
    if (!spec?.awning || !out.front) continue;
    const dir = fp.side === 'N' ? 1 : -1;
    const a0 = Math.min(out.front.p[0], out.front.q[0]);
    const a1 = Math.max(out.front.p[0], out.front.q[0]);
    const cf = (out.front.p[1] + out.front.q[1]) / 2;
    const mat = spec.awning === 'red' ? NY.awningRed : spec.awning === 'green' ? NY.awningGreen : spec.awning === 'blue' ? NY.awningBlue : NY.canvas;
    const list = awnings.get(mat) ?? [];
    // 篷布：由牆面 3.3 m 高斜下到外伸 2.8 m 處，前緣垂片 0.3 m
    const y0 = PLINTH + 2.9;
    const y1 = PLINTH + 2.25;
    const out1 = 2.8;
    const wa0 = a0 + 0.3;
    const wa1 = a1 - 0.3;
    list.push(quad([V(wa0, y0, cf - dir * 0.25), V(wa1, y0, cf - dir * 0.25), V(wa1, y1, cf - dir * out1), V(wa0, y1, cf - dir * out1)], [[wa0, 0], [wa1, 0], [wa1, 1], [wa0, 1]]));
    list.push(quad([V(wa0, y1, cf - dir * out1), V(wa1, y1, cf - dir * out1), V(wa1, y1 - 0.3, cf - dir * out1), V(wa0, y1 - 0.3, cf - dir * out1)], [[wa0, 0], [wa1, 0], [wa1, 0.3], [wa0, 0.3]]));
    awnings.set(mat, list);
    for (const a of [wa0, wa1]) iron.push(rod(V(a, y0 - 0.1, cf - dir * 0.25), V(a, y1, cf - dir * out1), 0.025));
    // 篷下桌椅（貼著立面一排）
    for (let a = wa0 + 0.9; a < wa1 - 0.5; a += 1.9) {
      tables.push(box(0.7, 0.04, 0.7, a, 0.74, -(cf - dir * 1.6)));
      legs.push(cylinder(0.03, 0.74, a, 0, -(cf - dir * 1.6), 5));
      for (const s of [-1, 1]) {
        legs.push(box(0.42, 0.04, 0.42, a + s * 0.62, 0.45, -(cf - dir * 1.6)));
        legs.push(box(0.04, 0.45, 0.42, a + s * 0.83, 0.45, -(cf - dir * 1.6)));
        legs.push(box(0.04, 0.45, 0.04, a + s * 0.62, 0, -(cf - dir * 1.6)));
      }
    }
    // 碼頭邊一排啤酒桌＋方形陽傘
    const cEdge = fp.side === 'N' ? 25.2 : -8.2;
    for (let a = a0 + 1.6; a < a1 - 1.2; a += 3.6) {
      tables.push(box(1.8, 0.05, 0.62, a, 0.74, -cEdge));
      for (const s of [-1, 1]) {
        tables.push(box(1.8, 0.05, 0.28, a, 0.44, -(cEdge + s * 0.62)));
        legs.push(box(0.06, 0.44, 0.24, a - 0.75, 0, -(cEdge + s * 0.62)));
        legs.push(box(0.06, 0.44, 0.24, a + 0.75, 0, -(cEdge + s * 0.62)));
      }
      legs.push(box(0.06, 0.74, 0.5, a - 0.75, 0, -cEdge));
      legs.push(box(0.06, 0.74, 0.5, a + 0.75, 0, -cEdge));
      const u = new THREE.ConeGeometry(1.75, 0.55, 4, 1, true);
      u.rotateY(Math.PI / 4);
      u.translate(a, 2.55, -cEdge);
      umbrellas.push(u);
      const flap = new THREE.CylinderGeometry(1.24, 1.24, 0.18, 4, 1, true);
      flap.rotateY(Math.PI / 4);
      flap.translate(a, 2.2, -cEdge);
      umbrellas.push(flap);
      iron.push(cylinder(0.035, 2.8, a, 0, -cEdge, 6));
    }
  }
  for (const [mat, list] of awnings) b.add(mat, merge(list));
  if (tables.length) b.add(NY.tableTop, merge(tables));
  if (legs.length) b.add(NY.furniture, merge(legs));
  if (umbrellas.length) b.add(NY.canvas, merge(umbrellas));
  if (iron.length) b.add(NY.iron, merge(iron));
}

function buildStreetFurniture(b: Batch) {
  const iron: THREE.BufferGeometry[] = [];
  // 繫船柱：沿兩岸碼頭邊，每 9 m
  for (let a = -160; a < 232; a += 9) {
    if (a > 56 && a < 75) continue; // 新港橋
    bollard(iron, a, 23.2);
    if (a > -99 || a < -150) bollard(iron, a, -6.2);
  }
  // 街燈
  for (let a = -150; a < 230; a += 22) {
    if (a > 55 && a < 76) continue;
    lamp(b, iron, a, 35.2);
    lamp(b, iron, a + 11, -17.6);
  }
  // 公廁入口亭（西端碼頭上，地下公廁的樓梯間）
  b.add(M.glassDark, box(5.2, 2.5, 5.6, -177, 0, -19.3));
  b.add(NY.iron, box(5.8, 0.25, 6.2, -177, 2.5, -19.3));
  b.add(M.glassDark, box(5.2, 2.5, 5.6, -177, 0, -1.0));
  b.add(NY.iron, box(5.8, 0.25, 6.2, -177, 2.5, -1.0));
  b.add(NY.iron, merge(iron));
}

// ---- 紀念錨（Mindeankeret，1951） ----

const ANCHOR = { a: -174.5, c: 9.5 };

function buildAnchor(b: Batch) {
  const { a, c } = ANCHOR;
  // 花崗岩台座：兩層台階＋方柱
  b.add(NY.coping, planarUV(box(5.2, 0.3, 5.2, a, 0, -c), 2));
  b.add(NY.coping, planarUV(box(4.2, 0.3, 4.2, a, 0.3, -c), 2));
  b.add(M.granite, planarUV(box(2.4, 1.1, 2.4, a, 0.6, -c), 2));
  b.add(M.granite, planarUV(box(2.7, 0.2, 2.7, a, 1.7, -c), 2));
  // 海軍錨：錨桿垂直、錨冠朝下，錨杆（橫桿）在上方與錨臂垂直
  const base = 1.9;
  const parts: THREE.BufferGeometry[] = [];
  const shankTop = base + 4.3;
  parts.push(cylinder(0.17, shankTop - base - 0.35, a, base + 0.35, -c, 12, 0.14));
  // 錨環
  const ring = new THREE.TorusGeometry(0.42, 0.07, 8, 20);
  ring.translate(a, shankTop + 0.3, -c);
  parts.push(ring);
  // 橫桿（鐵製，兩端球頭），與錨臂所在平面垂直（沿 c）
  const stock = new THREE.CylinderGeometry(0.11, 0.11, 3.6, 10);
  stock.rotateX(Math.PI / 2);
  stock.translate(a, shankTop - 0.35, -c);
  parts.push(stock);
  for (const s of [-1, 1]) {
    const ball = new THREE.SphereGeometry(0.17, 10, 8);
    ball.translate(a, shankTop - 0.35, -(c + s * 1.8));
    parts.push(ball);
  }
  // 錨臂：以錨冠為中心的圓弧（沿 a），末端為三角形錨爪
  const R = 1.5;
  const crown = new THREE.Vector3(a, base + 0.35 + R, -c);
  const arc = new THREE.TorusGeometry(R, 0.15, 8, 24, (110 * Math.PI) / 180);
  arc.rotateZ(-Math.PI / 2 - (55 * Math.PI) / 180);
  arc.translate(crown.x, crown.y, crown.z);
  parts.push(arc);
  for (const s of [-1, 1]) {
    const t = -Math.PI / 2 + s * (55 * Math.PI) / 180;
    const tip = crown.clone().add(new THREE.Vector3(Math.cos(t) * R, Math.sin(t) * R, 0));
    const fluke = new THREE.ConeGeometry(0.42, 0.9, 3);
    fluke.scale(1, 1, 0.35);
    fluke.rotateZ(s * (35 * Math.PI) / 180);
    fluke.translate(tip.x - s * 0.1, tip.y + 0.3, tip.z);
    parts.push(fluke);
  }
  const crownBall = new THREE.SphereGeometry(0.24, 10, 8);
  crownBall.translate(a, base + 0.35, -c);
  parts.push(crownBall);
  b.add(NY.iron, merge(parts));
}

// ---- 新港橋（Nyhavnsbroen，1912） ----

const BRIDGE = { a0: 58.7, a1: 72.4, c0: -8, c1: 26.5 };

function buildBridge(b: Batch) {
  const { a0, a1, c0, c1 } = BRIDGE;
  const ac = (a0 + a1) / 2;
  const w = a1 - a0;
  // 橋面：微拱（中央高 0.35 m），鋼梁外側
  const n = 12;
  const deck: THREE.BufferGeometry[] = [];
  const fascia: THREE.BufferGeometry[] = [];
  const rail: THREE.BufferGeometry[] = [];
  const hump = (c: number) => 0.35 * Math.cos(((c - (c0 + c1) / 2) / (c1 - c0)) * Math.PI);
  for (let i = 0; i < n; i++) {
    const ca = c0 + ((c1 - c0) * i) / n;
    const cb = c0 + ((c1 - c0) * (i + 1)) / n;
    const ya = Math.max(0.02, hump(ca));
    const yb = Math.max(0.02, hump(cb));
    deck.push(quad([V(a0, ya, ca), V(a1, ya, ca), V(a1, yb, cb), V(a0, yb, cb)], [[a0 / 3, ca / 3], [a1 / 3, ca / 3], [a1 / 3, cb / 3], [a0 / 3, cb / 3]]));
    // 橋底
    deck.push(quad([V(a0, -0.9, cb), V(a1, -0.9, cb), V(a1, -0.9, ca), V(a0, -0.9, ca)], [[0, 0], [1, 0], [1, 1], [0, 1]]));
    for (const a of [a0, a1]) {
      const s = a === a0 ? -1 : 1;
      const p = [V(a, ya + 0.15, ca), V(a, yb + 0.15, cb), V(a, -0.9, cb), V(a, -0.9, ca)];
      fascia.push(s < 0 ? quad(p, [[0, 0], [1, 0], [1, 1], [0, 1]]) : quad([p[1], p[0], p[3], p[2]], [[0, 0], [1, 0], [1, 1], [0, 1]]));
      // 鑄鐵欄杆：扶手＋立柱
      const ra = V(a - s * 0.15, ya + 1.1, ca);
      const rb = V(a - s * 0.15, yb + 1.1, cb);
      rail.push(rod(ra, rb, 0.045, 6));
      rail.push(rod(ra.clone().setY(ya + 0.25), rb.clone().setY(yb + 0.25), 0.03, 4));
      for (let k = 0; k < 8; k++) {
        const t = k / 8;
        const cc = ca + (cb - ca) * t;
        const yy = ya + (yb - ya) * t;
        rail.push(rod(V(a - s * 0.15, yy + 0.15, cc), V(a - s * 0.15, yy + 1.1, cc), 0.018, 4));
      }
      if (i % 3 === 0) rail.push(box(0.2, 1.25, 0.2, a - s * 0.15, ya + 0.1, -ca));
    }
  }
  b.add(M.road, planarUV(merge(deck), 3));
  b.add(NY.hullGreen, merge(fascia));
  b.add(NY.iron, merge(rail));
  // 橋面兩側人行道緣石
  for (const a of [a0 + 2.2, a1 - 2.2]) b.add(NY.coping, box(0.25, 0.14, c1 - c0, a, 0.3, -(c0 + c1) / 2));
  // 兩岸橋台
  for (const c of [-5.5, 22.5]) b.add(NY.quayStone, planarUV(box(w, 0 - WATER_Y + 0.9, 1.2, ac, WATER_Y - 0.9, -c), 4));
}

// ---- 木造帆船 ----

/** 船殼：沿長度取站位，每站為半橢圓截面；bow 朝 +x */
function hull(len: number, beam: number, free: number, sheer: number, transom: number): { outer: THREE.BufferGeometry; band: THREE.BufferGeometry; deck: THREE.BufferGeometry; top: (x: number) => number; half: (x: number) => number } {
  const NS = 22;
  const NR = 7;
  const draft = 1.8;
  const half = (x: number) => {
    const t = x / len + 0.5;
    if (t < 0.18) return (beam / 2) * (transom + (1 - transom) * Math.sin((t / 0.18) * (Math.PI / 2)));
    if (t < 0.55) return beam / 2;
    return (beam / 2) * Math.pow(Math.max(0, 1 - ((t - 0.55) / 0.45) ** 2), 0.62);
  };
  const top = (x: number) => free + sheer * ((2 * x) / len) ** 2 * (x > 0 ? 1.2 : 0.8);
  const rows: THREE.Vector3[][] = [];
  for (let i = 0; i <= NS; i++) {
    const x = -len / 2 + (len * i) / NS;
    const hb = half(x);
    const yt = top(x);
    const col: THREE.Vector3[] = [];
    for (let k = 0; k <= NR * 2; k++) {
      // θ：−90°（右舷甲板邊）→ 0（龍骨）→ +90°（左舷甲板邊）
      const th = ((k / (NR * 2)) * 2 - 1) * (Math.PI / 2);
      const yy = yt - (yt + draft) * Math.pow(Math.cos(th), 1.6);
      col.push(new THREE.Vector3(x, yy, Math.sin(th) * hb));
    }
    rows.push(col);
  }
  const pos: number[] = [];
  const bandPos: number[] = [];
  const push = (arr: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < NS; i++)
    for (let k = 0; k < NR * 2; k++) {
      const a = rows[i][k];
      const b = rows[i + 1][k];
      const c = rows[i + 1][k + 1];
      const d = rows[i][k + 1];
      const arr = k === 0 || k === NR * 2 - 1 ? bandPos : pos;
      push(arr, a, c, b);
      push(arr, a, d, c);
    }
  // 船尾板
  const st = rows[0];
  for (let k = 1; k < st.length - 1; k++) push(pos, st[0], st[k], st[k + 1]);
  const mk = (arr: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    return g;
  };
  // 甲板：兩舷之間，比舷牆低 0.45 m
  const dp: number[] = [];
  for (let i = 0; i < NS; i++) {
    const x0 = -len / 2 + (len * i) / NS;
    const x1 = -len / 2 + (len * (i + 1)) / NS;
    const h0 = half(x0) * 0.94;
    const h1 = half(x1) * 0.94;
    const y0 = top(x0) - 0.45;
    const y1 = top(x1) - 0.45;
    const P = [new THREE.Vector3(x0, y0, -h0), new THREE.Vector3(x1, y1, -h1), new THREE.Vector3(x1, y1, h1), new THREE.Vector3(x0, y0, h0)];
    push(dp, P[0], P[2], P[1]);
    push(dp, P[0], P[3], P[2]);
  }
  const deck = mk(dp);
  return { outer: mk(pos), band: mk(bandPos), deck: planarUV(deck, 2), top, half };
}

function hullMat(h: ShipSpec['hull']): THREE.Material {
  return h === 'white' ? NY.hullWhite : h === 'green' ? NY.hullGreen : h === 'blue' ? NY.hullBlue : h === 'red' ? NY.hullRed : h === 'tar' ? NY.hullTar : NY.hullBlack;
}

function buildShip(b: Batch, s: ShipSpec) {
  const L = s.len;
  const B = s.beam ?? L * 0.27;
  const free = s.freeboard ?? 1.2;
  const inner = new Batch();
  const h = hull(L, B, free, s.kind === 'barge' ? 0.1 : 0.55, s.kind === 'barge' ? 0.95 : 0.7);
  inner.add(hullMat(s.hull), h.outer);
  inner.add(s.band === 'white' ? NY.hullWhite : s.band === 'red' ? NY.hullRed : s.band === 'green' ? NY.hullGreen : NY.mast, h.band);
  inner.add(NY.deck, h.deck);
  const deckY = (x: number) => h.top(x) - 0.45;
  const rope: THREE.BufferGeometry[] = [];
  const spar: THREE.BufferGeometry[] = [];
  const sails: THREE.BufferGeometry[] = [];
  if (s.kind === 'barge') {
    // 劇場船：長條船屋、雙坡頂
    const x0 = -L / 2 + 1.5;
    const x1 = L / 2 - 2.5;
    const hw = B / 2 - 0.5;
    const y0 = deckY(0);
    inner.add(NY.hullWhite, planarUV(box(x1 - x0, 2.4, hw * 2, (x0 + x1) / 2, y0, 0), 4));
    const rp = [new THREE.Vector3(x0, y0 + 2.4, -hw - 0.3), new THREE.Vector3(x1, y0 + 2.4, -hw - 0.3), new THREE.Vector3(x1, y0 + 3.6, 0), new THREE.Vector3(x0, y0 + 3.6, 0)];
    inner.add(NY.roofBlack, quad(rp, [[0, 0], [L / 2, 0], [L / 2, 1], [0, 1]]));
    inner.add(NY.roofBlack, quad(rp.map((p) => p.clone().setZ(-p.z)).reverse(), [[0, 0], [L / 2, 0], [L / 2, 1], [0, 1]]));
    for (const x of [x0, x1]) {
      const g = tri([new THREE.Vector3(x, y0 + 2.4, -hw), new THREE.Vector3(x, y0 + 2.4, hw), new THREE.Vector3(x, y0 + 3.6, 0)]);
      inner.add(NY.hullWhite, g);
      const g2 = tri([new THREE.Vector3(x, y0 + 2.4, hw), new THREE.Vector3(x, y0 + 2.4, -hw), new THREE.Vector3(x, y0 + 3.6, 0)]);
      inner.add(NY.hullWhite, g2);
    }
    for (let x = x0 + 1; x < x1 - 0.5; x += 1.6)
      for (const z of [-hw - 0.01, hw + 0.01]) {
        const w = new THREE.PlaneGeometry(0.9, 0.9);
        if (z > 0) w.rotateY(0);
        else w.rotateY(Math.PI);
        w.translate(x, y0 + 1.2, z);
        inner.add(M.glassDark, w);
      }
  } else {
    // 甲板室、艙口
    const dh = s.kind === 'lightship' ? 2.2 : 1.0;
    const dx = s.kind === 'lightship' ? 0 : -L * 0.3;
    const dl = s.kind === 'lightship' ? L * 0.3 : L * 0.14;
    inner.add(s.cabin === 'white' ? NY.hullWhite : NY.mast, planarUV(box(dl, dh, B * 0.45, dx, deckY(dx) - 0.05, 0), 2));
    inner.add(NY.hullTar, box(dl + 0.2, 0.08, B * 0.5, dx, deckY(dx) + dh - 0.05, 0));
    inner.add(NY.mast, box(L * 0.1, 0.5, B * 0.35, L * 0.12, deckY(L * 0.12) - 0.05, 0));
    // 桅杆
    const masts = s.masts ?? [];
    let first: THREE.Vector3 | null = null;
    masts.forEach(([xr, mh], i) => {
      const x = xr * L;
      const y0 = deckY(x);
      const topP = new THREE.Vector3(x - 0.3, y0 + mh, 0);
      spar.push(rod(new THREE.Vector3(x, y0 - 0.2, 0), topP, 0.17, 8, 0.08));
      if (!first) first = topP;
      // 橫桅（斜桁帆）：下桁＋斜桁，帆收捲在下桁上
      if (s.kind !== 'lightship') {
        const bl = i === masts.length - 1 ? L * 0.42 : L * 0.28;
        const boomA = new THREE.Vector3(x, y0 + 1.4, 0);
        const boomB = new THREE.Vector3(x - bl, y0 + 1.7, 0);
        spar.push(rod(boomA, boomB, 0.09, 6));
        const gaffA = new THREE.Vector3(x - 0.1, y0 + mh * 0.62, 0);
        const gaffB = new THREE.Vector3(x - bl * 0.75, y0 + mh * 0.62 + bl * 0.45, 0);
        spar.push(rod(gaffA, gaffB, 0.07, 6));
        sails.push(rod(boomA.clone().add(new THREE.Vector3(-0.3, 0.22, 0)), boomB.clone().add(new THREE.Vector3(0.4, 0.2, 0)), 0.2, 8, 0.14));
        rope.push(rod(topP, gaffB, 0.015, 3));
        rope.push(rod(gaffB, boomB, 0.015, 3));
      } else {
        // 燈船：桅頂燈籠（燈室＋頂蓋＋平台）
        inner.add(NY.lampGlass, cylinder(0.45, 1.1, x - 0.3, y0 + mh - 0.2, 0, 10));
        inner.add(NY.hullRed, cylinder(0.55, 0.35, x - 0.3, y0 + mh + 0.9, 0, 10, 0.1));
        inner.add(NY.iron, cylinder(0.75, 0.08, x - 0.3, y0 + mh - 0.3, 0, 12));
      }
      // 側支索（每舷 3 條）
      for (const side of [-1, 1])
        for (const k of [-0.5, 0, 0.5]) {
          const at = x + k * 0.6;
          rope.push(rod(new THREE.Vector3(x - 0.1, y0 + mh * 0.85, 0), new THREE.Vector3(at, h.top(at), side * h.half(at)), 0.018, 3));
        }
      // 後支索
      rope.push(rod(topP, new THREE.Vector3(-L / 2 + 0.3, h.top(-L / 2), 0), 0.018, 3));
    });
    // 船首斜桅與前支索
    if (s.kind !== 'lightship' && s.kind !== 'motor' && first) {
      const bowX = L / 2;
      const bsTip = new THREE.Vector3(bowX + L * 0.3, h.top(bowX) + 0.9, 0);
      spar.push(rod(new THREE.Vector3(bowX - 1.5, h.top(bowX) - 0.1, 0), bsTip, 0.12, 6, 0.07));
      rope.push(rod(first, bsTip, 0.02, 3));
      rope.push(rod(bsTip, new THREE.Vector3(bowX, 0.2, 0), 0.02, 3));
      // 船首三角帆收在斜桅上
      sails.push(rod(new THREE.Vector3(bowX, h.top(bowX) + 0.4, 0), bsTip.clone().add(new THREE.Vector3(-0.4, 0, 0)), 0.14, 6, 0.09));
    }
    // 舷牆欄杆
    for (let x = -L / 2 + 1; x < L / 2 - 1; x += 1.2)
      for (const side of [-1, 1]) spar.push(box(0.08, 0.35, 0.08, x, h.top(x), side * h.half(x) * 0.97));
  }
  if (spar.length) inner.add(NY.mast, merge(spar));
  if (rope.length) inner.add(NY.rope, merge(rope));
  if (sails.length) inner.add(NY.sail, merge(sails));
  const grp = inner.build('ship', { castShadow: true, receiveShadow: true });
  // 放到碼頭邊：北岸船靠 c≈22、南岸靠 c≈−5
  const edge = s.side === 'N' ? 22.5 - B / 2 - 0.4 : -5.5 + B / 2 + 0.4;
  const m = new THREE.Matrix4().makeRotationY(s.bow === 'west' ? Math.PI : 0).setPosition(s.a, WATER_Y, -edge);
  grp.updateMatrixWorld(true);
  grp.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const g = (o.geometry as THREE.BufferGeometry).clone();
      g.applyMatrix4(m);
      b.add(o.material as THREE.Material, g);
    }
  });
}

// ---- 組裝 ----

/** 以 a = cut 的直線切多邊形，保留 a < cut（keepLow）或 a > cut 的一側 */
function clipA(poly: P2[], cut: number, keepLow: boolean): P2[] {
  const inside = (p: P2) => (keepLow ? p[0] <= cut : p[0] >= cut);
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (inside(p)) out.push(p);
    if (inside(p) !== inside(q)) {
      const t = (cut - p[0]) / (q[0] - p[0]);
      out.push([cut, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** OSM 輪廓依 SPLITS 切成個別房屋 */
function footprints(): Footprint[] {
  const out: Footprint[] = [];
  for (const f of FOOTPRINTS) {
    const sp = SPLITS[`${f.side}${f.no}`];
    if (!sp) {
      out.push(f);
      continue;
    }
    out.push({ ...f, poly: clipA(f.poly, sp[0], true) });
    out.push({ no: sp[1], side: f.side, poly: clipA(f.poly, sp[0], false) });
  }
  return out;
}

export function buildNyhavn(): { group: THREE.Group; labels: MapLabel[] } {
  const b = new Batch();
  buildQuays(b);
  const fps = footprints();
  const polys = fps.map((f) => f.poly);
  const fronts: { fp: Footprint; out: HouseOut }[] = [];
  fps.forEach((fp, i) => {
    if (!fp.no) return; // 公廁入口亭另外建
    const others = polys.filter((_, j) => j !== i);
    fronts.push({ fp, out: buildHouse(b, fp, others) });
  });
  buildTerraces(b, fronts);
  buildStreetFurniture(b);
  buildAnchor(b);
  buildBridge(b);
  for (const s of SHIPS) buildShip(b, s);
  const inner = b.build('nyhavn', { castShadow: true, receiveShadow: true });
  inner.rotation.y = (90 - AXIS) * DEG;
  const group = new THREE.Group();
  group.name = 'nyhavn';
  group.add(inner);
  const lab = (text: string, a: number, c: number, minZoom?: number): MapLabel => {
    const [e, n] = acToEN(a, c);
    return { text, x: e, z: -n, minZoom };
  };
  return {
    group,
    labels: [
      lab('新港', -20, 8),
      lab('紀念錨', ANCHOR.a, ANCHOR.c, 1),
      lab('新港橋', NYHAVN.bridgeA, 8, 1),
      lab('夏洛滕堡宮', -150, -40, 1),
    ],
  };
}
