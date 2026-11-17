import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* =====================================================================
   0. UTILITIES
   ===================================================================== */
const UP = new THREE.Vector3(0, 1, 0);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function seededRandom(seed) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}
const rand = seededRandom(20240917);

/* =====================================================================
   1. RENDERER, SCENE, CAMERA
   ===================================================================== */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xd9a882, 160, 1150);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.62;   // allow low "looking-up" angles
controls.minDistance = 3;
controls.maxDistance = 900;

/* =====================================================================
   2. SKY + LIGHTING (golden hour)
   ===================================================================== */
const SUN_DIR = new THREE.Vector3(0.78, 0.2, -0.6).normalize();

function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      sunDir:  { value: SUN_DIR },
      top:     { value: new THREE.Color(0x3a64a8) },
      horizon: { value: new THREE.Color(0xffb27a) },
      bottom:  { value: new THREE.Color(0x6e5a48) }
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 sunDir, top, horizon, bottom;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(horizon, top, pow(h, 0.5)) : mix(horizon, bottom, pow(-h, 0.35));
        float s = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.55, 0.25) * pow(s, 6.0) * 0.55;   // warm glow
        col += vec3(1.0, 0.85, 0.6) * pow(s, 900.0) * 6.0;   // sun disc
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
}
const skyMaterial = createSkyMaterial();
const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 48, 24), skyMaterial);
sky.renderOrder = -1;
scene.add(sky);

// Environment map (PBR reflections) baked from the same sky
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMaterial));
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.65;
  pmrem.dispose();
}

const hemi = new THREE.HemisphereLight(0xffd8ae, 0x2f4a22, 0.55);
const ambient = new THREE.AmbientLight(0xffe2c4, 0.12);
const sun = new THREE.DirectionalLight(0xffb06a, 3.4);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 450 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(hemi, ambient, sun, sun.target);

/* =====================================================================
   3. TRACK (CatmullRomCurve3 + custom ribbon geometry)
   ===================================================================== */
const TRACK_HALF_W = 9;

// Spa-style lap: T1 hairpin -> downhill -> dip (Red Water) -> esses climbing (Raidillon) -> crest -> long straight ->
// right-hander at the top -> sweeping return -> chicane -> start/finish straight -> T1.
// Corner radii must stay above TRACK_HALF_W + 8.5 (hairpin: 20 m) or the inner guardrail folds over itself
const controlPoints = [
  [-150, 21, 119], [-100, 14, 96], [-55, 5, 70], [-15, 0, 48],
  [7.5, 1.9, 27], [15, 7.5, 0], [7.5, 15, -30], [18, 22.5, -67.5],
  [37.5, 28.8, -120], [75, 31.3, -180], [135, 31.3, -210], [195, 27.5, -165],
  [210, 23.8, -60], [180, 21.3, 60], [110, 22.5, 145], [88, 23.5, 152],
  [70, 23.5, 152], [64, 23.5, 152.9], [58.6, 23.5, 155.6], [54.2, 23.5, 159.7],
  [51.3, 23.5, 165], [48.3, 23.5, 170.3], [43.9, 23.5, 174.4], [38.5, 23.5, 177.1],
  [32.5, 23.5, 178], [14.5, 23.8, 178], [-40, 25, 178], [-110, 25, 178],
  [-165, 25, 178], [-190, 25, 178], [-197.7, 25, 176.5], [-204.2, 25, 172.1],
  [-208.5, 25, 165.6], [-210, 25, 157.9], [-208.4, 25, 150.2], [-204, 25, 143.8],
  [-197.5, 25, 139.5]
].map(p => new THREE.Vector3(...p));

// Catmull-Rom is only C1: its curvature, and with it a car's yaw rate, jumps at every control point.
// Resampling every ~2 m and averaging neighbours gives a centreline whose curvature changes smoothly.
const curve = (() => {
  const rough = new THREE.CatmullRomCurve3(controlPoints, true, 'centripetal');
  rough.arcLengthDivisions = 20000;
  const M = Math.round(rough.getLength() / 2);
  let pts = rough.getSpacedPoints(M).slice(0, M);
  for (let pass = 0; pass < 8; pass++) {
    pts = pts.map((p, i) => p.clone().add(pts[(i + M - 1) % M]).add(pts[(i + 1) % M]).divideScalar(3));
  }
  const c = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  c.arcLengthDivisions = 20000;   // the default 200 makes getPointAt surge and lag inside tight corners
  return c;
})();
const N = Math.round(curve.getLength() / 10) * 10;   // ~1 m per sample, a multiple of 10 for the racing-line solver

// Sample frames: p (point), t (tangent), x (lateral, horizontal), y (surface normal), dist (arc length)
const samples = [];
{
  let acc = 0;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u).normalize();
    const x = new THREE.Vector3().crossVectors(UP, t).normalize();
    const y = new THREE.Vector3().crossVectors(t, x).normalize();
    if (i > 0) acc += p.distanceTo(samples[i - 1].p);
    samples.push({ p, t, x, y, dist: acc });
  }
}
const TRACK_LEN = samples[N].dist;

// Frame at an arbitrary distance along the track (for cars)
function frameAt(dist) {
  const u = (((dist % TRACK_LEN) + TRACK_LEN) % TRACK_LEN) / TRACK_LEN;
  const p = curve.getPointAt(u);
  const t = curve.getTangentAt(u).normalize();
  const x = new THREE.Vector3().crossVectors(UP, t).normalize();
  const y = new THREE.Vector3().crossVectors(t, x).normalize();
  return { p, t, x, y };
}

// Put an object on the track surface, facing down the track (local +Z = direction of travel)
const basis = new THREE.Matrix4();
function placeOnTrack(obj, dist, lat = 0, lift = 0) {
  const f = frameAt(dist);
  obj.position.copy(f.p).addScaledVector(f.x, lat).addScaledVector(f.y, lift);
  obj.quaternion.setFromRotationMatrix(basis.makeBasis(f.x, f.y, f.t));
  return f;
}

// Where the curvature is high we place kerbs
const kerbMask = new Array(N).fill(false);
{
  const a = new THREE.Vector2(), b = new THREE.Vector2();
  for (let i = 0; i < N; i++) {
    const s0 = samples[i].t, s1 = samples[(i + 10) % N].t;
    a.set(s0.x, s0.z).normalize(); b.set(s1.x, s1.z).normalize();
    if (Math.acos(Math.min(1, a.dot(b))) > 0.075) {
      for (let k = -14; k <= 24; k++) kerbMask[(i + k + N) % N] = true;
    }
  }
}

