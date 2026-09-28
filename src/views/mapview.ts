import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { World } from '../world/World';
import type { Target } from '../world/types';
import { store, type ShotState } from '../state';
import { fieldOfView, frameSize } from '../lens';
import { bearing } from '../geo';
import { createRenderer, drawTag, EnvMapCache, fitCanvas } from './shared';

const DEG = Math.PI / 180;

type Mode = '2d' | '3d' | 'off';

/**
 * 位置規劃圖：
 * - 2D 俯視：點一下移動位置、拖曳相機圖示移動、拖曳方向把手轉向、Shift+點一下朝該點對準、滾輪縮放、拖曳空白處平移
 * - 3D 環視：軌道相機繞著拍攝位置旋轉，顯示相機視錐；雙擊地面移動位置
 */
export class MapView {
  readonly renderer: THREE.WebGLRenderer;
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000);
  private persp = new THREE.PerspectiveCamera(50, 1, 1, 300000);
  private controls: OrbitControls;
  private overlay: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private envCache: EnvMapCache;
  private size = { w: 1, h: 1 };
  private center = { x: -312, z: -168 };
  /** 資訊列追蹤的目標（由主程式同步） */
  target: Target | null = null;
  private mpp = 1.9; // 每像素公尺數
  private dirty = true;
  private frustum = new THREE.Group();
  private eye = new THREE.Vector3();
  mode: Mode = '2d';

  constructor(private stage: HTMLElement, private world: World, private eyeOf: (s: ShotState) => THREE.Vector3) {
    const canvas = stage.querySelector<HTMLCanvasElement>('canvas.gl')!;
    this.overlay = stage.querySelector<HTMLCanvasElement>('canvas.overlay')!;
    this.renderer = createRenderer(canvas);
    this.envCache = new EnvMapCache(this.renderer);

    this.ortho.up.set(0, 0, -1); // 北朝上
    this.persp.layers.enable(1);
    this.persp.layers.enable(2);

    this.controls = new OrbitControls(this.persp, canvas);
    this.controls.enableDamping = false;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 3000;
    this.controls.enabled = false;
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.frustum.layers.set(1);
    world.scene.add(this.frustum);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(stage);
    this.bind2D();
    canvas.addEventListener('dblclick', (e) => this.relocate3D(e));
  }

  /** 目前使用中的 Three.js 相機（Google 地圖模式時為 null） */
  activeCamera(): THREE.Camera | null {
    return this.mode === '2d' ? this.ortho : this.mode === '3d' ? this.persp : null;
  }

  setMode(mode: Mode) {
    this.mode = mode;
    this.controls.enabled = mode === '3d';
    this.overlay.style.pointerEvents = mode === '2d' ? 'auto' : 'none';
    if (mode === '2d') this.recenter();
    if (mode === '3d') {
      const s = store.state;
      const back = new THREE.Vector3(-Math.sin(s.azimuth * DEG), 0, Math.cos(s.azimuth * DEG));
      this.persp.position.copy(this.eye).addScaledVector(back, 90).add(new THREE.Vector3(0, 45, 0));
      this.controls.target.copy(this.eye);
      this.controls.update();
    }
    this.dirty = true;
  }

  /** 讓地圖中心移到目前位置 */
  recenter() {
    const s = store.state;
    this.center = { x: s.x, z: s.z };
    this.updateOrtho();
  }

  private resize() {
    const r = this.stage.getBoundingClientRect();
    this.size = { w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) };
    this.renderer.setSize(this.size.w, this.size.h);
    this.ctx = fitCanvas(this.overlay, this.size.w, this.size.h);
    this.persp.aspect = this.size.w / this.size.h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
  }

  private updateOrtho() {
    const { w, h } = this.size;
    const o = this.ortho;
    o.left = (-w / 2) * this.mpp;
    o.right = (w / 2) * this.mpp;
    o.top = (h / 2) * this.mpp;
    o.bottom = (-h / 2) * this.mpp;
    o.position.set(this.center.x, 3000, this.center.z);
    o.lookAt(this.center.x, 0, this.center.z);
    o.updateProjectionMatrix();
    this.dirty = true;
  }

  apply(s: ShotState) {
    const prev = this.eye.clone();
    this.eye.copy(this.eyeOf(s));
    if (this.mode === '3d') {
      // 位置變動時軌道相機跟著平移
      const delta = this.eye.clone().sub(prev);
      this.persp.position.add(delta);
      this.controls.target.copy(this.eye);
      this.controls.update();
    }
    this.buildFrustum(s);
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  private buildFrustum(s: ShotState) {
    this.frustum.clear();
    const frame = frameSize(s.aspect, s.portrait);
    const fov = fieldOfView(s.focal, frame);
    const L = 70;
    const hh = Math.tan((fov.v / 2) * DEG) * L;
    const hw = Math.tan((fov.h / 2) * DEG) * L;
    const c = [
      new THREE.Vector3(-hw, -hh, -L), new THREE.Vector3(hw, -hh, -L),
      new THREE.Vector3(hw, hh, -L), new THREE.Vector3(-hw, hh, -L),
    ];
    const o = new THREE.Vector3();
    const pts = [o, c[0], o, c[1], o, c[2], o, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0]];
    const lines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true }),
    );
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(hw * 2, hh * 2).translate(0, 0, -L),
      new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 1.6), new THREE.MeshBasicMaterial({ color: 0xffb020 }));
    const g = new THREE.Group();
    g.add(lines, plane, body);
    g.position.copy(this.eye);
    g.rotation.order = 'YXZ';
    g.rotation.set(s.pitch * DEG, -s.azimuth * DEG, -s.roll * DEG);
    g.traverse((o) => {
      o.layers.set(1);
      o.renderOrder = 10;
    });
    this.frustum.add(g);
  }

  render() {
    if (!this.dirty || this.mode === 'off') return;
    this.dirty = false;
    const { scene, env } = this.world;
    scene.environment = this.envCache.get(env);
    // 地圖要在夜間也看得清楚：夜晚時補一盞天光並固定曝光
    const night = env.info.night;
    const hemi = env.hemi.intensity;
    env.hemi.intensity = hemi + 1.1 * night;
    this.renderer.toneMappingExposure = env.exposure * (1 - night) + 0.9 * night;
    // 俯視時霧會讓遠處變灰，暫時關掉
    const fog = scene.fog;
    if (this.mode === '2d') scene.fog = null;
    this.renderer.render(scene, this.mode === '2d' ? this.ortho : this.persp);
    scene.fog = fog;
    env.hemi.intensity = hemi;
    if (this.mode === '2d') this.drawOverlay();
    else this.ctx.clearRect(0, 0, this.size.w, this.size.h);
  }

  // ---- 2D 疊加層 ----

  private toScreen(x: number, z: number): [number, number] {
    return [(x - this.center.x) / this.mpp + this.size.w / 2, (z - this.center.z) / this.mpp + this.size.h / 2];
  }

  private toWorld(sx: number, sy: number): { x: number; z: number } {
    return { x: (sx - this.size.w / 2) * this.mpp + this.center.x, z: (sy - this.size.h / 2) * this.mpp + this.center.z };
  }

  private handlePos(s: ShotState): [number, number] {
    const [cx, cy] = this.toScreen(s.x, s.z);
    const a = s.azimuth * DEG;
    return [cx + Math.sin(a) * 46, cy - Math.cos(a) * 46];
  }

  private drawOverlay() {
    const { ctx } = this;
    const { w, h } = this.size;
    const s = store.state;
    const { env } = this.world;
    const labels = this.world.labels();
    ctx.clearRect(0, 0, w, h);

    // 建築標籤
    for (const l of labels) {
      if (l.minZoom && this.mpp > l.minZoom) continue;
      const [x, y] = this.toScreen(l.x, l.z);
      if (x < -40 || x > w + 40 || y < -20 || y > h + 20) continue;
      drawTag(ctx, l.text, x, y, { bg: 'rgba(20,24,32,0.62)', font: '500 11px system-ui, sans-serif' });
    }

    const [cx, cy] = this.toScreen(s.x, s.z);
    const R = Math.hypot(w, h) * 1.5;

    // 太陽、月亮方位線
    const ray = (az: number, color: string, dash: number[], label: string) => {
      const a = az * DEG;
      const ex = cx + Math.sin(a) * R;
      const ey = cy - Math.cos(a) * R;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.restore();
      const lx = cx + Math.sin(a) * 110;
      const ly = cy - Math.cos(a) * 110;
      drawTag(ctx, label, lx, ly, { color, bg: 'rgba(0,0,0,0.5)', font: '600 11px system-ui, sans-serif' });
    };
    const info = env.info;
    ray(info.sunAz, '#ffbf3c', info.sunAlt > 0 ? [] : [4, 5], `☀ ${info.sunAz.toFixed(0)}°`);
    if (info.moonAlt > -2) ray(info.moonAz, '#c9d6ff', [2, 4], `☾ ${info.moonAz.toFixed(0)}°`);

    // 往追蹤目標的方向線
    const tg = this.target;
    if (tg) {
      const b = bearing(s.x, s.z, tg.base.x, tg.base.z);
      const d = Math.hypot(tg.base.x - s.x, tg.base.z - s.z);
      ray(b, '#5fe0bf', [8, 6], `${tg.label} ${d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${Math.round(d)} m`}`);
    }

    // 視野扇形
    const fov = fieldOfView(s.focal, frameSize(s.aspect, s.portrait));
    const a0 = (s.azimuth - fov.h / 2) * DEG;
    const a1 = (s.azimuth + fov.h / 2) * DEG;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h));
    grad.addColorStop(0, 'rgba(255,176,32,0.38)');
    grad.addColorStop(1, 'rgba(255,176,32,0.04)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, a0 - Math.PI / 2, a1 - Math.PI / 2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,176,32,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(a0) * R, cy - Math.cos(a0) * R);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + Math.sin(a1) * R, cy - Math.cos(a1) * R);
    ctx.stroke();

    // 方向把手
    const [hx, hy] = this.handlePos(s);
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = '#ffb020';
    ctx.beginPath();
    ctx.arc(hx, hy, 6, 0, Math.PI * 2);
    ctx.fill();

    // 相機位置
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    this.drawScale();
    this.drawNorth();
  }

  private drawScale() {
    const { ctx } = this;
    const { h } = this.size;
    const target = 100 * this.mpp;
    const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find((n) => n >= target) ?? 2000;
    const px = nice / this.mpp;
    const x = 12;
    const y = h - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - 6, y - 16, px + 46, 24);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, x + px + 5, y);
  }

  private drawNorth() {
    const { ctx } = this;
    const x = this.size.w - 22;
    const y = 26;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff5b4f';
    ctx.beginPath();
    ctx.moveTo(x, y - 11); ctx.lineTo(x + 5, y + 2); ctx.lineTo(x - 5, y + 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', x, y + 8);
  }

  // ---- 2D 互動 ----

  private bind2D() {
    const el = this.overlay;
    type Drag = { kind: 'pan' | 'move' | 'aim'; sx: number; sy: number; moved: boolean; cx: number; cz: number };
    let drag: Drag | null = null;

    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as [number, number];
    };

    el.addEventListener('pointerdown', (e) => {
      const [x, y] = local(e);
      const s = store.state;
      const [cx, cy] = this.toScreen(s.x, s.z);
      const [hx, hy] = this.handlePos(s);
      let kind: Drag['kind'] = 'pan';
      if (Math.hypot(x - hx, y - hy) < 12) kind = 'aim';
      else if (Math.hypot(x - cx, y - cy) < 12) kind = 'move';
      drag = { kind, sx: x, sy: y, moved: false, cx: this.center.x, cz: this.center.z };
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      const s = store.state;
      if (!drag) {
        const [cx, cy] = this.toScreen(s.x, s.z);
        const [hx, hy] = this.handlePos(s);
        el.style.cursor =
          Math.hypot(x - hx, y - hy) < 12 ? 'crosshair' : Math.hypot(x - cx, y - cy) < 12 ? 'move' : 'grab';
        return;
      }
      if (Math.hypot(x - drag.sx, y - drag.sy) > 3) drag.moved = true;
      if (!drag.moved) return;
      const p = this.toWorld(x, y);
      if (drag.kind === 'pan') {
        this.center = { x: drag.cx - (x - drag.sx) * this.mpp, z: drag.cz - (y - drag.sy) * this.mpp };
        this.updateOrtho();
        el.style.cursor = 'grabbing';
      } else if (drag.kind === 'move') {
        store.set({ x: p.x, z: p.z });
      } else {
        store.set({ azimuth: bearing(s.x, s.z, p.x, p.z) });
      }
    });

    el.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && drag.kind === 'pan') {
        const [x, y] = local(e);
        const p = this.toWorld(x, y);
        const s = store.state;
        if (e.shiftKey) store.set({ azimuth: bearing(s.x, s.z, p.x, p.z) });
        else store.set({ x: p.x, z: p.z });
      }
      drag = null;
    });

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [x, y] = local(e);
        const before = this.toWorld(x, y);
        this.mpp = Math.min(12, Math.max(0.08, this.mpp * Math.pow(1.0018, e.deltaY)));
        const after = this.toWorld(x, y);
        this.center.x += before.x - after.x;
        this.center.z += before.z - after.z;
        this.updateOrtho();
      },
      { passive: false },
    );
  }

  private relocate3D(e: MouseEvent) {
    if (this.mode !== '3d') return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.persp);
    const hit = rc.intersectObjects([...this.world.occluders(), this.world.terrain.group], true)[0];
    if (hit) store.set({ x: hit.point.x, z: hit.point.z });
  }
}
