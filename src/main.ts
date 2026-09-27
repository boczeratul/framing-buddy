import './style.css';
import * as THREE from 'three';
import { store, encodeHash, decodeHash, type ShotState, type StateKey } from './state';
import { fieldOfView, frameSize, aspectText } from './lens';
import { bearing, compassName, distanceLatLon, getOrigin, setOrigin, toLatLon, toLocal, type LatLon } from './geo';
import { formatMinutes, lookupTimeZone, offsetLabel, zonedToInstant } from './time';
import { hasGoogle } from './google';
import { World } from './world/World';
import { PRESETS } from './world/presets';
import type { Preset } from './world/types';
import { Viewfinder, pickTarget, type VisibilityReport } from './views/viewfinder';
import { MapView } from './views/mapview';
import { GoogleMapView } from './views/googlemap';
import { buildPanel } from './ui/panel';

const DEG = Math.PI / 180;

// ---- 初始原點與時區 ----
{
  const s = store.state;
  setOrigin({ lat: s.lat0, lon: s.lon0 });
  if (!decodeHash(location.hash).tz) store.set({ tz: lookupTimeZone(s.lat0, s.lon0) });
}

const world = new World();
world.rebase(getOrigin(), store.state.range * 1000);

// 光線最先更新：面板、HUD 都會讀取太陽位置
const ENV_KEYS = new Set<StateKey>(['date', 'minutes', 'clouds', 'visibility', 'tz', 'lat0', 'lon0']);
const instantOf = (s: ShotState) => zonedToInstant(s.date, s.minutes, s.tz);
store.subscribe((s, changed) => {
  if ([...changed].some((k) => ENV_KEYS.has(k))) {
    world.env.update(instantOf(s), s.clouds, s.visibility, { lat: s.lat0, lon: s.lon0 });
    world.photoreal?.setDaylight(1 - world.env.info.night);
  }
  if (changed.has('trees')) world.setTrees(s.trees);
  if (changed.has('relight')) world.setRelight(s.relight);
});

const viewfinder = new Viewfinder(document.getElementById('viewfinder')!, world);
const map = new MapView(document.getElementById('map')!, world, (s) => viewfinder.eye(s));

// ---- 移動、對準 ----

/** 前往某個經緯度：距離原點太遠時換原點（整個場景重建），否則只移動相機 */
function goTo(p: LatLon, patch: Partial<ShotState> = {}) {
  if (distanceLatLon(p, getOrigin()) > 2500) {
    store.set({ lat0: p.lat, lon0: p.lon, x: 0, z: 0, tz: lookupTimeZone(p.lat, p.lon), ...patch });
  } else {
    const l = toLocal(p);
    store.set({ x: l.x, z: l.z, ...patch });
  }
}

function aim(id: string) {
  const s = store.state;
  const eye = viewfinder.eye(s);
  let dir: THREE.Vector3;
  let target = s.target;
  if (id === 'sun') dir = world.env.sunDir.clone();
  else if (id === 'moon') dir = world.env.moonDir.clone();
  else {
    const t = world.targets().find((x) => x.id === id);
    if (!t) return;
    dir = t.base.clone().lerp(t.top, t.aimAt).sub(eye);
    target = id;
  }
  const az = Math.atan2(dir.x, -dir.z) / DEG;
  const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) / DEG;
  store.set({ azimuth: az, pitch, roll: 0, target });
}

let pendingAim: { id: string; until: number } | null = null;

function applyPreset(p: Preset) {
  goTo({ lat: p.lat, lon: p.lon }, { height: p.height ?? 1.6, snap: p.snap ?? true, ...(p.state ?? {}) });
  if (p.aim) pendingAim = { id: p.aim, until: performance.now() + 25000 };
  gmap?.panTo({ lat: p.lat, lon: p.lon });
}

// ---- 左側地圖 ----

const gmap = hasGoogle()
  ? new GoogleMapView(document.getElementById('gmap')!, document.getElementById('search')!, {
      moveTo: (p) => goTo(p),
      aimAt: (p) => {
        const s = store.state;
        const l = toLocal(p);
        store.set({ azimuth: bearing(s.x, s.z, l.x, l.z) });
      },
      place: (p, viewport) => {
        goTo(p);
        gmap?.panTo(p, viewport);
      },
    })
  : null;

