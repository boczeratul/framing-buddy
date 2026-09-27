import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { googleKey } from './config';

// Maps JavaScript API 只初始化一次；沒有金鑰時所有 Google 功能停用、改用 OSM 備援。

let configured = false;

export function hasGoogle(): boolean {
  return Boolean(googleKey());
}

export async function loadGoogle<K extends keyof google.maps.ImportLibraryMap>(lib: K): Promise<google.maps.ImportLibraryMap[K]> {
  if (!hasGoogle()) throw new Error('未設定 Google Maps 金鑰');
  if (!configured) {
    setOptions({ key: googleKey(), v: 'weekly', language: 'zh-TW', region: 'TW' });
    configured = true;
  }
  return importLibrary(lib);
}
