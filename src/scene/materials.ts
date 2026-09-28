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

/** 大理石砌塊（牆面石材分縫）：貼圖涵蓋 4 m × 4 m，塊材 1 m × 0.5 m 錯縫 */
const marbleBlockTex = canvasTexture(512, (ctx, s) => {
  ctx.fillStyle = '#f4f2ec';
  ctx.fillRect(0, 0, s, s);
  const rows = 8;
  const cols = 4;
  const rh = s / rows;
  const cw = s / cols;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? cw / 2 : 0;
    for (let c = -1; c <= cols; c++) {
      const v = 236 + Math.floor(Math.random() * 14);
      ctx.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
      ctx.fillRect(c * cw + off + 1.5, r * rh + 1.5, cw - 3, rh - 3);
    }
  }
});

/** 清水模板混凝土：垂直模板紋＋細微斑駁 */
const concreteTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#e6e6e2';
  ctx.fillRect(0, 0, s, s);
  for (let x = 0; x < s; x += s / 16) {
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(x, 0, 1.5, s);
  }
  for (let i = 0; i < 1600; i++) {
    const v = Math.random();
    ctx.fillStyle = v > 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)';
    ctx.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 4, 2 + Math.random() * 8);
  }
});

/** 哈爾格林姆廣場鋪面：深淺石材的鋸齒紋 */
const meanderTex = canvasTexture(512, (ctx, s) => {
  ctx.fillStyle = '#6f6f6c';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#cfcfca';
  ctx.lineWidth = s / 28;
  for (let row = -1; row < 5; row++) {
    ctx.beginPath();
    const y0 = row * (s / 4);
    for (let i = 0; i <= 8; i++) ctx.lineTo((i * s) / 8, y0 + (i % 2 ? s / 8 : 0));
    ctx.stroke();
  }
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`;
    ctx.fillRect(Math.random() * s, Math.random() * s, 3, 3);
  }
});

/** 彩畫（樑枋上的藍綠彩繪與金色線條） */
const caihuaTex = canvasTexture(512, (ctx, s) => {
  ctx.fillStyle = '#1f5a63';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#2f7f6f';
  ctx.fillRect(0, s * 0.12, s, s * 0.76);
  ctx.strokeStyle = '#e2b84c';
  ctx.lineWidth = 6;
  ctx.strokeRect(s * 0.25, s * 0.18, s * 0.5, s * 0.64);
  ctx.beginPath();
  ctx.ellipse(s * 0.5, s * 0.5, s * 0.16, s * 0.24, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#244f9a';
  ctx.fillRect(0, s * 0.18, s * 0.22, s * 0.64);
  ctx.fillRect(s * 0.78, s * 0.18, s * 0.22, s * 0.64);
  ctx.fillStyle = '#e2b84c';
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.arc(s * 0.11, s * (0.26 + i * 0.1), 7, 0, Math.PI * 2);
    ctx.arc(s * 0.89, s * (0.26 + i * 0.1), 7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#b3342b';
  ctx.fillRect(0, 0, s, s * 0.05);
  ctx.fillRect(0, s * 0.95, s, s * 0.05);
});

/** 戲劇院、音樂廳的牆面：赭色牆面嵌金色方形浮雕 */
const panelWallTex = canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = '#8b6a4f';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#c9a24a';
  ctx.fillRect(s * 0.25, s * 0.3, s * 0.5, s * 0.4);
  ctx.strokeStyle = '#7a5a2a';
  ctx.lineWidth = 4;
  ctx.strokeRect(s * 0.3, s * 0.35, s * 0.4, s * 0.3);
});

/** 國徽（白日：十二道光芒）浮雕，用在紀念堂正面御路 */
export const emblemTex = canvasTexture(512, (ctx, s) => {
  ctx.fillStyle = '#efece5';
  ctx.fillRect(0, 0, s, s);
  const c = s / 2;
  ctx.fillStyle = '#d9d5cc';
  ctx.beginPath();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 ? s * 0.28 : s * 0.46;
    ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#bdb8ad';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = '#efece5';
  ctx.beginPath();
  ctx.arc(c, c, s * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c, c, s * 0.235, 0, Math.PI * 2);
  ctx.stroke();
});

/** 自由廣場鋪面：扇形同心弧紋（每格 8 m） */
const fanPavingTex = canvasTexture(512, (ctx, s) => {
  ctx.fillStyle = '#b9b5ad';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#8f8b83';
  ctx.lineWidth = 3;
  const cell = s / 2;
  for (let gy = 0; gy < 3; gy++)
    for (let gx = 0; gx < 3; gx++) {
      const cx = gx * cell;
      const cy = gy * cell;
      for (let r = cell * 0.12; r <= cell; r += cell * 0.12) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI / 2);
        ctx.stroke();
      }
    }
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.12})`;
    ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
  }
});