const mapStage = document.getElementById('map')!;
const modeSeg = document.getElementById('map-mode')!;
const hint = document.getElementById('map-hint')!;
const HINTS = {
  google: '點一下移動 · 拖曳相機或橘點 · Shift+點一下對準該處 · 上方可搜尋任何地點',
  '2d': '點一下移動 · 拖曳橘點轉向 · Shift+點一下對準該處 · 滾輪縮放 · 拖曳空白處平移',
  '3d': '拖曳旋轉 · 右鍵拖曳平移 · 滾輪縮放 · 雙擊地面移動位置',
};
type MapMode = keyof typeof HINTS;
function setMapMode(mode: MapMode) {
  for (const b of modeSeg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
  mapStage.className = `stage mode-${mode}`;
  map.setMode(mode === 'google' ? 'off' : mode);
  hint.textContent = HINTS[mode];
}
modeSeg.addEventListener('click', (e) => {
  const mode = (e.target as HTMLElement).dataset.mode as MapMode | undefined;
  if (mode) setMapMode(mode);
});
document.getElementById('map-recenter')!.addEventListener('click', () => {
  map.recenter();
  const s = store.state;
  gmap?.panTo(toLatLon(s.x, s.z));
});

const disableGoogleMode = () => {
  if (gmap) gmap.disabled = true;
  (modeSeg.querySelector('[data-mode="google"]') as HTMLElement).hidden = true;
  document.getElementById('search')!.replaceChildren();
  setMapMode('2d');
};
// Google 在金鑰驗證失敗時會呼叫這個全域函式
(window as unknown as { gm_authFailure: () => void }).gm_authFailure = () => {
  console.warn('[map] Google Maps 金鑰驗證失敗，改用俯視地圖');
  disableGoogleMode();
};
if (gmap) {
  setMapMode('google');
  gmap.init(toLatLon(store.state.x, store.state.z)).catch(disableGoogleMode);
} else disableGoogleMode();

// ---- 面板 ----

const panel = buildPanel(document.getElementById('panel')!, {
  presets: PRESETS,
  applyPreset,
  goTo: (p) => {
    goTo(p);
    gmap?.panTo(p);
  },
  aim,
  targets: () => world.targets(),
  surface: () => viewfinder.eye(store.state).y - store.state.height,
  celestial: () => world.env.info,
  snapshot: () => {
    const s = store.state;
    const a = document.createElement('a');
    a.href = viewfinder.snapshot();
    a.download = `framing-${s.date}-${formatMinutes(s.minutes).replace(':', '')}-${Math.round(s.focal)}mm.png`;
    a.click();
  },
  status: statusText,
});

function statusText(): string {
  const st = world.status();
  const near = store.state.photoreal
    ? { off: '關閉', loading: 'Google 實景 3D 載入中', ready: 'Google 實景 3D', error: `實景 3D 無法使用（${st.photorealError}），改用 OSM` }[st.photoreal]
    : `OSM 精細建物 ${st.osm.near.built}/${st.osm.near.wanted} 區塊`;
  const parts = [
    `地形：${{ loading: '載入中', ready: '已載入（Google 高程）', flat: '平面' }[st.terrain]}`,
    `近景：${near}`,
    `遠景：OSM 高樓 ${st.osm.far.built}/${st.osm.far.wanted} 區塊${st.osm.loading ? `（下載中 ${st.osm.loading}）` : ''}`,
  ];
  if (st.osm.errors) parts.push(`OSM 請求失敗 ${st.osm.errors} 次`);
  return parts.join('\n');
}

// ---- 狀態 → 視圖 ----

const hud = document.getElementById('hud')!;
let report: VisibilityReport = viewfinder.report;
viewfinder.onReport = (r) => {
  report = r;
  map.target = r.target;
  updateHud(store.state);
  syncGoogleMap(store.state);
};

let hashTimer = 0;
let rangeTimer = 0;
store.subscribe((s, changed) => {
  if (changed.has('lat0') || changed.has('lon0')) {
    const o = getOrigin();
    if (s.lat0 !== o.lat || s.lon0 !== o.lon) {
      world.rebase({ lat: s.lat0, lon: s.lon0 }, s.range * 1000);
      viewfinder.resetSurface();
      map.recenter();
    }
  } else if (changed.has('range')) {
    clearTimeout(rangeTimer);
    rangeTimer = window.setTimeout(() => world.reloadTerrain(store.state.range * 1000), 400);
  }
  viewfinder.apply(s, changed as Set<string>);
  map.apply(s);
  if ([...changed].some((k) => ENV_KEYS.has(k) || k === 'trees' || k === 'relight' || k === 'photoreal')) {
    viewfinder.invalidate();
    map.invalidate();
  }
  updateHud(s);
  syncGoogleMap(s);
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => history.replaceState(null, '', `#${encodeHash(s)}`), 300);
});

// 在同一分頁貼上分享連結時套用
window.addEventListener('hashchange', () => store.set(decodeHash(location.hash)));

function syncGoogleMap(s: ShotState) {
  if (!gmap) return;
  const info = world.env.info;
  const t = report.target;
  gmap.sync({
    eye: toLatLon(s.x, s.z),
    azimuth: s.azimuth,
    hfov: fieldOfView(s.focal, frameSize(s.aspect, s.portrait)).h,
    near: s.near,
    range: s.range * 1000,
    sunAz: info.sunAz,
    sunUp: info.sunAlt > 0,
    moonAz: info.moonAlt > -2 ? info.moonAz : null,
    target: t ? { label: t.label, at: toLatLon(t.base.x, t.base.z) } : null,
  });
}

