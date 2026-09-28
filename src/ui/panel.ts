import { store, type ShotState, encodeHash } from '../state';
import { ASPECTS, type AspectId, FOCAL_PRESETS, fieldOfView, focalToSlider, frameSize, sliderToFocal } from '../lens';
import { compassName, formatLatLon, parseLatLon, toLatLon, type LatLon } from '../geo';
import { formatMinutes, minutesOnDate, nowInZone, offsetLabel, zonedToInstant } from '../time';
import { googleKey, setGoogleKey } from '../config';
import type { CelestialInfo } from '../scene/environment';
import type { Preset, Target } from '../world/types';

// 左側控制面板：位置、高度、方向、鏡頭、光線、場景載入、顯示／分享

export interface PanelActions {
  presets: Preset[];
  applyPreset(p: Preset): void;
  goTo(p: LatLon): void;
  /** 目標 id，或 'sun'、'moon' */
  aim(id: string): void;
  targets(): Target[];
  /** 目前站立面高度（公尺，相對原點地面） */
  surface(): number;
  celestial(): CelestialInfo;
  snapshot(): void;
  status(): string;
}

type Sync = (s: ShotState) => void;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...children);
  return el;
};

const fmt = (v: number, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);

export function buildPanel(root: HTMLElement, act: PanelActions) {
  const syncs: Sync[] = [];

  const section = (title: string, open = true) => {
    const d = h('details', { class: 'sec' });
    d.open = open;
    d.append(h('summary', {}, title));
    const body = h('div', { class: 'sec-body' });
    d.append(body);
    root.append(d);
    return body;
  };

  /** 滑桿＋數字輸入 */
  const slider = (
    parent: HTMLElement,
    label: string,
    o: {
      min: number; max: number; step: number;
      get: (s: ShotState) => number;
      set: (v: number) => Partial<ShotState>;
      unit?: string;
      suffix?: (s: ShotState) => string;
      toSlider?: (v: number) => number;
      fromSlider?: (v: number) => number;
      numberMin?: number; numberMax?: number; digits?: number;
      commit?: boolean;
    },
  ) => {
    const range = h('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step), 'aria-label': label });
    const num = h('input', { type: 'number', step: 'any', class: 'num', 'aria-label': `${label}數值` });
    if (o.numberMin != null) num.min = String(o.numberMin);
    if (o.numberMax != null) num.max = String(o.numberMax);
    const suffix = h('span', { class: 'suffix' });
    const row = h('div', { class: 'row' },
      h('label', {}, label),
      range,
      h('span', { class: 'numwrap' }, num, h('span', { class: 'unit' }, o.unit ?? '')),
    );
    parent.append(h('div', { class: 'ctl' }, row, suffix));
    // commit：放開滑桿才套用（重新載入代價高的設定）
    range.addEventListener(o.commit ? 'change' : 'input', () => {
      const v = Number(range.value);
      store.set(o.set(o.fromSlider ? o.fromSlider(v) : v));
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (Number.isFinite(v)) store.set(o.set(v));
    });
    syncs.push((s) => {
      const v = o.get(s);
      if (document.activeElement !== range) range.value = String(o.toSlider ? o.toSlider(v) : v);
      if (document.activeElement !== num) num.value = fmt(v, o.digits ?? 1);
      suffix.textContent = o.suffix ? o.suffix(s) : '';
      suffix.hidden = !o.suffix;
    });
  };

  const buttons = (parent: HTMLElement, items: [string, () => void, string?][], cls = 'chips') => {
    const row = h('div', { class: cls });
    for (const [text, fn, title] of items) {
      const b = h('button', title ? { title } : {}, text);
      b.addEventListener('click', fn);
      row.append(b);
    }
    parent.append(row);
    return row;
  };

  const check = (parent: HTMLElement, label: string, key: 'snap' | 'trees' | 'grid' | 'photoreal' | 'relight') => {
    const input = h('input', { type: 'checkbox' });
    input.addEventListener('change', () => store.set({ [key]: input.checked } as Partial<ShotState>));
    parent.append(h('label', { class: 'check' }, input, label));
    syncs.push((s) => (input.checked = s[key]));
  };

  // ---- 位置 ----
  {
    const sec = section('位置');
    const sel = h('select', { 'aria-label': '快速位置' }, h('option', { value: '' }, '快速位置…'));
    const groups = new Map<string, HTMLOptGroupElement>();
    act.presets.forEach((p, i) => {
      let g = groups.get(p.group);
      if (!g) {
        g = h('optgroup', { label: p.group });
        groups.set(p.group, g);
        sel.append(g);
      }
      g.append(h('option', { value: String(i) }, p.name));
    });
    sel.addEventListener('change', () => {
      const p = act.presets[Number(sel.value)];
      sel.value = '';
      if (p) act.applyPreset(p);
    });
    sec.append(sel);

    const coord = h('input', { type: 'text', placeholder: '緯度, 經度（例：25.0346, 121.5218）', 'aria-label': '前往座標', class: 'coord' });
    const go = h('button', {}, '前往');
    const me = h('button', { title: '使用裝置目前的位置' }, '我的位置');
    const goCoord = () => {
      const p = parseLatLon(coord.value);
      coord.classList.toggle('bad', !p);
      if (p) act.goTo(p);
    };
    go.addEventListener('click', goCoord);
    coord.addEventListener('keydown', (e) => e.key === 'Enter' && goCoord());
    me.addEventListener('click', () => {
      me.textContent = '定位中…';
      navigator.geolocation?.getCurrentPosition(
        (pos) => {
          me.textContent = '我的位置';
          act.goTo({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        },
        () => (me.textContent = '無法定位'),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    });
    sec.append(h('div', { class: 'row3' }, coord, go, me));

    slider(sec, '東西', {
      min: -1500, max: 1500, step: 0.5, unit: 'm',
      get: (s) => s.x, set: (v) => ({ x: v }),
    });
    slider(sec, '南北', {
      min: -1500, max: 1500, step: 0.5, unit: 'm',
      get: (s) => -s.z, set: (v) => ({ z: -v }),
      suffix: (s) => `目前 ${formatLatLon(toLatLon(s.x, s.z))}（相對場景原點，正值＝以東／以北）`,
    });
  }

  // ---- 高度 ----
  {
    const sec = section('高度');
    slider(sec, '離地', {
      min: 0, max: 1000, step: 1, unit: 'm', numberMin: 0, numberMax: 2000, digits: 2,
      // 滑桿前段細、後段粗：0–1000 對應 0–500 m
      toSlider: (v) => Math.sqrt(v / 500) * 1000,
      fromSlider: (v) => Math.round((v / 1000) ** 2 * 500 * 20) / 20,
      get: (s) => s.height, set: (v) => ({ height: v }),
      suffix: (s) => {
        const base = s.snap ? act.surface() : 0;
        return `站立面 ${fmt(base)} m ・ 鏡頭 ${fmt(base + s.height)} m（相對原點地面）`;
      },
    });
    check(sec, '站在地面／屋頂／台階上（自動貼合高度）', 'snap');
    buttons(sec, [
      ['低角度 0.4m', () => store.set({ height: 0.4 })],
      ['平視 1.6m', () => store.set({ height: 1.6 })],
      ['舉高 2.4m', () => store.set({ height: 2.4 })],
      ['空拍 60m', () => store.set({ height: 60, snap: false })],
    ]);
  }

  // ---- 方向 ----
  {
    const sec = section('方向');
    slider(sec, '方位', {
      min: 0, max: 360, step: 0.1, unit: '°',
      get: (s) => s.azimuth, set: (v) => ({ azimuth: v }),
      suffix: (s) => `朝${compassName(s.azimuth)}（0°＝北，順時針）`,
    });
    slider(sec, '俯仰', {
      min: -90, max: 90, step: 0.1, unit: '°',
      get: (s) => s.pitch, set: (v) => ({ pitch: v }),
    });
    slider(sec, '水平', {
      min: -45, max: 45, step: 0.1, unit: '°',
      get: (s) => s.roll, set: (v) => ({ roll: v }),
    });
    const tsel = h('select', { 'aria-label': '目標' });
    const aimBtn = h('button', {}, '對準');
    tsel.addEventListener('change', () => store.set({ target: tsel.value }));
    aimBtn.addEventListener('click', () => tsel.value && act.aim(tsel.value));
    sec.append(h('div', { class: 'row2' }, h('label', {}, '目標'), tsel, aimBtn));
    let lastIds = '';
    const refreshTargets = () => {
      const s = store.state;
      const list = act.targets();
      const ids = list.map((t) => t.id).join('|') + s.target;
      if (ids === lastIds) return;
      lastIds = ids;
      tsel.replaceChildren(...list.map((t) => h('option', { value: t.id }, t.label)));
      if (!list.length) tsel.append(h('option', { value: '' }, '（範圍內沒有已知地標）'));
      tsel.value = list.some((t) => t.id === s.target) ? s.target : list[0]?.id ?? '';
    };
    setInterval(refreshTargets, 1000);
    syncs.push(refreshTargets);
    buttons(sec, [
      ['對準太陽', () => act.aim('sun')],
      ['對準月亮', () => act.aim('moon')],
      ['水平歸零', () => store.set({ roll: 0, pitch: 0 })],
    ]);
  }

  // ---- 鏡頭 ----
  {
    const sec = section('鏡頭');
    slider(sec, '焦段', {
      min: 0, max: 1000, step: 1, unit: 'mm', digits: 0,
      toSlider: focalToSlider, fromSlider: sliderToFocal,
      get: (s) => s.focal, set: (v) => ({ focal: v }),
      suffix: (s) => {
        const f = fieldOfView(s.focal, frameSize(s.aspect, s.portrait));
        return `全片幅等效 ・ 視角 水平 ${fmt(f.h)}° ／ 垂直 ${fmt(f.v)}° ／ 對角 ${fmt(f.d)}°`;
      },
    });
    const chips = buttons(sec, FOCAL_PRESETS.map((f) => [String(f), () => store.set({ focal: f })] as [string, () => void]), 'chips focal');
    syncs.push((s) => {
      for (const b of chips.querySelectorAll('button')) b.classList.toggle('on', Number(b.textContent) === Math.round(s.focal));
    });

    const aspect = h('select', { 'aria-label': '畫面比例' });
    for (const [id, a] of Object.entries(ASPECTS)) aspect.append(h('option', { value: id }, a.label));
    aspect.addEventListener('change', () => store.set({ aspect: aspect.value as AspectId }));
    const orient = h('div', { class: 'seg' }, h('button', { 'data-v': '0' }, '橫幅'), h('button', { 'data-v': '1' }, '直幅'));
    orient.addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).dataset.v;
      if (v) store.set({ portrait: v === '1' });
    });
    sec.append(h('div', { class: 'row2' }, h('label', {}, '比例'), aspect, orient));
    syncs.push((s) => {
      aspect.value = s.aspect;
      for (const b of orient.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === (s.portrait ? '1' : '0'));
    });
  }

  // ---- 光線 ----
  {
    const sec = section('光線（日期與時間）');
    const date = h('input', { type: 'date', 'aria-label': '日期' });
    date.addEventListener('change', () => date.value && store.set({ date: date.value }));
    const today = h('button', {}, '現在');
    today.addEventListener('click', () => store.set(nowInZone(store.state.tz)));
    sec.append(h('div', { class: 'row2' }, h('label', {}, '日期'), date, today));
    syncs.push((s) => (date.value = s.date));

    {
      const range = h('input', { type: 'range', min: '0', max: '1439', step: '1', 'aria-label': '時間' });
      const time = h('input', { type: 'time', step: '60', class: 'num', 'aria-label': '時間（時:分）' });
      const tzNote = h('span', { class: 'suffix' });
      range.addEventListener('input', () => store.set({ minutes: Number(range.value) }));
      time.addEventListener('change', () => {
        const [hh, mm] = time.value.split(':').map(Number);
        if (Number.isFinite(hh) && Number.isFinite(mm)) store.set({ minutes: hh * 60 + mm });
      });
      sec.append(h('div', { class: 'ctl' },
        h('div', { class: 'row wide' }, h('label', {}, '時間'), range, h('span', { class: 'numwrap' }, time)),
        tzNote,
      ));
      syncs.push((s) => {
        range.value = String(s.minutes);
        if (document.activeElement !== time) time.value = formatMinutes(s.minutes);
        tzNote.textContent = `拍攝地點當地時間（${s.tz}，${offsetLabel(s.tz, zonedToInstant(s.date, s.minutes, s.tz))}）`;
      });
    }

    const jump = (key: string, offset = 0) => () => {
      const t = act.celestial().times[key];
      const s = store.state;
      if (t instanceof Date) store.set({ minutes: minutesOnDate(t, s.date, s.tz) + offset });
    };
    buttons(sec, [
      ['日出', jump('sunrise')],
      ['晨間金色時刻', jump('goldenHourEnd', -20)],
      ['正午', jump('solarNoon')],
      ['黃昏金色時刻', jump('goldenHour', 20)],
      ['日落', jump('sunset')],
      ['藍色時刻', jump('dusk', -8)],
    ]);

    const info = h('div', { class: 'info' });
    sec.append(info);
    syncs.push((s) => {
      const c = act.celestial();
      const t = (k: string) => {
        const v = c.times[k];
        return v instanceof Date ? formatMinutes(minutesOnDate(v, s.date, s.tz)) : '—';
      };
      info.innerHTML = `
        <div><b>太陽</b> 方位 ${fmt(c.sunAz)}° ・ 仰角 ${fmt(c.sunAlt)}°${c.sunAlt < 0 ? '（地平線下）' : ''}</div>
        <div><b>日出</b> ${t('sunrise')} ・ <b>日落</b> ${t('sunset')} ・ <b>正午</b> ${t('solarNoon')}</div>
        <div><b>金色時刻</b> 早 ${t('sunrise')}–${t('goldenHourEnd')} ・ 晚 ${t('goldenHour')}–${t('sunset')}</div>
        <div><b>藍色時刻</b> 早 ${t('dawn')}–${t('sunrise')} ・ 晚 ${t('sunset')}–${t('dusk')}</div>
        <div><b>月亮</b> ${moonPhaseName(c.moonPhase)} ${Math.round(c.moonFraction * 100)}% ・ 方位 ${fmt(c.moonAz)}° ・ 仰角 ${fmt(c.moonAlt)}°</div>`;
    });

    slider(sec, '雲量', {
      min: 0, max: 1, step: 0.01, unit: '', digits: 2,
      get: (s) => s.clouds, set: (v) => ({ clouds: v }),
    });
    slider(sec, '能見度', {
      min: 2, max: 150, step: 1, unit: 'km',
      suffix: () => '相機所在高度的水平能見度；霾集中在低空，高山山頂會比山腳清楚',
      get: (s) => s.visibility, set: (v) => ({ visibility: v }),
    });
    slider(sec, '曝光補償', {
      min: -3, max: 3, step: 0.1, unit: 'EV',
      get: (s) => s.ev, set: (v) => ({ ev: v }),
    });
  }

  // ---- 場景載入 ----
  {
    const sec = section('場景載入', false);
    slider(sec, '遠景', {
      min: 1, max: 20, step: 0.5, unit: 'km', commit: true,
      get: (s) => s.range, set: (v) => ({ range: v }),
      suffix: () => '此距離內有名稱的高樓、高塔（沒有 Google 時也決定 OSM 高樓的載入範圍）。地形、遠山與 Google 模型一律載入到約 90 km 的地平線',
    });
    slider(sec, '近景', {
      min: 200, max: 3000, step: 50, unit: 'm', digits: 0, commit: true,
      get: (s) => s.near, set: (v) => ({ near: v }),
      suffix: (s) => (s.photoreal ? '此半徑內使用 Google 實景 3D 模型' : '此半徑內使用 OSM 精細建物（含斜屋頂、樹木）'),
    });
    check(sec, '近景使用 Google 實景 3D 圖磚', 'photoreal');
    check(sec, '實景模型套用模擬日照（取消則保留照片原始光影）', 'relight');
    check(sec, '顯示樹木（地標園區）', 'trees');
    const status = h('div', { class: 'info status' });
    sec.append(status);
    setInterval(() => (status.textContent = act.status()), 800);

    const key = h('input', { type: 'password', placeholder: googleKey() ? '已設定（輸入新金鑰以更換）' : '貼上 Google Maps API 金鑰', class: 'coord', 'aria-label': 'Google Maps API 金鑰' });
    const save = h('button', {}, '儲存並重新載入');
    save.addEventListener('click', () => {
      setGoogleKey(key.value.trim());
      location.reload();
    });
    sec.append(h('div', { class: 'row3' }, key, save));
    sec.append(h('p', { class: 'help' }, '金鑰只存在這個瀏覽器；未設定時改用 OpenStreetMap 資料，地圖搜尋與實景模型停用。'));
  }

  // ---- 顯示與分享 ----
  {
    const sec = section('顯示與分享', false);
    check(sec, '構圖輔助線（三分法、中心、水平線）', 'grid');
    const copy = h('button', { class: 'primary' }, '複製分享連結');
    copy.addEventListener('click', async () => {
      const url = `${location.origin}${location.pathname}#${encodeHash(store.state)}`;
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = '已複製 ✓';
      } catch {
        copy.textContent = '請手動複製網址列';
      }
      setTimeout(() => (copy.textContent = '複製分享連結'), 1500);
    });
    const shot = h('button', {}, '下載畫面 PNG');
    shot.addEventListener('click', () => act.snapshot());
    sec.append(h('div', { class: 'chips' }, copy, shot));
    sec.append(
      h('p', { class: 'help' },
        '快捷鍵：W/S 前進後退、A/D 左右平移、R/F 升降、方向鍵轉向與俯仰、+/- 變焦、按住 Shift 加速。在取景器上拖曳可轉動鏡頭、滾輪可變焦。',
      ),
    );
  }

  store.subscribe((s) => syncs.forEach((f) => f(s)));
  return { refresh: () => syncs.forEach((f) => f(store.state)) };
}

function moonPhaseName(p: number): string {
  const names = ['新月', '眉月', '上弦月', '盈凸月', '滿月', '虧凸月', '下弦月', '殘月'];
  return names[Math.round(p * 8) % 8];
}
