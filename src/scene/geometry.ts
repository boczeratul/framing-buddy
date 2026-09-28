import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// 程序化建模工具：以「環」放樣（loft）建出屋頂、塔身等曲面，
// 並把同材質的幾何合併成單一 Mesh 以減少 draw call。

export type Ring = THREE.Vector3[];

interface LoftOptions {
  capBottom?: boolean;
  capTop?: boolean;
  /** UV 比例：1 單位 UV = uvScale 公尺 */
  uvScale?: number;
}

/**
 * 以一串點數相同的環（由下而上、從上方看逆時針）產生側面。
 * UV：u＝沿環弧長、v＝沿母線距離（公尺 / uvScale），方便套用瓦片、窗格等重複貼圖。
 */
export function loft(rings: Ring[], opts: LoftOptions = {}): THREE.BufferGeometry {
  const { capBottom = false, capTop = false, uvScale = 1 } = opts;
  const pos: number[] = [];
  const uv: number[] = [];
  const n = rings[0].length;

  // 每一環的弧長累計
  const arc = rings.map((r) => {
    const out = [0];
    for (let j = 1; j <= n; j++) out.push(out[j - 1] + r[j - 1].distanceTo(r[j % n]));
    return out;
  });
  // 環與環之間的平均母線距離累計
  const vAcc = [0];
  for (let i = 1; i < rings.length; i++) {
    let d = 0;
    for (let j = 0; j < n; j++) d += rings[i][j].distanceTo(rings[i - 1][j]);
    vAcc.push(vAcc[i - 1] + d / n);
  }

  const push = (p: THREE.Vector3, u: number, v: number) => {
    pos.push(p.x, p.y, p.z);
    uv.push(u / uvScale, v / uvScale);
  };

  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i];
    const r1 = rings[i + 1];
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const a = r0[j], b = r0[k], c = r1[k], d = r1[j];
      const ua = arc[i][j], ub = arc[i][j + 1], uc = arc[i + 1][j + 1], ud = arc[i + 1][j];
      const va = vAcc[i], vb = vAcc[i + 1];
      push(a, ua, va); push(b, ub, va); push(c, uc, vb);
      push(a, ua, va); push(c, uc, vb); push(d, ud, vb);
    }
  }

  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const cap = (ring: Ring, up: boolean) => {
    const contour = ring.map((p) => new THREE.Vector2(p.x, -p.z));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const f of faces) {
      const [p0, p1, p2] = f.map((i) => ring[i]);
      const ny = e1.subVectors(p1, p0).cross(e2.subVectors(p2, p0)).y;
      const order = ny > 0 === up ? [p0, p1, p2] : [p0, p2, p1];
      for (const p of order) push(p, p.x, p.z);
    }
  };
  if (capBottom) cap(rings[0], false);
  if (capTop) cap(rings[rings.length - 1], true);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** 從上方看逆時針的正多邊形環；perSide 為每邊細分數，lift(w) 依「接近角點程度 w∈[0,1]」抬升 */
export function polygonRing(
  sides: number,
  radius: number,
  y: number,
  perSide = 1,
  rotation = 0,
  lift?: (w: number) => number,
): Ring {
  const pts: Ring = [];
  for (let s = 0; s < sides; s++) {
    const a0 = rotation + (s / sides) * Math.PI * 2;
    const a1 = rotation + ((s + 1) / sides) * Math.PI * 2;
    const p0 = new THREE.Vector2(Math.cos(a0) * radius, -Math.sin(a0) * radius);
    const p1 = new THREE.Vector2(Math.cos(a1) * radius, -Math.sin(a1) * radius);
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      const w = Math.pow(Math.abs(t - 0.5) * 2, 4);
      pts.push(new THREE.Vector3(p0.x + (p1.x - p0.x) * t, y + (lift ? lift(w) : 0), p0.y + (p1.y - p0.y) * t));
    }
  }
  return pts;
}