function updateHud(s: ShotState) {
  const fov = fieldOfView(s.focal, frameSize(s.aspect, s.portrait));
  const eye = viewfinder.eye(s);
  const info = world.env.info;
  const t = report.target;
  let targetLine = '<b>目標</b> 範圍內沒有已知地標（可到「場景載入」加大遠景範圍）';
  if (t) {
    const d = Math.hypot(t.base.x - s.x, t.base.z - s.z);
    const b = bearing(s.x, s.z, t.base.x, t.base.z);
    const vis = Math.round(report.visible * 100);
    let status: string;
    if (!report.inFrame) status = '不在畫面內';
    else if (vis >= 98) status = '完整入鏡、無遮擋';
    else if (vis <= 2) status = '在畫面方向上，但被遮擋';
    else status = `可見約 ${vis}%（部分被遮擋）`;
    const pct = report.frameFraction != null ? Math.round(report.frameFraction * 100) : 0;
    const frac = report.inFrame && report.frameFraction != null ? ` ・ 高度為畫面的 ${pct}%${pct > 100 ? '（超出畫面）' : ''}` : '';
    const dist = d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${Math.round(d)} m`;
    const ok = report.inFrame && vis > 2 ? 'ok' : '';
    targetLine = `<span class="${ok}"><b>${t.label}</b> 距離 ${dist} ・ 方位 ${b.toFixed(1)}° ・ ${status}${frac}</span>`;
  }
  hud.innerHTML = `
    <div class="hud-main">
      <span class="big">${Math.round(s.focal)}<small>mm</small></span>
      <span>${aspectText(s.aspect, s.portrait)} ${s.portrait ? '直幅' : '橫幅'}</span>
      <span>視角 ${fov.h.toFixed(1)}° × ${fov.v.toFixed(1)}°</span>
      <span>方位 ${s.azimuth.toFixed(1)}° ${compassName(s.azimuth)}</span>
      <span>俯仰 ${s.pitch >= 0 ? '+' : ''}${s.pitch.toFixed(1)}°</span>
      <span>鏡頭 海拔 ${(eye.y + world.terrain.originElevation).toFixed(1)} m</span>
      <span>${s.date} ${formatMinutes(s.minutes)}（${offsetLabel(s.tz, instantOf(s))}）</span>
      <span>☀ ${info.sunAz.toFixed(0)}° / ${info.sunAlt.toFixed(1)}°</span>
    </div>
    <div class="hud-101">${targetLine}</div>`;
}

// ---- 鍵盤操作 ----

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.closest?.('gmp-place-autocomplete') || el.tagName.startsWith('GMP-')) return;
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
  const speed = 6 * fast * dt;
  const turn = fieldOfView(s.focal, frameSize(s.aspect, s.portrait)).v * 0.6 * fast * dt;
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

// ---- 渲染迴圈：依相機動態載入內容，按需渲染 ----

const loadingEl = document.getElementById('loading')!;
const attributionEl = document.getElementById('attribution')!;
let lastVersion = -1;
let lastStatusAt = 0;

function frame(now: number) {
  tickKeys(now);
  const s = store.state;
  // 走離原點太遠時換原點，避免浮點誤差
  if (Math.hypot(s.x, s.z) > 3000) goTo(toLatLon(s.x, s.z));

  const eye = viewfinder.eye(s);
  const fov = fieldOfView(s.focal, frameSize(s.aspect, s.portrait));
  const cameras: { camera: THREE.Camera; renderer: THREE.WebGLRenderer }[] = [{ camera: viewfinder.camera, renderer: viewfinder.renderer }];
  const mapCam = map.activeCamera();
  if (mapCam) cameras.push({ camera: mapCam, renderer: map.renderer });
  world.update({ eye, azimuth: s.azimuth, hfov: fov.h, range: s.range * 1000, near: s.near, photoreal: s.photoreal }, cameras);

  if (world.version !== lastVersion) {
    lastVersion = world.version;
    viewfinder.apply(s, new Set());
    map.apply(s);
    viewfinder.invalidate();
    map.invalidate();
  }
  if (pendingAim && !world.rebasing) {
    if (world.targets().some((t) => t.id === pendingAim!.id)) {
      aim(pendingAim.id);
      pendingAim = null;
    } else if (now > pendingAim.until) pendingAim = null;
  }
  viewfinder.render();
  map.render();

  if (now - lastStatusAt > 500) {
    lastStatusAt = now;
    const st = world.status();
    const busy = st.terrain === 'loading' || st.photoreal === 'loading' || st.osm.loading > 0;
    loadingEl.hidden = !busy;
    if (busy) loadingEl.textContent = `載入中… ${statusText().replace(/\n/g, ' · ')}`;
    attributionEl.textContent = world.attributions();
    panel.refresh();
    // 新地標載入後，若目前沒有目標就重新挑選
    if (!report.target && pickTarget(world.targets(), s.target, eye)) viewfinder.invalidate();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 開發模式：方便在主控台檢查狀態
if (import.meta.env.DEV) Object.assign(window, { __fb: { world, store, gmap, viewfinder, map } });
if (import.meta.env.DEV) Object.assign(window, { THREE });
