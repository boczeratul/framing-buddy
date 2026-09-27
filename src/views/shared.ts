import * as THREE from 'three';
import type { Environment } from '../scene/environment';

// 兩個視圖（取景器、地圖）各有自己的 WebGLRenderer；
// 環境貼圖（PMREM）屬於各自的 GL context，不能共用，因此每個視圖各自產生。

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,
    preserveDrawingBuffer: true, // 匯出 PNG 需要
  });
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  return r;
}

export class EnvMapCache {
  private pmrem: THREE.PMREMGenerator;
  private target: THREE.WebGLRenderTarget | null = null;
  private version = -1;

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  /** 天空變動時重建環境貼圖，回傳目前可用的貼圖 */
  get(env: Environment): THREE.Texture | null {
    if (this.version !== env.envVersion) {
      this.version = env.envVersion;
      const old = this.target;
      this.target = this.pmrem.fromScene(env.envScene, 0, 0.1, 1000);
      old?.dispose();
    }
    return this.target?.texture ?? null;
  }
}

/** 在 2D canvas 上畫帶底色的標籤 */
export function drawTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: { color?: string; bg?: string; align?: 'left' | 'center' | 'right'; font?: string } = {},
) {
  const { color = '#fff', bg = 'rgba(0,0,0,0.55)', align = 'center', font = '600 12px system-ui, sans-serif' } = opts;
  ctx.font = font;
  const w = ctx.measureText(text).width + 12;
  const h = 20;
  const left = align === 'center' ? x - w / 2 : align === 'left' ? x : x - w;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, y - h / 2, w, h, 4);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 6, y + 0.5);
}

export function fitCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