/** 矩形環（中心在原點，hw＝東西半寬、hd＝南北半深），從東南角起逆時針 */
export function rectRing(hw: number, hd: number, y: number, perSide = 1, lift?: (w: number) => number): Ring {
  const corners: [number, number][] = [[hw, hd], [hw, -hd], [-hw, -hd], [-hw, hd]];
  const pts: Ring = [];
  for (let s = 0; s < 4; s++) {
    const [x0, z0] = corners[s];
    const [x1, z1] = corners[(s + 1) % 4];
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      const w = Math.pow(Math.abs(t - 0.5) * 2, 4);
      pts.push(new THREE.Vector3(x0 + (x1 - x0) * t, y + (lift ? lift(w) : 0), z0 + (z1 - z0) * t));
    }
  }
  return pts;
}

interface RoofOptions {
  /** 屋簷處東西、南北半寬（已含出簷） */
  hw: number;
  hd: number;
  /** 屋頂高度 */
  height: number;
  /** 屋脊半長（廡殿頂 >0；攢尖頂 0） */
  ridge?: number;
  /** 凹曲程度：y = h·t^curve，>1 越接近屋簷越平 */
  curve?: number;
  /** 翼角起翹高度 */
  cornerLift?: number;
  /** 歇山：從 t≥gableAt 起東西向不再收分，兩端形成山牆 */
  gableAt?: number;
  /** 頂部收至此比例（重簷下層用；1＝收到屋脊） */
  top?: number;
  steps?: number;
  perSide?: number;
}

/** 中式曲面屋頂（廡殿／歇山／重簷下層裙頂），以矩形環放樣 */
export function chineseRoof(o: RoofOptions): THREE.BufferGeometry {
  const { hw, hd, height, ridge = 0, curve = 1.7, cornerLift = 0, gableAt = 1, top = 1, steps = 10, perSide = 8 } = o;
  const rings: Ring[] = [];
  const ridgeHw = Math.max(ridge, 0.01);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * top;
    const tx = Math.min(t, gableAt);
    const w = hw + (ridgeHw - hw) * tx;
    const d = Math.max(hd + (0.01 - hd) * t, 0.01);
    const y = height * Math.pow(t, curve);
    const liftAmt = cornerLift * Math.pow(1 - t, 3);
    rings.push(rectRing(w, d, y, perSide, (wc) => wc * liftAmt));
  }
  return loft(rings, { uvScale: 0.6 });
}

/** 八角攢尖頂（或截頂裙簷） */
export function octagonRoof(o: {
  radius: number;
  height: number;
  curve?: number;
  cornerLift?: number;
  top?: number;
  apex?: number;
  steps?: number;
}): THREE.BufferGeometry {
  const { radius, height, curve = 1.6, cornerLift = 0, top = 1, apex = 0.3, steps = 12 } = o;
  const rings: Ring[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * top;
    const r = radius + (apex - radius) * t;
    const y = height * Math.pow(t, curve);
    const liftAmt = cornerLift * Math.pow(1 - t, 3);
    rings.push(polygonRing(8, r, y, 6, Math.PI / 8, (w) => w * liftAmt));
  }
  return loft(rings, { uvScale: 0.6 });
}

/** 階梯：沿 -X 方向（向西）下降。回傳合併後的幾何，原點在最高一階的前緣中央 */
export function stairs(width: number, steps: number, rise: number, tread: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const h = (steps - i) * rise;
    const g = new THREE.BoxGeometry(tread, h, width);
    g.translate(-(i + 0.5) * tread, h / 2 - steps * rise, 0);
    parts.push(g);
  }
  return merge(parts);
}

/** 平面多邊形（x, z）擠出成柱體：y0 → y1 */
export function extrude(points: [number, number][], y0: number, y1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

/** 平面多邊形（x, z）→ 水平面，y 高度 */
export function flat(points: [number, number][], y: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
}

export function cylinder(r: number, h: number, x: number, y: number, z: number, seg = 12, rTop = r): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, r, h, seg);
  g.translate(x, y + h / 2, z);
  return g;
}

/** 合併前統一為 non-indexed，並補齊 uv，避免 attribute 不一致 */
export function merge(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = geoms.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.getAttribute('uv')) {
      const count = ng.getAttribute('position').count;
      ng.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    for (const name of Object.keys(ng.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) ng.deleteAttribute(name);
    }
    if (!ng.getAttribute('normal')) ng.computeVertexNormals();
    return ng;
  });
  const out = mergeGeometries(prepared, false);
  if (!out) throw new Error('mergeGeometries failed');
  return out;
}

