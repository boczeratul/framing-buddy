import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import * as SunCalc from 'suncalc';
import { ORIGIN } from '../geo';
import { NIGHT_GLOW, TOWER_GLOW } from './materials';

// 光線：依日期時間計算太陽／月亮位置，驅動天空、日光、陰影、霧氣、夜間燈光與自動曝光。

const DEG = Math.PI / 180;

// Preetham 天空模型在太陽低於地平線後幾乎全黑：補上暮光漸層與城市夜空光害
const skyShader = Sky.SkyShader as { fragmentShader: string };
skyShader.fragmentShader = skyShader.fragmentShader.replace(
  'gl_FragColor = vec4( texColor, 1.0 );',
  /* glsl */ `{
    float sunAltDeg = degrees( asin( clamp( vSunDirection.y, -1.0, 1.0 ) ) );
    float strength = exp( -pow( ( sunAltDeg + 2.5 ) / 5.5, 2.0 ) );
    float up = max( direction.y, 0.0 );
    vec2 dh = normalize( direction.xz + vec2( 1e-5 ) );
    vec2 sh = normalize( vSunDirection.xz + vec2( 1e-5 ) );
    float toward = dot( dh, sh ) * 0.5 + 0.5;
    vec3 warm = mix( vec3( 0.42, 0.30, 0.36 ), vec3( 1.0, 0.52, 0.24 ), toward * toward );
    vec3 zen = vec3( 0.09, 0.15, 0.34 );
    vec3 tw = mix( warm, zen, pow( up, 0.45 ) );
    texColor += tw * strength * 0.08 * ( 1.0 - cloudCoverage * 0.5 );
    float nightK = smoothstep( -4.0, -14.0, sunAltDeg );
    texColor += mix( vec3( 0.0085, 0.0065, 0.006 ), vec3( 0.0011, 0.0015, 0.0028 ), pow( up, 0.35 ) ) * nightK;
  }
  gl_FragColor = vec4( texColor, 1.0 );`,
);

// 霧改成物理正確的指數衰減（three 內建 FogExp2 為平方指數）
THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace(
  'fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
  'fogFactor = 1.0 - exp( - fogDensity * vFogDepth );',
);

export function dirFromAzAlt(azDeg: number, altDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const az = azDeg * DEG;
  const alt = altDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
}

/** 色溫（K）→ 線性 RGB（Tanner Helland 近似） */
function kelvin(k: number, out: THREE.Color): THREE.Color {
  const t = k / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  return out.setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- 天空顏色的 CPU 版本（與 Sky shader＋上方暮光補償相同公式），用來讓霧色貼合地平線 ----

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];

function skyRadiance(dir: THREE.Vector3, sun: THREE.Vector3, u: Record<string, THREE.IUniform>): number[] {
  const sunE = 1000 * Math.max(0, 1 - Math.exp(-((1.6110731556870734 - Math.acos(Math.min(1, Math.max(-1, sun.y)))) / 1.5)));
  const betaR = TOTAL_RAYLEIGH.map((v) => v * u.rayleigh.value);
  const c = 0.2 * u.turbidity.value * 10e-18;
  const betaM = MIE_CONST.map((v) => 0.434 * c * v * u.mieCoefficient.value);
  const zenith = Math.acos(Math.max(0, dir.y));
  const inv = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
  const sR = 8.4e3 * inv;
  const sM = 1.25e3 * inv;
  const cosT = dir.dot(sun);
  const x = cosT * 0.5 + 0.5;
  const rPhase = (3 / (16 * Math.PI)) * (1 + x * x);
  const g = u.mieDirectionalG.value;
  const mPhase = (1 / (4 * Math.PI)) * ((1 - g * g) / Math.pow(1 - 2 * g * cosT + g * g, 1.5));
  const mixK = Math.min(1, Math.max(0, Math.pow(1 - sun.y, 5)));
  const base = [0, 0.0003, 0.00075];
  // 暮光補償
  const altDeg = (Math.asin(Math.min(1, Math.max(-1, sun.y))) * 180) / Math.PI;
  const strength = Math.exp(-Math.pow((altDeg + 2.5) / 5.5, 2));
  const up = Math.max(dir.y, 0);
  const dh = new THREE.Vector2(dir.x, dir.z).normalize();
  const sh = new THREE.Vector2(sun.x, sun.z).normalize();
  const toward = dh.dot(sh) * 0.5 + 0.5;
  const warm = [0.42, 0.3, 0.36].map((a, i) => a + ([1.0, 0.52, 0.24][i] - a) * toward * toward);
  const zen = [0.09, 0.15, 0.34];
  const k = Math.pow(up, 0.45);
  const nightK = smooth(-4, -14, altDeg);
  const nk = Math.pow(up, 0.35);
  const night = [0.0085, 0.0065, 0.006].map((a, i) => a + ([0.0011, 0.0015, 0.0028][i] - a) * nk);
  return [0, 1, 2].map((i) => {
    const fex = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
    const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]);
    let lin = Math.pow(sunE * ratio * (1 - fex), 1.5);
    lin *= 1 + (Math.pow(sunE * ratio * fex, 0.5) - 1) * mixK;
    const tw = warm[i] + (zen[i] - warm[i]) * k;
    return (lin + 0.1 * fex) * 0.04 + base[i] + tw * strength * 0.08 * (1 - u.cloudCoverage.value * 0.5) + night[i] * nightK;
  });
}

