// Google Maps Platform 設定。金鑰優先順序：使用者在介面輸入（存在 localStorage）＞ .env.local。

const LS_KEY = 'framing-buddy:google-key';

export function googleKey(): string {
  try {
    const k = localStorage.getItem(LS_KEY);
    if (k) return k;
  } catch {
    // 無痕模式等情況讀不到 localStorage
  }
  return import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '';
}

export function setGoogleKey(key: string) {
  try {
    if (key) localStorage.setItem(LS_KEY, key);
    else localStorage.removeItem(LS_KEY);
  } catch {
    // 忽略
  }
}

/** 可拖曳的 AdvancedMarker 需要 Map ID；未設定時用 Google 提供的測試 ID */
export const GOOGLE_MAP_ID = import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID';
