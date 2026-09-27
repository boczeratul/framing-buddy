import './style.css';
import * as THREE from 'three';
import { store, toInstant, encodeHash, decodeHash, formatMinutes, type ShotState } from './state';
import { fieldOfView, frameSize, aspectText } from './lens';
import { bearing, compassName } from './geo';
import { World } from './scene/world';
import { CKS_PRESETS } from './scene/cks';
import { Viewfinder, type VisibilityReport } from './views/viewfinder';
import { MapView } from './views/mapview';
import { buildPanel } from './ui/panel';

const world = new World();

// 光線與樹木要最先更新：面板、HUD 都會讀取太陽位置
const ENV_KEYS = new Set(['date', 'minutes', 'clouds', 'visibility']);
store.subscribe((s, changed) => {
  if ([...changed].some((k) => ENV_KEYS.has(k))) world.env.update(toInstant(s.date, s.minutes), s.clouds, s.visibility);
  if (changed.has('trees')) world.setTrees(s.trees);
});
const viewfinder = new Viewfinder(document.getElementById('viewfinder')!, world);
const map = new MapView(document.getElementById('map')!, world, (s) => viewfinder.eye(s));

const DEG = Math.PI / 180;

/** 把鏡頭對準目標（方位＋俯仰） */
function aim(target: '101' | 'hall' | 'sun' | 'moon') {
  const s = store.state;
  const eye = viewfinder.eye(s);
  let dir: THREE.Vector3;
  if (target === 'sun') dir = world.env.sunDir.clone();
  else if (target === 'moon') dir = world.env.moonDir.clone();
  else {
    const p =
      target === '101'
        ? world.tower101.base.clone().lerp(world.tower101.top, 0.5)
        : world.hall.top.clone().setY(world.hall.top.y * 0.55);
    dir = p.sub(eye);
  }
  const az = Math.atan2(dir.x, -dir.z) / DEG;
  const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) / DEG;
  store.set({ azimuth: az, pitch, roll: 0 });
}

buildPanel(document.getElementById('panel')!, {
  presets: CKS_PRESETS,
  aim,
  surfaceAt: (x, z) => world.surfaceAt(x, z),
  celestial: () => world.env.info,
  bounds: world.bounds,
  snapshot: () => {
    const s = store.state;
    const a = document.createElement('a');
    a.href = viewfinder.snapshot();
    a.download = `framing-${s.date}-${formatMinutes(s.minutes).replace(':', '')}-${Math.round(s.focal)}mm.png`;
    a.click();
  },
});

// ---- 狀態 → 場景 ----

const hud = document.getElementById('hud')!;
let report: VisibilityReport = viewfinder.report;
viewfinder.onReport = (r) => {
  report = r;
  updateHud(store.state);
};

let hashTimer = 0;

store.subscribe((s, changed) => {
  viewfinder.apply(s, changed as Set<string>);
  map.apply(s);
  if (changed.has('trees') || [...changed].some((k) => ENV_KEYS.has(k))) {
    viewfinder.invalidate();
    map.invalidate();
  }
  updateHud(s);
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => history.replaceState(null, '', `#${encodeHash(s)}`), 300);
});

// 在同一分頁貼上分享連結時套用
window.addEventListener('hashchange', () => store.set(decodeHash(location.hash)));

// ---- HUD（取景器下方資訊列）----

