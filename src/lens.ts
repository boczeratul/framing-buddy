// 全片幅等效焦段 → 視角。畫面比例以「從 36×24 mm 感光元件裁切」計算，
// 與在全片幅機身上切換長寬比的實際結果一致。

// 一律以橫幅定義，直幅時長寬互換（等同把相機轉 90°）
export const ASPECTS = {
  '3:2': { label: '3:2（全片幅原生）', w: 36, h: 24 },
  '4:3': { label: '4:3', w: 32, h: 24 },
  '5:4': { label: '5:4（直幅即 IG 4:5）', w: 30, h: 24 },
  '1:1': { label: '1:1', w: 24, h: 24 },
  '16:9': { label: '16:9', w: 36, h: 20.25 },
  '65:24': { label: '65:24（XPan 寬景）', w: 36, h: 13.29 },
} as const;

export type AspectId = keyof typeof ASPECTS;

export const FOCAL_MIN = 8;
export const FOCAL_MAX = 1200;
export const FOCAL_PRESETS = [14, 16, 20, 24, 28, 35, 50, 70, 85, 105, 135, 200, 300, 400, 600, 800];

/** 顯示用比例文字，直幅時前後互換（例：5:4 → 4:5） */
export function aspectText(aspect: AspectId, portrait: boolean): string {
  const [a, b] = aspect.split(':');
  return portrait && a !== b ? `${b}:${a}` : aspect;
}

export function frameSize(aspect: AspectId, portrait: boolean): { w: number; h: number } {
  const a = ASPECTS[aspect];
  return portrait ? { w: a.h, h: a.w } : { w: a.w, h: a.h };
}

const RAD = 180 / Math.PI;

export function fieldOfView(focal: number, frame: { w: number; h: number }) {
  const d = Math.hypot(frame.w, frame.h);
  return {
    h: 2 * Math.atan(frame.w / (2 * focal)) * RAD,
    v: 2 * Math.atan(frame.h / (2 * focal)) * RAD,
    d: 2 * Math.atan(d / (2 * focal)) * RAD,
  };
}

// 焦段滑桿採對數刻度，讓廣角與望遠都好調
export function focalToSlider(f: number): number {
  return (Math.log(f / FOCAL_MIN) / Math.log(FOCAL_MAX / FOCAL_MIN)) * 1000;
}

export function sliderToFocal(v: number): number {
  const f = FOCAL_MIN * Math.pow(FOCAL_MAX / FOCAL_MIN, v / 1000);
  return f < 100 ? Math.round(f) : Math.round(f / 5) * 5;
}
