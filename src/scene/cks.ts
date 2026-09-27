import * as THREE from 'three';
import { Batch, balustrade, box, chineseRoof, cylinder, flat, loft, octagonRoof, polygonRing, stairs } from './geometry';
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
  door: { w: 8, h: 16 },
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
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, curveSegments: 16 });
  g.rotateY(Math.PI / 2);
  return g;
}

function buildHall(b: Batch, floors: Floor[]) {
  const H = HALL;
  const S = H.stairs;
  const gap = S.flightWidth + S.rampWidth / 2 + 0.2;

  // 三層台基與欄杆（西側留台階開口）
  let prevTop = 0;
  for (const t of H.tiers) {
    b.add(t.half === 62 ? M.granite : M.marble, box(t.half * 2, t.top - prevTop, t.half * 2, 0, prevTop, 0));
    b.add(M.marbleShade, box(t.half * 2 + 0.8, 0.8, t.half * 2 + 0.8, 0, t.top - 0.8, 0));
    b.add(M.marble, balustrade(ring(t.half - 0.4, gap), t.top));
    floors.push({ kind: 'rect', cx: 0, cz: 0, hw: t.half, hd: t.half, y: t.top });
    prevTop = t.top;
  }

  // 正面台階：三段，每段 28 級；中央御路；兩側擋牆
  const rise = H.tiers[0].top / S.perFlight;
  const run = S.perFlight * S.tread;
  const flights = [
    { foot: S.front, y0: 0 },
    { foot: -H.tiers[1].half - run, y0: H.tiers[0].top },
    { foot: -H.tiers[2].half - run, y0: H.tiers[1].top },
  ];
  // 第一段上方的平台（台階塊突出第一層台基 23.5 m）
  const landing0 = S.front + run;
  b.add(M.granite, box(-H.tiers[0].half - landing0, H.tiers[0].top, gap * 2, (landing0 - H.tiers[0].half) / 2, 0, 0));
  floors.push({ kind: 'rect', cx: (landing0 - H.tiers[0].half) / 2, cz: 0, hw: (-H.tiers[0].half - landing0) / 2, hd: gap, y: H.tiers[0].top });
  for (const f of flights) {
    const top = f.foot + run;
    const y1 = f.y0 + rise * S.perFlight;
    for (const side of [-1, 1]) {
      const sg = stairs(S.flightWidth, S.perFlight, rise, S.tread);
      sg.translate(top, y1, side * (S.rampWidth / 2 + S.flightWidth / 2));
      b.add(M.granite, sg);
      // 外側擋牆
      const wv = side * (gap - 0.6);
      b.add(M.marble, profile([[f.foot - 0.6, f.y0], [top, f.y0], [top, y1 + 1.1], [f.foot - 0.6, f.y0 + 1.1]], wv - 0.6, wv + 0.6));
    }
    // 御路（雕刻石坡）
    b.add(M.marble, profile([[f.foot, f.y0], [top, f.y0], [top, y1 + 0.25], [f.foot, f.y0 + 0.25]], -S.rampWidth / 2, S.rampWidth / 2));
    b.add(M.marbleShade, profile([[f.foot, f.y0], [top, f.y0], [top, y1 + 0.6], [f.foot, f.y0 + 0.6]], -S.rampWidth / 2 - 0.4, -S.rampWidth / 2 + 0.4));
    b.add(M.marbleShade, profile([[f.foot, f.y0], [top, f.y0], [top, y1 + 0.6], [f.foot, f.y0 + 0.6]], S.rampWidth / 2 - 0.4, S.rampWidth / 2 + 0.4));
    floors.push({ kind: 'stairs', axis: 'x', from: f.foot, to: top, center: 0, halfWidth: gap, y0: f.y0, y1, steps: S.perFlight });
  }

  // 堂身：40 m 見方的牆（可入內），四角 13 m 見方的實心角樓突出至 55 m
  const y0 = H.tiers[2].top;
  const deck = H.wallTop - 1.5;
  const c = H.core;
  const t = H.wallThick;
  b.add(M.marble, box(t, deck - y0, c * 2, c - t / 2, y0, 0)); // 東
  b.add(M.marble, box(c * 2, deck - y0, t, 0, y0, -c + t / 2)); // 北
  b.add(M.marble, box(c * 2, deck - y0, t, 0, y0, c - t / 2)); // 南
  const west = doorWall(c * 2, deck - y0, t, H.door.w, H.door.h);
  west.translate(-c, y0, 0);
  b.add(M.marble, west);
  const cw = H.outer - H.cornerFrom;
  for (const su of [-1, 1])
    for (const sv of [-1, 1]) b.add(M.marble, box(cw, deck - y0, cw, su * (H.cornerFrom + cw / 2), y0, sv * (H.cornerFrom + cw / 2)));
  // 屋面平台與簷口
  b.add(M.marble, box(H.outer * 2, 1.5, H.outer * 2, 0, deck, 0));
  b.add(M.marbleShade, box(H.outer * 2 + 1, 0.9, H.outer * 2 + 1, 0, H.wallTop - 0.9, 0));
  // 銅門（向內開啟）
  for (const side of [-1, 1]) b.add(M.bronze, box(H.door.w / 2, H.door.h - H.door.w / 2, 0.4, -c + t + H.door.w / 4 + 0.2, y0, side * (H.door.w / 2 + 0.4)));
  // 室內：地坪、天花
  b.add(M.granite, flat(rect(-c + t, -c + t, c - t, c - t), y0 + 0.02));
  b.add(M.darkInterior, box(c * 2 - t * 2, 0.3, c * 2 - t * 2, 0, deck - 0.3, 0));
  // 銅像（坐東朝西）：基座 3.5 m、像高 6.3 m
  const sx = c - t - 7;
  b.add(M.granite, box(6.5, 3.5, 8, sx, y0, 0));
  b.add(M.bronze, box(3.6, 3.0, 4.4, sx + 0.3, y0 + 3.5, 0));
  b.add(M.bronze, box(2.3, 2.4, 3.2, sx + 0.8, y0 + 6.5, 0));
  const head = new THREE.SphereGeometry(0.72, 16, 12);
  head.translate(sx + 0.7, y0 + 9.3, 0);
  b.add(M.bronze, head);

  // 斗拱層（藍綠彩繪）
  const oct = (r: number, y: number) => polygonRing(8, r, y, 1, Math.PI / 8);
  const yB = H.wallTop;
  const yE1 = yB + 2.5;
  b.add(M.eaveUnder, loft([oct(H.bracketR, yB), oct(H.bracketR, yE1)], { capTop: false }));
  // 下層簷
  const r1 = octagonRoof({ radius: H.eave1R, height: H.eave1H, apex: H.drumR, curve: 1.35, cornerLift: 1.3, steps: 8 });
  r1.translate(0, yE1, 0);
  b.add(M.blueTile, r1);
  b.add(M.eaveUnder, loft([oct(H.bracketR, yE1 - 0.02), oct(H.eave1R, yE1 - 0.02)]));
  // 簷間八角鼓座
  const yD = yE1 + H.eave1H;
  b.add(M.marble, loft([oct(H.drumR - 0.5, yD - 0.6), oct(H.drumR - 0.5, yD + H.drumH - 1.2)]));
  b.add(M.eaveUnder, loft([oct(H.drumR - 0.3, yD + H.drumH - 1.2), oct(H.drumR - 0.3, yD + H.drumH)]));
  // 上層簷與攢尖
  const yE2 = yD + H.drumH;
  const r2 = octagonRoof({ radius: H.eave2R, height: H.eave2H, apex: 0.9, curve: 1.5, cornerLift: 1.2 });
  r2.translate(0, yE2, 0);
  b.add(M.blueTile, r2);
  b.add(M.eaveUnder, loft([oct(H.drumR - 0.5, yE2 - 0.02), oct(H.eave2R, yE2 - 0.02)]));
  // 垂脊
  const ridge = (r0: number, r1: number, y: number, h: number, curve: number, lift: number, apexT = 1) => {
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + (k * Math.PI) / 4;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) {
        const tt = (i / 10) * apexT;
        const r = r0 + (r1 - r0) * tt;
        pts.push(new THREE.Vector3(Math.cos(a) * r, y + h * Math.pow(tt, curve) + lift * Math.pow(1 - tt, 3) + 0.3, -Math.sin(a) * r));
      }
      b.add(M.blueTrim, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.32, 5));
    }
  };
  ridge(H.eave1R, H.drumR, yE1, H.eave1H, 1.35, 1.3);
  ridge(H.eave2R, 0.9, yE2, H.eave2H, 1.5, 1.2, 0.97);
  // 金色寶頂
  const yTop = yE2 + H.eave2H;
  const fin = H.top - yTop;
  b.add(M.gold, cylinder(1.5, fin * 0.18, 0, yTop - 0.3, 0, 16, 1.2));
  const ball = new THREE.SphereGeometry(fin * 0.26, 20, 14);
  ball.translate(0, yTop + fin * 0.4, 0);
  b.add(M.gold, ball);
  b.add(M.gold, cylinder(fin * 0.13, fin * 0.4, 0, yTop + fin * 0.6, 0, 12, 0.08));
}