const luminance = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** three.js 的 ACESFilmicToneMapping，回傳 0–1 線性值 */
function acesFilmic(rgb: number[], exposure: number): number[] {
  const v = rgb.map((c) => (c * exposure) / 0.6);
  const i = [
    0.59719 * v[0] + 0.35458 * v[1] + 0.04823 * v[2],
    0.076 * v[0] + 0.90834 * v[1] + 0.01566 * v[2],
    0.0284 * v[0] + 0.13383 * v[1] + 0.83777 * v[2],
  ].map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  return [
    1.60475 * i[0] - 0.53108 * i[1] - 0.07367 * i[2],
    -0.10208 * i[0] + 1.10813 * i[1] - 0.00605 * i[2],
    -0.00327 * i[0] - 0.07276 * i[1] + 1.07602 * i[2],
  ].map((x) => Math.min(1, Math.max(0, x)));
}

/** 在相機前方「無限遠」處、面向相機的日／月圓盤 */
function celestialDisc(angularDiameterDeg: number, fragment: string, uniforms: Record<string, THREE.IUniform>, quadScale = 1) {
  const D = 30000;
  const size = 2 * D * Math.tan((angularDiameterDeg / 2) * DEG) * quadScale;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vRight;
      varying vec3 vUp;
      varying vec3 vFwd;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vRight = normalize(mat3(modelMatrix) * vec3(1.0, 0.0, 0.0));
        vUp = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
        vFwd = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 vUv;
      varying vec3 vRight;
      varying vec3 vUp;
      varying vec3 vFwd;
      ${fragment}`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  const dir = new THREE.Vector3(0, 1, 0);
  mesh.onBeforeRender = (_r, _s, camera) => {
    mesh.position.copy(camera.position).addScaledVector(dir, D);
    mesh.lookAt(camera.position);
    mesh.updateMatrixWorld();
  };
  return { mesh, dir };
}

export interface CelestialInfo {
  sunAz: number;
  sunAlt: number;
  moonAz: number;
  moonAlt: number;
  moonFraction: number;
  moonPhase: number;
  times: SunCalc.SunTimes;
  night: number;
}

export class Environment {
  readonly group = new THREE.Group();
  readonly sky = new Sky();
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly moonLight = new THREE.DirectionalLight(0xaec4ff, 0);
  readonly hemi = new THREE.HemisphereLight(0xbfd4ff, 0x6b6250, 0.3);
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  /** 供 PMREM 產生環境光照的獨立天空場景 */
  readonly envScene = new THREE.Scene();
  /** 天空改變時遞增，各視圖據此重建環境貼圖 */
  envVersion = 0;
  info!: CelestialInfo;
  exposure = 0.5;

  private stars: THREE.Points;
  private sunDisc: ReturnType<typeof celestialDisc>;
  private moonDisc: ReturnType<typeof celestialDisc>;
  private fogExp: THREE.FogExp2;
  private envGround: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private shadowCenter = new THREE.Vector3(-150, 0, 0);

  constructor(scene: THREE.Scene) {
    this.sky.scale.setScalar(50000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 6;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.82;
    u.showSunDisc.value = 0;
    u.cloudScale.value = 0.00025;
    u.cloudElevation.value = 0.55;
    this.group.add(this.sky);

    const envSky = new THREE.Mesh(this.sky.geometry, this.sky.material);
    envSky.scale.setScalar(50);
    // 環境光的下半球：地面反射（否則天空盒下半部會把物體底面照得過亮）
    this.envGround = new THREE.Mesh(new THREE.CircleGeometry(40, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    this.envGround.position.y = -1;
    this.envScene.add(envSky, this.envGround);

    // 太陽：只在園區範圍內投影陰影
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -420; sc.right = 420; sc.top = 420; sc.bottom = -420;
    sc.near = 10; sc.far = 3000;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;
    this.sun.target.position.copy(this.shadowCenter);
    this.group.add(this.sun, this.sun.target, this.moonLight, this.moonLight.target, this.hemi);

    this.stars = this.makeStars();
    this.group.add(this.stars);

    this.sunDisc = celestialDisc(0.533, /* glsl */ `
      uniform vec3 color;
      void main() {
        #include <logdepthbuf_fragment>
        float r = length(vUv) * 3.0; // 以日盤半徑為單位；貼片為日盤的 3 倍大
        float disc = 1.0 - smoothstep(0.96, 1.0, r);
        float limb = mix(0.6, 1.0, sqrt(max(0.0, 1.0 - r * r)));
        float glow = exp(-max(r - 1.0, 0.0) * 1.6) * 0.18 * (1.0 - smoothstep(1.8, 3.0, r));
        gl_FragColor = vec4(color * (disc * limb + glow), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`, { color: { value: new THREE.Color() } }, 3);

    this.moonDisc = celestialDisc(0.518, /* glsl */ `
      uniform vec3 sunDir;
      uniform float brightness;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      void main() {
        #include <logdepthbuf_fragment>
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        vec3 nLocal = vec3(vUv, sqrt(1.0 - r2));
        vec3 n = normalize(nLocal.x * vRight + nLocal.y * vUp + nLocal.z * vFwd);
        float lit = smoothstep(-0.03, 0.06, dot(n, sunDir));
        float maria = 0.72 + 0.28 * noise(vUv * 3.0 + 4.0) - 0.12 * smoothstep(0.55, 0.8, noise(vUv * 2.2 + 11.0));
        float edge = 1.0 - smoothstep(0.94, 1.0, sqrt(r2));
        vec3 c = vec3(1.0, 0.97, 0.9) * maria * (lit + 0.015) * brightness * edge;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`, { sunDir: { value: this.sunDir }, brightness: { value: 1 } });
    this.group.add(this.sunDisc.mesh, this.moonDisc.mesh);
    // 日月圓盤只給取景相機看（地圖俯視不需要）
    this.sunDisc.mesh.layers.set(2);
    this.moonDisc.mesh.layers.set(2);
    this.stars.layers.set(2);

    this.fogExp = new THREE.FogExp2(0xaabbcc, 0.0003);
    scene.fog = this.fogExp;
    scene.add(this.group);
  }

  /**
   * 中央重點測光：鏡頭對著明亮天空（例如逆光、夕陽）時降低曝光，前景自然成為剪影。
   * 回傳此視角下建議的曝光值（不含曝光補償）。
   */
  meter(viewDir: THREE.Vector3): number {
    if (viewDir.y < -0.02) return this.exposure;
    const d = viewDir.clone();
    d.y = Math.max(d.y, 0.01);
    const lum = luminance(skyRadiance(d.normalize(), this.sunDir, this.sky.material.uniforms));
    return Math.min(this.exposure, 0.55 / Math.max(lum, 1e-5));
  }

  /** 自動曝光（模擬相機測光，保留晝夜差異）；曝光補償由取景器另外疊加 */
  private exposureFor(sunAlt: number, clouds: number): number {
    const brightness = 0.015 + 0.985 * smooth(-10, 25, sunAlt) * (1 - 0.35 * clouds);
    return 0.6 / Math.pow(brightness, 0.72);
  }

  /**
   * 霧在 three.js 中於色調映射之後混色，霧色＝畫面上地平線的顯示顏色。
   * 依相機方位計算，遠景才會自然融入天空。
   */
  setFogForView(azimuthDeg: number, exposure: number) {
    const a = azimuthDeg * DEG;
    const dir = new THREE.Vector3(Math.sin(a), 0.012, -Math.cos(a)).normalize();
    const lin = acesFilmic(skyRadiance(dir, this.sunDir, this.sky.material.uniforms), exposure);
    const clouds = this.sky.material.uniforms.cloudCoverage.value as number;
    // 陰天時地平線偏灰
    const gray = (lin[0] + lin[1] + lin[2]) / 3;
    const out = lin.map((c) => c + (gray - c) * clouds * 0.6);
    this.fogExp.color.setRGB(out[0], out[1], out[2], THREE.LinearSRGBColorSpace);
  }

  private makeStars(): THREE.Points {
    const n = 2500;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const y = rnd() * 0.98 + 0.02;
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(1 - y * y);
      pos.set([Math.cos(a) * rr * 40000, y * 40000, Math.sin(a) * rr * 40000], i * 3);
      const b = Math.pow(rnd(), 3) * 0.9 + 0.1;
      col.set([b, b, b * (0.9 + rnd() * 0.2)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, fog: false, depthWrite: false });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    p.onBeforeRender = (_r, _s, camera) => {
      p.position.copy(camera.position);
      p.updateMatrixWorld();
    };
    return p;
  }

  update(instant: Date, clouds: number, visibilityKm: number) {
    const s = SunCalc.getPosition(instant, ORIGIN.lat, ORIGIN.lon);
    const m = SunCalc.getMoonPosition(instant, ORIGIN.lat, ORIGIN.lon);
    const ill = SunCalc.getMoonIllumination(instant);
    const times = SunCalc.getTimes(instant, ORIGIN.lat, ORIGIN.lon);
    dirFromAzAlt(s.azimuth, s.altitude, this.sunDir);
    dirFromAzAlt(m.azimuth, m.altitude, this.moonDir);
    this.sunDisc.dir.copy(this.sunDir);
    this.moonDisc.dir.copy(this.moonDir);

    const alt = s.altitude;
    const night = smooth(-1, -9, alt); // 0 白天 → 1 入夜
    this.info = {
      sunAz: s.azimuth, sunAlt: alt, moonAz: m.azimuth, moonAlt: m.altitude,
      moonFraction: ill.fraction, moonPhase: ill.phase, times, night,
    };

    // 天空
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    u.cloudCoverage.value = clouds;
    u.cloudDensity.value = 0.3 + clouds * 0.5;
    u.turbidity.value = 2 + 6 * smooth(40, 3, visibilityKm);

    // 直射日光：以大氣質量估算穿透率與色溫
    const altR = Math.max(alt, -2) * DEG;
    const airMass = 1 / (Math.sin(Math.max(altR, 0.001)) + 0.50572 * Math.pow(Math.max(alt, 0) + 6.07995, -1.6364));
    const trans = Math.pow(0.7, Math.pow(airMass, 0.678));
    const above = smooth(-0.8, 0.8, alt);
    const cloudDim = 1 - 0.75 * clouds;
    this.sun.intensity = 4.3 * trans * above * cloudDim;
    kelvin(1900 + 3700 * smooth(0, 35, alt), this.sun.color);
    this.sun.visible = above > 0.001;
    this.sun.position.copy(this.shadowCenter).addScaledVector(this.sunDir, 1500);

    // 環境光地面：約 20% 反照率的城市地面，亮度隨日照
    const groundLum = 0.2 * (this.sun.intensity * Math.max(this.sunDir.y, 0) / Math.PI + 0.02 + 0.08 * (1 - night));
    this.envGround.material.color.setRGB(groundLum * 1.05, groundLum, groundLum * 0.9);

    // 月光
    const moonUp = smooth(-1, 3, m.altitude);
    this.moonLight.intensity = 0.025 * ill.fraction * moonUp * night * cloudDim;
    this.moonLight.visible = this.moonLight.intensity > 0.001;
    this.moonLight.position.copy(this.moonDir).multiplyScalar(1000);

    // 天光（環境貼圖以外的補光，夜間代表城市光害）
    this.hemi.intensity = 0.06 * (1 - night) + 0.035 * night + 0.2 * clouds * (1 - night);
    // 夜間補光代表路燈與城市光害（偏暖）
    this.hemi.color.set(night > 0.5 ? 0xb8a488 : 0xcfdcff);
    this.hemi.groundColor.set(night > 0.5 ? 0x7a6248 : 0x756b58);

    // 日月圓盤
    // 日盤亮度至少是周圍天空的數倍，否則低空時會被米氏散射的光暈蓋過
    const sunCol = (this.sunDisc.mesh.material as THREE.ShaderMaterial).uniforms.color.value as THREE.Color;
    const around = luminance(skyRadiance(this.sunDir, this.sunDir, u));
    sunCol.copy(this.sun.color).multiplyScalar(Math.max(60 * trans, 2.5 * around) * above * (1 - 0.9 * clouds));
    // 月面亮度：白天淡淡疊在天空上；夜晚依曝光調到接近白但保留月相與月海紋理
    const moonNight = 1.1 / this.exposureFor(alt, clouds);
    (this.moonDisc.mesh.material as THREE.ShaderMaterial).uniforms.brightness.value = (0.25 + (moonNight - 0.25) * night) * (1 - 0.8 * clouds);
    this.moonDisc.mesh.visible = m.altitude > -1;
    this.sunDisc.mesh.visible = alt > -1;
    (this.stars.material as THREE.PointsMaterial).opacity = night * night * (1 - clouds) * 0.9;
    this.stars.visible = night > 0.05;

    // 霧（能見度，Koschmieder：對比 2% 時的距離）
    this.fogExp.density = 3.912 / (visibilityKm * 1000);
    // 夜間建築照明與 101 燈光（每日顏色：週一紅、二橙、三黃、四綠、五藍、六靛、日紫）
    const weekday = new Date(instant.getTime() + 8 * 3600_000).getUTCDay();
    TOWER_GLOW.color = [0x9b5cff, 0xff4a3d, 0xff9a2e, 0xffd83a, 0x49e07a, 0x3d8bff, 0x5a5cff][weekday];
    const glow = smooth(2, -4, alt);
    for (const g of NIGHT_GLOW) {
      g.material.emissive.set(g.color);
      g.material.emissiveIntensity = g.intensity * glow;
    }

    this.exposure = this.exposureFor(alt, clouds);

    this.envVersion++;
  }
}
