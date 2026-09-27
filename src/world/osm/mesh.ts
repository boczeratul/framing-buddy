import * as THREE from 'three';
import { toLocal, type LatLon } from '../../geo';
import { applyRing, FAR_RING, NEAR_RING } from '../../scene/ringmask';
import { NIGHT_GLOW } from '../../scene/materials';
import type { Target } from '../types';
import { buildingShape, centroid, osmColour, pointInRing, type Feature } from './parse';

// OSM 特徵 → 合併後的 Mesh。
// 遠景（far）：窗格立面＋平頂，高塔收分成錐形——與中正紀念堂、101 手工模型同一等級的程序化精細度。
// 近景（near，沒有實景圖磚時的備援）：再加上斜屋頂（山牆、廡殿、角錐）、圓頂、樹木與綠地水域。

type V3 = THREE.Vector3;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ---- 共用貼圖與材質 ----

function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 一格＝一個柱距 × 一層樓；灰階，由頂點顏色著色 */
const facadeTex = canvasTex(64, (ctx, s) => {
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, s, s);
  const g = ctx.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, '#7d858c');
  g.addColorStop(1, '#5c646b');
  ctx.fillStyle = g;
  ctx.fillRect(s * 0.12, s * 0.22, s * 0.76, s * 0.62);
});

const facadeLightTex = canvasTex(256, (ctx, s) => {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, s, s);
  const n = 8;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const r = Math.random();
      if (r < 0.62) continue;
      const v = 90 + Math.floor(r * 120);
      ctx.fillStyle = `rgb(${v},${Math.floor(v * 0.9)},${Math.floor(v * 0.72)})`;
      ctx.fillRect((i + 0.12) * (s / n), (j + 0.22) * (s / n), 0.76 * (s / n), 0.62 * (s / n));
    }
});
facadeLightTex.repeat.set(1 / 8, 1 / 8);

const roofTileTex = canvasTex(64, (ctx, s) => {
  ctx.fillStyle = '#ddd';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = 0; y < s; y += s / 4) ctx.fillRect(0, y, s, 2);
  for (let x = 0; x < s; x += s / 4) ctx.fillRect(x, 0, 1, s);
});

const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);

export const OSM_MATERIALS = {
  farFacade: std({ vertexColors: true, map: facadeTex, emissiveMap: facadeLightTex, emissive: 0x000000, roughness: 0.6, metalness: 0.2 }),
  farRoof: std({ vertexColors: true, roughness: 0.9 }),
  nearFacade: std({ vertexColors: true, map: facadeTex, emissiveMap: facadeLightTex, emissive: 0x000000, roughness: 0.6, metalness: 0.15 }),
  nearRoof: std({ vertexColors: true, roughness: 0.9 }),
  nearTiles: std({ vertexColors: true, map: roofTileTex, roughness: 0.75, side: THREE.DoubleSide }),
  green: std({ color: 0x6e8f4f, roughness: 1 }),
  water: std({ color: 0x3a5f66, roughness: 0.1, metalness: 0.3 }),
  trunk: std({ color: 0x3e3128, roughness: 1 }),
  foliage: std({ color: 0x55803f, roughness: 0.95, flatShading: true }),
};
applyRing(OSM_MATERIALS.farFacade, 'far', FAR_RING);
applyRing(OSM_MATERIALS.farRoof, 'far', FAR_RING);
for (const m of [OSM_MATERIALS.nearFacade, OSM_MATERIALS.nearRoof, OSM_MATERIALS.nearTiles, OSM_MATERIALS.green, OSM_MATERIALS.water, OSM_MATERIALS.trunk, OSM_MATERIALS.foliage])
  applyRing(m, 'near', NEAR_RING);
NIGHT_GLOW.push(
  { material: OSM_MATERIALS.farFacade, color: 0xffd9a0, intensity: 0.14 },
  { material: OSM_MATERIALS.nearFacade, color: 0xffd9a0, intensity: 0.14 },
);

// ---- 幾何累積器 ----

class Builder {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];

  tri(a: V3, b: V3, c: V3, ua: number[], ub: number[], uc: number[], color: THREE.Color) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b);
  }

  /** 依期望方向自動調整三角形繞向 */
  triFacing(a: V3, b: V3, c: V3, want: V3, color: THREE.Color, uvScale = 3) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const uvOf = (p: V3) => [(p.x + p.z) / uvScale, p.y / uvScale];
    if (n.dot(want) >= 0) this.tri(a, b, c, uvOf(a), uvOf(b), uvOf(c), color);
    else this.tri(a, c, b, uvOf(a), uvOf(c), uvOf(b), color);
  }

  get empty() {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ---- 平面工具 ----

type P2 = [number, number];

function signedArea(r: P2[]): number {
  // 以 (x, north) = (x, -z) 計算：正值＝從上方看逆時針
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, z0] = r[i];
    const [x1, z1] = r[(i + 1) % r.length];
    a += x0 * -z1 - x1 * -z0;
  }
  return a / 2;
}

