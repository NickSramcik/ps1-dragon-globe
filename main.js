// PS1-style viewer for the dragon snow-globe scene built by blender/build.py.
//
// PS1 mode: the scene renders to a 240-line target with a custom material
// that snaps vertices to that pixel grid, interpolates UVs without
// perspective correction (affine warp), lights per vertex, and fogs to the
// sky. A final pass dithers to 15-bit colour and scales up with no filtering.
//
// URL params for headless checks: ?t=<seconds> fast-forwards the clock,
// ?ps1=0, ?tex=ai, ?shake=<seconds into shake>, ?az=<deg>&el=<deg>&dist=<n>,
// ?freeze draws that one frame and stops. ?record exposes __step(dt) and
// __shake() for checks/record.mjs instead of running the loop; ?spin=<n> sets
// the auto-orbit speed.
// document.title gets a JSON status line once the model is loaded.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const params = new URLSearchParams(location.search);
const FF = parseFloat(params.get('t') || '0');
const LOW_H = 240;
const AI_TEXTURES = ['scales', 'snow', 'bark', 'pine', 'rock', 'wood'];
const SKY_TOP = new THREE.Color(0x3c468c), SKY_BOTTOM = new THREE.Color(0x080a23);
const FOG = new THREE.Color(0x141a40);

const state = {
  ps1: params.get('ps1') !== '0',
  tex: params.get('tex') === 'ai' ? 'ai' : 'procedural',
  shakeT: -1,            // seconds since the last shake, -1 = none
};

// ------------------------------------------------------------ renderer

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // everything stays in display space, like the PS1
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.55, 0);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 3.5;
controls.maxDistance = 11;
controls.maxPolarAngle = 1.5;
controls.autoRotate = !params.has('az');
controls.autoRotateSpeed = parseFloat(params.get('spin') || '0.5');
{
  const az = THREE.MathUtils.degToRad(parseFloat(params.get('az') ?? '35'));
  const el = THREE.MathUtils.degToRad(parseFloat(params.get('el') ?? '18'));
  const d = parseFloat(params.get('dist') ?? '6.0');
  camera.position.set(Math.sin(az) * Math.cos(el) * d, 0.55 + Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d);
}
controls.update();

const lowTarget = new THREE.WebGLRenderTarget(1, 1, {
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
});

// Final pass: Bayer-dither the low-res frame down to 5 bits per channel.
const post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { tFrame: { value: lowTarget.texture }, uRes: { value: new THREE.Vector2() } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: `
    uniform sampler2D tFrame; uniform vec2 uRes; varying vec2 vUv;
    float bayer(vec2 p){
      int x = int(mod(p.x, 4.)), y = int(mod(p.y, 4.));
      int m[16] = int[16](0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5);
      return float(m[y * 4 + x]) / 16. - 0.5;
    }
    void main(){
      vec2 px = floor(vUv * uRes);
      vec3 c = texture2D(tFrame, (px + .5) / uRes).rgb;
      c = floor(c * 31. + 0.5 + bayer(px) * 0.9) / 31.;
      gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
    }`,
  depthTest: false, depthWrite: false,
}));
const postScene = new THREE.Scene();
postScene.add(post);
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ------------------------------------------------------------ PS1 material

const shared = {
  uSnap: { value: new THREE.Vector2(320, 240) },
  uAffine: { value: 1 },
  uLightDir: { value: new THREE.Vector3(0.55, 0.9, 0.65).normalize() },
  uLight: { value: new THREE.Color(0.95, 0.88, 0.78) },
  uAmbient: { value: new THREE.Color(0.38, 0.42, 0.62) },
  uPointPos: { value: new THREE.Vector3() },
  uPoint: { value: new THREE.Color(1.0, 0.55, 0.15) },
  uFog: { value: FOG },
  uFogRange: { value: new THREE.Vector2(7, 16) },
  uTime: { value: 0 },
};

