import * as THREE from 'three';
import { curvatureDrop, distanceLatLon, toLatLon, toLocal, type LatLon } from '../geo';
import { sampleDEM } from './terrain';
import { snowLine, treeLine } from './season';

// 精細山體：地平線內最顯著的山峰（例如從河口湖、山中湖望向富士山）改用自建的 DEM 網格呈現，
// 取代 Google 遠距離的粗圖磚（照片烘焙光影、形狀簡化，換光線方向幾乎沒有變化）。
// - 50–80 m 網格（DEM z13，約 15 m／像素；範圍越大網格越粗），保留山脊與沖蝕溝；
// - 範圍約為相對高度的 3 倍（上限 12 km），讓與 Google 模型的接縫落在較平坦的山麓；
// - 依海拔、坡度、季節雪線上色（森林、裸露火山礫／岩石、積雪），並加上雜訊細節；
// - 頂點著色器沿太陽方向在高度圖上步進，計算山體自身的陰影（日出日落時稜線與溝谷的明暗）；
// - Google 模型在山體範圍（16 邊形）內挖空；網格邊緣略超出範圍並往下壓，接縫處由 Google 蓋過。

const SIDES = 16;
const MAX_MOUNTAINS = 2;

export interface PeakInfo {
  name: string;
  at: LatLon;
  ele: number;
}

interface Mountain {
  key: string;
  peak: PeakInfo;
  mesh: THREE.Mesh;
  /** Google 挖空範圍（場景座標） */
  mask: { x: number; z: number }[];
  center: { x: number; z: number };
  radius: number;
}

const snowUniform = { value: 3000 };
const treeUniform = { value: 2500 };

interface SunUniforms {
  uSunI0: { value: number };
  uSunScene: { value: number };
}

function makeMaterial(sunDir: THREE.Vector3, sun: SunUniforms, hm: THREE.DataTexture, origin: THREE.Vector2, size: number, originEle: number): THREE.MeshStandardMaterial {
  // 雙面：裙邊的繞向不必講究，網格底面也只會在接縫處被看到
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uHeight: { value: hm },
      uHmOrigin: { value: origin },
      uHmSize: { value: size },
      uSun: { value: sunDir },
      uOriginEle: { value: originEle },
      uSnow: snowUniform,
      uTree: treeUniform,
      uSunDirF: { value: sunDir },
      uSunI0: sun.uSunI0,
      uSunScene: sun.uSunScene,
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uHeight;
        uniform vec2 uHmOrigin;
        uniform float uHmSize;
        uniform vec3 uSun;
        uniform float uOriginEle;
        attribute float elevation;
        varying float vShadow;
        varying float vEle;
        varying vec3 vWPos;
        varying vec3 vWNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        {
          vec3 p = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          vWPos = p;
          vWNormal = normalize( mat3( modelMatrix ) * objectNormal );
          vEle = elevation;
          float sh = 1.0;
          if ( uSun.y > -0.06 ) {
            float t = 25.0;
            for ( int i = 0; i < 56; i ++ ) {
              vec3 q = p + uSun * t;
              vec2 uv = ( q.xz - uHmOrigin ) / uHmSize;
              if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;
              float h = texture2D( uHeight, uv ).r;
              sh = min( sh, clamp( ( q.y - h ) / ( 3.0 + t * 0.015 ), 0.0, 1.0 ) );
              if ( sh <= 0.0 ) break;
              t = t * 1.1 + 20.0;
            }
          } else {
            sh = 0.0;
          }
          vShadow = sh;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uSnow;
        uniform float uTree;
        uniform vec3 uSunDirF;
        uniform float uSunI0;
        uniform float uSunScene;
        varying float vShadow;
        varying float vEle;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        float fbHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
        float fbNoise( vec2 p ) {
          vec2 i = floor( p ), f = fract( p );
          vec2 u = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( fbHash( i ), fbHash( i + vec2( 1, 0 ) ), u.x ), mix( fbHash( i + vec2( 0, 1 ) ), fbHash( i + vec2( 1, 1 ) ), u.x ), u.y );
        }
        float fbFbm( vec2 p ) {
          float s = 0.0, a = 0.5;
          for ( int i = 0; i < 5; i ++ ) { s += a * fbNoise( p ); p *= 2.03; a *= 0.5; }
          return s;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float slope = 1.0 - clamp( vWNormal.y, 0.0, 1.0 );
          float n = fbFbm( vWPos.xz / 180.0 );
          float n2 = fbFbm( vWPos.xz / 35.0 );
          vec3 forest = mix( vec3( 0.13, 0.2, 0.11 ), vec3( 0.2, 0.26, 0.14 ), n );
          vec3 scrub = mix( vec3( 0.32, 0.3, 0.2 ), vec3( 0.4, 0.36, 0.24 ), n2 );
          vec3 scoria = mix( vec3( 0.34, 0.22, 0.17 ), vec3( 0.46, 0.33, 0.25 ), n2 );
          scoria = mix( scoria, vec3( 0.3, 0.28, 0.27 ), smoothstep( 0.45, 0.8, n ) * 0.6 );
          float treeEdge = uTree + ( n - 0.5 ) * 260.0;
          vec3 col = mix( forest, scrub, smoothstep( treeEdge - 180.0, treeEdge, vEle ) );
          col = mix( col, scoria, smoothstep( treeEdge, treeEdge + 250.0, vEle ) );
          // 積雪：雪線附近依雜訊呈條紋狀（溝谷積雪較久），陡坡較少
          float snowEdge = uSnow + ( n - 0.5 ) * 320.0 + ( n2 - 0.5 ) * 120.0 + slope * 260.0;
          float snow = smoothstep( snowEdge - 40.0, snowEdge + 40.0, vEle );
          col = mix( col, vec3( 0.93, 0.94, 0.97 ), snow );
          diffuseColor.rgb = col;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          // 細部起伏：以雜訊梯度擾動法線，避免大面積平滑得像塑膠
          vec2 e = vec2( 12.0, 0.0 );
          float h0 = fbFbm( vWPos.xz / 70.0 );
          float hx = fbFbm( ( vWPos.xz + e.xy ) / 70.0 );
          float hz = fbFbm( ( vWPos.xz + e.yx ) / 70.0 );
          vec3 pw = vec3( -( hx - h0 ), 0.0, -( hz - h0 ) ) * 3.0;
          normal = normalize( normal + ( viewMatrix * vec4( pw, 0.0 ) ).xyz );
        }`,
      )
      .replace(
        '#include <aomap_fragment>',
        `{
          // 依山體所在海拔補足日照（空氣稀薄、地平線較低）
          float hEle = max( vEle, 0.0 );
          float dip = degrees( sqrt( 2.0 * hEle / 6371000.0 ) );
          float alt = degrees( asin( clamp( uSunDirF.y, -1.0, 1.0 ) ) );
          float aboveEff = smoothstep( -0.8 - dip, 0.8 - dip, alt );
          float a = max( alt + dip, 0.1 );
          float am = 1.0 / ( sin( radians( a ) ) + 0.50572 * pow( a + 6.07995, -1.6364 ) ) * exp( -hEle / 8400.0 );
          float T = pow( 0.7, pow( am, 0.678 ) );
          float extra = max( 0.0, uSunI0 * T * aboveEff - uSunScene );
          vec3 warm = mix( vec3( 1.0, 0.3, 0.1 ), vec3( 1.0, 0.93, 0.85 ), smoothstep( 0.03, 0.45, T ) );
          float ndl = max( dot( normalize( vWNormal ), uSunDirF ), 0.0 );
          reflectedLight.directDiffuse += diffuseColor.rgb * warm * extra * ndl * vShadow * RECIPROCAL_PI;
          // 背光面偏冷、較暗；太陽越低，天空補光越弱，明暗對比越強
          float lowSun = 1.0 - smoothstep( 2.0, 20.0, alt );
          reflectedLight.indirectDiffuse *= mix( 0.7, 0.45, lowSun ) * vec3( 0.92, 0.96, 1.08 );
        }
        #include <aomap_fragment>`,
      )
      .replace(
        '#include <lights_fragment_begin>',
        THREE.ShaderChunk.lights_fragment_begin.replace(
          'getDirectionalLightInfo( directionalLight, directLight );',
          'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= vShadow;',
        ),
      );
  };
  m.customProgramCacheKey = () => 'fb-mountain';
  return m;
}

