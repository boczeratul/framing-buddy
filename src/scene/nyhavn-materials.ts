import * as THREE from 'three';
import { canvasTexture, NIGHT_GLOW } from './materials';

// 新港專用材質：灰泥立面（色票依照片取色）、磚、鵝卵石碼頭、花崗岩駁岸、陶瓦／黑釉瓦屋頂、遮陽篷布、木船。
// 貼圖皆為 canvas 程序化產生；UV 以公尺為單位（planarUV 或手動計算）。

let seed = 7;
/** 固定亂數（每次產生的貼圖相同，匯出的 GLB 才穩定） */
function rnd(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

/** 灰泥：淺色底＋斑駁（實際顏色由材質 color 決定），貼圖涵蓋 4 m */
const plasterTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 2200; i++) {
    const v = rnd();
    ctx.fillStyle = v > 0.5 ? `rgba(0,0,0,${0.01 + rnd() * 0.02})` : `rgba(255,255,255,${0.02 + rnd() * 0.03})`;
    const r = 2 + rnd() * 7;
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 底部雨水痕
  const g = ctx.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.03)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});

/** 紅磚（丹麥磚 22.8 × 5.5 cm，一順一丁），貼圖涵蓋 2 m */
const brickTex = canvasTexture(512, (ctx, s) => {
  ctx.fillStyle = '#c9c1b3';
  ctx.fillRect(0, 0, s, s);
  const rows = 30;
  const rh = s / rows;
  for (let r = 0; r < rows; r++) {
    const header = r % 2 === 1;
    const bw = header ? s / 17.5 : s / 8.75;
    const off = header ? bw / 2 : 0;
    for (let x = -off; x < s; x += bw) {
      const v = 0.8 + rnd() * 0.35;
      ctx.fillStyle = `rgb(${Math.floor(168 * v)},${Math.floor(78 * v)},${Math.floor(58 * v)})`;
      ctx.fillRect(x + 1, r * rh + 1, bw - 2, rh - 2);
    }
  }
});

/** 鵝卵石（方形石塊鋪面），貼圖涵蓋 3 m */
const cobbleTex = canvasTexture(512, (ctx, s) => {
  ctx.fillStyle = '#5d5a55';
  ctx.fillRect(0, 0, s, s);
  const n = 24;
  const c = s / n;
  for (let j = 0; j < n; j++) {
    const off = (j % 2) * c * 0.5;
    for (let i = -1; i <= n; i++) {
      const v = 120 + Math.floor(rnd() * 60);
      const warm = rnd() * 12;
      ctx.fillStyle = `rgb(${v + warm},${v + warm / 2},${v - 4})`;
      const w = c * (0.78 + rnd() * 0.12);
      ctx.beginPath();
      ctx.roundRect(i * c + off + (c - w) / 2, j * c + c * 0.1, w, c * 0.8, c * 0.18);
      ctx.fill();
    }
  }
});

/** 駁岸花崗岩砌塊：1.2 m × 0.5 m 錯縫，貼圖涵蓋 4 m */
const quayStoneTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#34322f';
  ctx.fillRect(0, 0, s, s);
  const rows = 8;
  const rh = s / rows;
  const cw = s / 3.33;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * cw * 0.5;
    for (let x = -off; x < s; x += cw) {
      const v = 70 + Math.floor(rnd() * 40);
      ctx.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
      ctx.fillRect(x + 1.5, r * rh + 1.5, cw - 3, rh - 3);
    }
  }
});

/** 屋瓦：u 沿屋脊、v 沿坡面；每列 0.33 m、每片 0.25 m，貼圖涵蓋 2 m × 2 m */
const roofTileTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, s, s);
  const rows = 6;
  const cols = 8;
  const rh = s / rows;
  const cw = s / cols;
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < cols; i++) {
      const g = ctx.createLinearGradient(i * cw, 0, (i + 1) * cw, 0);
      const v = 0.86 + rnd() * 0.14;
      const hi = Math.floor(250 * v);
      const lo = Math.floor(165 * v);
      g.addColorStop(0, `rgb(${lo},${lo},${lo})`);
      g.addColorStop(0.45, `rgb(${hi},${hi},${hi})`);
      g.addColorStop(1, `rgb(${lo},${lo},${lo})`);
      ctx.fillStyle = g;
      ctx.fillRect(i * cw, r * rh, cw, rh);
    }
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (let r = 0; r < rows; r++) ctx.fillRect(0, r * rh, s, 3);
});

/** 條紋遮陽篷（直條紋 0.25 m），貼圖涵蓋 1 m */
function stripeTex(a: string, b: string) {
  return canvasTexture(64, (ctx, s) => {
    ctx.fillStyle = a;
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = b;
    ctx.fillRect(0, 0, s / 4, s);
    ctx.fillRect(s / 2, 0, s / 4, s);
  });
}

/** 甲板木條：寬 0.12 m，貼圖涵蓋 2 m */
const deckTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#6d5a44';
  ctx.fillRect(0, 0, s, s);
  const n = 16;
  for (let i = 0; i < n; i++) {
    const v = 150 + Math.floor(rnd() * 40);
    ctx.fillStyle = `rgb(${v},${Math.floor(v * 0.82)},${Math.floor(v * 0.6)})`;
    ctx.fillRect(0, (i * s) / n + 1, s, s / n - 2);
  }
});

const std = (name: string, p: THREE.MeshStandardMaterialParameters) => {
  const m = new THREE.MeshStandardMaterial(p);
  m.name = name;
  return m;
};

const plaster = (name: string, color: number) => std(name, { color, roughness: 0.88, map: plasterTex });

