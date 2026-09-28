import * as THREE from 'three';
import {
  Batch, balustradeFine, beamBetween, box, chineseRoof, column, cylinder, dougongBand, flat, frameFromOutlines, loft, merge,
  octagonRoof, offsetRings, placeOnWall, planarUV, plaqueTexture, polygonRing, railAlong, roofRingsOct, roofRingsRect,
  roundArchPoints, stairs, tileRidges, type Ring,
} from './geometry';
import { M } from './materials';
import { buildTrees, type TreeArea, type TreeRow } from './trees';
import type { MapLabel, Preset } from '../world/types';
import { DEFAULT_ORIGIN, offsetLatLon } from '../geo';

// 中正紀念堂園區（程序化建模）
//
// 建模在「園區座標」(u, v) 中進行：原點＝紀念堂中心，+u 沿主軸指向紀念堂後方（方位 118.3°，東南東），
// +v 指向主軸右側（方位 208.3°，南南西）。整組模型再旋轉到真實方位，
// 輸出的「區域座標」以紀念堂中心為原點、+X 東、+Z 南；放進場景時由地標圖層平移到正確位置。
// 牌樓在西北西端（中山南路），國家戲劇院在廣場南側（+v）、國家音樂廳在北側（−v）。
//
// 尺寸來源：中正紀念堂管理處「環境介紹」（堂高 70 m＝台基 14.5 + 堂身 24 + 屋頂 31.5；
// 主體約 15,000 m²；牌樓高 30 m 寬 80 m、五間六柱十一樓；民主大道 380 × 40 m；廣場 120 × 120 m）
// 與 OpenStreetMap 建物輪廓（園區邊界 relation 1506269、各建物 way 形心）。

const DEG = Math.PI / 180;

/** 主軸方位（牌樓 → 紀念堂） */
export const SITE_AXIS_BEARING = 118.3;
const ROT = (SITE_AXIS_BEARING - 90) * DEG;
const COS = Math.cos(ROT);
const SIN = Math.sin(ROT);

/** 紀念堂中心的經緯度（區域座標原點） */
export const CKS_ANCHOR = DEFAULT_ORIGIN;

export function siteToLocal(u: number, v: number): { x: number; z: number } {
  return { x: u * COS - v * SIN, z: u * SIN + v * COS };
}

export function localToSite(x: number, z: number): { u: number; v: number } {
  return { u: x * COS + z * SIN, v: -x * SIN + z * COS };
}

export type Floor =
  | { kind: 'rect'; cx: number; cz: number; hw: number; hd: number; y: number }
  | {
      kind: 'stairs';
      axis: 'x' | 'z';
      /** 最低一階所在座標 → 最高一階所在座標 */
      from: number;
      to: number;
      center: number;
      halfWidth: number;
      y0: number;
      y1: number;
      steps: number;
    };

type P2 = [number, number];

/** 園區配置（園區座標，公尺） */
export const L = {
  /** 園區邊界（OSM relation 1506269 簡化，12 點） */
  park: [
    [-466, 179.7], [-72.8, 173.4], [153.2, 175.4], [155.5, -175.6], [-537.9, -165.7], [-550.6, -157.1],
    [-553.8, -145.8], [-537.7, -78.2], [-525.2, -64.9], [-492, -50.3], [-491.8, 49.8], [-500.5, 56.6],
  ] as P2[],
  arch: { u: -470.5, width: 80, height: 30, depth: 12 },
  square: { u0: -492, u1: -295, half: 60 },
  avenue: { u0: -295, u1: -85.5, half: 20 },
  walks: { inner: 25, outer: 34 },
  theater: { u: -355, v: 96, len: 104, wid: 56, wingV: 143 },
  concert: { u: -355, v: -96, len: 99, wid: 56, wingV: -143 },
  ponds: [
    { u: -230, v: -124, ru: 36, rv: 23, seed: 3, name: '光華池' },
    { u: -225, v: 119, ru: 36, rv: 23, seed: 9, name: '雲漢池' },
  ],
  gates: [
    { u: 0, v: -167, name: '大忠門' },
    { u: 0, v: 167.5, name: '大孝門' },
  ],
};

/** 紀念堂尺寸 */
export const HALL = {
  /** 三層台基，合計 14.5 m */
  tiers: [
    { half: 62, top: 14.5 / 3 },
    { half: 50, top: (14.5 * 2) / 3 },
    { half: 38, top: 14.5 },
  ],
  /** 堂身：40 m 見方，四角各突出 7.5 m（總寬 55 m） */
  core: 20, outer: 27.5, cornerFrom: 14.5, wallTop: 38.5, wallThick: 3,
  door: { w: 11, h: 16 },
  /** 屋頂（八角重簷攢尖）：以外接圓半徑表示 */
  bracketR: 29, eave1R: 36, eave1H: 6.5, drumR: 24, drumH: 4, eave2R: 29.5, eave2H: 14,
  top: 70,
  /** 正面台階：84 級分三段，中間御路分隔成左右兩道 */
  stairs: { perFlight: 28, tread: 0.34, flightWidth: 15.5, rampWidth: 9, front: -85.5 },
};

const rect = (u0: number, v0: number, u1: number, v1: number): P2[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];

function blob(cu: number, cv: number, ru: number, rv: number, seed: number, n = 28): P2[] {
  const pts: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.12 * Math.sin(a * 3 + seed) + 0.08 * Math.cos(a * 5 + seed * 2);
    pts.push([cu + Math.cos(a) * ru * k, cv + Math.sin(a) * rv * k]);
  }
  return pts;
}

function groundMesh(points: P2[], material: THREE.MeshStandardMaterial, y: number, texScale?: number) {
  const g = flat(points, y);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  if (texScale) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / texScale, uv.getY(i) / texScale);
  const m = new THREE.Mesh(g, material);
  m.receiveShadow = true;
  return m;
}

/** 側面輪廓（u, y）沿 v 方向擠出，用於台階擋牆、御路 */
function profile(points: P2[], v0: number, v1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([u, y]) => new THREE.Vector2(u, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: v1 - v0, bevelEnabled: false });
  g.translate(0, 0, v0);
  return g;
}

const ring = (half: number, gapHalf: number): THREE.Vector2[] => [
  new THREE.Vector2(-half, -gapHalf), new THREE.Vector2(-half, -half), new THREE.Vector2(half, -half),
  new THREE.Vector2(half, half), new THREE.Vector2(-half, half), new THREE.Vector2(-half, gapHalf),
];

// ---- 精細建模共用：屋頂（琉璃瓦壟、瓦當、簷口、垂脊、正脊與鴟吻）----

interface RectRoofSpec {
  hw: number;
  hd: number;
  height: number;
  ridge?: number;
  curve?: number;
  cornerLift?: number;
  gableAt?: number;
  top?: number;
  steps?: number;
  perSide?: number;
}

interface RoofLook {
  tile: THREE.Material;
  trim: THREE.Material;
  ridge: THREE.Material;
  at: THREE.Vector3;
  rotY?: number;
  spacing?: number;
  /** 正脊兩端的鴟吻 */
  ornaments?: boolean;
  /** 垂脊上的小獸 */
  beasts?: boolean;
}