/** 依材質收集幾何，最後各合併為一個 Mesh */
export class Batch {
  private groups = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(material: THREE.Material, geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4) {
    if (matrix) geometry.applyMatrix4(matrix);
    const list = this.groups.get(material) ?? [];
    list.push(geometry);
    this.groups.set(material, list);
  }

  build(name: string, { castShadow = true, receiveShadow = true } = {}): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, list] of this.groups) {
      const mesh = new THREE.Mesh(merge(list), mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      group.add(mesh);
    }
    return group;
  }
}

// ---------------------------------------------------------------------------
// 精細建模工具：屋瓦瓦壟、瓦當、斗拱、細緻欄杆、車削柱

/** 環上第 face 個面、橫向比例 s（0–1）處的點；面由角點索引 face*perSide 起算 */
function pointOnFace(ring: Ring, face: number, perSide: number, s: number): THREE.Vector3 {
  const n = ring.length;
  const f = s * perSide;
  const i = Math.min(perSide - 1, Math.floor(f));
  const a = ring[(face * perSide + i) % n];
  const b = ring[(face * perSide + i + 1) % n];
  return a.clone().lerp(b, f - i);
}

/**
 * 在放樣屋頂上鋪瓦壟：每個屋面沿坡度方向排列半圓形瓦壟，屋簷處加瓦當。
 * rings 由簷口到屋脊；faces 為屋面數、perSide 為每面細分數；maxRing 可限制只鋪到某一環（歇山的山花以上不鋪）。
 */
export function tileRidges(
  rings: Ring[],
  faces: number,
  perSide: number,
  spacing = 0.9,
  opts: { radius?: number; lift?: number; maxRing?: number; skipFaces?: number[] } = {},
): { ridges: THREE.BufferGeometry; caps: THREE.BufferGeometry } {
  const { radius = 0.13, lift = 0.02, maxRing = rings.length - 1, skipFaces = [] } = opts;
  const ridgeParts: THREE.BufferGeometry[] = [];
  const capParts: THREE.BufferGeometry[] = [];
  const bottom = rings[0];
  for (let f = 0; f < faces; f++) {
    if (skipFaces.includes(f)) continue;
    const a = bottom[(f * perSide) % bottom.length];
    const b = bottom[((f + 1) * perSide) % bottom.length];
    const width = a.distanceTo(b);
    const count = Math.max(2, Math.floor(width / spacing));
    for (let k = 1; k < count; k++) {
      const s = k / count;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= maxRing; i++) pts.push(pointOnFace(rings[i], f, perSide, s));
      // 往上抬一點，避免與屋面 z-fighting
      const up = new THREE.Vector3(0, lift + radius * 0.5, 0);
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => p.clone().add(up)));
      ridgeParts.push(new THREE.TubeGeometry(curve, Math.max(4, maxRing), radius, 5, false));
      // 瓦當：屋簷端的圓片，朝外
      const p0 = pts[0];
      const dir = pts[0].clone().sub(pts[1]).normalize();
      const disc = new THREE.CylinderGeometry(radius * 1.6, radius * 1.6, 0.06, 10);
      disc.rotateX(Math.PI / 2);
      disc.lookAt(dir);
      disc.translate(p0.x, p0.y + radius * 0.5, p0.z);
      capParts.push(disc);
    }
  }
  return { ridges: merge(ridgeParts), caps: merge(capParts) };
}

/**
 * 斗拱帶：沿多邊形路徑（從上方看逆時針）重複排列斗拱。
 * 每朵斗拱＝坐斗＋十字交錯的拱臂＋上方散斗與挑出的昂，朝外挑出 reach。
 */
