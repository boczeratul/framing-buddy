import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LANDMARK_DEFS } from '../src/world/landmarks';
import { M, NIGHT_GLOW } from '../src/scene/materials';

// 開發工具：匯出地標 GLB（給 Unity 版使用）與離線預覽。由 tools/landmark.mjs 以無頭瀏覽器驅動。
// ?id=<地標 id>；window.exportGlb() 回傳 base64 GLB；window.render(views) 回傳各視角 PNG（data URL）。

const q = new URLSearchParams(location.search);
const def = LANDMARK_DEFS.find((d) => d.id === q.get('id'));
if (!def) throw new Error('unknown landmark ' + q.get('id'));
const inst = def.create();

// Unity 版依材質名稱微調 HDRP 材質，並以 emissiveFactor 判斷夜間發光材質（白天強度 0）
for (const [k, m] of Object.entries(M)) m.name = k;
for (const g of NIGHT_GLOW) {
  g.material.emissive.set(g.color);
  g.material.emissiveIntensity = 0;
}

declare global {
  interface Window {
    exportGlb(): Promise<string>;
    stats(): { meshes: number; vertices: number; triangles: number; materials: number };
    render(views: { eye: number[]; target: number[]; fov?: number; w?: number; h?: number; night?: boolean }[]): string[];
    ready: boolean;
  }
}

window.exportGlb = async () => {
  // 匯出副本：頂點去重（索引化）縮小檔案，外層再包一個同名節點（與既有地標 GLB 結構相同）
  const copy = inst.group.clone(true);
  copy.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) m.geometry = mergeVertices(m.geometry.clone(), 1e-4);
  });
  const root = new THREE.Group();
  root.name = def.id;
  root.add(copy);
  const buf = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

window.stats = () => {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  const mats = new Set<THREE.Material>();
  inst.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const n = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
    meshes++;
    const g = m.geometry;
    vertices += g.getAttribute('position').count * n;
    triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3 * n;
    mats.add(m.material as THREE.Material);
  });
  return { meshes, vertices, triangles, materials: mats.size };
};

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.add(inst.group);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ color: 0x77805f, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -3.5;
ground.receiveShadow = true;
scene.add(ground);
const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a5040, 1.3);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.position.set(-120, 160, 140);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 1, far: 600 });
scene.add(sun);

window.render = (views) => {
  const out: string[] = [];
  for (const v of views) {
    const w = v.w ?? 1280;
    const h = v.h ?? 800;
    renderer.setSize(w, h);
    const cam = new THREE.PerspectiveCamera(v.fov ?? 50, w / h, 0.1, 5000);
    cam.position.fromArray(v.eye);
    cam.lookAt(new THREE.Vector3().fromArray(v.target));
    scene.background = new THREE.Color(v.night ? 0x0b1020 : 0x9fb8d0);
    hemi.intensity = v.night ? 0.08 : 1.3;
    sun.intensity = v.night ? 0 : 2.6;
    renderer.render(scene, cam);
    out.push(renderer.domElement.toDataURL('image/png'));
  }
  return out;
};

window.ready = true;