/** 鴟吻：正脊兩端向內捲起的魚尾狀脊飾（側面輪廓擠出），dir 指向正脊內側 */
function chiwen(b: Batch, mat: THREE.Material, at: THREE.Vector3, dir: THREE.Vector3, size: number) {
  const pts = [
    [-0.15, 0], [1.1, 0], [1.1, 0.35], [0.55, 0.6], [0.35, 1.1], [0.45, 1.65], [0.85, 1.95], [1.2, 1.85],
    [1.05, 2.25], [0.6, 2.45], [0.15, 2.2], [-0.1, 1.7], [-0.25, 1.0], [-0.35, 0.4],
  ].map(([x, y]) => new THREE.Vector2(x * size, y * size));
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: size * 0.4, bevelEnabled: true, bevelThickness: size * 0.06, bevelSize: size * 0.05, bevelSegments: 2 });
  g.translate(0, 0, -size * 0.2);
  g.rotateY(-Math.atan2(dir.z, dir.x));
  g.translate(at.x, at.y - 0.1, at.z);
  b.add(mat, g);
}

/** 垂脊上的小獸：一列小方塊與尖角 */
function beastsAlong(b: Batch, mat: THREE.Material, curve: THREE.Curve<THREE.Vector3>, count: number, size: number) {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const p = curve.getPoint(0.06 + i * 0.06);
    parts.push(box(size, size * 1.2, size * 0.7, p.x, p.y + 0.2, p.z));
    const horn = new THREE.ConeGeometry(size * 0.25, size * 0.6, 4);
    horn.translate(p.x, p.y + 0.2 + size * 1.5, p.z);
    parts.push(horn);
  }
  b.add(mat, merge(parts));
}

/** 矩形平面的中式屋頂（廡殿／歇山／截頂的重簷下層），含瓦壟、瓦當、簷口、垂脊、正脊 */
function rectRoof(b: Batch, spec: RectRoofSpec, o: RoofLook) {
  const perSide = spec.perSide ?? 8;
  const steps = spec.steps ?? 10;
  const top = spec.top ?? 1;
  const m = new THREE.Matrix4().makeRotationY(o.rotY ?? 0).setPosition(o.at);
  const geo = chineseRoof({ ...spec, perSide });
  geo.applyMatrix4(m);
  b.add(o.tile, geo);
  const rings = roofRingsRect({ ...spec, perSide }).map((r) => r.map((p) => p.clone().applyMatrix4(m)));
  const gableAt = spec.gableAt ?? 1;
  const gRing = gableAt < 1 ? Math.min(steps, Math.round((steps * gableAt) / top)) : steps;
  const spacing = o.spacing ?? 0.9;
  const addTiles = (t: { ridges: THREE.BufferGeometry; caps: THREE.BufferGeometry }) => {
    b.add(o.tile, t.ridges);
    b.add(o.tile, t.caps);
  };
  if (gableAt < 1) {
    addTiles(tileRidges(rings, 4, perSide, spacing, { skipFaces: [0, 2] }));
    addTiles(tileRidges(rings, 4, perSide, spacing, { skipFaces: [1, 3], maxRing: gRing }));
  } else addTiles(tileRidges(rings, 4, perSide, spacing));
  // 簷口
  b.add(o.trim, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rings[0], true), rings[0].length * 2, 0.17, 5, true));
  // 垂脊（四角）
  for (let k = 0; k < 4; k++) {
    const idx = k * perSide;
    const pts = rings.slice(0, gRing + 1).map((r) => r[idx].clone().setY(r[idx].y + 0.22));
    const curve = new THREE.CatmullRomCurve3(pts);
    b.add(o.ridge, new THREE.TubeGeometry(curve, Math.max(6, pts.length * 2), 0.26, 6));
    if (o.beasts) beastsAlong(b, o.ridge, curve, 4, 0.32);
  }
  // 正脊與鴟吻（截頂的下層簷沒有）
  if (top >= 1) {
    const last = rings[rings.length - 1];
    const e0 = last[0].clone().setY(last[0].y + 0.45);
    const e1 = last[2 * perSide].clone().setY(last[2 * perSide].y + 0.45);
    b.add(o.ridge, beamBetween(e0, e1, 0.6, 1.0));
    if (o.ornaments) {
      const size = Math.min(2.2, 0.6 + spec.height * 0.12);
      chiwen(b, o.ridge, e0, e1.clone().sub(e0).normalize(), size);
      chiwen(b, o.ridge, e1, e0.clone().sub(e1).normalize(), size);
    }
  }
}

/** 八角攢尖（或截頂裙簷）屋頂，含瓦壟、瓦當、簷口、垂脊與小獸 */
function octRoof(b: Batch, spec: { radius: number; height: number; curve: number; cornerLift: number; apex: number; steps?: number }, y: number) {
  const geo = octagonRoof(spec);
  geo.translate(0, y, 0);
  b.add(M.blueTile, geo);
  const rings = offsetRings(roofRingsOct({ ...spec, perSide: 6 }), 0, y, 0);
  const t = tileRidges(rings, 8, 6, 0.85, { radius: 0.12 });
  b.add(M.blueTile, t.ridges);
  b.add(M.blueTile, t.caps);
  b.add(M.eaveWhite, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rings[0], true), rings[0].length * 2, 0.2, 5, true));
  const tip = spec.apex < 2 ? rings.length - 1 : rings.length - 1;
  for (let k = 0; k < 8; k++) {
    const pts = rings.slice(0, tip + 1).map((r) => r[k * 6].clone().setY(r[k * 6].y + 0.3));
    const curve = new THREE.CatmullRomCurve3(pts);
    b.add(M.blueTrim, new THREE.TubeGeometry(curve, 20, 0.32, 6));
    beastsAlong(b, M.blueTrim, curve, 5, 0.34);
  }
}

// ---- 紀念堂 ----

/** 帶拱門開口的牆板（牆面在 YZ 平面，厚度朝 +u） */
function doorWall(width: number, height: number, thick: number, doorW: number, doorH: number) {
  const s = new THREE.Shape();
  const r = doorW / 2;
  s.moveTo(-width / 2, 0);
  s.lineTo(-r, 0);
  s.lineTo(-r, doorH - r);
  s.absarc(0, doorH - r, r, Math.PI, 0, true);
  s.lineTo(r, 0);
  s.lineTo(width / 2, 0);
  s.lineTo(width / 2, height);
  s.lineTo(-width / 2, height);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, curveSegments: 24 });
  g.rotateY(Math.PI / 2);
  return g;
}

/** 台階：每階加上突出的踏面前緣 */
function stairsFine(width: number, steps: number, rise: number, tread: number): THREE.BufferGeometry {
  const parts = [stairs(width, steps, rise, tread)];
  for (let i = 0; i < steps; i++) {
    const g = new THREE.BoxGeometry(0.08, 0.05, width);
    g.translate(-(i + 1) * tread + 0.02, -i * rise - 0.025, 0);
    parts.push(g);
  }
  return merge(parts);
}

const wall = (b: Batch, g: THREE.BufferGeometry) => b.add(M.marbleWall, planarUV(g, 4));

/** 從上方看逆時針的 4 點矩形環 */
function rect4(x0: number, x1: number, z0: number, z1: number, y: number): Ring {
  return [new THREE.Vector3(x1, y, z1), new THREE.Vector3(x1, y, z0), new THREE.Vector3(x0, y, z0), new THREE.Vector3(x0, y, z1)];
}