/** 立面色票（依攝影作品與街景取色） */
export const FACADE = {
  ochre: plaster('nyOchre', 0xd6a13f),
  yellow: plaster('nyYellow', 0xe9c357),
  paleYellow: plaster('nyPaleYellow', 0xecd89b),
  orange: plaster('nyOrange', 0xd8773a),
  terracotta: plaster('nyTerracotta', 0xb95a3c),
  red: plaster('nyRed', 0xa53a2e),
  oxblood: plaster('nyOxblood', 0x7c2c26),
  pink: plaster('nyPink', 0xdba69b),
  blue: plaster('nyBlue', 0x5a86ad),
  lightBlue: plaster('nyLightBlue', 0xa6c3d6),
  green: plaster('nyGreen', 0x86a07e),
  white: plaster('nyWhite', 0xefebe2),
  cream: plaster('nyCream', 0xe7dcc2),
  grey: plaster('nyGrey', 0xaeaca5),
  paleBlue: plaster('nyPaleBlue', 0xd3dde2),
  blueGrey: plaster('nyBlueGrey', 0x98afbf),
  paleGreen: plaster('nyPaleGreen', 0xb5caab),
  paleRed: plaster('nyPaleRed', 0xc97b6b),
  salmon: plaster('nySalmon', 0xe0ae98),
  sand: plaster('nySand', 0xcdc2ab),
  brown: plaster('nyBrown', 0x80604a),
  brick: std('nyBrick', { color: 0xffffff, roughness: 0.9, map: brickTex }),
};
export type FacadeColor = keyof typeof FACADE;

export const NY = {
  plinth: std('nyPlinth', { color: 0x4b4945, roughness: 0.85, map: plasterTex }),
  trim: std('nyTrim', { color: 0xf1efe8, roughness: 0.6 }),
  sandstone: std('nySandstone', { color: 0xc9b99a, roughness: 0.8, map: plasterTex }),
  door: std('nyDoor', { color: 0x2f3b33, roughness: 0.55 }),
  doorBrown: std('nyDoorBrown', { color: 0x4a3223, roughness: 0.55 }),
  roofRed: std('nyRoofRed', { color: 0xb65a3e, roughness: 0.75, map: roofTileTex, side: THREE.DoubleSide }),
  roofBlack: std('nyRoofBlack', { color: 0x3a3a3d, roughness: 0.32, metalness: 0.1, map: roofTileTex, side: THREE.DoubleSide }),
  roofSlate: std('nyRoofSlate', { color: 0x5b6168, roughness: 0.6, map: roofTileTex, side: THREE.DoubleSide }),
  roofCopper: std('nyRoofCopper', { color: 0x6f9c89, roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide }),
  roofFlat: std('nyRoofFlat', { color: 0x4a4948, roughness: 0.9 }),
  chimney: std('nyChimney', { color: 0xffffff, roughness: 0.9, map: brickTex }),
  cobble: std('nyCobble', { color: 0xffffff, roughness: 0.9, map: cobbleTex }),
  quayStone: std('nyQuayStone', { color: 0xffffff, roughness: 0.85, map: quayStoneTex }),
  coping: std('nyCoping', { color: 0x9e9a92, roughness: 0.8, map: plasterTex }),
  iron: std('nyIron', { color: 0x1d1f20, roughness: 0.5, metalness: 0.6 }),
  lampGlass: std('nyLampGlass', { color: 0xf3ead2, roughness: 0.2, emissive: 0x000000 }),
  awningRed: std('nyAwningRed', { color: 0xffffff, roughness: 0.85, map: stripeTex('#f1ece0', '#a8262a'), side: THREE.DoubleSide }),
  awningGreen: std('nyAwningGreen', { color: 0xffffff, roughness: 0.85, map: stripeTex('#f1ece0', '#2f5b3f'), side: THREE.DoubleSide }),
  awningBlue: std('nyAwningBlue', { color: 0xffffff, roughness: 0.85, map: stripeTex('#f1ece0', '#2a4a78'), side: THREE.DoubleSide }),
  canvas: std('nyCanvas', { color: 0xe9e2cf, roughness: 0.85, side: THREE.DoubleSide }),
  furniture: std('nyFurniture', { color: 0x2a2826, roughness: 0.6, metalness: 0.3 }),
  tableTop: std('nyTableTop', { color: 0x8a6a4a, roughness: 0.7 }),
  // 木船
  hullBlack: std('nyHullBlack', { color: 0x1c1d1f, roughness: 0.45 }),
  hullWhite: std('nyHullWhite', { color: 0xe9e7e0, roughness: 0.45 }),
  hullGreen: std('nyHullGreen', { color: 0x1f4a3a, roughness: 0.45 }),
  hullBlue: std('nyHullBlue', { color: 0x1f3552, roughness: 0.45 }),
  hullRed: std('nyHullRed', { color: 0xb3261e, roughness: 0.45 }),
  hullTar: std('nyHullTar', { color: 0x3b2c21, roughness: 0.6 }),
  deck: std('nyDeck', { color: 0xffffff, roughness: 0.8, map: deckTex }),
  mast: std('nyMast', { color: 0xb88a4e, roughness: 0.5 }),
  sail: std('nySail', { color: 0xd9ccb0, roughness: 0.9 }),
  rope: std('nyRope', { color: 0x3a342c, roughness: 0.9 }),
};

// 夜間：碼頭路燈亮起
NIGHT_GLOW.push({ material: NY.lampGlass, color: 0xffd79a, intensity: 3.5 });
