import * as THREE from 'three';

// 近景／遠景交界（沒有 Google 圖磚時的 OSM 備援模式）：依片段與相機的水平距離在 shader 裡捨棄。
// - 'far'：距離小於半徑的部分捨棄（遠景模型讓給近景精細模型）
// - 'near'：距離大於半徑的部分捨棄（近景模型只顯示在半徑內）
// 半徑設為 0 即不裁切。

export interface RingUniforms {
  uRingEye: { value: THREE.Vector3 };
  uRingCut: { value: number };
}

export const ringEye = new THREE.Vector3();

/** 遠景程序化建物（OSM）：永遠讓出近景範圍 */
export const FAR_RING: RingUniforms = { uRingEye: { value: ringEye }, uRingCut: { value: 0 } };
/** 近景 OSM 精細建物：只顯示在半徑內 */
export const NEAR_RING: RingUniforms = { uRingEye: { value: ringEye }, uRingCut: { value: 1e9 } };

const patched = new WeakSet<THREE.Material>();

export function applyRing(material: THREE.Material, mode: 'far' | 'near', uniforms: RingUniforms) {
  if (patched.has(material)) return;
  patched.add(material);
  const sign = mode === 'far' ? '1.0' : '-1.0';
  const prev = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uRingEye = uniforms.uRingEye;
    shader.uniforms.uRingCut = uniforms.uRingCut;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRingWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 ringW = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          ringW = instanceMatrix * ringW;
        #endif
        vRingWorld = ( modelMatrix * ringW ).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vRingWorld;\nuniform vec3 uRingEye;\nuniform float uRingCut;',
      )
      .replace(
        'void main() {',
        `void main() {
        if ( ${sign} * ( length( vRingWorld.xz - uRingEye.xz ) - uRingCut ) < 0.0 ) discard;`,
      );
  };
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|ring-${mode}`;
  material.needsUpdate = true;
}
