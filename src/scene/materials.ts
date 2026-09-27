import * as THREE from 'three';

// 共用材質與程序化貼圖（canvas 產生，不需外部素材）

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 琉璃瓦：u 方向為瓦壟、v 方向為瓦列 */
const tileTex = canvasTexture(128, (ctx, s) => {
  const g = ctx.createLinearGradient(0, 0, s, 0);
  g.addColorStop(0, '#6d6d6d');
  g.addColorStop(0.18, '#f4f4f4');
  g.addColorStop(0.5, '#ffffff');
  g.addColorStop(0.82, '#d8d8d8');
  g.addColorStop(1, '#5a5a5a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = 0; y < s; y += s / 4) ctx.fillRect(0, y, s, 3);
});

/** 石材鋪面 */
const pavingTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#c9c4ba';
  ctx.fillRect(0, 0, s, s);
  const n = 16;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const v = 212 + Math.floor(Math.random() * 14);
      ctx.fillStyle = `rgb(${v},${v - 3},${v - 9})`;
      ctx.fillRect((i * s) / n + 0.5, (j * s) / n + 0.5, s / n - 1, s / n - 1);
    }
});

/** 草地雜訊 */
const grassTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#6f8f4e';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 5000; i++) {
    const v = Math.random();
    ctx.fillStyle = v > 0.5 ? 'rgba(40,70,25,0.18)' : 'rgba(150,180,100,0.14)';
    ctx.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
});

/** 城市地面（園區外） */
const urbanTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#8d8c88';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 3000; i++) {
    const v = 110 + Math.random() * 60;
    ctx.fillStyle = `rgba(${v},${v},${v - 4},0.25)`;
    ctx.fillRect(Math.random() * s, Math.random() * s, 3, 3);
  }
});

/** 台北 101 帷幕窗格：一格 = 一層樓 × 一柱距 */
const windowTex = canvasTexture(128, (ctx, s) => {
  ctx.fillStyle = '#9fb4ae';
  ctx.fillRect(0, 0, s, s);
  const g = ctx.createLinearGradient(0, 0, 0, s);
  g.addColorStop(0, '#d0ddd8');
  g.addColorStop(1, '#8aa39c');
  ctx.fillStyle = g;
  ctx.fillRect(6, 10, s - 12, s - 20);
  ctx.fillStyle = '#56645f';
  ctx.fillRect(0, 0, s, 8);
  ctx.fillRect(0, 0, 4, s);
  ctx.fillRect(s - 4, 0, 4, s);
});

/** 夜間窗燈（emissive），隨機亮暗 */
export const windowLightTex = canvasTexture(512, (ctx, s) => {
  // 底色＝帷幕外打燈的整體光暈，亮格＝室內燈
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(0, 0, s, s);
  const n = 16;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const r = Math.random();
      if (r < 0.55) continue;
      const v = r > 0.9 ? 230 : 110 + Math.floor(r * 70);
      ctx.fillStyle = `rgb(${v},${Math.floor(v * 0.94)},${Math.floor(v * 0.82)})`;
      ctx.fillRect((i * s) / n + 3, (j * s) / n + 4, s / n - 6, s / n - 7);
    }
});

const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);

export const M = {
  marble: std({ color: 0xf1eee7, roughness: 0.62 }),
  marbleShade: std({ color: 0xdcd8cf, roughness: 0.7 }),
  granite: std({ color: 0xa9a49a, roughness: 0.8 }),
  blueTile: std({ color: 0x2a5bb8, roughness: 0.32, metalness: 0.08, map: tileTex, side: THREE.DoubleSide }),
  blueTrim: std({ color: 0x1d3f86, roughness: 0.4 }),
  yellowTile: std({ color: 0xe8a93a, roughness: 0.34, metalness: 0.08, map: tileTex, side: THREE.DoubleSide }),
  greenTile: std({ color: 0x3f7a4f, roughness: 0.36, map: tileTex, side: THREE.DoubleSide }),
  gold: std({ color: 0xd8ae4a, roughness: 0.28, metalness: 0.9 }),
  red: std({ color: 0xa3302a, roughness: 0.55 }),
  eaveUnder: std({ color: 0x2c5a6e, roughness: 0.7 }),
  bronze: std({ color: 0x4b3a26, roughness: 0.45, metalness: 0.7 }),
  darkInterior: std({ color: 0x3b3833, roughness: 0.9 }),
  paving: std({ color: 0xa8a39a, roughness: 0.85, map: pavingTex }),
  path: std({ color: 0x9c9384, roughness: 0.9 }),
  grass: std({ color: 0xffffff, roughness: 0.95, map: grassTex }),
  urban: std({ color: 0xffffff, roughness: 0.95, map: urbanTex }),
  road: std({ color: 0x55565a, roughness: 0.9 }),
  water: std({ color: 0x2f5358, roughness: 0.08, metalness: 0.35 }),
  trunk: std({ color: 0x3e3128, roughness: 0.95 }),
  foliage: std({ color: 0x4f7a3c, roughness: 0.92, flatShading: true }),
  glass101: std({ color: 0x7fa39c, roughness: 0.18, metalness: 0.55, map: windowTex, emissiveMap: windowLightTex, emissive: 0x000000 }),
  frame101: std({ color: 0x5b6f6a, roughness: 0.45, metalness: 0.5 }),
  steel: std({ color: 0xa8b0b3, roughness: 0.35, metalness: 0.8 }),
};

/** 夜間會打燈／發光的材質：環境模組依「夜晚程度」調整 emissiveIntensity */
export const NIGHT_GLOW: { material: THREE.MeshStandardMaterial; color: number; intensity: number }[] = [
  { material: M.marble, color: 0xfff1d6, intensity: 0.22 },
  { material: M.marbleShade, color: 0xffe8c4, intensity: 0.16 },
  { material: M.blueTile, color: 0x3b6fd8, intensity: 0.12 },
  { material: M.yellowTile, color: 0xffb54a, intensity: 0.18 },
  { material: M.red, color: 0xff5a3c, intensity: 0.14 },
  { material: M.gold, color: 0xffd27a, intensity: 0.3 },
];

/** 台北 101 夜間燈光（顏色依星期幾由環境模組設定） */
export const TOWER_GLOW = { material: M.glass101, color: 0xfff2dc, intensity: 1.1 };
NIGHT_GLOW.push(TOWER_GLOW);