function oriented(r: P2[], ccw: boolean): P2[] {
  const a = signedArea(r);
  return (a > 0) === ccw ? r : r.slice().reverse();
}

/** 最小外接矩形（逐邊旋轉） */
function minRect(r: P2[]) {
  let best = { area: Infinity, cx: 0, cz: 0, ux: 1, uz: 0, L: 0, W: 0 };
  for (let i = 0; i < r.length; i++) {
    const [x0, z0] = r[i];
    const [x1, z1] = r[(i + 1) % r.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.5) continue;
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of r) {
      const a = x * ux + z * uz;
      const b = -x * uz + z * ux;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a);
      b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const area = (a1 - a0) * (b1 - b0);
    if (area < best.area) {
      const ca = (a0 + a1) / 2;
      const cb = (b0 + b1) / 2;
      const long = a1 - a0 >= b1 - b0;
      best = {
        area,
        cx: ca * ux - cb * uz,
        cz: ca * uz + cb * ux,
        ux: long ? ux : -uz,
        uz: long ? uz : ux,
        L: Math.max(a1 - a0, b1 - b0) / 2,
        W: Math.min(a1 - a0, b1 - b0) / 2,
      };
    }
  }
  return best;
}

const PALETTE = ['#a8a39a', '#979ca0', '#b3ad9f', '#868f96', '#bcb6aa', '#8e9791', '#a19886', '#aaa49c', '#7d7f80'];
const GLASS = ['#6c8394', '#7a8f9b', '#5f7788', '#83969f', '#56666f'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---- 建物 ----

export interface TileBuildContext {
  detail: 'far' | 'near';
  heightAt: (x: number, z: number) => number;
  excluded: (p: LatLon) => boolean;
}

export interface TileContent {
  group: THREE.Group;
  targets: Target[];
  /** 可被射線偵測（遮擋、站立面）的物件 */
  solids: THREE.Object3D[];
}

export function buildTile(features: Feature[], ctx: TileBuildContext): TileContent {
  const near = ctx.detail === 'near';
  const walls = new Builder();
  const roofs = new Builder();
  const tiles = new Builder();
  const targets: Target[] = [];
  const group = new THREE.Group();

  const solidsFeatures = features.filter((f) => f.kind === 'building' || f.kind === 'part' || f.kind === 'tower');
  const parts = solidsFeatures.filter((f) => f.kind === 'part');
  const partCenters = parts.map((p) => centroid(p.rings[0]));

  for (const f of solidsFeatures) {
    const outerLL = f.rings[0];
    const c = centroid(outerLL);
    if (ctx.excluded(c)) continue;
    // 有 building:part 的建物外框不另外建（Simple 3D Buildings 慣例）
    if (f.kind === 'building' && partCenters.some((pc) => pointInRing(pc, outerLL))) continue;
    if (f.tags.building === 'roof' && !near) continue;

    const shape = buildingShape(f.tags);
    if (f.kind === 'tower') {
      shape.levels = Math.max(1, Math.round(shape.top / 4));
      shape.roofShape = 'flat';
    }
    const cl = toLocal(c);
    const ground = ctx.heightAt(cl.x, cl.z);
    const rings = f.rings.map((r, i) => oriented(r.map((p) => { const l = toLocal(p); return [l.x, l.z] as P2; }), i === 0));
    const outer = rings[0];
    if (outer.length < 3 || Math.abs(signedArea(outer)) < 4) continue;

    const h = hash(f.id);
    const tall = shape.top > 80;
    const facade = new THREE.Color(osmColour(f.tags['building:colour']) ?? (tall ? GLASS[h % GLASS.length] : PALETTE[h % PALETTE.length]));
    const roofCol = new THREE.Color(osmColour(f.tags['roof:colour']) ?? (near && shape.roofShape !== 'flat' ? '#8b5a46' : '#8e8c86'));

    const y0 = ground + shape.base;
    const yE = ground + shape.eave;
    const yT = ground + shape.top;
    const levelH = Math.max(2.8, (shape.eave - shape.base) / Math.max(1, shape.levels));
    const taper = f.kind === 'tower' ? 0.3 : 1;
    const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length;
    const cz = outer.reduce((s, p) => s + p[1], 0) / outer.length;
    const top = (p: P2): P2 => [cx + (p[0] - cx) * taper, cz + (p[1] - cz) * taper];

    // 牆面（外環＋中庭內環）
    for (const ring of rings) {
      let acc = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const ta = top(a);
        const tb = top(b);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const u0 = acc / 3.6;
        const u1 = (acc + len) / 3.6;
        acc += len;
        const v0 = 0;
        const v1 = (yE - y0) / levelH;
        const A0 = v3(a[0], y0, a[1]);
        const B0 = v3(b[0], y0, b[1]);
        const B1 = v3(tb[0], yE, tb[1]);
        const A1 = v3(ta[0], yE, ta[1]);
        walls.tri(A0, B0, B1, [u0, v0], [u1, v0], [u1, v1], facade);
        walls.tri(A0, B1, A1, [u0, v0], [u1, v1], [u0, v1], facade);
      }
    }

    // 屋頂
    const roofDone = near && shape.eave < shape.top - 0.3 ? shapedRoof(outer, shape.roofShape, yE, yT, roofCol, facade, roofs, tiles, walls) : false;
    if (!roofDone) flatCap(rings.map((r) => r.map(top)), yE, roofCol, roofs);

    // 有名字的高樓與高塔 → 可對準的目標
    const name = f.tags['name:zh-Hant'] ?? f.tags['name:zh'] ?? f.tags.name;
    if (name && (shape.top >= 120 || (f.kind === 'tower' && shape.top >= 100))) {
      targets.push({
        id: `osm-${f.id}`,
        label: name,
        base: v3(cx, ground, cz),
        top: v3(cx, yT, cz),
        aimAt: 0.5,
        radius: Math.max(...outer.map((p) => Math.hypot(p[0] - cx, p[1] - cz))),
      });
    }
  }

  const solids: THREE.Object3D[] = [];
  const add = (b: Builder, m: THREE.Material, solid = true) => {
    if (b.empty) return;
    const g = b.build();
    g.computeBoundsTree?.();
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (solid) solids.push(mesh);
  };
  add(walls, near ? OSM_MATERIALS.nearFacade : OSM_MATERIALS.farFacade);
  add(roofs, near ? OSM_MATERIALS.nearRoof : OSM_MATERIALS.farRoof);
  add(tiles, OSM_MATERIALS.nearTiles);

  if (near) {
    addAreas(features, ctx, group);
    addTrees(features, ctx, group);
  }
  return { group, targets, solids };
}