// Generic ribbon builder along the track; edge(sample, side) returns a Vector3
function buildStrip({ edge, filter = null, color = null, vScale = 10 }) {
  const pos = [], uv = [], col = [];
  const push = v => pos.push(v.x, v.y, v.z);
  for (let i = 0; i < N; i++) {
    if (filter && !filter(i)) continue;
    const a = samples[i], b = samples[i + 1];
    const a0 = edge(a, 0), a1 = edge(a, 1), b0 = edge(b, 0), b1 = edge(b, 1);
    push(a0); push(b0); push(a1); push(a1); push(b0); push(b1);
    const va = a.dist / vScale, vb = b.dist / vScale;
    uv.push(0, va, 0, vb, 1, va, 1, va, 0, vb, 1, vb);
    if (color) { const c = color(i, a); for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
// Flat ribbon between lateral offsets o0 < o1, with lift (height) l0 / l1
const flatEdge = (o0, o1, l0 = 0, l1 = l0) => (s, side) =>
  s.p.clone().addScaledVector(s.x, side ? o1 : o0).addScaledVector(s.y, side ? l1 : l0);
// Vertical ribbon at lateral offset o from height h0 to h1
const wallEdge = (o, h0, h1) => (s, side) =>
  s.p.clone().addScaledVector(s.x, o).addScaledVector(UP, side ? h1 : h0);

// --- Procedural asphalt textures (color + roughness for wet-ish sheen on the racing line)
function asphaltTextures() {
  const S = 1024;
  const cCol = document.createElement('canvas'), cRgh = document.createElement('canvas');
  cCol.width = cCol.height = cRgh.width = cRgh.height = S;
  const gc = cCol.getContext('2d'), gr = cRgh.getContext('2d');
  const ic = gc.createImageData(S, S), ir = gr.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const u = x / S;
      const rubber = Math.exp(-Math.pow((u - 0.5) / 0.2, 2));     // darker rubbered racing line
      const n = (Math.random() - 0.5) * 34 + (Math.random() < 0.02 ? 40 : 0);
      const v = Math.max(0, Math.min(255, 62 - rubber * 14 + n));
      ic.data[i] = v; ic.data[i + 1] = v; ic.data[i + 2] = v + 3; ic.data[i + 3] = 255;
      const r = Math.max(0, Math.min(255, 215 - rubber * 90 + (Math.random() - 0.5) * 60));
      ir.data[i] = ir.data[i + 1] = ir.data[i + 2] = r; ir.data[i + 3] = 255;
    }
  }
  gc.putImageData(ic, 0, 0); gr.putImageData(ir, 0, 0);
  const map = new THREE.CanvasTexture(cCol);
  map.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(cRgh);
  for (const t of [map, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  return { map, roughnessMap, bumpMap: roughnessMap, bumpScale: 0.5 };   // same grain doubles as surface relief
}

// Tiling grain multiplied over the grass colours so turf stays crisp up close
function grassTexture(repeat) {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), im = g.createImageData(S, S);
  for (let i = 0; i < S * S * 4; i += 4) {
    const v = 195 + Math.random() * 60;
    im.data[i] = v * 0.94; im.data[i + 1] = v; im.data[i + 2] = v * 0.88; im.data[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

function createTrack() {
  const group = new THREE.Group();
  const W = TRACK_HALF_W;

  // Road surface
  const road = new THREE.Mesh(
    buildStrip({ edge: flatEdge(-W, W), vScale: 12 }),
    new THREE.MeshStandardMaterial({ ...asphaltTextures(), roughness: 1, metalness: 0.08 })
  );
  road.receiveShadow = true;
  group.add(road);

  // Red/white kerbs (raised on the outer edge)
  const red = new THREE.Color(0xd41c1c), white = new THREE.Color(0xf3f1ec);
  const kerbColor = (i, s) => (Math.floor(s.dist / 1.6) % 2 ? red : white);
  const kerbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05 });
  for (const side of [-1, 1]) {
    const edge = side < 0 ? flatEdge(-W - 0.05, -W + 1.1, 0.07, 0.015) : flatEdge(W - 1.1, W + 0.05, 0.015, 0.07);
    const kerb = new THREE.Mesh(buildStrip({ edge, filter: i => kerbMask[i], color: kerbColor }), kerbMat);
    kerb.receiveShadow = true;
    group.add(kerb);
  }

  // White edge lines (where there are no kerbs)
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 });
  for (const side of [-1, 1]) {
    const o0 = side < 0 ? -W + 0.3 : W - 0.55, o1 = o0 + 0.25;
    const line = new THREE.Mesh(buildStrip({ edge: flatEdge(o0, o1, 0.012), filter: i => !kerbMask[i] }), lineMat);
    line.receiveShadow = true;
    group.add(line);
  }

  // Grass shoulders sloping down to the terrain
  const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x4f7d33, roughness: 0.95, map: grassTexture(1) });
  for (const side of [-1, 1]) {
    const edge = side < 0 ? flatEdge(-W - 4, -W, -0.38, -0.01) : flatEdge(W, W + 4, -0.01, -0.38);
    const sh = new THREE.Mesh(buildStrip({ edge, vScale: 4 }), shoulderMat);
    sh.receiveShadow = true;
    group.add(sh);
  }

  // Armco guardrails + posts
  const railMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.85, roughness: 0.32, side: THREE.DoubleSide });
  const postGeo = new THREE.BoxGeometry(0.12, 0.9, 0.12);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8d92, metalness: 0.6, roughness: 0.5 });
  const POST_STEP = 5;
  const posts = new THREE.InstancedMesh(postGeo, postMat, Math.ceil(N / POST_STEP) * 2);
  let pi = 0;
  const m = new THREE.Matrix4();
  for (const side of [-1, 1]) {
    const off = side * (W + 8.5);
    for (const [h0, h1] of [[0.12, 0.42], [0.5, 0.8]]) {
      const rail = new THREE.Mesh(buildStrip({ edge: wallEdge(off, h0 - 0.35, h1 - 0.35) }), railMat);
      rail.castShadow = rail.receiveShadow = true;
      group.add(rail);
    }
    for (let i = 0; i < N; i += POST_STEP) {
      const s = samples[i];
      const p = s.p.clone().addScaledVector(s.x, off - side * 0.1);
      p.y += -0.35 + 0.45;
      m.makeRotationY(Math.atan2(s.t.x, s.t.z)).setPosition(p);
      posts.setMatrixAt(pi++, m);
    }
  }
  posts.count = pi;
  posts.castShadow = true;
  group.add(posts);

  return group;
}
scene.add(createTrack());

/* ---------- 3b. Start line, grid slots, light gantry ---------- */
const GRID_I = nearestTrack(-100, 178).i;      // on the start/finish straight between the chicane and the T1 hairpin
const GRID_DIST = samples[GRID_I].dist;
const GRID_SLOTS = [0, 1, 2, 3].map(k => ({ dist: GRID_DIST - 6 - k * 8, lat: k % 2 ? 3 : -3 }));   // staggered 2-wide
const startLights = [];                         // one material per red light, switched in the loop
{
  const paint = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
  const mark = (w, len, dist, lat, mat = paint) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, len).rotateX(-Math.PI / 2), mat);
    placeOnTrack(m, dist, lat, 0.02);
    m.receiveShadow = true;
    scene.add(m);
  };
  // chequered start/finish line: 24 x 2 squares of 0.75 m
  const c = document.createElement('canvas'); c.width = 24; c.height = 2;
  const g = c.getContext('2d');
  for (let i = 0; i < 48; i++) { g.fillStyle = (i + (i >= 24)) % 2 ? '#f3f1ec' : '#111'; g.fillRect(i % 24, i >= 24, 1, 1); }
  const chequer = new THREE.CanvasTexture(c);
  chequer.colorSpace = THREE.SRGBColorSpace; chequer.magFilter = THREE.NearestFilter;
  mark(TRACK_HALF_W * 2, 1.5, GRID_DIST, 0, new THREE.MeshStandardMaterial({ map: chequer, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }));
  for (const s of GRID_SLOTS) {
    mark(2.8, 0.18, s.dist + 3.0, s.lat);
    for (const sx of [-1, 1]) mark(0.18, 1.6, s.dist + 2.3, s.lat + sx * 1.31);
  }

  // gantry 10 m past the line, lights facing the grid (local -Z)
  const gantry = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x3c424b, metalness: 0.7, roughness: 0.4 });
  const box = (w, h, d, x, y, z, mat = steel) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; gantry.add(m);
  };
  const GX = TRACK_HALF_W + 1.2;
  for (const sx of [-1, 1]) box(0.35, 9, 0.35, sx * GX, 3.5, 0);
  box(GX * 2, 0.5, 0.5, 0, 7.6, 0);
  box(GX * 2, 0.12, 0.12, 0, 6.9, 0);
  box(4.4, 1.0, 0.3, 0, 6.3, -0.15, new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.5 }));
  for (let k = 0; k < 5; k++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a0000, emissive: 0xff1a1a, emissiveIntensity: 0 });
    startLights.push(mat);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.27, 20, 12), mat);
    bulb.position.set((2 - k) * 0.82, 6.3, -0.32);   // +x is the drivers' left, so light 1 is on their left
    gantry.add(bulb);
  }
  placeOnTrack(gantry, GRID_DIST + 10);
  scene.add(gantry);
}

/* =====================================================================
   4. TERRAIN (Ardennes hills, flattened along the track)
   ===================================================================== */
function nearestTrack(x, z) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < N; i += 3) {
    const p = samples[i].p, dx = p.x - x, dz = p.z - z, d = dx * dx + dz * dz;
    if (d < best) { best = d; bi = i; }
  }
  const c = bi;
  for (let k = -3; k <= 3; k++) {
    const i = (c + k + N) % N, p = samples[i].p, dx = p.x - x, dz = p.z - z, d = dx * dx + dz * dz;
    if (d < best) { best = d; bi = i; }
  }
  return { d: Math.sqrt(best), y: samples[bi].p.y, i: bi };
}

// Radius around (0, -10) that holds the whole circuit; terrain is levelled inside it, hills rise outside
const TRACK_R = Math.max(...samples.map(s => Math.hypot(s.p.x, s.p.z + 10)));