function updateHud(s: ShotState) {
  const fov = fieldOfView(s.focal, frameSize(s.aspect, s.portrait));
  const eye = viewfinder.eye(s);
  const t = world.tower101;
  const d101 = Math.hypot(t.base.x - s.x, t.base.z - s.z);
  const b101 = bearing(s.x, s.z, t.base.x, t.base.z);
  const info = world.env.info;
  const vis = Math.round(report.visible * 100);
  let status: string;
  if (!report.inFrame) status = '不在畫面內';
  else if (vis >= 98) status = '完整入鏡、無遮擋';
  else if (vis <= 2) status = '在畫面方向上，但被遮擋';
  else status = `可見約 ${vis}%（部分被遮擋）`;
  const pct = report.frameFraction != null ? Math.round(report.frameFraction * 100) : 0;
  const frac = report.inFrame && report.frameFraction != null ? ` ・ 高度為畫面的 ${pct}%${pct > 100 ? '（超出畫面）' : ''}` : '';
  hud.innerHTML = `
    <div class="hud-main">
      <span class="big">${Math.round(s.focal)}<small>mm</small></span>
      <span>${aspectText(s.aspect, s.portrait)} ${s.portrait ? '直幅' : '橫幅'}</span>
      <span>視角 ${fov.h.toFixed(1)}° × ${fov.v.toFixed(1)}°</span>
      <span>方位 ${s.azimuth.toFixed(1)}° ${compassName(s.azimuth)}</span>
      <span>俯仰 ${s.pitch >= 0 ? '+' : ''}${s.pitch.toFixed(1)}°</span>
      <span>鏡頭高 ${eye.y.toFixed(1)} m</span>
      <span>${s.date} ${formatMinutes(s.minutes)}</span>
      <span>☀ ${info.sunAz.toFixed(0)}° / ${info.sunAlt.toFixed(1)}°</span>
    </div>
    <div class="hud-101 ${report.inFrame && vis > 2 ? 'ok' : ''}">
      <b>台北 101</b> 距離 ${(d101 / 1000).toFixed(2)} km ・ 方位 ${b101.toFixed(1)}° ・ ${status}${frac}
    </div>`;
}

// ---- 地圖模式切換 ----

const modeSeg = document.getElementById('map-mode')!;
const hint = document.getElementById('map-hint')!;
modeSeg.addEventListener('click', (e) => {
  const mode = (e.target as HTMLElement).dataset.mode as '2d' | '3d' | undefined;
  if (!mode) return;
  for (const b of modeSeg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
  map.setMode(mode);
  hint.textContent =
    mode === '2d'
      ? '點一下移動 · 拖曳橘點轉向 · Shift+點一下對準該處 · 滾輪縮放 · 拖曳空白處平移'
      : '拖曳旋轉 · 右鍵拖曳平移 · 滾輪縮放 · 雙擊地面移動位置';
});
document.getElementById('map-recenter')!.addEventListener('click', () => map.recenter());

// ---- 鍵盤操作 ----

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  keys.add(e.code);
  if (e.code === 'Equal' || e.code === 'NumpadAdd') store.set({ focal: store.state.focal * 1.08 });
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') store.set({ focal: store.state.focal / 1.08 });
  if (e.code.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

let lastT = performance.now();
function tickKeys(now: number) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (!keys.size) return;
  const s = store.state;
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1;
  const speed = 6 * fast * dt; // m/s
  const turn = (fieldOfView(s.focal, frameSize(s.aspect, s.portrait)).v * 0.6 * fast) * dt; // 依視角調整轉速
  const a = s.azimuth * DEG;
  const fwd = [Math.sin(a), -Math.cos(a)];
  const right = [Math.cos(a), Math.sin(a)];
  let { x, z, height, azimuth, pitch } = s;
  if (keys.has('KeyW')) { x += fwd[0] * speed; z += fwd[1] * speed; }
  if (keys.has('KeyS')) { x -= fwd[0] * speed; z -= fwd[1] * speed; }
  if (keys.has('KeyD')) { x += right[0] * speed; z += right[1] * speed; }
  if (keys.has('KeyA')) { x -= right[0] * speed; z -= right[1] * speed; }
  if (keys.has('KeyR')) height += speed * 0.5;
  if (keys.has('KeyF')) height = Math.max(0, height - speed * 0.5);
  if (keys.has('ArrowLeft')) azimuth -= turn;
  if (keys.has('ArrowRight')) azimuth += turn;
  if (keys.has('ArrowUp')) pitch += turn;
  if (keys.has('ArrowDown')) pitch -= turn;
  store.set({ x, z, height, azimuth, pitch });
}

// ---- 按需渲染 ----

function frame(now: number) {
  tickKeys(now);
  viewfinder.render();
  map.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