function buildHall(b: Batch, floors: Floor[]) {
  const H = HALL;
  const S = H.stairs;
  const gap = S.flightWidth + S.rampWidth / 2 + 0.2;

  // 三層台基：石材分縫牆面、底座與簷口線腳、細緻欄杆（西側留台階開口）
  let prevTop = 0;
  for (const t of H.tiers) {
    wall(b, box(t.half * 2, t.top - prevTop, t.half * 2, 0, prevTop, 0));
    b.add(M.granite, box(t.half * 2 + 0.5, 0.6, t.half * 2 + 0.5, 0, prevTop, 0));
    b.add(M.marbleShade, box(t.half * 2 + 0.9, 0.35, t.half * 2 + 0.9, 0, t.top - 0.35, 0));
    b.add(M.marbleShade, box(t.half * 2 + 0.5, 0.3, t.half * 2 + 0.5, 0, t.top - 0.75, 0));
    b.add(M.marble, balustradeFine(ring(t.half - 0.4, gap), t.top, 1.1, 2.2));
    floors.push({ kind: 'rect', cx: 0, cz: 0, hw: t.half, hd: t.half, y: t.top });
    prevTop = t.top;
  }

  // 正面台階：三段，每段 28 級；中央御路（國徽浮雕）；兩側擋牆與欄杆
  const rise = H.tiers[0].top / S.perFlight;
  const run = S.perFlight * S.tread;
  const flights = [
    { foot: S.front, y0: 0 },
    { foot: -H.tiers[1].half - run, y0: H.tiers[0].top },
    { foot: -H.tiers[2].half - run, y0: H.tiers[1].top },
  ];
  const landing0 = S.front + run;
  b.add(M.granite, box(-H.tiers[0].half - landing0, H.tiers[0].top, gap * 2, (landing0 - H.tiers[0].half) / 2, 0, 0));
  floors.push({ kind: 'rect', cx: (landing0 - H.tiers[0].half) / 2, cz: 0, hw: (-H.tiers[0].half - landing0) / 2, hd: gap, y: H.tiers[0].top });
  flights.forEach((f, fi) => {
    const top = f.foot + run;
    const y1 = f.y0 + rise * S.perFlight;
    for (const side of [-1, 1]) {
      const sg = stairsFine(S.flightWidth, S.perFlight, rise, S.tread);
      sg.translate(top, y1, side * (S.rampWidth / 2 + S.flightWidth / 2));
      b.add(M.granite, sg);
      const wv = side * (gap - 0.6);
      wall(b, profile([[f.foot - 0.6, f.y0], [top, f.y0], [top, y1 + 0.6], [f.foot - 0.6, f.y0 + 0.6]], wv - 0.6, wv + 0.6));
      b.add(M.marble, railAlong([new THREE.Vector3(f.foot - 0.3, f.y0 + 0.6, wv), new THREE.Vector3(top, y1 + 0.6, wv)], 1.0, 1.9));
      // 御路兩側的欄杆
      const rv = side * (S.rampWidth / 2 + 0.1);
      b.add(M.marble, railAlong([new THREE.Vector3(f.foot, f.y0 + 0.6, rv), new THREE.Vector3(top, y1 + 0.6, rv)], 0.9, 1.9));
    }
    b.add(M.marble, profile([[f.foot, f.y0], [top, f.y0], [top, y1 + 0.25], [f.foot, f.y0 + 0.25]], -S.rampWidth / 2, S.rampWidth / 2));
    b.add(M.marbleShade, profile([[f.foot, f.y0], [top, f.y0], [top, y1 + 0.6], [f.foot, f.y0 + 0.6]], -S.rampWidth / 2 - 0.4, -S.rampWidth / 2 + 0.4));
    b.add(M.marbleShade, profile([[f.foot, f.y0], [top, f.y0], [top, y1 + 0.6], [f.foot, f.y0 + 0.6]], S.rampWidth / 2 - 0.4, S.rampWidth / 2 + 0.4));
    if (fi === 0) {
      // 國徽浮雕貼在最下段御路的坡面上
      const hv = S.rampWidth / 2 - 0.5;
      const q = [
        new THREE.Vector3(f.foot, f.y0 + 0.27, -hv), new THREE.Vector3(top, y1 + 0.27, -hv),
        new THREE.Vector3(top, y1 + 0.27, hv), new THREE.Vector3(f.foot, f.y0 + 0.27, hv),
      ];
      const uvq = [[0, 0], [0, 1], [1, 1], [1, 0]];
      const g = new THREE.BufferGeometry();
      const order = [0, 2, 1, 0, 3, 2];
      g.setAttribute('position', new THREE.Float32BufferAttribute(order.flatMap((k) => q[k].toArray()), 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(order.flatMap((k) => uvq[k]), 2));
      g.computeVertexNormals();
      b.add(M.emblem, g);
    }
    floors.push({ kind: 'stairs', axis: 'x', from: f.foot, to: top, center: 0, halfWidth: gap, y0: f.y0, y1, steps: S.perFlight });
  });

  // 堂身：40 m 見方的牆（可入內），四角 13 m 見方的角樓，外側牆面略為內傾
  const y0 = H.tiers[2].top;
  const deck = H.wallTop - 1.5;
  const c = H.core;
  const t = H.wallThick;
  wall(b, box(t, deck - y0, c * 2, c - t / 2, y0, 0));
  wall(b, box(c * 2, deck - y0, t, 0, y0, -c + t / 2));
  wall(b, box(c * 2, deck - y0, t, 0, y0, c - t / 2));
  const west = doorWall(c * 2, deck - y0, t, H.door.w, H.door.h);
  west.translate(-c, y0, 0);
  wall(b, west);
  const batter = 1.3;
  for (const su of [-1, 1])
    for (const sv of [-1, 1]) {
      const xs = (o: number) => (su > 0 ? [H.cornerFrom, o] : [-o, -H.cornerFrom]);
      const zs = (o: number) => (sv > 0 ? [H.cornerFrom, o] : [-o, -H.cornerFrom]);
      const [x0, x1] = xs(H.outer);
      const [z0, z1] = zs(H.outer);
      const [X0, X1] = xs(H.outer - batter);
      const [Z0, Z1] = zs(H.outer - batter);
      wall(b, loft([rect4(x0, x1, z0, z1, y0), rect4(X0, X1, Z0, Z1, deck)], { capTop: true }));
      // 角樓底座線腳
      b.add(M.marbleShade, loft([rect4(x0 - 0.3, x1 + 0.3, z0 - 0.3, z1 + 0.3, y0), rect4(x0 - 0.3, x1 + 0.3, z0 - 0.3, z1 + 0.3, y0 + 0.9)], { capTop: true }));
    }
  const top = H.outer - batter + 0.2;
  wall(b, box(top * 2, 1.5, top * 2, 0, deck, 0));
  b.add(M.marbleShade, box(top * 2 + 1, 0.5, top * 2 + 1, 0, H.wallTop - 0.5, 0));
  b.add(M.marbleShade, box(top * 2 + 0.5, 0.4, top * 2 + 0.5, 0, H.wallTop - 1.1, 0));

  // 正門：拱券線腳、開啟的銅門（門釘）
  const face = new THREE.Vector3(-c, y0, 0);
  const n = new THREE.Vector3(-1, 0, 0);
  b.add(M.marbleShade, placeOnWall(frameFromOutlines(roundArchPoints(H.door.w + 2.4, H.door.h + 1.2), roundArchPoints(H.door.w + 1.2, H.door.h + 0.6).map((p) => p.clone().setY(p.y + 0.02)), 0.45), face.clone(), n));
  b.add(M.marble, placeOnWall(frameFromOutlines(roundArchPoints(H.door.w + 1.2, H.door.h + 0.6), roundArchPoints(H.door.w, H.door.h).map((p) => p.clone().setY(p.y + 0.02)), 0.25), face.clone(), n));
  for (const side of [-1, 1]) {
    const lx = -c + t + H.door.w / 4 + 0.2;
    const lz = side * (H.door.w / 2 + 0.4);
    b.add(M.bronze, box(H.door.w / 2, H.door.h - H.door.w / 2, 0.4, lx, y0, lz));
    const studs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 11; j++) {
        const st = new THREE.SphereGeometry(0.09, 6, 4);
        st.translate(lx - H.door.w / 4 + 0.4 + i * 0.8, y0 + 0.8 + j * 1.0, lz - side * 0.22);
        studs.push(st);
      }
    b.add(M.gold, merge(studs));
  }
  // 匾額「中正紀念堂」（直式）
  const plaqueMat = new THREE.MeshStandardMaterial({ map: plaqueTexture('中正紀念堂', { vertical: true, bg: '#1d3f8f', fg: '#f0d27a', border: '#8a4b2a' }), roughness: 0.4 });
  const plq = new THREE.PlaneGeometry(1.9, 5.4);
  plq.translate(0, 2.7, 0.08);
  b.add(plaqueMat, placeOnWall(plq, new THREE.Vector3(-c, y0 + 16.9, 0), n));
  b.add(M.bronze, placeOnWall(box(2.3, 5.8, 0.12, 0, -0.2, 0), new THREE.Vector3(-c, y0 + 16.9, 0), n));

  // 室內：地坪、藻井天花（格柵＋中央國徽）
  b.add(M.granite, flat(rect(-c + t, -c + t, c - t, c - t), y0 + 0.02));
  b.add(M.darkInterior, box(c * 2 - t * 2, 0.3, c * 2 - t * 2, 0, deck - 0.3, 0));
  const coffers: THREE.BufferGeometry[] = [];
  for (let k = -7; k <= 7; k++) {
    coffers.push(box(c * 2 - t * 2, 0.45, 0.35, 0, deck - 0.75, k * 2.2));
    coffers.push(box(0.35, 0.45, c * 2 - t * 2, k * 2.2, deck - 0.75, 0));
  }
  b.add(M.caihua, planarUV(merge(coffers), 3));
  const emb = new THREE.CircleGeometry(3.2, 48);
  emb.rotateX(Math.PI / 2);
  emb.translate(0, deck - 0.8, 0);
  b.add(M.emblem, emb);
  // 銅像（坐東朝西）：基座 3.5 m、像高 6.3 m
  const sx = c - t - 7;
  b.add(M.granite, box(6.5, 3.5, 8, sx, y0, 0));
  b.add(M.marbleShade, box(7.1, 0.4, 8.6, sx, y0 + 3.1, 0));
  const statue: THREE.BufferGeometry[] = [];
  statue.push(box(3.6, 1.2, 4.4, sx + 0.3, y0 + 3.5, 0)); // 椅座
  statue.push(box(1.0, 3.4, 4.4, sx + 1.9, y0 + 4.7, 0)); // 椅背
  statue.push(box(2.6, 2.6, 3.0, sx + 0.9, y0 + 4.7, 0)); // 身軀
  for (const zz of [-0.7, 0.7]) {
    statue.push(box(2.4, 0.9, 0.9, sx - 0.6, y0 + 4.7, zz)); // 大腿
    statue.push(box(0.8, 2.0, 0.8, sx - 1.5, y0 + 3.5, zz)); // 小腿
  }
  const head = new THREE.SphereGeometry(0.72, 20, 14);
  head.translate(sx + 0.7, y0 + 8.1, 0);
  statue.push(head);
  b.add(M.bronze, merge(statue));

  // 斗拱層（白色斗拱、藍綠底）
  const oct = (r: number, y: number) => polygonRing(8, r, y, 1, Math.PI / 8);
  const octPath = (r: number) => oct(r, 0).map((p) => new THREE.Vector2(p.x, p.z));
  const yB = H.wallTop;
  const yE1 = yB + 2.5;
  b.add(M.eaveUnder, loft([oct(H.bracketR - 0.8, yB), oct(H.bracketR - 0.8, yE1)], { capTop: false }));
  b.add(M.eaveWhite, dougongBand(octPath(H.bracketR - 0.8), yB + 0.3, 1.8, 0.95, 1.1));
  // 下層簷
  octRoof(b, { radius: H.eave1R, height: H.eave1H, apex: H.drumR, curve: 1.35, cornerLift: 1.3, steps: 8 }, yE1);
  b.add(M.eaveUnder, loft([oct(H.bracketR, yE1 - 0.02), oct(H.eave1R, yE1 - 0.02)]));
  // 簷間八角鼓座與上層斗拱
  const yD = yE1 + H.eave1H;
  b.add(M.marble, loft([oct(H.drumR - 0.5, yD - 0.6), oct(H.drumR - 0.5, yD + H.drumH - 1.6)]));
  b.add(M.eaveUnder, loft([oct(H.drumR - 0.3, yD + H.drumH - 1.6), oct(H.drumR - 0.3, yD + H.drumH)]));
  b.add(M.eaveWhite, dougongBand(octPath(H.drumR - 0.3), yD + H.drumH - 1.55, 1.6, 0.75, 0.9));
  // 上層簷與攢尖
  const yE2 = yD + H.drumH;
  octRoof(b, { radius: H.eave2R, height: H.eave2H, apex: 0.9, curve: 1.5, cornerLift: 1.2 }, yE2);
  b.add(M.eaveUnder, loft([oct(H.drumR - 0.5, yE2 - 0.02), oct(H.eave2R, yE2 - 0.02)]));

  // 寶頂：橘金色南瓜形，縱向稜紋
  const yTop = yE2 + H.eave2H;
  const fin = H.top - yTop;
  const prof = [
    [0, -0.3], [1.5, -0.3], [1.5, 0.3], [1.1, 0.5], [1.0, 0.9], [1.45, 1.3], [1.7, 1.9], [1.65, 2.5], [1.35, 3.0], [0.8, 3.35], [0.45, 3.5], [0.45, 3.9], [0, 3.95],
  ].map(([r, y]) => new THREE.Vector2(r * (fin / 5.5), y * (fin / 5.5)));
  const finial = new THREE.LatheGeometry(prof, 48).toNonIndexed();
  const fp = finial.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < fp.count; i++) {
    const x = fp.getX(i);
    const z = fp.getZ(i);
    const k = 1 + 0.05 * Math.cos(12 * Math.atan2(z, x));
    fp.setXYZ(i, x * k, fp.getY(i) + yTop, z * k);
  }
  finial.computeVertexNormals();
  b.add(M.finial, finial);
  b.add(M.finial, new THREE.TorusGeometry(1.05 * (fin / 5.5), 0.08, 6, 48).rotateX(Math.PI / 2).translate(0, yTop + 0.9 * (fin / 5.5), 0));
  b.add(M.gold, cylinder(0.06, fin * 0.3, 0, yTop + 3.9 * (fin / 5.5), 0, 8, 0.02));
}