function naturalHeight(x, z) {
  let h = 14 * Math.sin(x * 0.008 + 0.5) * Math.cos(z * 0.009)
        + 7 * Math.sin(x * 0.021 + 2.0) * Math.sin(z * 0.017 + 1.0)
        + 2.2 * Math.sin(x * 0.06) * Math.cos(z * 0.05);
  const r = Math.hypot(x, z + 10);
  h += Math.max(0, r - TRACK_R - 70) * 0.2;   // ring of taller hills in the distance
  return h + 15;
}

const FLAT = TRACK_HALF_W + 10, BLEND = 42;
function groundHeight(x, z) {
  const nat = naturalHeight(x, z);
  if (Math.hypot(x, z + 10) > TRACK_R + 60) return nat;
  const n = nearestTrack(x, z);
  return lerp(n.y - 0.35, nat, smoothstep(FLAT, FLAT + BLEND, n.d));
}

function createTerrain() {
  const SIZE = 1700, SEG = 425;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cA = new THREE.Color(0x3f6e2a), cB = new THREE.Color(0x6a8f37), cMown = new THREE.Color(0x5c9a3a),
        cRock = new THREE.Color(0x6d6450), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = groundHeight(x, z);
    pos.setY(i, y);
    const noise = 0.5 + 0.5 * Math.sin(x * 0.05 + Math.cos(z * 0.04) * 2.0) * Math.cos(z * 0.031);
    c.copy(cA).lerp(cB, noise);
    if (Math.hypot(x, z + 10) < TRACK_R + 60) {
      const d = nearestTrack(x, z).d;
      c.lerp(cMown, 1 - smoothstep(FLAT - 2, FLAT + 8, d));
    }
    c.lerp(cRock, smoothstep(45, 90, y) * 0.6);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, map: grassTexture(SIZE / 4) }));
  mesh.receiveShadow = true;
  return mesh;
}
scene.add(createTerrain());

/* =====================================================================
   5. GRANDSTANDS + TRACKSIDE BOARDS
   ===================================================================== */
function createGrandstand(rows = 9, width = 42) {
  const g = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b3a8, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x5b6470, metalness: 0.7, roughness: 0.4 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide });
  const RISE = 0.6, DEPTH = 1.2;
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true; g.add(m); return m;
  };
  // stepped tiers (seats go up toward -z, facing +z)
  for (let r = 0; r < rows; r++) {
    const h = (r + 1) * RISE;
    add(new THREE.BoxGeometry(width, h, DEPTH), concrete, 0, h / 2, -r * DEPTH);
  }
  // foundation hiding uneven ground
  add(new THREE.BoxGeometry(width + 1, 14, rows * DEPTH + 1), concrete, 0, -7, -(rows - 1) * DEPTH / 2);
  // back wall, pillars, roof
  const topY = rows * RISE;
  add(new THREE.BoxGeometry(width, 5, 0.3), concrete, 0, topY + 2.5, -rows * DEPTH + 0.4);
  for (let x = -width / 2 + 1; x <= width / 2 - 1; x += 8) {
    add(new THREE.BoxGeometry(0.3, 5.5, 0.3), steel, x, topY + 2.75, -rows * DEPTH + 0.8);
  }
  const roof = add(new THREE.BoxGeometry(width + 2, 0.25, rows * DEPTH + 4), roofMat, 0, topY + 5.6, -(rows * DEPTH) / 2 + 1.5);
  roof.rotation.x = -0.07;

  // crowd (instanced)
  const palette = [0xe63946, 0xf1faee, 0xffb703, 0x219ebc, 0x8ecae6, 0xfb8500, 0x2a9d8f, 0x222222, 0xd62828];
  const SEAT = 0.85, perRow = Math.floor(width / SEAT);
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.85, 0.35),
    new THREE.MeshStandardMaterial({ roughness: 0.8 }), rows * perRow);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < perRow; s++) {
      if (rand() < 0.25) continue;
      m.makeTranslation(-width / 2 + 0.5 + s * SEAT + (rand() - 0.5) * 0.15, (r + 1) * RISE + 0.42, -r * DEPTH - 0.1);
      crowd.setMatrixAt(k, m);
      crowd.setColorAt(k, col.setHex(palette[Math.floor(rand() * palette.length)]));
      k++;
    }
  }
  crowd.count = k;
  crowd.castShadow = true;
  g.add(crowd);
  return g;
}

function boardTexture(text, bg, fg, w = 1024) {
  const c = document.createElement('canvas'); c.width = w; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, 128);
  g.fillStyle = fg; g.font = '800 82px "Barlow Condensed", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// Index of the lowest point = the "Red Water" dip
let iDip = 0;
for (let i = 0; i < N; i++) if (samples[i].p.y < samples[iDip].p.y) iDip = i;

function placeBeside(index, offset) {
  // choose the side whose spot isn't closer to another part of the track
  for (const sign of [1, -1]) {
    const s = samples[(index + N) % N];
    const p = s.p.clone().addScaledVector(s.x, sign * offset);
    if (nearestTrack(p.x, p.z).d > offset - 2) return { p, s, sign };
  }
  const s = samples[(index + N) % N];
  return { p: s.p.clone().addScaledVector(s.x, offset), s, sign: 1 };
}

function addGrandstand(index, offset, rows, width) {
  const { p, s } = placeBeside(index, offset);
  const gs = createGrandstand(rows, width);
  gs.position.set(p.x, 0, p.z);
  gs.lookAt(s.p.x, 0, s.p.z);
  gs.updateMatrixWorld();
  // rest on the highest ground under the footprint
  let y = s.p.y - 0.35;
  for (const [lx, lz] of [[-width / 2, 0], [width / 2, 0], [-width / 2, -rows * 1.2], [width / 2, -rows * 1.2]]) {
    const w = gs.localToWorld(new THREE.Vector3(lx, 0, lz));
    y = Math.max(y, groundHeight(w.x, w.z));
  }
  gs.position.y = y;
  scene.add(gs);
  return gs.position.clone();
}
const standSpots = [
  addGrandstand(iDip + 135, 30, 10, 46),
  addGrandstand(iDip + 150, 26, 8, 36),
  addGrandstand(GRID_I, 30, 9, 40)              // overlooking the start grid
];

// Trackside boards along the climb
{
  const boardMats = [
    new THREE.MeshStandardMaterial({ map: boardTexture('ARDENNES CIRCUIT', '#13233f', '#ffffff'), roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ map: boardTexture('ENDURANCE · OPEN WHEEL', '#f2efe6', '#b5121b'), roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ map: boardTexture('GOLDEN HOUR SESSION', '#ffb26b', '#1b120a'), roughness: 0.6 })
  ];
  const geo = new THREE.PlaneGeometry(9, 1.1);
  for (let k = 0; k < 9; k++) {
    const idx = iDip - 30 + k * 22;
    const s = samples[idx];
    for (const side of [-1, 1]) {
      const p = s.p.clone().addScaledVector(s.x, side * (TRACK_HALF_W + 8.2));
      const b = new THREE.Mesh(geo, boardMats[(k + (side > 0 ? 1 : 0)) % boardMats.length]);
      b.position.set(p.x, s.p.y + 0.25, p.z);
      b.lookAt(s.p.x, s.p.y + 0.25, s.p.z);
      b.castShadow = true;
      scene.add(b);
    }
  }
}

/* =====================================================================
   6. PINE FOREST (instanced cones + cylinders)
   ===================================================================== */
