import * as THREE from 'three';
import type { World } from '../scene/world';
import { store, type ShotState } from '../state';
import { fieldOfView, frameSize } from '../lens';
import { createRenderer, drawTag, EnvMapCache, fitCanvas } from './shared';

const DEG = Math.PI / 180;

export interface VisibilityReport {
  /** 101 的可見比例（0–1，未進入畫面也會計算：只看是否被遮擋） */
  visible: number;
  /** 101 在畫面中的垂直佔比（0–1，以 NDC 計），不在前方時為 null */
  frameFraction: number | null;
  inFrame: boolean;
}

/** 取景器：以相機實際視角渲染場景，外加構圖輔助線與目標提示 */
export class Viewfinder {
  readonly camera = new THREE.PerspectiveCamera(40, 1.5, 0.3, 80000);
  readonly renderer: THREE.WebGLRenderer;
  private overlay: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private envCache: EnvMapCache;
  private size = { w: 1, h: 1 };
  private dirty = true;
  private raycaster = new THREE.Raycaster();
  report: VisibilityReport = { visible: 1, frameFraction: null, inFrame: false };
  onReport?: (r: VisibilityReport) => void;
  private occlusionTimer = 0;

  constructor(private stage: HTMLElement, private world: World) {
    const canvas = stage.querySelector<HTMLCanvasElement>('canvas.gl')!;
    this.overlay = stage.querySelector<HTMLCanvasElement>('canvas.overlay')!;
    this.renderer = createRenderer(canvas);
    this.envCache = new EnvMapCache(this.renderer);
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.enable(2);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(stage);
    this.bindPointer();
  }

  /** 相機實際位置（含站立面高度） */
  eye(s: ShotState): THREE.Vector3 {
    const base = s.snap ? this.world.surfaceAt(s.x, s.z) : 0;
    return new THREE.Vector3(s.x, base + s.height, s.z);
  }

