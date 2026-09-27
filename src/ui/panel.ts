import { store, type ShotState, formatMinutes, taipeiNow, toTaipeiMinutes, encodeHash } from '../state';
import { ASPECTS, type AspectId, FOCAL_PRESETS, fieldOfView, focalToSlider, frameSize, sliderToFocal } from '../lens';
import { compassName, toLatLon } from '../geo';
import type { CelestialInfo } from '../scene/environment';
import type { Preset } from '../scene/cks';

// 左側控制面板：位置、高度、方向、鏡頭、光線、顯示／分享

export interface PanelActions {
  presets: Preset[];
  aim(target: '101' | 'hall' | 'sun' | 'moon'): void;
  surfaceAt(x: number, z: number): number;
  celestial(): CelestialInfo;
  snapshot(): void;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
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
    const wrap = h('div', { class: 'ctl' }, row, suffix);
    parent.append(wrap);
    range.addEventListener('input', () => {
      const v = Number(range.value);
      store.set(o.set(o.fromSlider ? o.fromSlider(v) : v));
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (Number.isFinite(v)) store.set(o.set(v));
    });
    syncs.push((s) => {
      const v = o.get(s);
      range.value = String(o.toSlider ? o.toSlider(v) : v);
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

  const check = (parent: HTMLElement, label: string, key: 'snap' | 'trees' | 'grid') => {
    const input = h('input', { type: 'checkbox' });
    input.addEventListener('change', () => store.set({ [key]: input.checked } as Partial<ShotState>));
    parent.append(h('label', { class: 'check' }, input, label));
    syncs.push((s) => (input.checked = s[key]));
  };

  // ---- 位置 ----
  {
    const sec = section('位置');
    const sel = h('select', { 'aria-label': '快速位置' }, h('option', { value: '' }, '快速位置…'));
    act.presets.forEach((p, i) => sel.append(h('option', { value: String(i) }, p.name)));
    sel.addEventListener('change', () => {
      const p = act.presets[Number(sel.value)];
      sel.value = '';
      if (!p) return;
      store.set({ x: p.x, z: p.z, height: p.height ?? 1.6, snap: p.snap ?? true, ...(p.state ?? {}) });
      if (p.aim) act.aim(p.aim);
    });
    sec.append(sel);
    const b = act.bounds;
    slider(sec, '東西', {
      min: b.minX, max: b.maxX, step: 0.5, unit: 'm',
      get: (s) => s.x, set: (v) => ({ x: v }),
    });
    slider(sec, '南北', {
      min: -b.maxZ, max: -b.minZ, step: 0.5, unit: 'm',
      get: (s) => -s.z, set: (v) => ({ z: -v }),
      suffix: (s) => {
        const ll = toLatLon(s.x, s.z);
        return `${ll.lat.toFixed(6)}, ${ll.lon.toFixed(6)}　（正值＝紀念堂以東／以北）`;
      },
    });
  }

  // ---- 高度 ----
  {
    const sec = section('高度');
    slider(sec, '離地', {
      min: 0, max: 1000, step: 1, unit: 'm', numberMin: 0, numberMax: 600, digits: 2,
      // 滑桿前段細、後段粗：0–1000 對應 0–300 m
      toSlider: (v) => Math.sqrt(v / 300) * 1000,
      fromSlider: (v) => Math.round((v / 1000) ** 2 * 300 * 20) / 20,
      get: (s) => s.height, set: (v) => ({ height: v }),
      suffix: (s) => {
        const base = s.snap ? act.surfaceAt(s.x, s.z) : 0;
        return `站立面 ${fmt(base)} m ・ 鏡頭離地面 ${fmt(base + s.height)} m`;
      },
    });
    check(sec, '站在地面／台階／平台上（自動貼合高度）', 'snap');
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
    buttons(sec, [
      ['對準 101', () => act.aim('101')],
      ['對準紀念堂', () => act.aim('hall')],
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
    today.addEventListener('click', () => store.set(taipeiNow()));
    sec.append(h('div', { class: 'row2' }, h('label', {}, '日期'), date, today));
    syncs.push((s) => (date.value = s.date));

    {
      const range = h('input', { type: 'range', min: '0', max: '1439', step: '1', 'aria-label': '時間' });
      const time = h('input', { type: 'time', step: '60', class: 'num', 'aria-label': '時間（時:分）' });
      range.addEventListener('input', () => store.set({ minutes: Number(range.value) }));
      time.addEventListener('change', () => {
        const [hh, mm] = time.value.split(':').map(Number);
        if (Number.isFinite(hh) && Number.isFinite(mm)) store.set({ minutes: hh * 60 + mm });
      });
      sec.append(h('div', { class: 'ctl' },
        h('div', { class: 'row wide' }, h('label', {}, '時間'), range, h('span', { class: 'numwrap' }, time)),
        h('span', { class: 'suffix' }, '台北時間（UTC+8）'),
      ));
      syncs.push((s) => {
        range.value = String(s.minutes);
        if (document.activeElement !== time) time.value = formatMinutes(s.minutes);
      });
    }

    const jump = (key: string, offset = 0) => () => {
      const info = act.celestial();
      const t = info.times[key];
      if (t instanceof Date) store.set({ minutes: toTaipeiMinutes(t, store.state.date) + offset });
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
    syncs.push(() => {
      const c = act.celestial();
      const t = (k: string) => {
        const v = c.times[k];
        return v instanceof Date ? formatMinutes(toTaipeiMinutes(v, store.state.date)) : '—';
      };
      const phaseName = moonPhaseName(c.moonPhase);
      info.innerHTML = `
        <div><b>太陽</b> 方位 ${fmt(c.sunAz)}° ・ 仰角 ${fmt(c.sunAlt)}°${c.sunAlt < 0 ? '（地平線下）' : ''}</div>
        <div><b>日出</b> ${t('sunrise')} ・ <b>日落</b> ${t('sunset')} ・ <b>正午</b> ${t('solarNoon')}</div>
        <div><b>金色時刻</b> 早 ${t('sunrise')}–${t('goldenHourEnd')} ・ 晚 ${t('goldenHour')}–${t('sunset')}</div>
        <div><b>藍色時刻</b> 早 ${t('dawn')}–${t('sunrise')} ・ 晚 ${t('sunset')}–${t('dusk')}</div>
        <div><b>月亮</b> ${phaseName} ${Math.round(c.moonFraction * 100)}% ・ 方位 ${fmt(c.moonAz)}° ・ 仰角 ${fmt(c.moonAlt)}°</div>`;
    });

    slider(sec, '雲量', {
      min: 0, max: 1, step: 0.01, unit: '', digits: 2,
      get: (s) => s.clouds, set: (v) => ({ clouds: v }),
    });
    slider(sec, '能見度', {
      min: 2, max: 50, step: 0.5, unit: 'km',
      get: (s) => s.visibility, set: (v) => ({ visibility: v }),
    });
    slider(sec, '曝光補償', {
      min: -3, max: 3, step: 0.1, unit: 'EV',
      get: (s) => s.ev, set: (v) => ({ ev: v }),
    });
  }

  // ---- 顯示與分享 ----
  {
    const sec = section('顯示與分享', false);
    check(sec, '顯示樹木', 'trees');
    check(sec, '構圖輔助線（三分法、中心、水平線）', 'grid');
    const copy = h('button', { class: 'primary' }, '複製分享連結');
    copy.addEventListener('click', async () => {
      const url = `${location.origin}${location.pathname}#${encodeHash(store.state)}`;
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = '已複製 ✓';
      } catch {
        prompt('複製這個連結：', url);
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