// ---- 自由廣場牌樓（五間六柱十一樓）----

function buildArch(b: Batch) {
  const A = L.arch;
  const u = A.u;
  const openings = [9, 12, 15, 12, 9];
  const heights = [12, 15, 19, 15, 12];
  const pierW = (A.width - openings.reduce((s, x) => s + x, 0)) / 6;
  const bodyTop = 22;
  b.add(M.granite, box(A.depth + 5, 0.6, A.width + 5, u, 0, 0));
  let v = -A.width / 2;
  const roofs: { v: number; w: number; y: number; h: number; main: boolean }[] = [];
  for (let i = 0; i < 6; i++) {
    const pv = v + pierW / 2;
    b.add(M.marble, box(A.depth, bodyTop - 0.6, pierW, u, 0.6, pv));
    b.add(M.marbleShade, box(A.depth + 1.4, 1.8, pierW + 1.4, u, 0.6, pv));
    // 柱頂小樓（夾樓）
    const outer = i === 0 || i === 5;
    roofs.push({ v: pv, w: pierW + 3, y: outer ? 18.4 : 19.4, h: 2.6, main: false });
    v += pierW;
    if (i < 5) {
      const w = openings[i];
      const hTop = heights[i];
      b.add(M.marble, box(A.depth - 0.8, bodyTop - hTop, w, u, hTop, v + w / 2));
      b.add(M.blueTrim, box(A.depth - 0.6, 1.2, w, u, hTop, v + w / 2));
      const main = i === 2;
      roofs.push({ v: v + w / 2, w: w + 2, y: main ? 24 : i === 1 || i === 3 ? 22.6 : 21.2, h: main ? 6 : 3.6, main: true });
      v += w;
    }
  }
  b.add(M.marbleShade, box(A.depth + 0.6, 1.2, A.width, u, bodyTop - 1.2, 0));
  // 匾額（正反兩面）
  for (const s of [-1, 1]) b.add(M.blueTrim, box(0.3, 3.2, 10, u + s * (A.depth / 2 + 0.2), 19.2, 0));
  for (const r of roofs) {
    const hw = r.w / 2 + 1.2;
    const hd = A.depth / 2 + (r.main ? 2.2 : 1.4);
    // chineseRoof 的屋脊沿 X；牌樓屋脊沿 v，建好後轉 90°
    const g = chineseRoof({ hw, hd, height: r.h, ridge: Math.max(0.5, hw - hd), curve: 1.5, cornerLift: r.main ? 0.9 : 0.5, steps: 8 });
    g.rotateY(Math.PI / 2);
    g.translate(u, r.y, r.v);
    b.add(M.blueTile, g);
    // 屋頂下的額枋
    b.add(M.marble, box(A.depth - 0.4, r.y - bodyTop + 0.2, r.w - 2, u, bodyTop - 0.2, r.v));
    b.add(M.eaveUnder, box(A.depth + 0.2, 0.8, r.w - 1.5, u, r.y - 0.8, r.v));
  }
}