  private resize() {
    const s = store.state;
    const frame = frameSize(s.aspect, s.portrait);
    const aspect = frame.w / frame.h;
    const rect = this.stage.getBoundingClientRect();
    const pad = 16;
    let w = rect.width - pad * 2;
    let h = rect.height - pad * 2;
    if (w / h > aspect) w = h * aspect;
    else h = w / aspect;
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    this.size = { w, h };
    this.renderer.setSize(w, h);
    this.ctx = fitCanvas(this.overlay, w, h);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  apply(s: ShotState, changed: Set<string>) {
    if (changed.has('aspect') || changed.has('portrait')) this.resize();
    const frame = frameSize(s.aspect, s.portrait);
    const fov = fieldOfView(s.focal, frame);
    this.camera.fov = fov.v;
    this.camera.aspect = frame.w / frame.h;
    this.camera.position.copy(this.eye(s));
    this.camera.rotation.set(s.pitch * DEG, -s.azimuth * DEG, -s.roll * DEG);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.dirty = true;
    this.scheduleOcclusion();
  }

  invalidate() {
    this.dirty = true;
    this.scheduleOcclusion();
  }

  render() {
    if (!this.dirty) return;
    this.dirty = false;
    const { scene, env } = this.world;
    scene.environment = this.envCache.get(env);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const exposure = env.meter(forward) * Math.pow(2, store.state.ev);
    this.renderer.toneMappingExposure = exposure;
    env.setFogForView(store.state.azimuth, exposure);
    this.renderer.render(scene, this.camera);
    this.drawOverlay();
  }

  /** 匯出目前畫面（含輔助線）為 PNG dataURL */
  snapshot(): string {
    this.dirty = true;
    this.render();
    const c = document.createElement('canvas');
    c.width = this.renderer.domElement.width;
    c.height = this.renderer.domElement.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(this.renderer.domElement, 0, 0);
    ctx.drawImage(this.overlay, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  // ---- 疊加層 ----

  private drawOverlay() {
    const { ctx } = this;
    const { w, h } = this.size;
    const s = store.state;
    ctx.clearRect(0, 0, w, h);

    if (s.grid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of [1 / 3, 2 / 3]) {
        ctx.moveTo(w * f, 0); ctx.lineTo(w * f, h);
        ctx.moveTo(0, h * f); ctx.lineTo(w, h * f);
      }
      ctx.stroke();
      // 中心十字
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.moveTo(w / 2 - 8, h / 2); ctx.lineTo(w / 2 + 8, h / 2);
      ctx.moveTo(w / 2, h / 2 - 8); ctx.lineTo(w / 2, h / 2 + 8);
      ctx.stroke();
      this.drawHorizon();
    }

    const { env, tower101, hall } = this.world;
    const info = env.info;
    const targets: { label: string; world: THREE.Vector3; color: string }[] = [
      { label: '台北 101', world: tower101.top.clone().lerp(tower101.base, 0.35), color: '#7fe3c8' },
      { label: '中正紀念堂', world: hall.top, color: '#9cc3ff' },
    ];
    const far = (dir: THREE.Vector3) => this.camera.position.clone().addScaledVector(dir, 20000);
    if (info.sunAlt > -8) targets.push({ label: `太陽 ${info.sunAlt.toFixed(1)}°`, world: far(env.sunDir), color: '#ffc861' });
    if (info.moonAlt > -8)
      targets.push({ label: `月亮 ${Math.round(info.moonFraction * 100)}%`, world: far(env.moonDir), color: '#d9e2ff' });
    for (const t of targets) this.drawTarget(t.label, t.world, t.color);
  }

  private drawHorizon() {
    const { ctx } = this;
    const { w, h } = this.size;
    const cam = this.camera;
    const s = store.state;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const pts: [number, number][] = [];
    for (const off of [-30, 30]) {
      const az = (s.azimuth + off) * DEG;
      a.set(Math.sin(az), 0, -Math.cos(az)).multiplyScalar(10000).add(cam.position);
      b.copy(a).project(cam);
      if (b.z > 1) return;
      pts.push([(b.x * 0.5 + 0.5) * w, (-b.y * 0.5 + 0.5) * h]);
    }
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = Math.abs(s.roll) < 0.25 ? 'rgba(120,255,170,0.7)' : 'rgba(255,210,90,0.7)';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.stroke();
    ctx.restore();
  }

  private drawTarget(label: string, world: THREE.Vector3, color: string) {
    const { ctx } = this;
    const { w, h } = this.size;
    const local = world.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const ndc = world.clone().project(this.camera);
    const inFront = local.z < 0;
    const inFrame = inFront && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
    if (inFrame) {
      const x = (ndc.x * 0.5 + 0.5) * w;
      const y = (-ndc.y * 0.5 + 0.5) * h;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
      drawTag(ctx, label, x, y - 18, { color });
      return;
    }
    // 畫面外：在邊緣畫箭頭指向目標
    let dx = local.x;
    let dy = local.y;
    if (!inFront && Math.hypot(dx, dy) < 1e-6) dx = 1;
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    const margin = 22;
    const hw = w / 2 - margin;
    const hh = h / 2 - margin;
    const t = Math.min(Math.abs(hw / (dx || 1e-9)), Math.abs(hh / (dy || 1e-9)));
    const x = w / 2 + dx * t;
    const y = h / 2 - dy * t;
    const ang = Math.atan2(-dy, dx);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(10, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const tx = Math.min(w - 60, Math.max(60, x - dx * 26));
    const ty = Math.min(h - 14, Math.max(14, y + dy * 22));
    drawTag(ctx, label, tx, ty, { color, bg: 'rgba(0,0,0,0.45)' });
  }

  // ---- 101 可見度（遮擋判定）----

  private scheduleOcclusion() {
    clearTimeout(this.occlusionTimer);
    this.occlusionTimer = window.setTimeout(() => this.computeReport(), 160);
  }

  private computeReport() {
    const { tower101, occluders } = this.world;
    const cam = this.camera;
    const origin = cam.position.clone();
    const samples = 24;
    let visible = 0;
    const p = new THREE.Vector3();
    const dir = new THREE.Vector3();
    for (let i = 0; i < samples; i++) {
      p.lerpVectors(tower101.base, tower101.top, (i + 0.5) / samples);
      dir.subVectors(p, origin);
      const dist = dir.length();
      this.raycaster.set(origin, dir.normalize());
      this.raycaster.far = dist;
      const hit = this.raycaster.intersectObjects(occluders, true);
      if (!hit.length) visible++;
    }
    const top = tower101.top.clone().project(cam);
    const base = tower101.base.clone().project(cam);
    const topLocal = tower101.top.clone().applyMatrix4(cam.matrixWorldInverse);
    const inFront = topLocal.z < 0;
    const inFrame =
      inFront && Math.abs(top.x) <= 1.05 && Math.min(top.y, base.y) <= 1 && Math.max(top.y, base.y) >= -1;
    this.report = {
      visible: visible / samples,
      frameFraction: inFront ? Math.abs(top.y - base.y) / 2 : null,
      inFrame,
    };
    this.onReport?.(this.report);
  }

  // ---- 拖曳轉向、滾輪變焦 ----

  private bindPointer() {
    const el = this.overlay;
    let last: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!last) return;
      const s = store.state;
      const fov = fieldOfView(s.focal, frameSize(s.aspect, s.portrait));
      const degPerPx = fov.v / this.size.h;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      // 「抓住畫面」的拖曳：往右拖＝鏡頭往左轉
      store.set({ azimuth: s.azimuth - dx * degPerPx, pitch: s.pitch + dy * degPerPx });
    });
    const end = () => {
      last = null;
      el.classList.remove('dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const s = store.state;
        store.set({ focal: s.focal * Math.pow(1.0015, -e.deltaY) });
      },
      { passive: false },
    );
  }
}