function createForest(count = 3600) {
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 2.4, 6).translate(0, 1.2, 0);
  const lowGeo = new THREE.ConeGeometry(2.4, 5.2, 12).translate(0, 4.4, 0);
  const highGeo = new THREE.ConeGeometry(1.65, 4.2, 12).translate(0, 7.4, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const lows = new THREE.InstancedMesh(lowGeo, leafMat, count);
  const highs = new THREE.InstancedMesh(highGeo, leafMat, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const col = new THREE.Color(), base = new THREE.Color(0x1d4a2a), alt = new THREE.Color(0x2f5e2c);
  let placed = 0, tries = 0;
  while (placed < count && tries < count * 8) {
    tries++;
    const ang = rand() * Math.PI * 2, rad = 25 + Math.sqrt(rand()) * 680;
    const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad - 10;
    // patchy forest density
    const dens = 0.5 + 0.5 * Math.sin(x * 0.018 + 1.3) * Math.cos(z * 0.021 - 0.4);
    if (rand() > dens + 0.25) continue;
    if (Math.hypot(x, z + 10) < TRACK_R + 80 && nearestTrack(x, z).d < TRACK_HALF_W + 15) continue;
    if (standSpots.some(s => Math.hypot(s.x - x, s.z - z) < 34)) continue;
    const s = 0.7 + rand() * 0.9;
    pos.set(x, groundHeight(x, z) - 0.2, z);
    q.setFromAxisAngle(UP, rand() * Math.PI * 2);
    sc.set(s, s * (0.85 + rand() * 0.4), s);
    m.compose(pos, q, sc);
    trunks.setMatrixAt(placed, m); lows.setMatrixAt(placed, m); highs.setMatrixAt(placed, m);
    col.copy(base).lerp(alt, rand());
    lows.setColorAt(placed, col); highs.setColorAt(placed, col.multiplyScalar(1.08));
    placed++;
  }
  const g = new THREE.Group();
  for (const im of [trunks, lows, highs]) {
    im.count = placed; im.castShadow = true; im.receiveShadow = true; g.add(im);
  }
  return g;
}
scene.add(createForest());

/* =====================================================================
   7. PROCEDURAL CAR MODELS  (forward = +Z, ground at y = 0)
   ===================================================================== */
const MAT = {
  carbon: new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.42, metalness: 0.35 }),
  tire:   new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.88 }),
  rim:    new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.9, roughness: 0.28 }),
  spoke:  new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.95, roughness: 0.22 }),
  glass:  new THREE.MeshPhysicalMaterial({ color: 0x0c1218, metalness: 0.3, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 }),
  tail:   new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1a1a, emissiveIntensity: 2.4 }),
  head:   new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1cc, emissiveIntensity: 2.2 })
};

// Box whose back (−z) and front (+z) faces have different width/height; bottom sits at y = 0
function taperedBox(wBack, hBack, wFront, hFront, len) {
  const g = new THREE.BoxGeometry(1, 1, len);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const front = p.getZ(i) > 0;
    p.setX(i, p.getX(i) * (front ? wFront : wBack));
    p.setY(i, (p.getY(i) + 0.5) * (front ? hFront : hBack));
  }
  g.computeVertexNormals();
  return g;
}

function addPart(group, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
  m.castShadow = true; m.receiveShadow = true;
  group.add(m);
  return m;
}

function strut(group, a, b, r, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = addPart(group, new THREE.CylinderGeometry(r, r, dir.length(), 6), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, dir.normalize());
  return m;
}

function createWheel(r, w, accentColor) {
  const group = new THREE.Group();
  const spin = new THREE.Group();
  group.add(spin);
  addPart(spin, new THREE.CylinderGeometry(r, r, w, 48).rotateZ(Math.PI / 2), MAT.tire);
  addPart(spin, new THREE.CylinderGeometry(r * 0.64, r * 0.64, w + 0.012, 36).rotateZ(Math.PI / 2), MAT.rim);
  for (let k = 0; k < 5; k++) {
    addPart(spin, new THREE.BoxGeometry(w + 0.024, 0.045, r * 1.2), MAT.spoke, 0, 0, 0, k * Math.PI / 5);
  }
  const ringMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.5 });
  addPart(spin, new THREE.CylinderGeometry(0.04, 0.04, w + 0.05, 6).rotateZ(Math.PI / 2), ringMat);   // centre-lock nut
  for (const sx of [-1, 1]) {
    addPart(spin, new THREE.TorusGeometry(r * 0.83, 0.013, 6, 48).rotateY(Math.PI / 2), ringMat, sx * (w / 2 + 0.002));
  }
  return { group, spin, r };
}

// Race number plate on both flanks (x = distance of the panel from the centreline)
function addNumber(car, n, x, y, z, w, h) {
  const mat = new THREE.MeshStandardMaterial({ map: boardTexture(String(n), '#f3f1ec', '#111111', 160), roughness: 0.5 });
  for (const sx of [-1, 1]) addPart(car, new THREE.PlaneGeometry(w, h), mat, sx * x, y, z, 0, sx * Math.PI / 2);
}

// Bake a front-to-back colour gradient (darker low down) into vertex colours
function paintGradient(mesh, front, back, zFront, zBack) {
  const g = mesh.geometry, p = g.attributes.position;
  const cf = new THREE.Color(front), cb = new THREE.Color(back), c = new THREE.Color();
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i) + mesh.position.z, y = p.getY(i) + mesh.position.y;
    c.copy(cb).lerp(cf, smoothstep(zBack, zFront, z));
    c.multiplyScalar(0.5 + 0.5 * smoothstep(0.1, 0.65, y));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Everything except the wheels moves into a "body" group so it can roll, pitch and heave on its suspension
function splitBody(car) {
  const ud = car.userData, body = new THREE.Group();
  body.add(...car.children.filter(c => !ud.wheels.some(w => w.group === c)));
  car.add(body);
  ud.body = body;
  ud.wheelbase = ud.wheels[0].group.position.z - ud.wheels[2].group.position.z;   // wheels are built front axle first
  return car;
}

/* ---------- 7a. F-Style Open Wheel Racer ---------- */
function createOpenWheelCar(front, back, number) {
  const car = new THREE.Group();
  const body = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, metalness: 0.75, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.06
  });
  const cyan = new THREE.MeshPhysicalMaterial({ color: front, metalness: 0.6, roughness: 0.3, clearcoat: 1 });

  // floor & diffuser
  addPart(car, new THREE.BoxGeometry(1.5, 0.04, 3.6), MAT.carbon, 0, 0.08, -0.2);
  addPart(car, taperedBox(1.0, 0.24, 1.0, 0.04, 0.45), MAT.carbon, 0, 0.08, -2.15);

  // nose, tub, sidepods, engine cover, airbox
  addPart(car, taperedBox(0.42, 0.32, 0.18, 0.14, 1.5), body, 0, 0.18, 1.95);
  addPart(car, taperedBox(0.72, 0.55, 0.5, 0.4, 1.4), body, 0, 0.12, 0.55);
  for (const sx of [-1, 1]) {
    addPart(car, taperedBox(0.36, 0.22, 0.48, 0.42, 1.7), body, sx * 0.56, 0.12, -0.25);
    addPart(car, new THREE.BoxGeometry(0.4, 0.3, 0.04), MAT.carbon, sx * 0.56, 0.32, 0.61);  // inlet
    addPart(car, new THREE.BoxGeometry(0.1, 0.03, 0.32), body, sx * 0.4, 0.67, 0.78);       // mirror
  }
  addPart(car, taperedBox(0.22, 0.3, 0.62, 0.6, 2.0), body, 0, 0.12, -1.05);
  addPart(car, taperedBox(0.3, 0.26, 0.3, 0.34, 0.55), body, 0, 0.68, -0.3);
  addPart(car, new THREE.BoxGeometry(0.2, 0.16, 0.04), MAT.carbon, 0, 0.88, -0.02);         // airbox intake

  // cockpit opening + driver helmet
  addPart(car, new THREE.BoxGeometry(0.42, 0.04, 0.7), MAT.carbon, 0, 0.655, 0.3);
  addPart(car, new THREE.SphereGeometry(0.14, 20, 14), new THREE.MeshPhysicalMaterial({ color: 0xf4f6f8, clearcoat: 1, roughness: 0.2 }), 0, 0.74, 0.18);
  addPart(car, new THREE.SphereGeometry(0.142, 20, 8, Math.PI / 2 - 0.8, 1.6, 1.2, 0.45), MAT.glass, 0, 0.74, 0.18); // visor

  // halo
  addPart(car, new THREE.TorusGeometry(0.36, 0.035, 8, 28, Math.PI).rotateX(Math.PI / 2), MAT.carbon, 0, 0.88, 0.15);
  for (const sx of [-1, 1]) strut(car, new THREE.Vector3(sx * 0.36, 0.64, 0.15), new THREE.Vector3(sx * 0.36, 0.88, 0.15), 0.03, MAT.carbon);
  strut(car, new THREE.Vector3(0, 0.56, 0.85), new THREE.Vector3(0, 0.88, 0.51), 0.032, MAT.carbon);

  // front wing (main plane + flap + endplates)
  addPart(car, new THREE.BoxGeometry(1.85, 0.035, 0.42), MAT.carbon, 0, 0.1, 2.62);
  addPart(car, new THREE.BoxGeometry(1.7, 0.03, 0.26), cyan, 0, 0.18, 2.5, -0.28);
  for (const sx of [-1, 1]) addPart(car, new THREE.BoxGeometry(0.03, 0.22, 0.62), MAT.carbon, sx * 0.93, 0.18, 2.56);

  // rear wing, beam wing, pillar, rain light
  addPart(car, new THREE.BoxGeometry(1.05, 0.04, 0.42), MAT.carbon, 0, 0.94, -2.2);
  addPart(car, new THREE.BoxGeometry(1.05, 0.03, 0.26), cyan, 0, 1.07, -2.34, 0.4);
  addPart(car, new THREE.BoxGeometry(0.9, 0.03, 0.2), MAT.carbon, 0, 0.46, -2.28);
  for (const sx of [-1, 1]) addPart(car, new THREE.BoxGeometry(0.03, 0.58, 0.78), body, sx * 0.54, 0.84, -2.22);
  addPart(car, new THREE.BoxGeometry(0.06, 0.55, 0.1), MAT.carbon, 0, 0.62, -2.12);
  addPart(car, new THREE.BoxGeometry(0.16, 0.06, 0.03), MAT.tail, 0, 0.36, -2.38);
  // onboard T-cam pod on the airbox, pitot on the nose, numbers on the rear-wing endplates
  addPart(car, new THREE.BoxGeometry(0.09, 0.07, 0.24), MAT.carbon, 0, 1.03, -0.22);
  strut(car, new THREE.Vector3(0, 0.5, 1.3), new THREE.Vector3(0, 0.62, 1.3), 0.008, MAT.carbon);
  addNumber(car, number, 0.557, 0.86, -2.22, 0.5, 0.4);
  // every part using the livery material gets the back -> front gradient
  for (const m of car.children) if (m.material === body) paintGradient(m, front, back, 2.6, -1.8);

  // wheels + suspension
  const wheels = [];
  const R = 0.36;
  for (const [z, w, tx] of [[1.8, 0.36, 0.82], [-1.75, 0.44, 0.8]]) {
    for (const sx of [-1, 1]) {
      const wh = createWheel(R, w, front);
      wh.group.position.set(sx * tx, R, z);
      car.add(wh.group);
      wheels.push(wh);
      const inner = sx * (tx - w / 2);
      strut(car, new THREE.Vector3(sx * 0.22, 0.42, z - 0.12), new THREE.Vector3(inner, 0.42, z), 0.018, MAT.carbon);
      strut(car, new THREE.Vector3(sx * 0.22, 0.22, z + 0.12), new THREE.Vector3(inner, 0.3, z), 0.018, MAT.carbon);
    }
  }

  car.userData = {
    wheels,
    dustPoints: [new THREE.Vector3(-0.8, 0.12, -2.0), new THREE.Vector3(0.8, 0.12, -2.0)],
    vortexPoints: [new THREE.Vector3(-0.54, 1.12, -2.55), new THREE.Vector3(0.54, 1.12, -2.55)],
    onboard: new THREE.Vector3(0, 1.12, -0.12)   // T-cam: halo, nose and front wheels in view
  };
  return splitBody(car);
}