// ---- 自由廣場牌樓（五間六柱十一樓）----

function buildArch(b: Batch) {
  const A = L.arch;
  const u = A.u;
  const D = A.depth;
  const widths = [9.5, 12.5, 15, 12.5, 9.5];
  const tops = [12.3, 13, 13.4, 13, 12.3];
  const pier = (A.width - widths.reduce((s, x) => s + x, 0)) / 6;
  const BODY = 19;
  const ops: { c: number; w: number; top: number }[] = [];
  const piers: number[] = [];
  let cur = -A.width / 2;
  for (let i = 0; i < 6; i++) {
    piers.push(cur + pier / 2);
    cur += pier;
    if (i < 5) {
      ops.push({ c: cur + widths[i] / 2, w: widths[i], top: tops[i] });
      cur += widths[i];
    }
  }

  // 主體：一片開了五個半圓拱的厚牆
  const outline: THREE.Vector2[] = [new THREE.Vector2(-A.width / 2, 0)];
  for (const o of ops) {
    const r = o.w / 2;
    const spring = o.top - r;
    outline.push(new THREE.Vector2(o.c - r, 0), new THREE.Vector2(o.c - r, spring));
    for (let k = 1; k < 24; k++) {
      const t = Math.PI - (k / 24) * Math.PI;
      outline.push(new THREE.Vector2(o.c + r * Math.cos(t), spring + r * Math.sin(t)));
    }
    outline.push(new THREE.Vector2(o.c + r, spring), new THREE.Vector2(o.c + r, 0));
  }
  outline.push(new THREE.Vector2(A.width / 2, 0), new THREE.Vector2(A.width / 2, BODY), new THREE.Vector2(-A.width / 2, BODY));
  const body = new THREE.ExtrudeGeometry(new THREE.Shape(outline), { depth: D, bevelEnabled: false, curveSegments: 1 });
  body.rotateY(Math.PI / 2);
  body.translate(u - D / 2, 0, 0);
  wall(b, body);
  b.add(M.granite, box(D + 5, 0.6, A.width + 5, u, 0, 0));

  const faces = [
    { x: u - D / 2, n: new THREE.Vector3(-1, 0, 0) },
    { x: u + D / 2, n: new THREE.Vector3(1, 0, 0) },
  ];
  for (const f of faces) {
    const at = (v: number, y: number) => new THREE.Vector3(f.x, y, v);
    for (const o of ops) {
      // 拱券線腳與拱心石
      b.add(M.marbleShade, placeOnWall(frameFromOutlines(roundArchPoints(o.w + 1.6, o.top + 0.8), roundArchPoints(o.w, o.top).map((p) => p.clone().setY(p.y + 0.02)), 0.3), at(o.c, 0), f.n));
      b.add(M.marble, placeOnWall(frameFromOutlines(roundArchPoints(o.w + 0.8, o.top + 0.4), roundArchPoints(o.w, o.top).map((p) => p.clone().setY(p.y + 0.02)), 0.45), at(o.c, 0), f.n));
      b.add(M.marbleShade, placeOnWall(box(1.1, 1.5, 0.6, 0, o.top - 0.4, 0), at(o.c, 0), f.n));
      // 拱上的雕刻框板
      const pw = o.w - 1;
      b.add(M.marbleShade, placeOnWall(frameFromOutlines(
        [new THREE.Vector2(-pw / 2, 0), new THREE.Vector2(pw / 2, 0), new THREE.Vector2(pw / 2, 3.2), new THREE.Vector2(-pw / 2, 3.2)],
        [new THREE.Vector2(-pw / 2 + 0.35, 0.35), new THREE.Vector2(pw / 2 - 0.35, 0.35), new THREE.Vector2(pw / 2 - 0.35, 2.85), new THREE.Vector2(-pw / 2 + 0.35, 2.85)],
        0.18,
      ), at(o.c, 14.9), f.n));
    }
    for (const p of piers) {
      // 柱面浮雕框與抱鼓石
      const pw = pier - 0.7;
      b.add(M.marbleShade, placeOnWall(frameFromOutlines(
        [new THREE.Vector2(-pw / 2, 0), new THREE.Vector2(pw / 2, 0), new THREE.Vector2(pw / 2, 8), new THREE.Vector2(-pw / 2, 8)],
        [new THREE.Vector2(-pw / 2 + 0.3, 0.3), new THREE.Vector2(pw / 2 - 0.3, 0.3), new THREE.Vector2(pw / 2 - 0.3, 7.7), new THREE.Vector2(-pw / 2 + 0.3, 7.7)],
        0.15,
      ), at(p, 3.2), f.n));
      const drum = new THREE.CylinderGeometry(0.95, 0.95, 1.4, 24);
      drum.rotateX(Math.PI / 2);
      drum.translate(0, 2.2, 1.0);
      b.add(M.marble, placeOnWall(drum, at(p, 0.6), f.n));
      b.add(M.marble, placeOnWall(box(1.5, 1.3, 2.0, 0, 0, 1.0), at(p, 0.6), f.n));
    }
    // 額枋線腳
    b.add(M.marbleShade, placeOnWall(box(A.width, 0.7, 0.4, 0, 13.9, 0.2), at(0, 0), f.n));
    b.add(M.marbleShade, placeOnWall(box(A.width + 0.6, 0.6, 0.6, 0, 18.4, 0.3), at(0, 0), f.n));
  }

  // 上部樓身與匾額「自由廣場」（橫匾由右至左）
  wall(b, box(D - 1, 6.2, 18, u, BODY, 0));
  const plaqueMat = new THREE.MeshStandardMaterial({ map: plaqueTexture('場廣由自', { bg: '#f3f1ea', fg: '#1a1a1a', border: '#c9b27a' }), roughness: 0.4 });
  for (const f of faces) {
    const g = new THREE.PlaneGeometry(12, 3.4);
    g.translate(0, 1.7, (D - 1) / 2 - D / 2 + 0.06);
    b.add(plaqueMat, placeOnWall(g, new THREE.Vector3(f.x, BODY + 1.1, 0), f.n));
  }
  for (const i of [1, 3]) wall(b, box(D - 1, 3.4, ops[i].w + 1.5, u, BODY, ops[i].c));
  for (const i of [0, 4]) wall(b, box(D - 1, 1.9, ops[i].w + 1.5, u, BODY, ops[i].c));
  for (let i = 1; i <= 4; i++) wall(b, box(D - 1.5, 1.3, pier + 1, u, BODY, piers[i]));

  // 十一樓：中央主樓、次樓 2、邊樓 2、夾樓 4、端樓 2
  const roofs: { c: number; y: number; hw: number; h: number; main?: boolean }[] = [
    { c: 0, y: BODY + 6.2 + 1.1, hw: 10.5, h: 4.2, main: true },
    { c: ops[1].c, y: BODY + 3.4 + 0.9, hw: 8.2, h: 3.4 },
    { c: ops[3].c, y: BODY + 3.4 + 0.9, hw: 8.2, h: 3.4 },
    { c: ops[0].c, y: BODY + 1.9 + 0.8, hw: 6.4, h: 3 },
    { c: ops[4].c, y: BODY + 1.9 + 0.8, hw: 6.4, h: 3 },
    ...[1, 2, 3, 4].map((i) => ({ c: piers[i], y: BODY + 1.3 + 0.6, hw: 2.8, h: 2.1 })),
    { c: piers[0], y: BODY + 0.6, hw: 2.8, h: 2 },
    { c: piers[5], y: BODY + 0.6, hw: 2.8, h: 2 },
  ];
  for (const r of roofs) {
    const hd = D / 2 + (r.main ? 2.8 : 2.0);
    // 斗拱（沿樓身四周）
    const bw = r.hw - 1.4;
    const bd = D / 2 - 0.4;
    const path = [new THREE.Vector2(u + bd, r.c + bw), new THREE.Vector2(u + bd, r.c - bw), new THREE.Vector2(u - bd, r.c - bw), new THREE.Vector2(u - bd, r.c + bw)];
    b.add(M.eaveWhite, dougongBand(path, r.y - (r.main ? 1.1 : 0.8), r.main ? 1.3 : 1.2, r.main ? 0.62 : 0.5, 0.9));
    b.add(M.eaveUnder, box(D - 0.6, r.main ? 1.0 : 0.7, bw * 2, u, r.y - (r.main ? 1.1 : 0.8), r.c));
    // chineseRoof 的屋脊沿 X；牌樓屋脊沿 v，轉 90°
    rectRoof(b, { hw: r.hw, hd, height: r.h, ridge: Math.max(0.6, r.hw - hd), curve: 1.5, cornerLift: r.main ? 1.0 : 0.6, steps: 8, perSide: 8 }, {
      tile: M.blueTile, trim: M.eaveWhite, ridge: M.blueTrim, at: new THREE.Vector3(u, r.y, r.c), rotY: Math.PI / 2,
      spacing: 0.75, ornaments: true, beasts: r.main,
    });
  }
}