export function dougongBand(path: THREE.Vector2[], y: number, spacing: number, scale = 1, reach = 1.2): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    const len = a.distanceTo(b);
    const count = Math.max(1, Math.round(len / spacing));
    const ang = Math.atan2(-(b.y - a.y), b.x - a.x);
    // 向外法線（從上方看逆時針的路徑，外側＝局部 +Z 經 rotateY(ang) 後的方向）
    const ox = Math.sin(ang);
    const oz = Math.cos(ang);
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      const px = a.x + (b.x - a.x) * t;
      const pz = a.y + (b.y - a.y) * t;
      const s = scale;
      const pieces: [number, number, number, number, number, number][] = [
        // w(沿牆), h, d(向外), 向外位移, 高度位移, 沿牆位移
        [0.7 * s, 0.35 * s, 0.7 * s, 0, 0, 0],
        [1.9 * s, 0.28 * s, 0.34 * s, 0.1 * s, 0.35 * s, 0],
        [0.34 * s, 0.28 * s, reach * s, reach * 0.45 * s, 0.35 * s, 0],
        [0.45 * s, 0.25 * s, 0.45 * s, 0, 0.63 * s, -0.75 * s],
        [0.45 * s, 0.25 * s, 0.45 * s, 0, 0.63 * s, 0.75 * s],
        [2.5 * s, 0.26 * s, 0.34 * s, 0.35 * s, 0.88 * s, 0],
        [0.34 * s, 0.26 * s, reach * 1.4 * s, reach * 0.7 * s, 0.88 * s, 0],
        [0.5 * s, 0.25 * s, 0.5 * s, reach * 1.3 * s, 1.14 * s, 0],
      ];
      for (const [w, h, d, out, dy, along] of pieces) {
        const g = new THREE.BoxGeometry(w, h, d);
        g.translate(along, dy + h / 2, 0);
        g.rotateY(ang);
        g.translate(px + ox * out, y, pz + oz * out);
        parts.push(g);
      }
    }
  }
  return merge(parts);
}

/** 細緻欄杆：望柱（柱身＋蓮頭）＋欄板（外框＋內凹花板）＋地栿 */
export function balustradeFine(path: THREE.Vector2[], y: number, height = 1.1, spacing = 2.2): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const place = (g: THREE.BufferGeometry, ang: number, x: number, yy: number, z: number) => {
    g.rotateY(ang);
    g.translate(x, yy, z);
    parts.push(g);
  };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const len = a.distanceTo(b);
    const ang = Math.atan2(-(b.y - a.y), b.x - a.x);
    const n = Math.max(1, Math.round(len / spacing));
    // 地栿
    place(new THREE.BoxGeometry(len, 0.18, 0.4), ang, (a.x + b.x) / 2, y + 0.09, (a.y + b.y) / 2);
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.y + (b.y - a.y) * t;
      place(new THREE.BoxGeometry(0.3, height, 0.3), ang, x, y + height / 2, z);
      const head = new THREE.CylinderGeometry(0.12, 0.2, 0.32, 8);
      place(head, ang, x, y + height + 0.16, z);
      const knob = new THREE.SphereGeometry(0.12, 8, 6);
      place(knob, ang, x, y + height + 0.38, z);
      if (k < n) {
        const mx = a.x + (b.x - a.x) * (t + 0.5 / n);
        const mz = a.y + (b.y - a.y) * (t + 0.5 / n);
        const w = len / n - 0.34;
        place(new THREE.BoxGeometry(w, 0.14, 0.26), ang, mx, y + height - 0.12, mz); // 扶手
        place(new THREE.BoxGeometry(w, height * 0.62, 0.12), ang, mx, y + 0.2 + height * 0.31, mz); // 欄板
        place(new THREE.BoxGeometry(w * 0.7, height * 0.36, 0.2), ang, mx, y + 0.2 + height * 0.31, mz); // 花板
      }
    }
  }
  return merge(parts);
}

/** 車削柱：柱礎＋柱身（微收分）＋柱頭 */
export function column(r: number, h: number, x: number, y: number, z: number, seg = 16): THREE.BufferGeometry {
  const prof = [
    [r * 1.45, 0], [r * 1.45, 0.25], [r * 1.25, 0.4], [r * 1.05, 0.55], [r, 0.7],
    [r * 0.92, h - 0.8], [r * 1.02, h - 0.6], [r * 1.12, h - 0.45], [r * 1.12, h - 0.2], [r * 1.3, h - 0.2], [r * 1.3, h], [0, h],
  ].map(([a, b]) => new THREE.Vector2(a, b));
  const g = new THREE.LatheGeometry([new THREE.Vector2(0, 0), ...prof], seg);
  g.translate(x, y, z);
  return g;
}

