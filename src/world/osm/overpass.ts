import type { Bounds } from './tiles';

// Overpass API 用戶端：單一佇列依序請求（公共伺服器有頻率限制）、失敗時輪替端點並退避，
// 結果存進 IndexedDB 快取 14 天，回訪同一區域時不必重抓。

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const TTL = 14 * 24 * 3600 * 1000;

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

// ---- IndexedDB 快取 ----

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open('framing-buddy-osm', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('tiles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function cacheGet(key: string): Promise<OverpassElement[] | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction('tiles').objectStore('tiles').get(key);
      req.onsuccess = () => {
        const v = req.result as { t: number; data: OverpassElement[] } | undefined;
        resolve(v && Date.now() - v.t < TTL ? v.data : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cachePut(key: string, data: OverpassElement[]) {
  const d = await db();
  if (!d) return;
  try {
    d.transaction('tiles', 'readwrite').objectStore('tiles').put({ t: Date.now(), data }, key);
  } catch {
    // 空間不足等情況：不快取
  }
}

// ---- 請求佇列 ----

type Job = { key: string; query: string; resolve: (v: OverpassElement[]) => void; reject: (e: unknown) => void; cancelled: boolean };
const queue: Job[] = [];
let running = false;
let endpoint = 0;

export interface OverpassRequest {
  promise: Promise<OverpassElement[]>;
  cancel(): void;
}

export function overpass(key: string, query: string): OverpassRequest {
  let job!: Job;
  const promise = new Promise<OverpassElement[]>((resolve, reject) => {
    job = { key, query, resolve, reject, cancelled: false };
  });
  (async () => {
    const hit = await cacheGet(key);
    if (hit) return job.resolve(hit);
    queue.push(job);
    pump();
  })();
  return {
    promise,
    cancel: () => {
      job.cancelled = true;
    },
  };
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift()!;
    if (job.cancelled) {
      job.reject(new Error('cancelled'));
      continue;
    }
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < ENDPOINTS.length * 2; attempt++) {
      const url = ENDPOINTS[endpoint % ENDPOINTS.length];
      try {
        const r = await fetch(url, {
          method: 'POST',
          body: new URLSearchParams({ data: job.query }),
        });
        if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { elements: OverpassElement[] };
        cachePut(job.key, j.elements);
        job.resolve(j.elements);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        endpoint++;
        await new Promise((res) => setTimeout(res, 1200 * (attempt + 1)));
      }
    }
    if (lastErr) job.reject(lastErr);
  }
  running = false;
}

export const bbox = (b: Bounds) => `${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)}`;

/** 可視範圍內有名稱的高樓與高塔（當作可對準的目標），只取外框範圍 */
export function namedTallQuery(b: Bounds): string {
  return `[out:json][timeout:60][bbox:${bbox(b)}];
(
  nwr["name"]["building"](if: number(t["height"]) >= 150);
  nwr["name"]["man_made"~"^(tower|mast)$"](if: number(t["height"]) >= 100);
);
out tags bb;`;
}

/** 近景備援（沒有實景圖磚時）：所有建物、樹木與綠地水域 */
export function nearQuery(b: Bounds): string {
  return `[out:json][timeout:60][bbox:${bbox(b)}];
(
  way["building"];
  relation["building"]["type"="multipolygon"];
  way["building:part"];
  way["man_made"~"^(tower|mast|chimney)$"];
  node["natural"="tree"];
  way["natural"~"^(water|wood)$"];
  way["landuse"~"^(grass|forest|meadow|village_green)$"];
  way["leisure"~"^(park|garden|pitch)$"];
);
out geom qt;`;
}