const PS1_VERT = `
  uniform vec2 uSnap; uniform float uAffine, uDouble;
  uniform vec3 uLightDir, uLight, uAmbient, uPointPos, uPoint;
  uniform vec2 uFogRange;
  varying vec3 vUvw; varying vec3 vLight; varying float vFog;
  void main(){
    vec4 world = modelMatrix * vec4(position, 1.);
    vec4 mv = viewMatrix * world;
    vec4 clip = projectionMatrix * mv;
    if (uSnap.x > 0.) {                       // wobble: snap to the low-res pixel grid
      vec2 ndc = clip.xy / clip.w;
      ndc = (floor((ndc * .5 + .5) * uSnap) + .5) / uSnap * 2. - 1.;
      clip.xy = ndc * clip.w;
    }
    vec3 n = normalize(mat3(modelMatrix) * normal);
    float d = dot(n, uLightDir);
    d = uDouble > .5 ? abs(d) : max(d, 0.);
    vec3 toP = uPointPos - world.xyz;
    float pd = max(dot(n, normalize(toP)), uDouble > .5 ? .6 : 0.);
    float att = 1. / (1. + dot(toP, toP) * 6.);
    vLight = uAmbient + uLight * d * .75 + uPoint * pd * att * 1.6;
    vFog = smoothstep(uFogRange.x, uFogRange.y, -mv.z);
    float w = mix(1., clip.w, uAffine);       // affine: interpolate uv*w and w, divide per pixel
    vUvw = vec3(uv * w, w);
    gl_Position = clip;
  }`;

const PS1_FRAG = `
  uniform sampler2D map; uniform vec3 uTint, uFog; uniform float uEmissive;
  varying vec3 vUvw; varying vec3 vLight; varying float vFog;
  void main(){
    vec3 t = texture2D(map, vUvw.xy / vUvw.z).rgb * uTint;
    vec3 c = t * mix(vLight, vec3(1.25), uEmissive);
    gl_FragColor = vec4(mix(c, uFog, vFog), 1.);
  }`;

const MAT_OPTS = {
  flame: { emissive: 1 },
  gem: { emissive: 0.45 },
  eye: { emissive: 0.35 },
};

function ps1Material(name, map, doubleSided) {
  const o = MAT_OPTS[name] || {};
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      map: { value: map },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uEmissive: { value: o.emissive || 0 },
      uDouble: { value: doubleSided ? 1 : 0 },
    },
    vertexShader: PS1_VERT, fragmentShader: PS1_FRAG,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

// One texture pair per material name; toggling swaps every material's map.
const texSets = {};   // name -> { procedural, ai, materials: [] }

function prepTexture(t) {
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  t.minFilter = t.magFilter = state.ps1 ? THREE.NearestFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function applyTextures() {
  for (const set of Object.values(texSets)) {
    const t = (state.tex === 'ai' && set.ai) || set.procedural;
    prepTexture(t);
    for (const m of set.materials) m.uniforms.map.value = t;
  }
}

// ------------------------------------------------------------ sky, stars, snow

{
  const sky = new THREE.Mesh(new THREE.SphereGeometry(40, 16, 12), new THREE.ShaderMaterial({
    uniforms: { top: { value: SKY_TOP }, bottom: { value: SKY_BOTTOM } },
    vertexShader: `varying float vH; void main(){ vH = normalize(position).y;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform vec3 top, bottom; varying float vH;
      void main(){ gl_FragColor = vec4(mix(bottom, top, smoothstep(-.2, .8, vH)), 1.); }`,
    side: THREE.BackSide, depthWrite: false,
  }));
  scene.add(sky);

  const n = 220, pos = new Float32Array(n * 3);
  const r = mulberry(11);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, y = 0.1 + r() * 0.9, s = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * s * 35, y * 35, Math.sin(a) * s * 35], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xc8d0ff, size: 1, sizeAttenuation: false })));
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same height function as build.py's ground(), in three's axes (x, -z).
function ground(x3, z3) {
  const x = x3, y = -z3, r = Math.hypot(x, y);
  let h = 0.05 * Math.sin(3 * x + 1) * Math.cos(2.5 * y) + 0.04 * Math.sin(5 * y + x);
  const hill = Math.max(0, 1 - Math.hypot(x + 0.3, y - 1.5) / 1.1);
  h += 0.45 * hill * hill;
  h *= Math.min(1, r / 0.9);
  const edge = Math.max(0, (r - 1.9) / 0.4);
  return h * (1 - edge) - 0.06 * edge;
}