/** 以 canvas 繪製的匾額貼圖（直式或橫式文字） */
export function plaqueTexture(text: string, opts: { vertical?: boolean; bg?: string; fg?: string; border?: string } = {}): THREE.CanvasTexture {
  const { vertical = false, bg = '#1c3f8f', fg = '#f1d27a', border = '#d4b35a' } = opts;
  const c = document.createElement('canvas');
  const n = text.length;
  c.width = vertical ? 256 : 256 * n;
  c.height = vertical ? 256 * n : 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = border;
  ctx.lineWidth = 18;
  ctx.strokeRect(12, 12, c.width - 24, c.height - 24);
  ctx.fillStyle = fg;
  ctx.font = `bold 190px "Noto Serif TC","PingFang TC","Microsoft JhengHei",serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const x = vertical ? c.width / 2 : 128 + i * 256;
    const y = vertical ? 128 + i * 256 : c.height / 2;
    ctx.fillText(text[i], x, y + 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 回傳放樣屋頂的環（供鋪瓦壟等細部使用） */
export function roofRingsRect(o: { hw: number; hd: number; height: number; ridge?: number; curve?: number; cornerLift?: number; gableAt?: number; top?: number; steps?: number; perSide?: number }): Ring[] {
  const { hw, hd, height, ridge = 0, curve = 1.7, cornerLift = 0, gableAt = 1, top = 1, steps = 10, perSide = 8 } = o;
  const rings: Ring[] = [];
  const ridgeHw = Math.max(ridge, 0.01);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * top;
    const tx = Math.min(t, gableAt);
    const w = hw + (ridgeHw - hw) * tx;
    const d = Math.max(hd + (0.01 - hd) * t, 0.01);
    const y = height * Math.pow(t, curve);
    const liftAmt = cornerLift * Math.pow(1 - t, 3);
    rings.push(rectRing(w, d, y, perSide, (wc) => wc * liftAmt));
  }
  return rings;
}

export function roofRingsOct(o: { radius: number; height: number; curve?: number; cornerLift?: number; top?: number; apex?: number; steps?: number; perSide?: number }): Ring[] {
  const { radius, height, curve = 1.6, cornerLift = 0, top = 1, apex = 0.3, steps = 12, perSide = 6 } = o;
  const rings: Ring[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * top;
    const r = radius + (apex - radius) * t;
    const y = height * Math.pow(t, curve);
    const liftAmt = cornerLift * Math.pow(1 - t, 3);
    rings.push(polygonRing(8, r, y, perSide, Math.PI / 8, (w) => w * liftAmt));
  }
  return rings;
}

/** 平移一組環 */
export function offsetRings(rings: Ring[], x: number, y: number, z: number): Ring[] {
  return rings.map((r) => r.map((p) => p.clone().add(new THREE.Vector3(x, y, z))));
}

/**
 * 以世界座標重建 UV（依三角形法線選投影面），1 UV 單位 = scale 公尺。
 * 用於需要真實尺度貼圖（石材分縫、混凝土模板紋）的幾何；請在幾何已放到最終位置後呼叫。
 */
export function planarUV(geometry: THREE.BufferGeometry, scale = 1): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u: number, v: number;
      if (ay >= ax && ay >= az) [u, v] = [p.x, p.z];
      else if (ax >= az) [u, v] = [p.z, p.y];
      else [u, v] = [p.x, p.y];
      uv[(i + k) * 2] = u / scale;
      uv[(i + k) * 2 + 1] = v / scale;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

/**
 * 把在 XY 平面建好的幾何（+Z 朝外）貼到牆面：pos 為牆面上的位置，normal 為水平朝外方向。
 */
export function placeOnWall(g: THREE.BufferGeometry, pos: THREE.Vector3, normal: THREE.Vector3): THREE.BufferGeometry {
  const n = normal.clone().setY(0).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, n);
  const m = new THREE.Matrix4().makeBasis(right, up, n).setPosition(pos);
  g.applyMatrix4(m);
  return g;
}

/** 尖拱（等邊尖拱）輪廓點：寬 w、總高 h（底在 y=0），順時針或逆時針由 ccw 決定 */
export function pointedArchPoints(w: number, h: number, ccw = true, seg = 10): THREE.Vector2[] {
  const r = w; // 等邊尖拱：半徑＝寬度
  const rise = Math.sqrt(r * r - (w / 2) * (w / 2));
  const spring = Math.max(0, h - rise);
  const pts: THREE.Vector2[] = [new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(w / 2, spring)];
  // 右半弧：圓心在左拱腳 (-w/2, spring)
  const a0 = 0;
  const a1 = Math.atan2(rise, w / 2);
  for (let i = 1; i <= seg; i++) {
    const t = a0 + ((a1 - a0) * i) / seg;
    pts.push(new THREE.Vector2(-w / 2 + r * Math.cos(t), spring + r * Math.sin(t)));
  }
  // 左半弧：圓心在右拱腳 (w/2, spring)
  const b1 = Math.PI - a1;
  for (let i = 1; i <= seg; i++) {
    const t = b1 + ((Math.PI - b1) * i) / seg;
    pts.push(new THREE.Vector2(w / 2 + r * Math.cos(t), spring + r * Math.sin(t)));
  }
  pts.push(new THREE.Vector2(-w / 2, spring));
  return ccw ? pts : pts.reverse();
}

/** 半圓拱輪廓點 */
export function roundArchPoints(w: number, h: number, ccw = true, seg = 16): THREE.Vector2[] {
  const r = w / 2;
  const spring = Math.max(0, h - r);
  const pts: THREE.Vector2[] = [new THREE.Vector2(-r, 0), new THREE.Vector2(r, 0)];
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI;
    pts.push(new THREE.Vector2(r * Math.cos(t), spring + r * Math.sin(t)));
  }
  return ccw ? pts : pts.reverse();
}

/** 以外輪廓與內輪廓（皆為封閉點列）擠出「框」 */
export function frameFromOutlines(outer: THREE.Vector2[], inner: THREE.Vector2[], depth: number): THREE.BufferGeometry {
  const s = new THREE.Shape(outer);
  s.holes.push(new THREE.Path(inner.slice().reverse()));
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 1 });
}

/** 將點列等比縮放（以底邊中心為基準）：寬度 dw、高度 dh 的內縮 */
export function insetOutline(pts: THREE.Vector2[], dw: number, dh: number): THREE.Vector2[] {
  const xs = pts.map((p) => Math.abs(p.x));
  const w = Math.max(...xs) * 2;
  const h = Math.max(...pts.map((p) => p.y));
  const sx = (w - 2 * dw) / w;
  const sy = (h - dh) / h;
  return pts.map((p) => new THREE.Vector2(p.x * sx, p.y * sy + 0.001));
}

/** 兩點之間的方柱 */
export function beamBetween(p0: THREE.Vector3, p1: THREE.Vector3, t: number, t2 = t): THREE.BufferGeometry {
  const len = p0.distanceTo(p1);
  const g = new THREE.BoxGeometry(t, t2, len);
  const m = new THREE.Matrix4().lookAt(p0, p1, Math.abs(p1.y - p0.y) > len * 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
  g.applyMatrix4(m);
  g.translate((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (p0.z + p1.z) / 2);
  return g;
}

/** 沿 3D 折線（可傾斜，例如台階兩側）的欄杆：望柱＋扶手＋欄板 */
export function railAlong(points: THREE.Vector3[], height = 1.0, spacing = 2.0): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, height, 0);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const c = points[i + 1];
    const n = Math.max(1, Math.round(a.distanceTo(c) / spacing));
    for (let k = 0; k <= n; k++) {
      const p = a.clone().lerp(c, k / n);
      parts.push(box(0.28, height, 0.28, p.x, p.y, p.z));
      const head = new THREE.CylinderGeometry(0.1, 0.18, 0.3, 8);
      head.translate(p.x, p.y + height + 0.15, p.z);
      parts.push(head);
      if (k < n) {
        const q = a.clone().lerp(c, (k + 1) / n);
        parts.push(beamBetween(p.clone().add(up).setY(p.y + height - 0.1), q.clone().setY(q.y + height - 0.1), 0.22, 0.14));
        parts.push(beamBetween(p.clone().setY(p.y + height * 0.45), q.clone().setY(q.y + height * 0.45), 0.1, height * 0.6));
      }
    }
    parts.push(beamBetween(a.clone().setY(a.y + 0.08), c.clone().setY(c.y + 0.08), 0.36, 0.16));
  }
  return merge(parts);
}
