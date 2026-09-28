import * as THREE from 'three';

// 多重測光（偏重中央）：模擬 Sony「多重測光 Multi」的行為。
// 先把畫面以線性 HDR 渲染成 48×32 的小圖（每個像素＝一個測光區，共 1536 區），再：
// - 以高斯權重偏重畫面中央（周邊仍保有基礎權重，不是單純的中央重點）；
// - 畫面上半部明顯比中位數亮的區域（天空）降低權重，避免逆光時主體過暗；
// - 周邊的極亮區（太陽、反光）亮度截頂在中位數的 8 倍，不讓少數高光把整張壓暗；
//   中央區域則保留到 64 倍，被打亮的主體（例如夜間投光的建築）才不會過曝；
// - 以加權對數平均（幾何平均）對應到 18% 中灰。

const W = 48;
const H = 32;
const KEY = 0.18;

export class MultiMeter {
  private target = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: true });
  private buf = new Float32Array(W * H * 4);
  private weights = new Float32Array(W * H);
  private central = new Uint8Array(W * H);
  failed = false;

  constructor() {
    const sigma = 0.42;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const x = ((i + 0.5) / W) * 2 - 1;
        const y = ((j + 0.5) / H) * 2 - 1;
        const g = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
        this.weights[j * W + i] = 0.2 + g;
        this.central[j * W + i] = g > 0.5 ? 1 : 0;
      }
  }

  /**
   * 渲染測光小圖並回傳建議曝光（renderer.toneMappingExposure，不含曝光補償）。
   * 讀取失敗（不支援浮點渲染目標）時回傳 null。
   */
  measure(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): number | null {
    if (this.failed) return null;
    try {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(this.target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(this.target, 0, 0, W, H, this.buf);
      renderer.setRenderTarget(prev);
    } catch (e) {
      console.warn('[meter] 無法讀取測光影像，改用環境估算', e);
      this.failed = true;
      return null;
    }

    const n = W * H;
    const lum = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const r = this.buf[k * 4];
      const g = this.buf[k * 4 + 1];
      const b = this.buf[k * 4 + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lum[k] = Number.isFinite(l) ? Math.max(l, 0) : 0;
    }
    const sorted = Float32Array.from(lum).sort();
    const median = Math.max(sorted[n >> 1], 1e-6);

    let sw = 0;
    let sl = 0;
    for (let j = 0; j < H; j++) {
      // readRenderTargetPixels 由下往上：j 越大越接近畫面頂端
      const top = j >= (H * 2) / 3;
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        let w = this.weights[k];
        if (top && lum[k] > median * 2) w *= 0.45;
        sw += w;
        sl += w * Math.log(1e-6 + Math.min(lum[k], median * (this.central[k] ? 64 : 8)));
      }
    }
    const avg = Math.exp(sl / sw);
    return KEY / Math.max(avg, 1e-6);
  }

  dispose() {
    this.target.dispose();
  }
}