const SNOW_N = 700, SNOW_R = 2.25, SNOW_TOP = 4.2;
const snow = {
  pos: new Float32Array(SNOW_N * 3), vel: new Float32Array(SNOW_N * 3),
  phase: new Float32Array(SNOW_N), rnd: mulberry(5),
};
function spawnFlake(i, anywhere) {
  const r = snow.rnd, a = r() * Math.PI * 2, d = Math.sqrt(r()) * SNOW_R;
  const x = Math.cos(a) * d, z = Math.sin(a) * d;
  snow.pos.set([x, anywhere ? ground(x, z) + r() * SNOW_TOP : SNOW_TOP, z], i * 3);
  snow.vel.set([0, -(0.25 + r() * 0.2), 0], i * 3);
  snow.phase[i] = r() * 100;
}
for (let i = 0; i < SNOW_N; i++) spawnFlake(i, true);
const snowGeo = new THREE.BufferGeometry();
snowGeo.setAttribute('position', new THREE.BufferAttribute(snow.pos, 3));
const snowMat = new THREE.ShaderMaterial({
  uniforms: { uSnap: shared.uSnap, uResY: { value: LOW_H }, uFog: shared.uFog, uFogRange: shared.uFogRange },
  vertexShader: `uniform vec2 uSnap; uniform float uResY; uniform vec2 uFogRange; varying float vFog;
    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.);
      vec4 clip = projectionMatrix * mv;
      if (uSnap.x > 0.) { vec2 ndc = clip.xy / clip.w;
        ndc = (floor((ndc * .5 + .5) * uSnap) + .5) / uSnap * 2. - 1.; clip.xy = ndc * clip.w; }
      gl_PointSize = clamp(1.5 * (uResY / 240.) * 6. / -mv.z, 1., 3. * uResY / 240.);
      vFog = smoothstep(uFogRange.x, uFogRange.y, -mv.z);
      gl_Position = clip;
    }`,
  fragmentShader: `uniform vec3 uFog; varying float vFog;
    void main(){ gl_FragColor = vec4(mix(vec3(.95, .97, 1.), uFog, vFog * .7), 1.); }`,
});
scene.add(new THREE.Points(snowGeo, snowMat));

function stepSnow(dt, t) {
  const p = snow.pos, v = snow.vel;
  for (let i = 0; i < SNOW_N; i++) {
    const k = i * 3;
    // ease back toward a gentle drifting fall
    const ph = snow.phase[i];
    const tx = Math.sin(t * 0.7 + ph) * 0.12, ty = -0.32, tz = Math.cos(t * 0.6 + ph * 1.3) * 0.12;
    const ease = 1 - Math.exp(-dt * 1.1);
    v[k] += (tx - v[k]) * ease; v[k + 1] += (ty - v[k + 1]) * ease; v[k + 2] += (tz - v[k + 2]) * ease;
    p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
    const r = Math.hypot(p[k], p[k + 2]);
    if (r > SNOW_R) {   // keep flakes inside the invisible globe
      p[k] *= SNOW_R / r; p[k + 2] *= SNOW_R / r;
      v[k] *= -0.3; v[k + 2] *= -0.3;
    }
    if (p[k + 1] > SNOW_TOP + 0.4) { p[k + 1] = SNOW_TOP + 0.4; v[k + 1] = Math.min(v[k + 1], 0); }
    if (p[k + 1] < ground(p[k], p[k + 2])) spawnFlake(i, false);
  }
  snowGeo.attributes.position.needsUpdate = true;
}

function kickSnow() {
  const r = snow.rnd, p = snow.pos, v = snow.vel;
  for (let i = 0; i < SNOW_N; i++) {
    const k = i * 3;
    if (r() < 0.55) {   // lift settled snow off the ground
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * SNOW_R;
      p[k] = Math.cos(a) * d; p[k + 2] = Math.sin(a) * d; p[k + 1] = ground(p[k], p[k + 2]) + 0.05;
    }
    const swirl = 1.5 + r() * 1.5, rr = Math.hypot(p[k], p[k + 2]) || 1;
    v[k] = -p[k + 2] / rr * swirl + (r() - 0.5);
    v[k + 2] = p[k] / rr * swirl + (r() - 0.5);
    v[k + 1] = 1.5 + r() * 3.5;
  }
}

// ------------------------------------------------------------ the model