// ---- 國家戲劇院（重簷廡殿）／國家音樂廳（重簷歇山）----

function buildPavilion(b: Batch, floors: Floor[], o: typeof L.theater, style: 'hip' | 'gable') {
  const { u, v, len, wid, wingV } = o;
  const toward = v > 0 ? -1 : 1; // 面向廣場（主軸）的方向
  const platH = 5;
  const pad = 6;

  // 台基與欄杆
  b.add(M.granite, box(len + pad * 2, platH, wid + pad * 2, u, 0, v));
  const e = pad - 0.4;
  b.add(M.marble, balustrade([
    new THREE.Vector2(u - len / 2 - e, v - wid / 2 - e), new THREE.Vector2(u + len / 2 + e, v - wid / 2 - e),
    new THREE.Vector2(u + len / 2 + e, v + wid / 2 + e), new THREE.Vector2(u - len / 2 - e, v + wid / 2 + e),
    new THREE.Vector2(u - len / 2 - e, v - wid / 2 - e),
  ], platH));
  floors.push({ kind: 'rect', cx: u, cz: v, hw: len / 2 + pad, hd: wid / 2 + pad, y: platH });
  // 面向廣場的台階
  const steps = 26;
  const tread = 0.36;
  const edge = v + toward * (wid / 2 + pad);
  const sg = stairs(36, steps, platH / steps, tread);
  sg.rotateY(toward < 0 ? -Math.PI / 2 : Math.PI / 2);
  sg.translate(u, platH, edge);
  b.add(M.granite, sg);
  floors.push({ kind: 'stairs', axis: 'z', from: edge + toward * steps * tread, to: edge, center: u, halfWidth: 18, y0: 0, y1: platH, steps });

  // 牆體與紅柱迴廊
  const colTop = platH + 11;
  b.add(M.marble, box(len - 12, colTop + 3 - platH, wid - 12, u, platH, v));
  const nu = 14;
  const nv = 7;
  for (let i = 0; i <= nu; i++) {
    const cu = u - len / 2 + (i / nu) * len;
    for (const cv of [v - wid / 2, v + wid / 2]) b.add(M.red, cylinder(0.8, colTop - platH, cu, platH, cv, 12));
  }
  for (let j = 1; j < nv; j++) {
    const cv = v - wid / 2 + (j / nv) * wid;
    for (const cu of [u - len / 2, u + len / 2]) b.add(M.red, cylinder(0.8, colTop - platH, cu, platH, cv, 12));
  }
  b.add(M.red, box(len + 1.8, 1.8, wid + 1.8, u, colTop, v));
  b.add(M.eaveUnder, box(len + 1, 1.2, wid + 1, u, colTop + 1.8, v));

  // 下層簷（重簷的腰簷）
  const yE1 = colTop + 3;
  const lower = chineseRoof({ hw: len / 2 + 4.5, hd: wid / 2 + 4.5, height: 9, ridge: (len - wid) / 2 + 4.5, curve: 1.25, cornerLift: 1.2, top: 0.36, steps: 6 });
  lower.translate(u, yE1, v);
  b.add(M.yellowTile, lower);
  // 重簷間的上層牆
  const yW = yE1 + 2;
  b.add(M.red, box(len - 24, 4, wid - 24, u, yW - 1, v));
  b.add(M.eaveUnder, box(len - 23, 1.1, wid - 23, u, yW + 2.4, v));
  // 上層屋頂（頂高約 38 m）
  const yE2 = yW + 3.4;
  const roofH = 38 - yE2;
  const hw = len / 2 - 5;
  const hd = wid / 2 - 5;
  const gableAt = style === 'gable' ? 0.6 : 1;
  const upper = chineseRoof({ hw, hd, height: roofH, ridge: hw - hd, curve: 1.7, cornerLift: 1.6, gableAt, steps: 14 });
  upper.translate(u, yE2, v);
  b.add(M.yellowTile, upper);
  const ridgeHalf = hw + (Math.max(hw - hd, 0.01) - hw) * gableAt;
  b.add(M.yellowTile, box(ridgeHalf * 2 + 1, 1.6, 1.4, u, yE2 + roofH - 0.4, v));
  if (style === 'gable') {
    // 歇山頂兩端的山花（三角牆）
    for (const s of [-1, 1]) {
      const tri = new THREE.Shape([new THREE.Vector2(-hd * (1 - gableAt), 0), new THREE.Vector2(hd * (1 - gableAt), 0), new THREE.Vector2(0, roofH * (1 - Math.pow(gableAt, 1.7)))]);
      const g = new THREE.ShapeGeometry(tri);
      g.rotateY(Math.PI / 2);
      g.translate(u + s * (ridgeHalf - 0.3), yE2 + roofH * Math.pow(gableAt, 1.7), v);
      b.add(M.red, g);
    }
  }

  // 後側翼樓（背向廣場）
  const wl = len * 0.75;
  const ww = 38;
  b.add(M.marble, box(wl, 17, ww, u, 0, wingV));
  b.add(M.red, box(wl + 1, 1.6, ww + 1, u, 17, wingV));
  const wr = chineseRoof({ hw: wl / 2 + 3, hd: ww / 2 + 3, height: 8, ridge: (wl - ww) / 2, curve: 1.5, cornerLift: 1, steps: 8 });
  wr.translate(u, 18.6, wingV);
  b.add(M.yellowTile, wr);
}