export class MountainLayer {
  readonly group = new THREE.Group();
  private items: Mountain[] = [];
  private token = 0;
  version = 0;

  constructor(private sunDir: THREE.Vector3, private sun: SunUniforms) {
    this.group.name = 'mountains';
  }

  setSeason(month: number, lat: number) {
    snowUniform.value = snowLine(month, lat);
    treeUniform.value = treeLine(lat);
  }

  /** 選出要精細呈現的山峰並建模（原點改變或山峰清單更新時呼叫） */
  async load(peaks: PeakInfo[], origin: LatLon, originEle: number) {
    const token = ++this.token;
    this.clear();
    const candidates = peaks
      .map((p) => {
        const relief = p.ele - originEle;
        const radius = Math.min(12000, Math.max(3000, relief * 3.2));
        const dist = distanceLatLon(origin, p.at);
        return { p, relief, radius, dist };
      })
      .filter((c) => c.relief > 1400 && c.dist > c.radius + 2500 && c.dist < 90000)
      .sort((a, b) => b.relief / b.dist - a.relief / a.dist)
      // 位在已選山體範圍內的次要山峰（例如富士山山腰的宝永山）不另外建
      .filter((c, i, arr) => !arr.slice(0, i).some((o) => distanceLatLon(o.p.at, c.p.at) < o.radius + c.radius * 0.5 && o.p.ele >= c.p.ele))
      .slice(0, MAX_MOUNTAINS);
    for (const c of candidates) {
      try {
        const m = await this.build(c.p, c.radius, originEle);
        if (token !== this.token) {
          m.mesh.geometry.dispose();
          return;
        }
        this.items.push(m);
        this.group.add(m.mesh);
        this.version++;
      } catch (e) {
        console.warn('[mountains] 山體建模失敗', c.p.name, e);
      }
    }
  }

