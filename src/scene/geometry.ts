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

/** 欄杆：沿路徑放置立柱與扶手 */
export function balustrade(path: THREE.Vector2[], y: number, height = 1.1, spacing = 2.4): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const len = a.distanceTo(b);
    const ang = Math.atan2(-(b.y - a.y), b.x - a.x);
    const rail = new THREE.BoxGeometry(len, 0.18, 0.3);
    rail.rotateY(ang);
    rail.translate((a.x + b.x) / 2, y + height, (a.y + b.y) / 2);
    parts.push(rail);
    const base = new THREE.BoxGeometry(len, 0.2, 0.34);
    base.rotateY(ang);
    base.translate((a.x + b.x) / 2, y + 0.1, (a.y + b.y) / 2);
    parts.push(base);
    const n = Math.max(1, Math.round(len / spacing));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const post = new THREE.BoxGeometry(0.32, height, 0.32);
      post.translate(a.x + (b.x - a.x) * t, y + height / 2, a.y + (b.y - a.y) * t);
      parts.push(post);
    }
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