/** 鞦韆下的橡膠植草墊 */
const rubberTex = canvasTexture(128, (ctx, s) => {
  ctx.fillStyle = '#4b5a3a';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#1b1b1b';
  const n = 8;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) ctx.fillRect((i * s) / n + 3, (j * s) / n + 3, s / n - 6, s / n - 6);
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
  ornament101: std({ color: 0x3e4a46, roughness: 0.4, metalness: 0.7 }),

  // 精細模型用（UV 以公尺為單位，由 planarUV 產生）
  marbleWall: std({ color: 0xffffff, roughness: 0.6, map: marbleBlockTex }),
  caihua: std({ color: 0xffffff, roughness: 0.6, map: caihuaTex }),
  panelWall: std({ color: 0xffffff, roughness: 0.75, map: panelWallTex }),
  emblem: std({ color: 0xffffff, roughness: 0.6, map: emblemTex }),
  fanPaving: std({ color: 0xffffff, roughness: 0.85, map: fanPavingTex }),
  eaveWhite: std({ color: 0xf3f1ea, roughness: 0.5 }),
  finial: std({ color: 0xd9822b, roughness: 0.35, metalness: 0.45 }),
  plaque: std({ color: 0xffffff, roughness: 0.4 }),

  concrete: std({ color: 0xd8d8d3, roughness: 0.88, map: concreteTex }),
  concreteGlow: std({ color: 0xd2d2cd, roughness: 0.88, map: concreteTex }),
  darkRoof: std({ color: 0x3a3b37, roughness: 0.55, metalness: 0.35, side: THREE.DoubleSide }),
  glassDark: std({ color: 0x1e262d, roughness: 0.15, metalness: 0.4 }),
  whiteTrim: std({ color: 0xf2f2ee, roughness: 0.6 }),
  basalt: std({ color: 0x3b3c3e, roughness: 0.92 }),
  redGranite: std({ color: 0x8c4f43, roughness: 0.7 }),
  anthracite: std({ color: 0x3b3e42, roughness: 0.5, metalness: 0.55 }),
  rubber: std({ color: 0x1a1a1a, roughness: 0.95 }),
  rubberMat: std({ color: 0xffffff, roughness: 0.95, map: rubberTex }),
  plaza: std({ color: 0xffffff, roughness: 0.9, map: meanderTex }),
  clockFace: std({ color: 0x23272b, roughness: 0.4, metalness: 0.3 }),
  churchRed: std({ color: 0xb3261e, roughness: 0.3, emissive: 0x000000 }),
};

/** 夜間會打燈／發光的材質：環境模組依「夜晚程度」調整 emissiveIntensity */
export const NIGHT_GLOW: { material: THREE.MeshStandardMaterial; color: number; intensity: number }[] = [
  { material: M.marble, color: 0xfff1d6, intensity: 0.22 },
  { material: M.marbleShade, color: 0xffe8c4, intensity: 0.16 },
  { material: M.blueTile, color: 0x3b6fd8, intensity: 0.12 },
  { material: M.yellowTile, color: 0xffb54a, intensity: 0.18 },
  { material: M.red, color: 0xff5a3c, intensity: 0.14 },
  { material: M.gold, color: 0xffd27a, intensity: 0.3 },
  { material: M.marbleWall, color: 0xfff1d6, intensity: 0.22 },
  { material: M.eaveWhite, color: 0xfff1d6, intensity: 0.2 },
  { material: M.caihua, color: 0xffe0b0, intensity: 0.12 },
  { material: M.finial, color: 0xffb060, intensity: 0.35 },
  // 哈爾格林姆教堂：夜間投光（塔尖打燈較亮）、窗內透出燈光
  { material: M.concrete, color: 0xfff4e4, intensity: 0.12 },
  { material: M.concreteGlow, color: 0xfff1dc, intensity: 0.6 },
  { material: M.glassDark, color: 0xffcf8a, intensity: 0.35 },
];

/** 台北 101 夜間燈光（顏色依星期幾由環境模組設定） */
export const TOWER_GLOW = { material: M.glass101, color: 0xfff2dc, intensity: 1.1 };
NIGHT_GLOW.push(TOWER_GLOW);
