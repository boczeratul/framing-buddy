import * as THREE from 'three';
import { distanceLatLon, offsetLatLon, toLocal, type LatLon } from '../../geo';
import type { Target } from '../types';
import { namedTallQuery, overpass } from './overpass';
import { parseLength } from './parse';

// 可對準的目標：可視範圍內有名稱的高樓（≥150 m）與高塔（≥100 m），來自 OSM。
// 每次換原點或範圍時查一次；查詢失敗時只是少了這些目標，不影響其他功能。

interface Named {
  id: string;
  label: string;
  at: LatLon;
  height: number;
  /** 外框半對角線（公尺） */
  radius: number;
}

export class NamedTargets {
  private list: Named[] = [];
  private token = 0;
  version = 0;

  async load(center: LatLon, radius: number, excluded: (p: LatLon) => boolean) {
    const token = ++this.token;
    this.list = [];
    this.version++;
    const sw = offsetLatLon(center, -radius, -radius);
    const ne = offsetLatLon(center, radius, radius);
    const b = { s: sw.lat, w: sw.lon, n: ne.lat, e: ne.lon };
    const key = `named-v2/${b.s.toFixed(2)},${b.w.toFixed(2)},${b.n.toFixed(2)},${b.e.toFixed(2)}`;
    try {
      const els = await overpass(key, namedTallQuery(b)).promise;
      if (token !== this.token) return;
      const seen = new Set<string>();
      for (const el of els) {
        const tags = el.tags ?? {};
        const bb = el.bounds;
        const at = bb ? { lat: (bb.minlat + bb.maxlat) / 2, lon: (bb.minlon + bb.maxlon) / 2 } : el.lat != null && el.lon != null ? { lat: el.lat, lon: el.lon } : null;
        const radius = bb ? distanceLatLon({ lat: bb.minlat, lon: bb.minlon }, { lat: bb.maxlat, lon: bb.maxlon }) / 2 : 20;
        const height = parseLength(tags.height);
        const label = tags['name:zh-Hant'] ?? tags['name:zh'] ?? tags.name;
        if (!at || !height || !label || seen.has(label)) continue;
        if (distanceLatLon(center, at) > radius || excluded(at)) continue;
        seen.add(label);
        this.list.push({ id: `osm-${el.type}/${el.id}`, label, at, height, radius });
      }
      this.version++;
    } catch (e) {
      if ((e as Error)?.message !== 'cancelled') console.warn('[osm] 地標目標查詢失敗', e);
    }
  }

  targets(heightAt: (x: number, z: number) => number): Target[] {
    return this.list.map((n) => {
      const l = toLocal(n.at);
      const y = heightAt(l.x, l.z);
      return {
        id: n.id,
        label: n.label,
        base: new THREE.Vector3(l.x, y, l.z),
        top: new THREE.Vector3(l.x, y + n.height, l.z),
        aimAt: 0.5,
        radius: n.radius,
      };
    });
  }
}