/* ---------- 7b. LM-Style Endurance Hypercar ---------- */
function createHypercar(color, number) {
  const car = new THREE.Group();
  const red = new THREE.MeshPhysicalMaterial({ color, roughness: 0.52, metalness: 0.12, clearcoat: 0.25, clearcoatRoughness: 0.6 });
  const matteBlack = new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.7, metalness: 0.15 });
  const redDS = red.clone(); redDS.side = THREE.DoubleSide;

  // Main body: side profile extruded across the width
  const s = new THREE.Shape();
  s.moveTo(-2.45, 0.12);
  s.lineTo(2.25, 0.12);
  s.quadraticCurveTo(2.5, 0.13, 2.5, 0.25);
  s.quadraticCurveTo(2.15, 0.52, 1.35, 0.6);
  s.lineTo(-1.1, 0.64);
  s.quadraticCurveTo(-2.0, 0.68, -2.45, 0.8);
  s.lineTo(-2.45, 0.12);
  const bodyGeo = new THREE.ExtrudeGeometry(s, {
    depth: 1.66, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.05, bevelSegments: 4, curveSegments: 18
  });
  bodyGeo.rotateY(-Math.PI / 2).translate(0.83, 0, 0);
  addPart(car, bodyGeo, red);

  // Closed fender arches over each wheel
  const R = 0.36, WB = 1.55;
  for (const z of [WB, -WB]) {
    for (const sx of [-1, 1]) {
      addPart(car, new THREE.CylinderGeometry(0.5, 0.5, 0.62, 28, 1, true, 0, Math.PI).rotateZ(Math.PI / 2), redDS, sx * 0.82, R, z);
    }
  }

  // Closed cockpit canopy + windshield
  const canopy = addPart(car, new THREE.SphereGeometry(1, 36, 18), matteBlack, 0, 0.6, 0.05);
  canopy.scale.set(0.56, 0.42, 1.15);
  const ws = addPart(car, new THREE.SphereGeometry(1.012, 36, 18, Math.PI / 2 - 0.85, 1.7, 0.32, 1.0), MAT.glass, 0, 0.6, 0.05);
  ws.scale.copy(canopy.scale);
  for (const sx of [-1, 1]) {   // side windows
    const sw = addPart(car, new THREE.SphereGeometry(1.012, 20, 10, sx > 0 ? Math.PI - 0.5 : -0.5, 1.0, 0.55, 0.6), MAT.glass, 0, 0.6, 0.05);
    sw.scale.copy(canopy.scale);
  }

  // Shark fin
  const fin = new THREE.Shape();
  fin.moveTo(-0.55, 0.9); fin.lineTo(-2.3, 1.08); fin.lineTo(-2.3, 0.72); fin.lineTo(-0.9, 0.66); fin.lineTo(-0.55, 0.9);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.03, bevelEnabled: false });
  finGeo.rotateY(-Math.PI / 2).translate(0.015, 0, 0);
  addPart(car, finGeo, matteBlack);

  // Wide rear wing on swan-neck pillars
  addPart(car, new THREE.BoxGeometry(1.95, 0.05, 0.42), matteBlack, 0, 1.13, -2.3);
  addPart(car, new THREE.BoxGeometry(1.95, 0.03, 0.18), red, 0, 1.2, -2.48, 0.35);
  for (const sx of [-1, 1]) {
    addPart(car, new THREE.BoxGeometry(0.04, 0.44, 0.72), red, sx * 0.99, 1.02, -2.27);
    addPart(car, new THREE.BoxGeometry(0.05, 0.4, 0.12), matteBlack, sx * 0.35, 0.95, -2.18);
  }

  // Splitter, skirts, diffuser, dive planes
  addPart(car, new THREE.BoxGeometry(1.9, 0.03, 0.42), matteBlack, 0, 0.09, 2.32);
  for (const sx of [-1, 1]) {
    addPart(car, new THREE.BoxGeometry(0.08, 0.2, 2.3), matteBlack, sx * 0.97, 0.2, 0);
    addPart(car, new THREE.BoxGeometry(0.22, 0.02, 0.18), matteBlack, sx * 0.85, 0.32, 2.3, 0, 0, sx * 0.2);
    addPart(car, new THREE.BoxGeometry(0.12, 0.06, 0.09), red, sx * 0.98, 0.84, 0.95);   // mirrors
  }
  addPart(car, new THREE.BoxGeometry(1.7, 0.26, 0.32), matteBlack, 0, 0.2, -2.42);
  for (let k = -2; k <= 2; k++) addPart(car, new THREE.BoxGeometry(0.02, 0.24, 0.35), matteBlack, k * 0.3, 0.2, -2.55);

  // Lights
  for (const sx of [-1, 1]) addPart(car, new THREE.BoxGeometry(0.36, 0.05, 0.08), MAT.head, sx * 0.6, 0.42, 2.12, -0.55);
  addPart(car, new THREE.BoxGeometry(1.7, 0.04, 0.04), MAT.tail, 0, 0.72, -2.53);

  // Roof scoop + door numbers
  addPart(car, taperedBox(0.2, 0.05, 0.3, 0.16, 0.7), matteBlack, 0, 0.92, -0.35);
  addNumber(car, number, 0.936, 0.44, -0.3, 0.5, 0.28);

  // Wheels
  const wheels = [];
  for (const z of [WB, -WB]) {
    for (const sx of [-1, 1]) {
      const wh = createWheel(R, 0.38, color);
      wh.group.position.set(sx * 0.82, R, z);
      car.add(wh.group);
      wheels.push(wh);
    }
  }

  car.userData = {
    wheels,
    dustPoints: [new THREE.Vector3(-0.85, 0.12, -2.2), new THREE.Vector3(0.85, 0.12, -2.2)],
    vortexPoints: [new THREE.Vector3(-0.99, 1.2, -2.65), new THREE.Vector3(0.99, 1.2, -2.65)],
    onboard: new THREE.Vector3(0, 1.14, 0.3)     // roof cam: canopy, bonnet and front arches in view
  };
  return splitBody(car);
}

