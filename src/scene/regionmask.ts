import * as THREE from 'three';

// 自建模型接手的區域：Google 圖磚在這些多邊形內的片段一律捨棄（含陰影深度），
// 避免與自建的精細模型重疊。多邊形以場景座標 (x, z) 表示，最多 4 個、每個最多 16 點。

const MAX_MASKS = 4;
const MAX_POINTS = 16;

export const MASK_UNIFORMS = {
  uMaskPts: { value: Array.from({ length: MAX_MASKS * MAX_POINTS }, () => new THREE.Vector2()) },
  uMaskStart: { value: new Array(MAX_MASKS).fill(0) as number[] },
  uMaskLen: { value: new Array(MAX_MASKS).fill(0) as number[] },
  uMaskCount: { value: 0 },
};

let polygons: { x: number; z: number }[][] = [];

/** 設定目前生效的遮罩多邊形 */
export function setMasks(polys: { x: number; z: number }[][]) {
  polygons = polys.slice(0, MAX_MASKS).map((p) => simplify(p, MAX_POINTS));
  let k = 0;
  polygons.forEach((poly, m) => {
    MASK_UNIFORMS.uMaskStart.value[m] = k;
    MASK_UNIFORMS.uMaskLen.value[m] = poly.length;
    for (const p of poly) MASK_UNIFORMS.uMaskPts.value[k++].set(p.x, p.z);
  });
  MASK_UNIFORMS.uMaskCount.value = polygons.length;
}

/** CPU 版判斷（射線偵測用） */
export function inMask(x: number, z: number): boolean {
  for (const poly of polygons) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** 點數過多時等距抽樣（遮罩只需大致外形） */
function simplify<T>(p: T[], max: number): T[] {
  if (p.length <= max) return p;
  return Array.from({ length: max }, (_, i) => p[Math.floor((i * p.length) / max)]);
}

const GLSL = /* glsl */ `
uniform vec2 uMaskPts[${MAX_MASKS * MAX_POINTS}];
uniform int uMaskStart[${MAX_MASKS}];
uniform int uMaskLen[${MAX_MASKS}];
uniform int uMaskCount;
varying vec3 vMaskWorld;
bool fbInMask( vec2 p ) {
  for ( int m = 0; m < ${MAX_MASKS}; m ++ ) {
    if ( m >= uMaskCount ) break;
    int s = uMaskStart[ m ];
    int n = uMaskLen[ m ];
    bool inside = false;
    for ( int i = 0; i < ${MAX_POINTS}; i ++ ) {
      if ( i >= n ) break;
      int j = i == 0 ? n - 1 : i - 1;
      vec2 a = uMaskPts[ s + i ];
      vec2 b = uMaskPts[ s + j ];
      if ( ( a.y > p.y ) != ( b.y > p.y ) && p.x < ( b.x - a.x ) * ( p.y - a.y ) / ( b.y - a.y ) + a.x ) inside = ! inside;
    }
    if ( inside ) return true;
  }
  return false;
}`;

const patched = new WeakSet<THREE.Material>();

export function applyMask(material: THREE.Material) {
  if (patched.has(material)) return;
  patched.add(material);
  const prev = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, MASK_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMaskWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 maskW = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          maskW = instanceMatrix * maskW;
        #endif
        vMaskWorld = ( modelMatrix * maskW ).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL}`)
      .replace('void main() {', 'void main() {\n  if ( fbInMask( vMaskWorld.xz ) ) discard;');
  };
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|fb-mask`;
  material.needsUpdate = true;
}

/** 陰影深度也要挖掉，否則被取代的 Google 建物仍會投下影子 */
export const maskedDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
applyMask(maskedDepthMaterial);
