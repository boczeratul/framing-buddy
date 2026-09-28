import * as THREE from 'three';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { distanceLatLon, toLocal, type LatLon } from '../geo';
import { tileTemplate } from './osm/vectortiles';
import { tilesAround } from './osm/tiles';
import type { Target } from './types';

// 山峰目標：OpenFreeMap 向量圖磚（z8）的 mountain_peak 圖層，取地平線內的主要山峰。
// 依「相對高度 ÷ 距離」（看起來有多醒目）排序，最多 12 座；同一座山的多個頂點（例如富士山與劍峰）只留一個。

const ZOOM = 8;
const MAX = 12;

interface Peak {
  id: string;
  name: string;
  at: LatLon;
  ele: number;
  volcano: boolean;
  rank: number;
}

export class PeakTargets {
  list: Peak[] = [];
  private token = 0;
  version = 0;

  async load(center: LatLon, radius: number, originEle: number) {
    const token = ++this.token;
    this.list = [];
    this.version++;
    try {
      const template = await tileTemplate();
      const tiles = tilesAround(center, radius, ZOOM);
      const found: Peak[] = [];
      await Promise.all(
        tiles.map(async (t) => {
          const r = await fetch(template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y)));
          if (!r.ok) return;
          const layer = new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer()))).layers.mountain_peak;
          for (let i = 0; layer && i < layer.length; i++) {
            const f = layer.feature(i);
            const p = f.properties as Record<string, unknown>;
            const ele = Number(p.ele);
            const name = String(p['name:zh-Hant'] ?? p.name ?? p['name:zh'] ?? '');
            if (!name || !Number.isFinite(ele) || f.type !== 1) continue;
            const g = f.toGeoJSON(t.x, t.y, t.z).geometry;
            if (g.type !== 'Point') continue;
            const at = { lon: g.coordinates[0], lat: g.coordinates[1] };
            if (distanceLatLon(center, at) > radius) continue;
            found.push({ id: `peak:${name}`, name, at, ele, volcano: p.class === 'volcano', rank: Number(p.rank) || 9 });
          }
        }),
      );
      if (token !== this.token) return;
      // 醒目程度：相對高度 ÷ 距離；火山、rank 高者優先
      const score = (p: Peak) => ((p.ele - originEle) / Math.max(2000, distanceLatLon(center, p.at))) * (p.volcano ? 1.5 : 1) / Math.sqrt(p.rank);
      found.sort((a, b) => score(b) - score(a));
      const kept: Peak[] = [];
      for (const p of found) {
        if (p.ele - originEle < 150) continue;
        if (kept.some((k) => k.name === p.name || distanceLatLon(k.at, p.at) < 1500)) continue;
        kept.push(p);
        if (kept.length >= MAX) break;
      }
      this.list = kept;
      this.version++;
    } catch (e) {
      console.warn('[peaks] 山峰資料取得失敗', e);
    }
  }

  targets(originEle: number, dropAt: (x: number, z: number) => number): Target[] {
    return this.list.map((p) => {
      const l = toLocal(p.at);
      const top = p.ele - originEle - dropAt(l.x, l.z);
      const relief = Math.min(2500, Math.max(200, p.ele - originEle));
      return {
        id: p.id,
        label: `${p.name}（${Math.round(p.ele)} m）`,
        base: new THREE.Vector3(l.x, top - relief, l.z),
        top: new THREE.Vector3(l.x, top, l.z),
        aimAt: 0.7,
        radius: 300,
        kind: 'peak' as const,
      };
    });
  }
}
