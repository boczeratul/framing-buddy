import * as THREE from 'three';
import { M } from './materials';

// 樹木：以 InstancedMesh 在指定多邊形區域內散佈（可重現的偽亂數）

export interface TreeArea {
  polygon: [number, number][];
  /** 每平方公尺棵數 */
  density: number;
  /** 樹高範圍 */
  height?: [number, number];
}

export interface TreeRow {
  from: [number, number];
  to: [number, number];
  spacing: number;
  height?: [number, number];
}

function inside(poly: [number, number][], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

export function buildTrees(
  areas: TreeArea[],
  rows: TreeRow[],
  exclude: [number, number][][] = [],
  clip?: [number, number][],
): THREE.Group {
  let seed = 20240517;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const spots: { x: number; z: number; h: number }[] = [];

  for (const a of areas) {
    const xs = a.polygon.map((p) => p[0]);
    const zs = a.polygon.map((p) => p[1]);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const count = Math.round((x1 - x0) * (z1 - z0) * a.density);
    const [h0, h1] = a.height ?? [8, 15];
    for (let i = 0; i < count; i++) {
      const x = x0 + rnd() * (x1 - x0);
      const z = z0 + rnd() * (z1 - z0);
      if (!inside(a.polygon, x, z) || exclude.some((e) => inside(e, x, z))) continue;
      if (clip && !inside(clip, x, z)) continue;
      spots.push({ x, z, h: h0 + rnd() * (h1 - h0) });
    }
  }
  for (const r of rows) {
    const len = Math.hypot(r.to[0] - r.from[0], r.to[1] - r.from[1]);
    const n = Math.max(1, Math.round(len / r.spacing));
    const [h0, h1] = r.height ?? [9, 13];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      spots.push({
        x: r.from[0] + (r.to[0] - r.from[0]) * t,
        z: r.from[1] + (r.to[1] - r.from[1]) * t,
        h: h0 + rnd() * (h1 - h0),
      });
    }
  }

  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 1, 6).translate(0, 0.5, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunks = new THREE.InstancedMesh(trunkGeo, M.trunk, spots.length);
  const crowns = new THREE.InstancedMesh(crownGeo, M.foliage, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const color = new THREE.Color();
  spots.forEach((s, i) => {
    const trunkH = s.h * 0.34;
    m.compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(1, trunkH, 1));
    trunks.setMatrixAt(i, m);
    const r = s.h * (0.3 + rnd() * 0.1);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
    m.compose(new THREE.Vector3(s.x, trunkH + r * 0.75, s.z), q, new THREE.Vector3(r * (0.9 + rnd() * 0.25), r * (0.7 + rnd() * 0.2), r * (0.9 + rnd() * 0.25)));
    crowns.setMatrixAt(i, m);
    color.setHSL(0.24 + rnd() * 0.07, 0.25 + rnd() * 0.2, 0.42 + rnd() * 0.22);
    crowns.setColorAt(i, color);
    q.identity();
  });
  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
  }
  const g = new THREE.Group();
  g.name = 'trees';
  g.add(trunks, crowns);
  return g;
}