// ---- 園區大門（大忠門／大孝門）----

function buildGate(b: Batch, u: number, v: number) {
  const w = 34;
  const d = 12;
  for (const du of [-w / 2 + 2, -6.5, 6.5, w / 2 - 2]) b.add(M.marble, box(4, 11, d, u + du, 0, v));
  b.add(M.marble, box(w, 3.4, d, u, 11, v));
  b.add(M.eaveUnder, box(w + 1, 0.8, d + 1, u, 14.4, v));
  const roof = chineseRoof({ hw: w / 2 + 2.5, hd: d / 2 + 2.5, height: 6, ridge: (w - d) / 2, curve: 1.5, cornerLift: 0.9, steps: 8 });
  roof.translate(u, 15.2, v);
  b.add(M.blueTile, roof);
}

// ---- 圍牆（白牆藍瓦）與周邊道路 ----

function buildWalls(b: Batch) {
  const poly = L.park;
  const openings = [
    ...L.gates.map((g) => ({ u: g.u, v: g.v, r: 19 })),
    { u: -492, v: 0, r: 52 }, // 自由廣場面向中山南路的開口
  ];
  for (let i = 0; i < poly.length; i++) {
    const [au, av] = poly[i];
    const [bu, bv] = poly[(i + 1) % poly.length];
    const len = Math.hypot(bu - au, bv - av);
    const n = Math.max(1, Math.ceil(len / 8));
    const ang = Math.atan2(-(bv - av), bu - au);
    for (let k = 0; k < n; k++) {
      const tm = (k + 0.5) / n;
      const mu = au + (bu - au) * tm;
      const mv = av + (bv - av) * tm;
      if (openings.some((o) => Math.hypot(mu - o.u, mv - o.v) < o.r)) continue;
      const segLen = len / n + 0.05;
      const wall = new THREE.BoxGeometry(segLen, 3.2, 0.8);
      wall.rotateY(ang);
      wall.translate(mu, 1.6, mv);
      b.add(M.marble, wall);
      const cap = new THREE.BoxGeometry(segLen, 0.5, 1.6);
      cap.rotateY(ang);
      cap.translate(mu, 3.45, mv);
      b.add(M.blueTile, cap);
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

  // 地面
  const ground = new THREE.Group();
  for (const r of roads()) ground.add(groundMesh(r, M.road, 0.01));
  ground.add(groundMesh(P, M.grass, 0.02, 40));
  const sq = L.square;
  ground.add(groundMesh(rect(sq.u0, -sq.half, sq.u1, sq.half), M.paving, 0.05, 16));
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

  return { group, buildings, trees, floors, labels, hallTop: new THREE.Vector3(0, HALL.top, 0) };
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