function flatCap(rings: P2[][], y: number, color: THREE.Color, b: Builder) {
  const contour = rings[0].map(([x, z]) => new THREE.Vector2(x, -z));
  const holes = rings.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, -z)));
  const all = [rings[0], ...rings.slice(1)].flat();
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  const up = v3(0, 1, 0);
  for (const [i, j, k] of faces) {
    const [a, bb, c] = [all[i], all[j], all[k]];
    if (!a || !bb || !c) continue;
    b.triFacing(v3(a[0], y, a[1]), v3(bb[0], y, bb[1]), v3(c[0], y, c[1]), up, color);
  }
}

/** 斜屋頂；形狀無法處理時回傳 false 改用平頂 */
function shapedRoof(outer: P2[], shape: string, yE: number, yT: number, roofCol: THREE.Color, wallCol: THREE.Color, roofs: Builder, tiles: Builder, walls: Builder): boolean {
  const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length;
  const cz = outer.reduce((s, p) => s + p[1], 0) / outer.length;
  const H = yT - yE;
  if (shape === 'pyramidal' || shape === 'cone') {
    const apex = v3(cx, yT, cz);
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i];
      const b = outer[(i + 1) % outer.length];
      const mid = v3((a[0] + b[0]) / 2 - cx, 1, (a[1] + b[1]) / 2 - cz);
      tiles.triFacing(v3(a[0], yE, a[1]), v3(b[0], yE, b[1]), apex, mid, roofCol);
    }
    return true;
  }
  if (shape === 'dome' || shape === 'onion' || shape === 'round') {
    const K = 7;
    for (let k = 0; k < K; k++) {
      const t0 = k / K;
      const t1 = (k + 1) / K;
      const s0 = Math.cos((t0 * Math.PI) / 2);
      const s1 = Math.cos((t1 * Math.PI) / 2);
      const y0 = yE + H * Math.sin((t0 * Math.PI) / 2);
      const y1 = yE + H * Math.sin((t1 * Math.PI) / 2);
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i];
        const b = outer[(i + 1) % outer.length];
        const P = (p: P2, s: number, y: number) => v3(cx + (p[0] - cx) * s, y, cz + (p[1] - cz) * s);
        const want = v3((a[0] + b[0]) / 2 - cx, 0.5, (a[1] + b[1]) / 2 - cz);
        roofs.triFacing(P(a, s0, y0), P(b, s0, y0), P(b, s1, y1), want, roofCol);
        roofs.triFacing(P(a, s0, y0), P(b, s1, y1), P(a, s1, y1), want, roofCol);
      }
    }
    return true;
  }
  if (!/^(gabled|hipped|half-hipped|side_hipped|gambrel|mansard|saltbox)$/.test(shape)) return false;
  const r = minRect(outer);
  const area = Math.abs(signedArea(outer));
  if (area / (4 * r.L * r.W) < 0.78) return false;
  const vx = -r.uz;
  const vz = r.ux;
  const P = (a: number, b: number, y: number) => v3(r.cx + a * r.ux + b * vx, y, r.cz + a * r.uz + b * vz);
  const gabled = shape === 'gabled' || shape === 'saltbox';
  const R = gabled ? r.L : Math.max(0, r.L - r.W);
  const p1 = P(-r.L, -r.W, yE), p2 = P(r.L, -r.W, yE), p3 = P(r.L, r.W, yE), p4 = P(-r.L, r.W, yE);
  const r1 = P(-R, 0, yT), r2 = P(R, 0, yT);
  const side = (dirB: number) => v3(dirB * vx, 1, dirB * vz);
  tiles.triFacing(p1, p2, r2, side(-1), roofCol);
  tiles.triFacing(p1, r2, r1, side(-1), roofCol);
  tiles.triFacing(p3, p4, r1, side(1), roofCol);
  tiles.triFacing(p3, r1, r2, side(1), roofCol);
  const endA = v3(r.ux, 0, r.uz);
  const endB = v3(-r.ux, 0, -r.uz);
  if (gabled) {
    walls.triFacing(p2, p3, r2, endA, wallCol);
    walls.triFacing(p4, p1, r1, endB, wallCol);
  } else {
    tiles.triFacing(p2, p3, r2, endA.clone().setY(1), roofCol);
    tiles.triFacing(p4, p1, r1, endB.clone().setY(1), roofCol);
  }
  // 牆頂與矩形屋簷之間的縫用平頂補上
  flatCap([outer], yE - 0.05, roofCol, roofs);
  return true;
}