/* =====================================================================
   8. PARTICLE TRAILS (dust + wing-tip air wake)
   ===================================================================== */
class ParticleTrail {
  constructor(count, color, opacity) {
    this.count = count;
    this.head = 0;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count).fill(1);
    this.size0 = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.size = new Float32Array(count);
    this.opacity = opacity;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uScale: { value: window.innerHeight * 0.5 } },
      vertexShader: /* glsl */`
        attribute float aAlpha;
        attribute float aSize;
        uniform float uScale;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * vAlpha);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }
  emit(p, v, life, size) {
    const i = this.head, j = i * 3;
    this.head = (this.head + 1) % this.count;
    this.pos[j] = p.x; this.pos[j + 1] = p.y; this.pos[j + 2] = p.z;
    this.vel[j] = v.x; this.vel[j + 1] = v.y; this.vel[j + 2] = v.z;
    this.life[i] = this.maxLife[i] = life;
    this.size0[i] = size;
  }
  update(dt) {
    const drag = Math.exp(-2.2 * dt);
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      this.life[i] -= dt;
      const j = i * 3, k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.vel[j] *= drag; this.vel[j + 1] = this.vel[j + 1] * drag + 0.5 * dt; this.vel[j + 2] *= drag;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      this.alpha[i] = this.opacity * k * Math.min(1, (1 - k) * 8);
      this.size[i] = this.size0[i] * (1 + (1 - k) * 2.5);
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.aAlpha.needsUpdate = a.aSize.needsUpdate = true;
  }
}
const dustTrail = new ParticleTrail(6400, 0xc9ac86, 0.45);   // sized for four cars
const wakeTrail = new ParticleTrail(3200, 0xf4f1ea, 0.55);
scene.add(dustTrail.points, wakeTrail.points);

// Emits along the path travelled since last frame so trails stay continuous at speed
function emitFromCar(car, frame, speed, dt) {
  const ud = car.userData;
  ud.prev ??= {};
  const tmp = new THREE.Vector3(), v = new THREE.Vector3();
  const sets = [
    { pts: ud.dustPoints, trail: dustTrail, rate: 110, key: 'd' },
    { pts: ud.vortexPoints, trail: wakeTrail, rate: 160, key: 'v' }
  ];
  for (const { pts, trail, rate, key } of sets) {
    pts.forEach((lp, idx) => {
      const id = key + idx;
      const now = car.localToWorld(tmp.copy(lp)).clone();
      const prev = ud.prev[id] ?? now;
      ud.prev[id] = now;
      ud.acc ??= {};
      ud.acc[id] = (ud.acc[id] ?? 0) + rate * dt * (0.4 + speed / 70);
      const n = Math.floor(ud.acc[id]);
      ud.acc[id] -= n;
      for (let k = 0; k < n; k++) {
        const p = prev.clone().lerp(now, (k + rand()) / n);
        if (key === 'd') {
          v.copy(frame.t).multiplyScalar(-speed * 0.12)
            .addScaledVector(frame.x, (rand() - 0.5) * 3)
            .addScaledVector(UP, 0.4 + rand() * 1.4);
          trail.emit(p, v, 0.9 + rand() * 0.9, 0.5 + rand() * 0.7);
        } else {
          v.copy(frame.t).multiplyScalar(-speed * 0.04).addScaledVector(UP, rand() * 0.3);
          trail.emit(p, v, 0.35 + rand() * 0.25, 0.14 + rand() * 0.08);
        }
      }
    });
  }
}

/* =====================================================================
   9. RACE PHYSICS (point mass on a friction circle)
   ===================================================================== */
const G = 9.81, DS = TRACK_LEN / N;
const TRACTION = 0.65;   // share of the tyre grip the driven rear axle can put down
const LAT_LIM = TRACK_HALF_W - 1.3;   // how far a car's centre may go from the centreline (outer wheels on the kerb)
const LOAD_MAX = 3.5 * G;             // tyres saturate here, however hard a dip squeezes the car
const wrap = i => ((i % N) + N) % N;
const clamp = THREE.MathUtils.clamp;

// Catmull-Rom through four evenly spaced values, t in [0, 1] between b and c
const cr = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);

// Racing line: lateral offset from the centreline at every sample. A coarse chain of points (one per 10 samples,
// each free to slide across the road) is relaxed until it bends as little as possible -> outside-inside-outside.
const lineLat = (() => {
  const STEP = 10, M = N / STEP, o = new Float64Array(M);
  const at = c => { c = (c % M + M) % M; const s = samples[c * STEP]; return [s.p.x + s.x.x * o[c], s.p.z + s.x.z * o[c]]; };
  for (let sweep = 0; sweep < 4000; sweep++) {
    for (let c = 0; c < M; c++) {
      const s = samples[c * STEP], a = at(c - 2), b = at(c - 1), d = at(c + 1), e = at(c + 2);
      // the spot that minimises bending given the four neighbours, projected onto this point's lateral axis
      const tx = (4 * (b[0] + d[0]) - a[0] - e[0]) / 6 - s.p.x, tz = (4 * (b[1] + d[1]) - a[1] - e[1]) / 6 - s.p.z;
      o[c] = clamp(tx * s.x.x + tz * s.x.z, -LAT_LIM, LAT_LIM);
    }
  }
  // Catmull-Rom between the coarse points so the line has no kinks
  const oc = c => o[(c % M + M) % M];
  let line = Array.from({ length: N }, (_, i) => {
    const c = Math.floor(i / STEP);
    return clamp(cr(oc(c - 1), oc(c), oc(c + 1), oc(c + 2), (i % STEP) / STEP), -LAT_LIM, LAT_LIM);
  });
  // The clamp leaves a kink where the line meets the kerb at an angle (a yaw jolt); averaging rounds it, inside the limits
  for (let pass = 0; pass < 2; pass++) {
    line = line.map((_, i) => { let s = 0; for (let j = -8; j <= 8; j++) s += line[wrap(i + j)]; return s / 17; });
  }
  return line;
})();
// Per-sample value interpolated at a distance, so limits and slopes ramp instead of stepping every sample
const interp = (arr, d) => {
  const f = (((d % TRACK_LEN) + TRACK_LEN) % TRACK_LEN) / DS, i = Math.floor(f) % N;
  return lerp(arr[i], arr[(i + 1) % N], f - Math.floor(f));
};
// Cubic, not linear: a polyline offset would kink the car's heading at every sample (visible in slow corners)
const lineAt = d => {
  const f = (((d % TRACK_LEN) + TRACK_LEN) % TRACK_LEN) / DS, i = Math.floor(f) % N;
  return cr(lineLat[wrap(i - 1)], lineLat[i], lineLat[wrap(i + 1)], lineLat[wrap(i + 2)], f - Math.floor(f));
};
const sampleIndex = d => Math.floor((((d % TRACK_LEN) + TRACK_LEN) % TRACK_LEN) / DS) % N;

// Geometry of the racing line per sample
const linePts = Array.from(lineLat, (o, i) => samples[i].p.clone().addScaledVector(samples[i].x, o));
const segLen = linePts.map((p, i) => p.distanceTo(linePts[(i + 1) % N]));   // true length of the step to the next sample
const heading = linePts.map((_, i) => {
  const a = linePts[wrap(i - 1)], b = linePts[wrap(i + 1)];
  return Math.atan2(b.x - a.x, b.z - a.z);
});
// Signed horizontal curvature (1/m); + = left-hander (toward +x)
const kappa = heading.map((_, i) => {
  const d = heading[wrap(i + 4)] - heading[wrap(i - 4)];
  let len = 0;
  for (let j = -4; j < 4; j++) len += segLen[wrap(i + j)];
  return Math.atan2(Math.sin(d), Math.cos(d)) / len;
});
// Vertical curvature (1/m): + in a dip (compression), - over a crest (the car goes light)
const kappaV = heading.map((_, i) => (Math.asin(samples[wrap(i + 4)].t.y) - Math.asin(samples[wrap(i - 4)].t.y)) / (8 * DS));
const gNormal = heading.map((_, i) => G * Math.hypot(samples[i].t.x, samples[i].t.z));   // gravity pressing onto a sloped road
const slope = heading.map((_, i) => samples[i].t.y);

// Per-kg car model. mu: tyre friction; aero: downforce per v^2; power: W/kg; drag: a = drag v^2; soft: suspension travel
const OW = { mu: 1.75, aero: 0.0035, power: 700, drag: 0.0010, soft: 1 };
const HC = { mu: 1.55, aero: 0.0024, power: 520, drag: 0.0006, soft: 1.6 };

// Normal force per kg: gravity + downforce + the road pushing up in a dip / falling away over a crest
const load = (c, v, gN, kV) => clamp(gN + (c.aero + kV) * v * v, 0, LOAD_MAX);
// Fastest a corner can be taken: mu * load(v) = v^2 * curvature
const cornerSpeed = (c, k, gN, kV) => {
  const d = Math.abs(k) - c.mu * (c.aero + kV);
  return Math.min(d > 1e-5 ? Math.sqrt(c.mu * gN / d) : Infinity, Math.sqrt(c.mu * LOAD_MAX / Math.abs(k)));
};
// Highest speed at every sample (on the racing line) from which the car can still brake for what lies ahead
function speedProfile(c) {
  const vTop = Math.cbrt(c.power / c.drag);                     // where drag eats all the power
  const v = kappa.map((k, i) => Math.min(vTop, cornerSpeed(c, k, gNormal[i], kappaV[i])));
  for (let n = 2 * N; n-- > 0;) {                               // backwards, two laps so it wraps the loop
    const i = n % N, j = (i + 1) % N, vj = v[j], lat = vj * vj * Math.abs(kappa[j]);
    // grip left for braking after cornering, helped by drag and by gravity when climbing
    const brake = Math.sqrt(Math.max(0, (c.mu * load(c, vj, gNormal[j], kappaV[j])) ** 2 - lat * lat)) + c.drag * vj * vj + G * slope[j];
    v[i] = Math.min(v[i], Math.sqrt(vj * vj + 2 * Math.max(0, brake) * segLen[i]));
  }
  return v;
}

const racers = [
  { name: 'F-Style Open Wheel #1', css: '#1fe0ff,#0a2bb8', car: createOpenWheelCar(0x1fe0ff, 0x0a2bb8, 1), spec: OW },
  { name: 'F-Style Open Wheel #4', css: '#ffc233,#d93a0b', car: createOpenWheelCar(0xffc233, 0xd93a0b, 4), spec: { ...OW, mu: OW.mu * 0.97 } },
  { name: 'LM-Style Hypercar #7',  css: '#b5121b,#111',    car: createHypercar(0xb5121b, 7), spec: HC },
  { name: 'LM-Style Hypercar #8',  css: '#0e7a4a,#111',    car: createHypercar(0x0e7a4a, 8), spec: { ...HC, mu: HC.mu * 0.97 } }
];
let target = racers[0];   // the car the chase / onboard / orbit cameras follow
const carsEl = document.querySelector('.cars');
for (const r of racers) {
  scene.add(r.car);
  r.vmax = speedProfile(r.spec);
  console.assert(r.vmax.every(v => v > 0 && Number.isFinite(v)), 'bad speed profile', r.name);
  r.row = carsEl.appendChild(document.createElement('button'));
  r.row.className = 'car';
  r.row.innerHTML = `<i style="background:linear-gradient(90deg,${r.css})"></i><b>${r.name}</b><span></span>`;
  r.el = r.row.lastChild;
  r.row.addEventListener('click', () => { target = r; setMode(cameraMode); });
}

const state = { raceT: 0, paused: false, speedFactor: 1 };
const GO = 5.3;   // lights: one every 0.7 s from t = 1, all out at GO

// Signed distance along the track from r to o, wrapped to +-half a lap (+ = o is ahead)
const gapTo = (r, o) => ((o.dist - r.dist) % TRACK_LEN + 1.5 * TRACK_LEN) % TRACK_LEN - TRACK_LEN / 2;

function stepPhysics(dt) {
  state.raceT += dt;
  for (const r of racers) {
    if (state.raceT < r.launch) continue;              // still on the grid waiting for the lights
    const c = r.spec, v = r.speed, d = r.dist, lat0 = r.lat;
    const k = interp(kappa, d), gN = interp(gNormal, d), kV = interp(kappaV, d);

    // --- traffic: slipstream, don't hit the car in front, pick a side to pass
    let cap = Infinity, draft = false, near = null, ng = Infinity;
    for (const o of racers) {
      if (o === r) continue;
      const g = gapTo(r, o), dl = Math.abs(o.lat - r.lat);
      if (g > 0 && g < 40 && dl < 1.5) draft = true;
      if (g > 0 && g < 30 && dl < 2.3) cap = Math.min(cap, o.speed + (g - 6) * 1.2);
      if (g > -7.5 && g < ng) { ng = g; near = o; }      // nearest car ahead or alongside
    }
    let want = lineAt(r.dist), rate = 2.5;               // default: the racing line
    if (near && (ng < 8 || (ng < 24 && v > near.speed + 0.3))) {   // alongside, or closing in
      const dl = r.lat - near.lat, committed = Math.abs(dl) > 1;
      let side = Math.sign(committed ? dl : kappa[sampleIndex(r.dist + 60)]) || 1;   // undecided: go for the inside of the next corner
      if (!committed && Math.abs(near.lat + side * 2.9) > LAT_LIM) side = -side;     // no room there
      want = clamp(near.lat + side * 2.9, -LAT_LIM, LAT_LIM);
      rate = 5;                                          // react faster than the racing line drifts
    }
    const move = (want - r.lat) * (1 - Math.exp(-rate * dt)), maxMove = 0.07 * v * dt;
    r.off += clamp(move, -maxMove, maxMove);             // offset from the racing line

    // --- longitudinal: whatever grip cornering leaves over drives the car, capped by engine power
    const off = Math.max(0.3, 1 - k * r.off);            // off-line: the inside is shorter but tighter
    r.curv = k / off;
    r.aLat = v * v * r.curv;
    r.load = load(c, v, gN, kV);
    const tyre = Math.sqrt(Math.max(0, (c.mu * r.load) ** 2 - r.aLat ** 2));
    const a = Math.min(TRACTION * tyre, c.power / Math.max(v, 5))
            - (draft ? 0.65 : 1) * c.drag * v * v        // slipstream cuts drag
            - G * interp(slope, d);                      // gravity on the slope
    r.speed = Math.max(0, Math.min(v + a * dt, interp(r.vmax, d), cornerSpeed(c, r.curv, gN, kV), cap));
    r.aLong = (r.speed - v) / dt;
    r.dist += r.speed * dt / (interp(segLen, d) / DS * off);   // ground speed -> progress along the centreline
    r.lat = clamp(lineAt(r.dist) + r.off, -LAT_LIM, LAT_LIM);   // the line may swing toward the edge while the car is off it
    r.off = r.lat - lineAt(r.dist);
    r.latVel = (r.lat - lat0) / dt;
  }
  resolveCollisions();
}

// Cars are CAR_LEN x CAR_W boxes in (track distance, lateral) space. An overlap is undone along its shallower axis:
// mostly alongside -> both are pushed apart sideways (racing side by side); nose to tail -> the car behind is held
// back and can't go faster than the one ahead.
const CAR_LEN = 5.6, CAR_W = 2.3;   // bodies are ~5.4 x 2.05 m including wings and wheels, plus a little air
function resolveCollisions() {
  for (let pass = 0; pass < 3; pass++) {               // repeat so a push into a third car gets resolved too
    for (let a = 0; a < racers.length; a++) {
      for (let b = a + 1; b < racers.length; b++) {
        let r = racers[a], o = racers[b], g = gapTo(r, o);
        if (g < 0) { [r, o] = [o, r]; g = -g; }        // r behind, o ahead
        const dl = o.lat - r.lat, ox = CAR_LEN - g, oy = CAR_W - Math.abs(dl);
        if (ox <= 0 || oy <= 0) continue;
        if (ox > oy) {
          const s = Math.sign(dl) || 1;
          // each takes half; whatever one can't take at the edge of the track the other takes
          const rLat = clamp(r.lat - s * oy / 2, -LAT_LIM, LAT_LIM);
          o.lat = clamp(o.lat + s * (oy - Math.abs(r.lat - rLat)), -LAT_LIM, LAT_LIM);
          r.lat = clamp(o.lat - s * CAR_W, -LAT_LIM, LAT_LIM);
          for (const c of [r, o]) c.off = c.lat - lineAt(c.dist);
        } else {
          r.dist -= ox;
          r.speed = Math.min(r.speed, o.speed);
        }
      }
    }
  }
}

// off = lateral offset from the racing line
function resetRacer(r, dist, off, speed, launch = 0) {
  Object.assign(r, { dist, off, speed, launch, lat: lineAt(dist) + off, latVel: 0, curv: 0, aLat: 0, aLong: 0, load: G, roll: 0, pitch: 0, heave: 0 });
  r.car.userData.prev = {};   // or the particle trails would streak across the teleport
}

const focus = new THREE.Vector3();
const lastFocus = new THREE.Vector3();
function placeCars(dt) {
  const ease = 1 - Math.exp(-8 * dt);
  for (const r of racers) {
    const ud = r.car.userData, soft = r.spec.soft;
    r.frame = placeOnTrack(r.car, r.dist, r.lat);
    r.car.rotateY(Math.atan2(r.latVel, Math.max(r.speed, 5)));   // nose points where the car is really heading

    // sprung body: rolls out of the corner, dives under braking, squats under load and rises over crests.
    // The clamps keep wings and splitter just clear of the asphalt.
    r.roll += (clamp(0.0008 * soft * r.aLat, -0.045, 0.045) - r.roll) * ease;
    r.pitch += (clamp(-0.0004 * soft * r.aLong, -0.015, 0.015) - r.pitch) * ease;
    r.heave += (clamp(-0.0008 * soft * (r.load - G), -0.02, 0.04) - r.heave) * ease;
    // road buzz on top, growing with speed: this is what shakes the onboard camera (each car has its own phase)
    const buzz = Math.min(1, r.speed / 70), t = state.raceT * 2 * Math.PI + r.car.id;
    ud.body.rotation.set(r.pitch + 0.0035 * buzz * Math.sin(t * 11.3), 0, r.roll + 0.005 * buzz * Math.sin(t * 7.1));
    ud.body.position.y = r.heave + 0.004 * buzz * Math.sin(t * 15.7);
    // front wheels steer to the curvature of the path (bicycle model)
    const steer = Math.atan(ud.wheelbase * r.curv);
    for (const w of ud.wheels.slice(0, 2)) w.group.rotation.y += (steer - w.group.rotation.y) * ease;
    r.car.updateMatrixWorld();
    for (const w of r.car.userData.wheels) w.spin.rotation.x += (r.speed * dt) / w.r;
    if (dt > 0 && r.speed > 3) emitFromCar(r.car, r.frame, r.speed, dt);
  }
  focus.copy(target.car.position);
}

/* =====================================================================
   10. CAMERA MODES
   ===================================================================== */
let cameraMode = 'follow';
const FOV = { lowangle: 42, follow: 48, chase: 58, aerial: 48, onboard: 72 };
// camera looks down -Z, cars drive toward +Z: turn around, then tip 3 degrees down
const ONBOARD_ROT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.05, Math.PI, 0, 'YXZ'));

function setLowAngle() {
  // Low, just off the asphalt in the dip, looking up the climb
  const s = samples[(iDip - 22 + N) % N];
  const p = s.p.clone().addScaledVector(s.x, -(TRACK_HALF_W + 2.5));
  camera.position.set(p.x, s.p.y + 0.55, p.z);
  const t = samples[(iDip + 115) % N].p;
  controls.target.set(t.x, t.y + 2.5, t.z);
}
function setFollow() {
  const f = target.frame;
  controls.target.copy(focus);
  camera.position.copy(focus).addScaledVector(f.t, -14).addScaledVector(f.x, 9).addScaledVector(UP, 4);
}
function setAerial() {
  controls.target.set(10, 12, -10);
  camera.position.set(-345, 285, 390);
}

const modeButtons = document.querySelectorAll('#controls [data-mode]');
function setMode(mode) {
  cameraMode = mode;
  modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  racers.forEach(r => r.row.classList.toggle('active', r === target));
  controls.enabled = mode !== 'chase' && mode !== 'onboard';
  focus.copy(target.car.position);
  if (mode === 'lowangle') setLowAngle();
  if (mode === 'follow') setFollow();
  if (mode === 'aerial') setAerial();
  if (mode === 'chase') camera.position.copy(focus).addScaledVector(target.frame.t, -11).addScaledVector(target.frame.y, 3.2);
  camera.fov = FOV[mode];
  camera.updateProjectionMatrix();
  lastFocus.copy(focus);
}
modeButtons.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

/* =====================================================================
   11. SCENES
   ===================================================================== */
function startRace() {
  state.raceT = 0;
  // reverse grid: slowest car on pole, so the quick ones have to overtake their way through
  [3, 2, 1, 0].forEach((ri, k) => {
    const s = GRID_SLOTS[k];
    resetRacer(racers[ri], s.dist, s.lat - lineAt(s.dist), 0, GO + 0.15 + rand() * 0.2);
  });
  target = racers[0];
  placeCars(0);
  setMode('follow');
}
function startOvertake() {
  state.raceT = GO;   // lights already out
  // Open Wheel #1 sits in the tow of Hypercar #8 on the downhill run into the Red Water dip; the other two trail far behind
  const d = samples[iDip].dist - 110;
  resetRacer(racers[3], d, 0, 28);
  resetRacer(racers[0], d - 10, 0, 28);   // closes in ~3 s and goes through on the inside at the dip
  resetRacer(racers[2], d - 150, 0, 40);
  resetRacer(racers[1], d - 190, 0, 40);
  target = racers[0];
  placeCars(0);
  setMode('chase');
}
document.getElementById('sceneStart').addEventListener('click', startRace);
document.getElementById('sceneOvertake').addEventListener('click', startOvertake);

/* =====================================================================
   12. ANIMATION LOOP
   ===================================================================== */
const tagEl = document.querySelector('#hud .tag');
document.getElementById('speed').addEventListener('input', e => state.speedFactor = parseFloat(e.target.value));
const pauseBtn = document.getElementById('pause');
pauseBtn.addEventListener('click', () => {
  state.paused = !state.paused;
  pauseBtn.textContent = state.paused ? 'Lanjut' : 'Jeda';
  pauseBtn.classList.toggle('active', state.paused);
});
let hudTimer = 0;

function animate() {
  requestAnimationFrame(animate);
  // the slider scales simulated time (slow motion .. 2x), the physics itself is untouched
  const dt = state.paused ? 0 : Math.min(clock.getDelta(), 0.05) * state.speedFactor;
  if (state.paused) clock.getDelta();

  for (let n = Math.ceil(dt / 0.02), h = dt / n; n-- > 0;) stepPhysics(h);   // substeps keep car-following stable at 2x
  placeCars(dt);
  dustTrail.update(dt);
  wakeTrail.update(dt);

  const lit = state.raceT < GO ? Math.max(0, Math.min(5, Math.floor((state.raceT - 1) / 0.7) + 1)) : 0;
  startLights.forEach((m, k) => m.emissiveIntensity = k < lit ? 6 : 0);

  // shadows follow the action
  sun.position.copy(focus).addScaledVector(SUN_DIR, 180);
  sun.target.position.copy(focus);

  if (cameraMode === 'follow') {
    const delta = focus.clone().sub(lastFocus);
    camera.position.add(delta);
    controls.target.add(delta);
  } else if (cameraMode === 'chase') {
    const f = target.frame;
    const want = focus.clone().addScaledVector(f.t, -11).addScaledVector(f.y, 3.2);
    camera.position.lerp(want, 1 - Math.exp(-6 * (dt || 0.016)));
    controls.target.copy(focus).addScaledVector(f.t, 10);
    camera.lookAt(controls.target);
  } else if (cameraMode === 'onboard') {
    const body = target.car.userData.body;   // mounted on the sprung body, so it rolls, dives and buzzes with it
    camera.position.copy(target.car.userData.onboard).applyMatrix4(body.matrixWorld);
    camera.quaternion.copy(target.car.quaternion).multiply(body.quaternion).multiply(ONBOARD_ROT);
  }
  lastFocus.copy(focus);

  if (controls.enabled) controls.update();
  sky.position.copy(camera.position);

  hudTimer += dt;
  if (hudTimer > 0.15) {
    hudTimer = 0;
    tagEl.textContent = state.raceT < GO ? `START · LAMPU ${lit}/5` : 'LIVE · GOLDEN HOUR';
    const order = [...racers].sort((a, b) => b.dist - a.dist);
    for (const r of racers) r.el.textContent = `P${order.indexOf(r) + 1} · ${Math.round(r.speed * 3.6)} km/j`;
  }
  renderer.render(scene, camera);
}

const clock = new THREE.Clock();
startRace();
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  dustTrail.material.uniforms.uScale.value = wakeTrail.material.uniforms.uScale.value = window.innerHeight * 0.5;
});