// ---- 國家戲劇院（重簷廡殿）／國家音樂廳（重簷歇山）----

function buildPavilion(b: Batch, floors: Floor[], o: typeof L.theater, style: 'hip' | 'gable') {
  const { u, v, len, wid, wingV } = o;
  const toward = v > 0 ? -1 : 1; // 面向廣場（主軸）的方向
  const platH = 5;
  const pad = 6;

  // 台基：花崗石、簷口線腳、細緻欄杆（正面留出大台階）
  b.add(M.granite, box(len + pad * 2, platH, wid + pad * 2, u, 0, v));
  b.add(M.marbleShade, box(len + pad * 2 + 0.6, 0.45, wid + pad * 2 + 0.6, u, platH - 0.45, v));
  b.add(M.granite, box(len + pad * 2 + 0.8, 0.6, wid + pad * 2 + 0.8, u, 0, v));
  const e = pad - 0.4;
  const zf = v + toward * (wid / 2 + e);
  const zb = v - toward * (wid / 2 + e);
  const x0 = u - len / 2 - e;
  const x1 = u + len / 2 + e;
  b.add(M.marble, balustradeFine([
    new THREE.Vector2(u + 18.6, zf), new THREE.Vector2(x1, zf), new THREE.Vector2(x1, zb),
    new THREE.Vector2(x0, zb), new THREE.Vector2(x0, zf), new THREE.Vector2(u - 18.6, zf),
  ], platH, 1.1, 2.2));
  floors.push({ kind: 'rect', cx: u, cz: v, hw: len / 2 + pad, hd: wid / 2 + pad, y: platH });
  // 面向廣場的大台階與兩側欄杆
  const steps = 26;
  const tread = 0.36;
  const edge = v + toward * (wid / 2 + pad);
  const sg = stairsFine(36, steps, platH / steps, tread);
  sg.rotateY(toward < 0 ? -Math.PI / 2 : Math.PI / 2);
  sg.translate(u, platH, edge);
  b.add(M.granite, sg);
  const foot = edge + toward * steps * tread;
  for (const s of [-1, 1]) {
    b.add(M.granite, box(1.2, platH, Math.abs(foot - edge), u + s * 18.6, 0, (foot + edge) / 2));
    b.add(M.marble, railAlong([new THREE.Vector3(u + s * 18.6, 0.6, foot), new THREE.Vector3(u + s * 18.6, platH, edge)], 1.0, 1.9));
  }
  floors.push({ kind: 'stairs', axis: 'z', from: foot, to: edge, center: u, halfWidth: 18, y0: 0, y1: platH, steps });

  // 牆體（赭色牆面嵌金色浮雕）與正面玻璃大門
  const colTop = platH + 11;
  b.add(M.panelWall, planarUV(box(len - 12, colTop + 3 - platH, wid - 12, u, platH, v), 4));
  b.add(M.glassDark, box(22, 7.5, 0.3, u, platH, v + toward * ((wid - 12) / 2 + 0.1)));
  b.add(M.gold, box(22.6, 0.3, 0.4, u, platH + 7.5, v + toward * ((wid - 12) / 2 + 0.12)));

  // 紅柱迴廊（柱礎、收分、柱頭）與雀替
  const nu = 14;
  const nv = 7;
  const colAt: [number, number][] = [];
  for (let i = 0; i <= nu; i++) for (const cv of [v - wid / 2, v + wid / 2]) colAt.push([u - len / 2 + (i / nu) * len, cv]);
  for (let j = 1; j < nv; j++) for (const cu of [u - len / 2, u + len / 2]) colAt.push([cu, v - wid / 2 + (j / nv) * wid]);
  const cols: THREE.BufferGeometry[] = [];
  const bases: THREE.BufferGeometry[] = [];
  for (const [cx, cz] of colAt) {
    cols.push(column(0.8, colTop - platH, cx, platH, cz, 20));
    bases.push(cylinder(1.25, 0.45, cx, platH, cz, 20, 1.15));
  }
  b.add(M.red, merge(cols));
  b.add(M.granite, merge(bases));

  // 額枋（紅＋彩畫）與斗拱
  b.add(M.red, box(len + 1.8, 1.0, wid + 1.8, u, colTop, v));
  b.add(M.caihua, planarUV(box(len + 2.0, 1.4, wid + 2.0, u, colTop + 1.0, v), 2.4));
  const ring4 = (hx: number, hz: number) => [new THREE.Vector2(u + hx, v + hz), new THREE.Vector2(u + hx, v - hz), new THREE.Vector2(u - hx, v - hz), new THREE.Vector2(u - hx, v + hz)];
  b.add(M.eaveUnder, dougongBand(ring4(len / 2 + 0.9, wid / 2 + 0.9), colTop + 2.4, 1.7, 0.8, 1.2));

  // 下層簷（重簷的腰簷）
  const yE1 = colTop + 3.3;
  rectRoof(b, { hw: len / 2 + 4.5, hd: wid / 2 + 4.5, height: 9, ridge: (len - wid) / 2 + 4.5, curve: 1.25, cornerLift: 1.2, top: 0.36, steps: 6, perSide: 12 }, {
    tile: M.yellowTile, trim: M.red, ridge: M.yellowTile, at: new THREE.Vector3(u, yE1, v), spacing: 0.9, beasts: true,
  });
  // 重簷間的上層牆（彩畫）與斗拱
  const yW = yE1 + 2;
  b.add(M.red, box(len - 24, 4, wid - 24, u, yW - 1, v));
  b.add(M.caihua, planarUV(box(len - 23.6, 1.3, wid - 23.6, u, yW + 1.6, v), 2.4));
  b.add(M.eaveUnder, dougongBand(ring4(len / 2 - 11.8, wid / 2 - 11.8), yW + 2.4, 1.6, 0.7, 1.0));

  // 上層屋頂（頂高約 38 m）
  const yE2 = yW + 3.4;
  const roofH = 38 - yE2;
  const hw = len / 2 - 5;
  const hd = wid / 2 - 5;
  const gableAt = style === 'gable' ? 0.6 : 1;
  rectRoof(b, { hw, hd, height: roofH, ridge: hw - hd, curve: 1.7, cornerLift: 1.6, gableAt, steps: 14, perSide: 12 }, {
    tile: M.yellowTile, trim: M.red, ridge: M.yellowTile, at: new THREE.Vector3(u, yE2, v), spacing: 0.9, ornaments: true, beasts: true,
  });
  if (style === 'gable') {
    // 歇山頂兩端的山花（紅底金框）
    const ridgeHalf = hw + (Math.max(hw - hd, 0.01) - hw) * gableAt;
    for (const s of [-1, 1]) {
      const h0 = roofH * Math.pow(gableAt, 1.7);
      const tri = new THREE.Shape([new THREE.Vector2(-hd * (1 - gableAt), 0), new THREE.Vector2(hd * (1 - gableAt), 0), new THREE.Vector2(0, roofH - h0)]);
      const g = new THREE.ShapeGeometry(tri);
      g.rotateY(Math.PI / 2);
      g.translate(u + s * (ridgeHalf - 0.3), yE2 + h0, v);
      b.add(M.red, g);
      b.add(M.gold, beamBetween(new THREE.Vector3(u + s * (ridgeHalf - 0.25), yE2 + h0 + 0.1, v - hd * (1 - gableAt)), new THREE.Vector3(u + s * (ridgeHalf - 0.25), yE2 + h0 + 0.1, v + hd * (1 - gableAt)), 0.2, 0.25));
    }
  }

  // 後側翼樓（背向廣場）
  const wl = len * 0.75;
  const ww = 38;
  wall(b, box(wl, 17, ww, u, 0, wingV));
  b.add(M.red, box(wl + 1, 0.9, ww + 1, u, 16.4, wingV));
  b.add(M.caihua, planarUV(box(wl + 1.2, 1.0, ww + 1.2, u, 17.3, wingV), 2.4));
  rectRoof(b, { hw: wl / 2 + 3, hd: ww / 2 + 3, height: 8, ridge: (wl - ww) / 2, curve: 1.5, cornerLift: 1, steps: 8, perSide: 10 }, {
    tile: M.yellowTile, trim: M.red, ridge: M.yellowTile, at: new THREE.Vector3(u, 18.3, wingV), spacing: 0.9, ornaments: true,
  });
}