const parts = {};
let shadow;
const loaded = new GLTFLoader().loadAsync('assets/dragon_globe.glb').then(async (gltf) => {
  let tris = 0;
  gltf.scene.traverse((o) => {
    if (o.name) parts[o.name] = o;
    if (!o.isMesh) return;
    tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
    const name = o.material.name;
    const set = texSets[name] ||= { procedural: o.material.map, ai: null, materials: [] };
    const m = ps1Material(name, set.procedural, o.material.side === THREE.DoubleSide);
    set.materials.push(m);
    o.material = m;
  });
  scene.add(gltf.scene);
  for (const [k, o] of Object.entries(parts)) o.userData.base = { r: o.rotation.clone(), p: o.position.clone(), s: o.scale.clone() };

  // Blob shadow under the dragon, PS1-game style.
  shadow = new THREE.Mesh(new THREE.CircleGeometry(0.62, 12), new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vP; void main(){ vP = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `varying vec2 vP; void main(){
      gl_FragColor = vec4(0.05, 0.06, 0.2, .45 * smoothstep(.62, .15, length(vP * vec2(1., .75)))); }`,
    transparent: true, depthWrite: false,
  }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, ground(0, 0) + 0.015, -0.05);
  scene.add(shadow);

  const loader = new THREE.TextureLoader();
  await Promise.all(AI_TEXTURES.map((n) => loader.loadAsync(`tex/ai/${n}.png`)
    .then((t) => { if (texSets[n]) texSets[n].ai = t; }).catch(() => {})));
  applyTextures();
  return { tris, ai: Object.values(texSets).filter((s) => s.ai).length };
});

// ------------------------------------------------------------ animation

const blink = { next: 2.5, t: -1 };
let flapBurst = { next: 4, t: -1 };

function animate(t, dt) {
  const P = parts;
  if (!P.Dragon) return;
  const b = (o) => o.userData.base;
  const sh = state.shakeT;
  const flinch = sh >= 0 ? Math.exp(-sh * 2.5) * Math.sin(Math.min(sh * 9, Math.PI)) : 0;

  // breathing
  const br = Math.sin(t * 2.1);
  P.Body.scale.set(1 + br * 0.02, 1 + br * 0.03 - flinch * 0.08, 1 + br * 0.015);
  P.Head.position.y = b(P.Head).p.y + br * 0.012;

  // head: slow look-around, jerks up on a shake
  P.Head.rotation.y = Math.sin(t * 0.37) * 0.35 + Math.sin(t * 0.91) * 0.08;
  P.Head.rotation.x = Math.sin(t * 2.1 + 0.6) * 0.04 - flinch * 0.35;

  // wings: lazy idle flutter plus an occasional full flap; flare on a shake
  if (t > flapBurst.next && flapBurst.t < 0) flapBurst.t = 0;
  let flap = Math.sin(t * 3) * 0.08;
  if (flapBurst.t >= 0) {
    flapBurst.t += dt;
    const ft = flapBurst.t;
    flap += Math.sin(ft * 11) * 0.55 * Math.sin(Math.min(ft / 1.3, 1) * Math.PI);
    if (ft > 1.3) { flapBurst.t = -1; flapBurst.next = t + 5 + Math.random() * 5; }
  }
  flap += flinch * 0.9;
  P.WingR.rotation.z = 0.15 + flap;
  P.WingL.rotation.z = -(0.15 + flap);
  P.WingR.rotation.y = P.WingL.rotation.y = 0;

  // tail sway and flame flicker
  P.Tail.rotation.y = Math.sin(t * 1.3) * 0.28 + flinch * 0.5;
  P.Tail.rotation.x = Math.sin(t * 0.8) * 0.06;
  const fl = 1 + Math.sin(t * 17) * 0.08 + Math.sin(t * 29 + 1) * 0.06;
  P.Flame.scale.set(1 / fl, fl * 1.05, 1 / fl);
  P.Flame.rotation.z = Math.sin(t * 7) * 0.12;
  P.Flame.getWorldPosition(shared.uPointPos.value);
  shared.uPointPos.value.y += 0.15;

  // blink every few seconds (eyes squash vertically)
  if (t > blink.next && blink.t < 0) blink.t = 0;
  let open = 1;
  if (blink.t >= 0) {
    blink.t += dt;
    open = Math.abs(Math.cos(Math.min(blink.t / 0.16, 1) * Math.PI)) * 0.92 + 0.08;
    if (blink.t > 0.16) { blink.t = -1; blink.next = t + 2.5 + Math.random() * 3.5; }
  }
  if (flinch > 0.3) open = 1.25;   // wide-eyed when shaken
  P.EyeL.scale.y = P.EyeR.scale.y = open;

  // gems spin and bob
  for (let i = 1; i <= 3; i++) {
    const g = P[`Gem${i}`];
    g.rotation.y = t * 1.6 + i;
    g.position.y = b(g).p.y + Math.sin(t * 2 + i * 2) * 0.05;
  }
}