  private clear() {
    for (const m of this.items) {
      m.mesh.geometry.dispose();
      (m.mesh.material as THREE.Material).dispose();
    }
    this.items = [];
    this.group.clear();
    this.version++;
  }

  /** Google 模型要挖空的範圍 */
  masks(): { x: number; z: number }[][] {
    return this.items.map((m) => m.mask);
  }

  /** 地形層在這些範圍內往下壓，避免與精細山體重疊 */
  sinks(): { x: number; z: number; r: number }[] {
    return this.items.map((m) => ({ ...m.center, r: m.radius * 1.08 }));
  }

  solids(): THREE.Object3D[] {
    return this.items.map((m) => m.mesh);
  }

  names(): string[] {
    return this.items.map((m) => m.peak.name);
  }

  private async build(peak: PeakInfo, radius: number, originEle: number): Promise<Mountain> {
    const c = toLocal(peak.at);
    // 挖空範圍：外接於半徑 radius 圓的 16 邊形
    const polyR = radius / Math.cos(Math.PI / SIDES);
    const mask = Array.from({ length: SIDES }, (_, i) => {
      const a = (i / SIDES) * Math.PI * 2;
      return { x: c.x + Math.cos(a) * polyR, z: c.z + Math.sin(a) * polyR };
    });
    const apothem = polyR * Math.cos(Math.PI / SIDES);
    const STEP = Math.max(50, Math.round(polyR / 150));
    const ext = polyR + 400;
    const n = Math.round((2 * ext) / STEP) + 1;
    const x0 = c.x - ext;
    const z0 = c.z - ext;
    const pts: LatLon[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push(toLatLon(x0 + i * STEP, z0 + j * STEP));
    const ele = await sampleDEM(pts, 13);

    // 到 16 邊形邊界的有號距離（正值＝外側）
    const outside = (x: number, z: number) => {
      const a = Math.atan2(z - c.z, x - c.x);
      const k = Math.floor(((a < 0 ? a + Math.PI * 2 : a) / (Math.PI * 2)) * SIDES);
      const mid = ((k + 0.5) / SIDES) * Math.PI * 2;
      return (x - c.x) * Math.cos(mid) + (z - c.z) * Math.sin(mid) - apothem;
    };

    const pos = new Float32Array(n * n * 3);
    const elevation = new Float32Array(n * n);
    const hm = new Uint16Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = x0 + i * STEP;
        const z = z0 + j * STEP;
        const d = outside(x, z);
        const dip = Math.min(1, Math.max(0, d / 200)) * 60;
        const y = ele[k] - originEle - curvatureDrop(Math.hypot(x, z)) - dip;
        pos.set([x, y, z], k * 3);
        elevation[k] = ele[k];
        hm[k] = THREE.DataUtils.toHalfFloat(y);
      }
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const cx = x0 + (i + 0.5) * STEP;
        const cz = z0 + (j + 0.5) * STEP;
        if (outside(cx, cz) > 380) continue;
        const a = j * n + i;
        const b = a + 1;
        const d = a + n;
        idx.push(a, d, b, b, d, d + 1);
      }
    // 裙邊：沿網格外緣往下補一圈垂直牆，蓋住與 Google 地面之間可能露出的縫隙
    const edgeCount = new Map<string, [number, number]>();
    for (let t = 0; t < idx.length; t += 3) {
      for (const [u, v] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        if (edgeCount.has(key)) edgeCount.delete(key);
        else edgeCount.set(key, [u, v]);
      }
    }
    const lowered = new Map<number, number>();
    const extraPos: number[] = [];
    const extraEle: number[] = [];
    const low = (v: number) => {
      let k = lowered.get(v);
      if (k === undefined) {
        k = n * n + extraEle.length;
        lowered.set(v, k);
        extraPos.push(pos[v * 3], pos[v * 3 + 1] - 150, pos[v * 3 + 2]);
        extraEle.push(elevation[v]);
      }
      return k;
    };
    for (const [u, v] of edgeCount.values()) {
      const lu = low(u);
      const lv = low(v);
      idx.push(u, lv, v, u, lu, lv);
    }
    const allPos = new Float32Array(pos.length + extraPos.length);
    allPos.set(pos);
    allPos.set(extraPos, pos.length);
    const allEle = new Float32Array(elevation.length + extraEle.length);
    allEle.set(elevation);
    allEle.set(extraEle, elevation.length);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(allPos, 3));
    geo.setAttribute('elevation', new THREE.BufferAttribute(allEle, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const tex = new THREE.DataTexture(hm, n, n, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    // 高度圖的 v 軸對應 z（第 j 列＝z0 + j·STEP）；網格點位於像素中心
    const size = n * STEP;
    const origin = new THREE.Vector2(x0 - STEP / 2, z0 - STEP / 2);
    const mesh = new THREE.Mesh(geo, makeMaterial(this.sunDir, this.sun, tex, origin, size, originEle));
    mesh.name = `mountain:${peak.name}`;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    return { key: peak.name, peak, mesh, mask, center: c, radius: polyR };
  }
}