// ---- 園區大門（大忠門／大孝門）----

function buildGate(b: Batch, u: number, v: number) {
  const w = 34;
  const d = 12;
  for (const du of [-w / 2 + 2, -6.5, 6.5, w / 2 - 2]) wall(b, box(4, 11, d, u + du, 0, v));
  wall(b, box(w, 3.4, d, u, 11, v));
  b.add(M.marbleShade, box(w + 0.6, 0.5, d + 0.6, u, 13.9, v));
  const path = [new THREE.Vector2(u + w / 2 - 0.5, v + d / 2 - 0.4), new THREE.Vector2(u + w / 2 - 0.5, v - d / 2 + 0.4), new THREE.Vector2(u - w / 2 + 0.5, v - d / 2 + 0.4), new THREE.Vector2(u - w / 2 + 0.5, v + d / 2 - 0.4)];
  b.add(M.eaveUnder, box(w - 0.4, 0.9, d - 0.4, u, 14.4, v));
  b.add(M.eaveWhite, dougongBand(path, 14.4, 1.4, 0.6, 0.9));
  rectRoof(b, { hw: w / 2 + 2.5, hd: d / 2 + 2.5, height: 6, ridge: (w - d) / 2, curve: 1.5, cornerLift: 0.9, steps: 8, perSide: 10 }, {
    tile: M.blueTile, trim: M.eaveWhite, ridge: M.blueTrim, at: new THREE.Vector3(u, 15.4, v), spacing: 0.8, ornaments: true, beasts: true,
  });
}