// ------------------------------------------------------------ input

const hint = document.getElementById('hint');
function shake() { state.shakeT = 0; kickSnow(); hint.style.opacity = 0; }

let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 && performance.now() - down.t < 350) shake();
  down = null;
});
controls.addEventListener('start', () => { controls.autoRotate = false; });

const btn = (id) => document.getElementById(id);
function syncUi() {
  btn('ps1').textContent = state.ps1 ? 'PS1 on' : 'PS1 off';
  btn('ps1').classList.toggle('off', !state.ps1);
  btn('tex').textContent = `tex: ${state.tex}`;
}
btn('ps1').onclick = () => { state.ps1 = !state.ps1; applyMode(); syncUi(); };
btn('tex').onclick = () => { state.tex = state.tex === 'ai' ? 'procedural' : 'ai'; applyTextures(); syncUi(); };
btn('shake').onclick = shake;

function applyMode() {
  shared.uAffine.value = state.ps1 ? 1 : 0;
  resize();
  applyTextures();
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // portrait: keep the island's width in frame by widening the vertical fov
  const halfTan = Math.tan(THREE.MathUtils.degToRad(20)) / Math.min(1, camera.aspect);
  camera.fov = Math.min(75, THREE.MathUtils.radToDeg(2 * Math.atan(halfTan)));
  camera.updateProjectionMatrix();
  if (state.ps1) {
    const lw = Math.round(LOW_H * w / h);
    lowTarget.setSize(lw, LOW_H);
    shared.uSnap.value.set(lw, LOW_H);
    post.material.uniforms.uRes.value.set(lw, LOW_H);
    snowMat.uniforms.uResY.value = LOW_H;
  } else {
    shared.uSnap.value.set(0, 0);
    snowMat.uniforms.uResY.value = h * renderer.getPixelRatio();
  }
}
addEventListener('resize', resize);

// ------------------------------------------------------------ loop

const clock = new THREE.Clock();
let t = 0;
const shakeAt = params.has('shake') ? parseFloat(params.get('shake')) : null;

function frame(dt) {
  t += dt;
  shared.uTime.value = t;
  if (state.shakeT >= 0) state.shakeT += dt;
  animate(t, dt);
  stepSnow(dt, t);
  controls.update(dt);

  // camera jolt, decaying over about a second
  let jolt = null;
  if (state.shakeT >= 0 && state.shakeT < 1.5) {
    const s = state.shakeT, a = Math.exp(-s * 4) * 0.18;
    jolt = new THREE.Vector3(Math.sin(s * 47) * a, Math.sin(s * 59 + 1) * a * 0.7, 0);
    camera.position.add(jolt);
  }
  if (state.ps1) {
    renderer.setRenderTarget(lowTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
  } else {
    renderer.render(scene, camera);
  }
  if (jolt) camera.position.sub(jolt);
}

loaded.then((info) => {
  applyMode();
  syncUi();
  // fast-forward for headless screenshots, in fixed 1/30 s steps
  if (FF > 0 || shakeAt !== null) {
    const steps = Math.round(FF * 30);
    for (let i = 0; i < steps; i++) {
      t += 1 / 30; animate(t, 1 / 30); stepSnow(1 / 30, t);
    }
    if (shakeAt !== null) {
      shake();
      for (let i = 0; i < Math.round(shakeAt * 30); i++) {
        t += 1 / 30; state.shakeT += 1 / 30; animate(t, 1 / 30); stepSnow(1 / 30, t);
      }
    }
  }
  document.title = JSON.stringify({ ok: true, ...info, parts: Object.keys(parts).length });
  if (params.has('freeze')) frame(0);
  else if (params.has('record')) Object.assign(window, { __step: frame, __shake: shake });
  else renderer.setAnimationLoop(() => frame(Math.min(clock.getDelta(), 0.05)));
}).catch((e) => { document.title = JSON.stringify({ ok: false, err: String(e) }); console.error(e); });