function addAreas(features: Feature[], ctx: TileBuildContext, group: THREE.Group) {
  for (const f of features) {
    if (f.kind !== 'green' && f.kind !== 'water' && f.kind !== 'wood') continue;
    const outer = f.rings[0].map((p) => { const l = toLocal(p); return new THREE.Vector2(l.x, -l.z); });
    if (outer.length < 3) continue;
    const c = toLocal(centroid(f.rings[0]));
    const shape = new THREE.Shape(outer);
    for (const hole of f.rings.slice(1)) shape.holes.push(new THREE.Path(hole.map((p) => { const l = toLocal(p); return new THREE.Vector2(l.x, -l.z); })));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    g.translate(0, ctx.heightAt(c.x, c.z) + (f.kind === 'water' ? 0.12 : 0.08), 0);
    const m = new THREE.Mesh(g, f.kind === 'water' ? OSM_MATERIALS.water : OSM_MATERIALS.green);
    m.receiveShadow = true;
    group.add(m);
  }
}

function addTrees(features: Feature[], ctx: TileBuildContext, group: THREE.Group) {
  const spots: { x: number; z: number; h: number }[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const f of features) {
    if (f.kind === 'tree' && f.point) {
      const l = toLocal(f.point);
      spots.push({ x: l.x, z: l.z, h: Number(f.tags.height) || 7 + rnd() * 5 });
    } else if (f.kind === 'wood') {
      const ring = f.rings[0];
      const pts = ring.map((p) => toLocal(p));
      const xs = pts.map((p) => p.x);
      const zs = pts.map((p) => p.z);
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      const n = Math.min(1500, Math.round(((x1 - x0) * (z1 - z0)) / 120));
      const poly = pts.map((p) => ({ lat: -p.z, lon: p.x }));
      for (let i = 0; i < n; i++) {
        const x = x0 + rnd() * (x1 - x0);
        const z = z0 + rnd() * (z1 - z0);
        if (pointInRing({ lat: -z, lon: x }, poly)) spots.push({ x, z, h: 8 + rnd() * 8 });
      }
    }
  }
  if (!spots.length) return;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.24, 1, 6).translate(0, 0.5, 0), OSM_MATERIALS.trunk, spots.length);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), OSM_MATERIALS.foliage, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  spots.forEach((s, i) => {
    const y = ctx.heightAt(s.x, s.z);
    const th = s.h * 0.35;
    m.compose(v3(s.x, y, s.z), q, v3(1, th, 1));
    trunks.setMatrixAt(i, m);
    const r = s.h * 0.32;
    m.compose(v3(s.x, y + th + r * 0.7, s.z), q, v3(r, r * 0.8, r));
    crowns.setMatrixAt(i, m);
  });
  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
}