// ---- 圍牆（白牆藍瓦、八角窗）----

function buildWalls(b: Batch) {
  const poly = L.park;
  const openings = [
    ...L.gates.map((g) => ({ u: g.u, v: g.v, r: 19 })),
    { u: -492, v: 0, r: 52 }, // 自由廣場面向中山南路的開口
  ];
  const octOuter = Array.from({ length: 8 }, (_, i) => {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    return new THREE.Vector2(Math.cos(a) * 0.72, Math.sin(a) * 0.72);
  });
  const octInner = octOuter.map((p) => p.clone().multiplyScalar(0.72));
  const copingProfile = new THREE.Shape([new THREE.Vector2(-0.85, 0), new THREE.Vector2(0.85, 0), new THREE.Vector2(0, 0.6)]);
  for (let i = 0; i < poly.length; i++) {
    const [au, av] = poly[i];
    const [bu, bv] = poly[(i + 1) % poly.length];
    const len = Math.hypot(bu - au, bv - av);
    const n = Math.max(1, Math.ceil(len / 8));
    const ang = Math.atan2(-(bv - av), bu - au);
    const nx = -(bv - av) / len;
    const nz = (bu - au) / len;
    for (let k = 0; k < n; k++) {
      const tm = (k + 0.5) / n;
      const mu = au + (bu - au) * tm;
      const mv = av + (bv - av) * tm;
      if (openings.some((o) => Math.hypot(mu - o.u, mv - o.v) < o.r)) continue;
      const segLen = len / n + 0.05;
      const w = new THREE.BoxGeometry(segLen, 3.2, 0.8);
      w.rotateY(ang);
      w.translate(mu, 1.6, mv);
      wall(b, w);
      const coping = new THREE.ExtrudeGeometry(copingProfile, { depth: segLen, bevelEnabled: false });
      coping.translate(0, 0, -segLen / 2);
      coping.rotateY(Math.PI / 2 + ang);
      coping.translate(mu, 3.2, mv);
      b.add(M.blueTile, coping);
      for (const s of [-1, 1]) {
        const nrm = new THREE.Vector3(nx * s, 0, nz * s);
        const pos = new THREE.Vector3(mu + nx * s * 0.4, 1.8, mv + nz * s * 0.4);
        b.add(M.marbleShade, placeOnWall(frameFromOutlines(octOuter, octInner, 0.1), pos.clone(), nrm));
        const glass = new THREE.ShapeGeometry(new THREE.Shape(octInner));
        glass.translate(0, 0, 0.02);
        b.add(M.glassDark, placeOnWall(glass, pos.clone(), nrm));
      }
    }
  }
}

function roads(): P2[][] {
  const poly = L.park;
  // 多邊形方向：面積為正代表 (u, v) 平面上逆時針
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const out: P2[][] = [];
  for (let i = 0; i < poly.length; i++) {
    const [au, av] = poly[i];
    const [bu, bv] = poly[(i + 1) % poly.length];
    const len = Math.hypot(bu - au, bv - av);
    if (len < 30) continue;
    // 向外法線
    let nu = (bv - av) / len;
    let nv = -(bu - au) / len;
    if (area > 0) { nu = -nu; nv = -nv; }
    const w = i === 2 ? 22 : i === 9 ? 44 : 32; // 杭州南路較窄、中山南路較寬
    const ext = 30;
    const du = ((bu - au) / len) * ext;
    const dv = ((bv - av) / len) * ext;
    out.push([
      [au - du + nu * 3, av - dv + nv * 3], [bu + du + nu * 3, bv + dv + nv * 3],
      [bu + du + nu * (3 + w), bv + dv + nv * (3 + w)], [au - du + nu * (3 + w), av - dv + nv * (3 + w)],
    ]);
  }
  return out;
}

// ---------------------------------------------------------------------------

export function buildCKS() {
  const group = new THREE.Group();
  group.name = 'cks';
  group.rotation.y = -ROT;
  const floors: Floor[] = [];
  const P = L.park;

  // 地面（周邊道路另外分組：有 Google 圖磚時用真實道路，不顯示示意道路）
  const ground = new THREE.Group();
  const roadGroup = new THREE.Group();
  for (const r of roads()) roadGroup.add(groundMesh(r, M.road, 0.01));
  group.add(roadGroup);
  ground.add(groundMesh(P, M.grass, 0.02, 40));
  const sq = L.square;
  ground.add(groundMesh(rect(sq.u0, -sq.half, sq.u1, sq.half), M.fanPaving, 0.05, 16));
  // 廣場中央的梅花形石材分割線
  {
    const plum = (r: number): THREE.Vector2[] =>
      Array.from({ length: 120 }, (_, i) => {
        const t = (i / 120) * Math.PI * 2;
        const rr = r * (0.8 + 0.2 * Math.abs(Math.cos(2.5 * t)));
        return new THREE.Vector2(-360 + Math.cos(t) * rr, -Math.sin(t) * rr);
      });
    const shape = new THREE.Shape(plum(27));
    shape.holes.push(new THREE.Path(plum(25.8).reverse()));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.07, 0);
    const m = new THREE.Mesh(g, M.granite);
    m.receiveShadow = true;
    ground.add(m);
  }
  for (const p of [L.theater, L.concert]) {
    const vv = Math.min(Math.abs(p.v) - p.wid / 2 - 16, sq.half) * Math.sign(p.v);
    ground.add(groundMesh(rect(p.u - p.len / 2 - 16, vv, p.u + p.len / 2 + 16, p.wingV + Math.sign(p.v) * 26), M.paving, 0.045, 16));
  }
  const av = L.avenue;
  ground.add(groundMesh(rect(av.u0, -av.half, av.u1, av.half), M.paving, 0.05, 16));
  for (const s of [-1, 1]) ground.add(groundMesh(rect(av.u0, s * L.walks.inner, av.u1, s * L.walks.outer), M.path, 0.04));
  const plaza = HALL.tiers[0].half + 12;
  ground.add(groundMesh(rect(HALL.stairs.front - 10, -plaza, plaza, plaza), M.paving, 0.045, 16));
  for (const g of L.gates) ground.add(groundMesh(rect(g.u - 7, Math.sign(g.v) * plaza, g.u + 7, g.v), M.path, 0.04));
  for (const p of L.ponds) {
    ground.add(groundMesh(blob(p.u, p.v, p.ru + 2.5, p.rv + 2.5, p.seed), M.granite, 0.06));
    ground.add(groundMesh(blob(p.u, p.v, p.ru, p.rv, p.seed), M.water, 0.1));
  }
  group.add(ground);

  // 建築
  const b = new Batch();
  buildHall(b, floors);
  buildArch(b);
  buildPavilion(b, floors, L.theater, 'hip');
  buildPavilion(b, floors, L.concert, 'gable');
  for (const g of L.gates) buildGate(b, g.u, g.v);
  buildWalls(b);
  const buildings = b.build('cks-buildings');
  group.add(buildings);

  // 樹木：民主大道兩側林蔭步道、花園、紀念堂周圍
  const w = L.walks;
  const rows: TreeRow[] = [];
  for (const s of [-1, 1])
    for (const vv of [w.inner - 2, w.outer + 2]) rows.push({ from: [av.u0 + 6, s * vv], to: [av.u1 - 8, s * vv], spacing: 13, height: [7, 10] });
  const pav = (p: typeof L.theater): P2[] =>
    rect(p.u - p.len / 2 - 18, Math.min(p.v - p.wid / 2 - 18, p.wingV - 30), p.u + p.len / 2 + 18, Math.max(p.v + p.wid / 2 + 18, p.wingV + 30));
  const areas: TreeArea[] = [
    { polygon: rect(av.u0 + 4, -180, av.u1, -w.outer - 8), density: 0.0045 },
    { polygon: rect(av.u0 + 4, w.outer + 8, av.u1, 180), density: 0.0045 },
    { polygon: rect(av.u1, -180, 160, -plaza - 6), density: 0.0045 },
    { polygon: rect(av.u1, plaza + 6, 160, 180), density: 0.0045 },
    { polygon: rect(plaza + 6, -plaza - 6, 160, plaza + 6), density: 0.005 },
    { polygon: rect(-560, -180, sq.u1, -sq.half - 6), density: 0.004 },
    { polygon: rect(-560, sq.half + 6, sq.u1, 180), density: 0.004 },
  ];
  const exclude = [
    ...L.ponds.map((p) => blob(p.u, p.v, p.ru + 8, p.rv + 8, p.seed)),
    ...L.gates.map((g) => rect(g.u - 14, g.v - 22, g.u + 14, g.v + 22)),
    ...L.gates.map((g) => rect(g.u - 10, Math.min(g.v, 0), g.u + 10, Math.max(g.v, 0))),
    pav(L.theater),
    pav(L.concert),
  ];
  // 距圍牆 6 m 內不種樹
  const inner = P.map(([pu, pv]) => [pu * 0.985 - 3, pv * 0.965] as P2);
  const trees = buildTrees(areas, rows, exclude, inner);
  group.add(trees);

  // 以下輸出為區域座標（紀念堂中心為原點）
  const W = (u: number, v: number) => siteToLocal(u, v);
  const lab = (text: string, u: number, v: number, minZoom?: number): MapLabel => ({ text, ...W(u, v), minZoom });
  const labels: MapLabel[] = [
    lab('中正紀念堂', 0, -HALL.tiers[0].half - 10),
    lab('自由廣場牌樓', L.arch.u, -L.arch.width / 2 - 12),
    lab('國家戲劇院', L.theater.u, L.theater.v),
    lab('國家音樂廳', L.concert.u, L.concert.v),
    lab('自由廣場', -360, 0, 2.5),
    lab('民主大道', -190, 0, 2),
    ...L.ponds.map((p) => lab(p.name, p.u, p.v, 2.5)),
    ...L.gates.map((g) => lab(g.name, g.u, g.v - Math.sign(g.v) * 18, 2.5)),
  ];

  return { group, buildings, ground, roads: roadGroup, trees, floors, labels, hallTop: new THREE.Vector3(0, HALL.top, 0) };
}

/** 園區邊界（經緯度），用來避免 OSM 建物與手工模型重疊 */
export const CKS_EXCLUSION = L.park.map(([u, v]) => {
  const p = siteToLocal(u, v);
  return offsetLatLon(CKS_ANCHOR, p.x, -p.z);
});

// ---- 快速位置（園區座標定義，輸出為經緯度）----

const AX = SITE_AXIS_BEARING;
const preset = (name: string, u: number, v: number, extra: Omit<Preset, 'name' | 'group' | 'lat' | 'lon'> = {}): Preset => {
  const p = siteToLocal(u, v);
  return { name, group: '中正紀念堂', ...offsetLatLon(CKS_ANCHOR, p.x, -p.z), ...extra };
};

export const CKS_PRESETS: Preset[] = [
  preset('自由廣場牌樓下（望向紀念堂）', -462, 0, { aim: 'cks-hall', state: { focal: 50 } }),
  preset('自由廣場中央', -355, 0, { aim: 'cks-hall', state: { focal: 35 } }),
  preset('民主大道（紀念堂正面）', -180, 0, { aim: 'cks-hall', state: { focal: 24 } }),
  preset('紀念堂台階下', -96, 13, { aim: 'cks-hall', state: { focal: 16 } }),
  preset('紀念堂正門平台（望向牌樓）', -33, 0, { state: { azimuth: AX + 180, pitch: -2, focal: 35 } }),
  preset('紀念堂後方高台（望向台北 101）', 33, 0, { aim: 'taipei101', state: { focal: 200 } }),
  preset('紀念堂東北角高台（101 × 屋簷）', 30, -30, { aim: 'taipei101', state: { focal: 70 } }),
  preset('國家戲劇院前（南側）', -355, 50, { aim: 'cks-hall', state: { focal: 35 } }),
  preset('國家音樂廳前（北側）', -355, -50, { aim: 'cks-hall', state: { focal: 35 } }),
  preset('光華池畔', -230, -96, { aim: 'cks-hall', state: { focal: 50 } }),
  preset('空拍：牌樓外 120 m 高', -600, 0, { height: 120, snap: false, state: { azimuth: AX, pitch: -13, focal: 24 } }),
];
