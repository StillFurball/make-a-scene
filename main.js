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
  head:   new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1cc, emissiveIntensity: 2.2 }),
  rimDark:   new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0.7, roughness: 0.35 }),
  spokeDark: new THREE.MeshStandardMaterial({ color: 0x1c1d21, metalness: 0.75, roughness: 0.3 })
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

// style: { rim, spoke, spokes, rimFrac } overrides the rim/spoke materials and the spoke-pair count
function createWheel(r, w, accentColor, style = {}) {
  const group = new THREE.Group();
  const spin = new THREE.Group();
  group.add(spin);
  const pairs = style.spokes ?? 5;
  addPart(spin, new THREE.CylinderGeometry(r, r, w, 48).rotateZ(Math.PI / 2), MAT.tire);
  const rf = style.rimFrac ?? 0.64;   // rim radius as a share of the tyre radius
  addPart(spin, new THREE.CylinderGeometry(r * rf, r * rf, w + 0.012, 36).rotateZ(Math.PI / 2), style.rim ?? MAT.rim);
  for (let k = 0; k < pairs; k++) {
    addPart(spin, new THREE.BoxGeometry(w + 0.024, 0.045 * 5 / pairs + 0.012, r * rf * 1.875), style.spoke ?? MAT.spoke, 0, 0, 0, k * Math.PI / pairs);
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

// Everything except the wheels moves into a "body" group so it can roll, pitch and heave on its suspension
function splitBody(car) {
  const ud = car.userData, body = new THREE.Group();
  body.add(...car.children.filter(c => !ud.wheels.some(w => w.group === c)));
  car.add(body);
  ud.body = body;
  ud.wheelbase = ud.wheels[0].group.position.z - ud.wheels[2].group.position.z;   // wheels are built front axle first
  return car;
}

// Physical paint whose colour, roughness, metalness and clearcoat come from a GLSL livery(col, rough, metal, coat)
// function of the body-space position vLp and normal vLn. Uniforms: numbers become floats, THREE.Colors vec3s.
// `zone` adds the per-vertex vZone attribute.
function proceduralPaint(glsl, uniforms, { zone = false, side = THREE.FrontSide } = {}) {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05, side });
  const decl = Object.entries(uniforms).map(([k, v]) => `uniform ${v.isColor ? 'vec3' : 'float'} ${k};`).join('\n');
  const vary = `varying vec3 vLp;\nvarying vec3 vLn;\n${zone ? 'varying float vZone;' : ''}`;
  m.onBeforeCompile = sh => {
    for (const [k, v] of Object.entries(uniforms)) sh.uniforms[k] = { value: v };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${zone ? 'attribute float zone;' : ''}\n${vary}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvLp = position; vLn = normal;${zone ? ' vZone = zone;' : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${decl}\n${vary}\n${glsl}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );',
        'vec3 lvCol; float lvRough, lvMetal, lvCoat;\nlivery(lvCol, lvRough, lvMetal, lvCoat);\nvec4 diffuseColor = vec4( lvCol, opacity );')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = lvRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = lvMetal;')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= lvCoat;\n#endif');
  };
  m.customProgramCacheKey = () => glsl;
  return m;
}

// Skin through closed rings of Vector3 (equal point counts), faces pointing away from each ring's centre;
// the two end rings are capped flat.
function loftGeometry(rings) {
  const P = rings[0].length, pos = [], idx = [];
  const centre = r => r.reduce((c, v) => c.add(v), new THREE.Vector3()).divideScalar(r.length);
  for (const ring of rings) for (const v of ring) pos.push(v.x, v.y, v.z);
  // winding from a well-formed quad in the middle
  const m = Math.floor(rings.length / 2), r0 = rings[m], r1 = rings[m + 1], c0 = centre(r0);
  let j0 = 0;
  r0.forEach((v, j) => { if (v.distanceTo(c0) > r0[j0].distanceTo(c0)) j0 = j; });
  const e1 = r0[(j0 + 1) % P].clone().sub(r0[j0]), e2 = r1[j0].clone().sub(r0[j0]);
  const flip = e1.cross(e2).dot(r0[j0].clone().sub(c0)) < 0;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < P; j++) {
      const a = i * P + j, b = i * P + (j + 1) % P, c = a + P, d = b + P;
      idx.push(...(flip ? [a, c, b, b, c, d] : [a, b, c, b, d, c]));
    }
  }
  for (const [end, next] of [[rings[0], rings[1]], [rings[rings.length - 1], rings[rings.length - 2]]]) {
    const axis = centre(end).sub(centre(next)).normalize();
    const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u);
    const base = pos.length / 3;
    for (const p of end) pos.push(p.x, p.y, p.z);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(end.map(p => new THREE.Vector2(p.dot(u), p.dot(v))), [])) {
      const n = end[b].clone().sub(end[a]).cross(end[c].clone().sub(end[a]));
      idx.push(...(n.dot(axis) > 0 ? [a, b, c] : [a, c, b]).map(k => k + base));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Mirror a geometry to the other side of the car (x -> -x) keeping its faces outward
function mirrorX(geo) {
  const g = geo.clone().scale(-1, 1, 1), ix = g.index.array;
  for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2], ix[i + 1]];
  g.computeVertexNormals();
  return g;
}

// Superellipse ring in the x-y plane at z: half-width w about xc, from bottom b to top t.
// taper narrows the top (1 = a point), under narrows the bottom; shapeY(x, y) can carve the result.
function superRing(z, { xc = 0, w, b, t, p = 2.5, taper = 0, under = 0, shapeY = null }, n = 48) {
  const ring = [], yc = (t + b) / 2, hh = (t - b) / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const u = Math.sign(c) * Math.abs(c) ** (2 / p), v = Math.sign(s) * Math.abs(s) ** (2 / p);
    const x = xc + w * u * (1 - taper * (v + 1) / 2 - under * (1 - v) / 2);
    const y = yc + hh * v;
    ring.push(new THREE.Vector3(x, shapeY ? shapeY(x, y, v) : y, z));
  }
  return ring;
}

/* ---------- 7a. F1 Car (2019 rules, shape and livery after the Mercedes W10) ---------- */
// Real dimensions: 3.72 m wheelbase, ~5.5 m long, 2.0 m wide, 13" rims on 0.66 m tyres (305 front / 405 rear),
// 2.0 m wide simplified front wing, 1.05 m rear wing. Silver over black with teal accents, no sponsors or logos.
const F1_LIVERY_GLSL = /* glsl */`
  void livery(out vec3 col, out float rough, out float metal, out float coat) {
    vec3 p = vLp, n = normalize(vLn);
    float ax = abs(p.x);
    col = vec3(0.6, 0.62, 0.64); rough = 0.24; metal = 0.85; coat = 1.0;
    bool blk = false, teal = false;
    if (uPart < 0.5) {                                                   // nose, tub, engine cover, sidepods
      float line = p.z > 1.85 ? 0.21 : p.z > 0.85 ? mix(0.3, 0.21, (p.z - 0.85)) : mix(0.3, 0.42, smoothstep(-1.4, 0.4, p.z));
      blk = p.y < line || n.y < -0.4 || p.z < -1.75;
      teal = !blk && p.y < line + 0.03 && p.z < 0.75 && p.z > -1.6;    // pin line along the silver / black split
      blk = blk || (ax < 0.2 && p.z > -0.13 && p.z < 0.72 && p.y > 0.5 && n.y > 0.2 && p.y < 0.645);   // cockpit
      blk = blk || (n.z > 0.45 && p.y > 0.69 && p.z < -0.1 && p.z > -0.4);                            // airbox mouth
      blk = blk || (n.z > 0.8 && ax > 0.3);                                                            // sidepod inlets
      teal = teal && !blk;
    } else {                                                             // front wing
      blk = ax > 0.9 || n.y < -0.5;
      teal = !blk && abs(ax - 0.805) < 0.016;
    }
    if (teal) { col = uAccent; rough = 0.22; metal = 0.25; }
    if (blk) { col = vec3(0.012); rough = 0.45; metal = 0.3; coat = 0.35; }
  }`;

function createOpenWheelCar(number, tcamColor) {
  const car = new THREE.Group();
  const TEAL = 0x00d2be;
  const body = proceduralPaint(F1_LIVERY_GLSL, { uPart: 0, uAccent: new THREE.Color(TEAL) });
  const wingPaint = proceduralPaint(F1_LIVERY_GLSL, { uPart: 1, uAccent: new THREE.Color(TEAL) }, { side: THREE.DoubleSide });
  const silver = new THREE.MeshPhysicalMaterial({ color: 0x9a9ea3, metalness: 0.85, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.05 });
  const teal = new THREE.MeshPhysicalMaterial({ color: TEAL, metalness: 0.25, roughness: 0.22, clearcoat: 1 });
  const black = MAT.carbon;
  const ZN = 2.98, WB = 1.86, R = 0.33;   // nose tip, half wheelbase, tyre radius

  // --- nose, monocoque, airbox and engine cover: one loft
  const top    = spline([[ZN, 0.27], [2.6, 0.31], [2.2, 0.4], [1.86, 0.5], [1.3, 0.6], [0.8, 0.65], [0.3, 0.66], [-0.1, 0.66], [-0.17, 0.69], [-0.33, 0.96], [-0.6, 0.93], [-1.0, 0.8], [-1.5, 0.58], [-1.9, 0.42], [-2.25, 0.33]]);
  const bottom = spline([[ZN, 0.17], [2.6, 0.16], [2.2, 0.19], [1.86, 0.22], [1.4, 0.12], [0.8, 0.08], [-1.5, 0.08], [-1.8, 0.14], [-2.25, 0.2]]);
  const halfW  = spline([[ZN, 0.07], [2.6, 0.09], [2.2, 0.11], [1.86, 0.14], [1.3, 0.21], [0.8, 0.27], [0.2, 0.29], [-0.3, 0.3], [-0.8, 0.28], [-1.3, 0.22], [-1.8, 0.14], [-2.25, 0.07]]);
  const taper  = spline([[ZN, 0.25], [1.86, 0.3], [0.0, 0.3], [-0.2, 0.82], [-0.7, 0.8], [-1.1, 0.6], [-2.25, 0.4]]);
  const pExp   = spline([[ZN, 2.6], [1.5, 3.0], [-0.1, 3.0], [-0.5, 2.4], [-2.25, 2.4]]);
  const dip    = z => 0.15 * smoothstep(-0.15, -0.06, z) * smoothstep(0.74, 0.62, z);   // cockpit opening
  const tubRings = [];
  for (let z = -2.25; z < ZN; z += 0.02) tubRings.push(z);
  tubRings.push(ZN);
  const tub = loftGeometry(tubRings.map(z => superRing(z, {
    w: halfW(z), b: bottom(z), t: top(z), p: pExp(z), taper: taper(z),
    shapeY: (x, y, v) => y - dip(z) * Math.max(0, 1 - (x / 0.2) ** 4) * smoothstep(0.2, 0.9, v)
  }, 56)));
  addPart(car, tub, body);

  // --- sidepods: slim and deeply undercut, tapering into the coke-bottle
  const spX = spline([[0.72, 0.47], [0.4, 0.5], [-0.3, 0.47], [-0.9, 0.37], [-1.55, 0.22]]);
  const spW = spline([[0.72, 0.17], [0.4, 0.21], [-0.3, 0.2], [-0.9, 0.13], [-1.55, 0.05]]);
  const spT = spline([[0.72, 0.6], [0.4, 0.6], [-0.3, 0.55], [-0.9, 0.42], [-1.55, 0.22]]);
  const spZ = [];
  for (let z = -1.55; z < 0.72; z += 0.03) spZ.push(z);
  spZ.push(0.72);
  const pod = loftGeometry(spZ.map(z => superRing(z, { xc: spX(z), w: spW(z), b: 0.1, t: spT(z), p: 3.2, under: 0.45, taper: 0.1 }, 40)));
  addPart(car, pod, body);
  addPart(car, mirrorX(pod), body);

  // --- floor, bargeboards, diffuser
  addPart(car, new THREE.BoxGeometry(1.6, 0.025, 2.75), black, 0, 0.055, -0.15);
  addPart(car, new THREE.BoxGeometry(1.0, 0.025, 0.5), black, 0, 0.055, 1.45);
  addPart(car, taperedBox(1.0, 0.3, 1.0, 0.03, 0.62), black, 0, 0.05, -1.85);
  for (let k = -2; k <= 2; k++) addPart(car, new THREE.BoxGeometry(0.01, 0.28, 0.6), black, k * 0.2, 0.06, -1.87);
  for (const sx of [-1, 1]) {
    addPart(car, new THREE.BoxGeometry(0.01, 0.3, 0.5), black, sx * 0.66, 0.21, 1.05);
    addPart(car, new THREE.BoxGeometry(0.01, 0.24, 0.36), black, sx * 0.55, 0.19, 1.2);
    addPart(car, new THREE.BoxGeometry(0.2, 0.01, 0.14), black, sx * 0.6, 0.44, 0.86, 0, 0, sx * 0.3);   // boomerang
    addPart(car, new THREE.BoxGeometry(0.01, 0.12, 0.7), black, sx * 0.79, 0.12, -0.3);                   // floor edge fence
  }

  // --- front wing: main plane plus four flaps that rise and steepen toward the endplates
  const foil = (le, chord, ang, thick) => {   // aerofoil ring at a station: leading edge (x, y, z), trailing edge raised by ang
    const d = new THREE.Vector2(-Math.cos(ang), Math.sin(ang)), nrm = new THREE.Vector2(Math.sin(ang), Math.cos(ang));
    const pts = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, s = (1 - Math.cos(a)) / 2;   // 0 -> 1 -> 0 round the section
      const t = 5 * thick * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1036 * s ** 4) * (i < 12 ? 1 : -1);
      pts.push(new THREE.Vector3(le.x, le.y + (s * d.y + t * nrm.y) * chord, le.z + (s * d.x + t * nrm.x) * chord));
    }
    return pts;
  };
  const wingStations = (ax) => {   // leading edges of all five elements at this span position
    const out = [];
    const rise = smoothstep(0.5, 0.97, ax), inner = smoothstep(0.22, 0.42, ax);
    let le = new THREE.Vector3(0, 0.085 + 0.025 * smoothstep(0.25, 0.9, ax), ZN - 0.1 * smoothstep(0.2, 1.0, ax));
    let ang = 0.05 + 0.08 * smoothstep(0.3, 1, ax), chord = 0.3;
    out.push({ le: le.clone(), chord, ang });
    const chords = [0.16, 0.13, 0.12, 0.11];
    for (let k = 0; k < 4; k++) {
      const te = le.clone().add(new THREE.Vector3(0, Math.sin(ang) * chord, -Math.cos(ang) * chord));
      le = te.add(new THREE.Vector3(0, 0.01 + 0.008 * rise, 0.035));
      ang += (0.13 + 0.07 * rise) * inner;
      chord = chords[k] * (0.15 + 0.85 * inner);
      out.push({ le: le.clone(), chord, ang });
    }
    return out;
  };
  for (const sx of [-1, 1]) {
    const xs = [];
    for (let ax = 0.0; ax <= 0.985; ax += 0.025) xs.push(Math.min(ax, 0.985));
    for (let k = 0; k < 5; k++) {
      const span = k === 0 ? xs : xs.filter(ax => ax >= 0.22);
      const rings = span.map(ax => { const st = wingStations(ax)[k]; st.le.x = sx * ax; return foil(st.le, st.chord, st.ang, k === 0 ? 0.1 : 0.12); });
      addPart(car, loftGeometry(rings), wingPaint);
    }
    // endplate with footplate and a small canard
    addPart(car, sideExtrude([[ZN, 0.07], [ZN, 0.15], [2.8, 0.27], [2.44, 0.3], [2.4, 0.07]], 0.012, sx * 0.99), black);
    addPart(car, new THREE.BoxGeometry(0.06, 0.01, 0.5), black, sx * 0.97, 0.072, 2.7);
    addPart(car, new THREE.BoxGeometry(0.08, 0.008, 0.12), black, sx * 1.03, 0.26, 2.62, 0.2);
    // nose pylons down to the main plane
    strut(car, new THREE.Vector3(sx * 0.05, 0.19, 2.62), new THREE.Vector3(sx * 0.09, 0.1, 2.76), 0.012, black);
  }

  // --- cockpit: halo, driver, mirrors, T-cam
  const haloR = 0.37, haloZ = 0.1, haloY = 0.86;
  addPart(car, new THREE.TorusGeometry(haloR, 0.032, 10, 32, Math.PI).rotateX(Math.PI / 2), silver, 0, haloY, haloZ);
  for (const sx of [-1, 1]) {
    strut(car, new THREE.Vector3(sx * haloR, haloY, haloZ), new THREE.Vector3(sx * haloR, haloY - 0.02, -0.12), 0.032, silver);
    strut(car, new THREE.Vector3(sx * haloR, haloY - 0.02, -0.12), new THREE.Vector3(sx * 0.3, 0.62, -0.16), 0.03, silver);
  }
  strut(car, new THREE.Vector3(0, haloY, haloZ + haloR), new THREE.Vector3(0, 0.63, 0.82), 0.03, silver);
  addPart(car, new THREE.SphereGeometry(0.14, 20, 14), new THREE.MeshPhysicalMaterial({ color: 0xf4f6f8, clearcoat: 1, roughness: 0.2 }), 0, 0.7, 0.06);
  addPart(car, new THREE.SphereGeometry(0.142, 20, 8, Math.PI / 2 - 0.8, 1.6, 1.2, 0.45), MAT.glass, 0, 0.7, 0.06);   // visor
  for (const sx of [-1, 1]) {
    addPart(car, new THREE.BoxGeometry(0.17, 0.07, 0.06), silver, sx * 0.63, 0.74, 0.62);
    addPart(car, new THREE.BoxGeometry(0.15, 0.055, 0.005), new THREE.MeshStandardMaterial({ color: 0x8a96a4, metalness: 1, roughness: 0.1 }), sx * 0.63, 0.74, 0.588);
    addPart(car, new THREE.BoxGeometry(0.05, 0.02, 0.07), teal, sx * 0.71, 0.785, 0.62);
    strut(car, new THREE.Vector3(sx * 0.5, 0.6, 0.6), new THREE.Vector3(sx * 0.58, 0.72, 0.62), 0.01, black);
  }
  addPart(car, new THREE.BoxGeometry(0.07, 0.05, 0.2), new THREE.MeshStandardMaterial({ color: tcamColor, roughness: 0.4 }), 0, top(-0.42) + 0.015, -0.42);
  // shark fin and pitot
  addPart(car, sideExtrude([[-0.45, 0.93], [-1.65, 0.72], [-1.65, 0.5], [-0.9, 0.76]], 0.01), body);
  strut(car, new THREE.Vector3(0, 0.27, 2.9), new THREE.Vector3(0, 0.27, 3.1), 0.005, black);

  // race number: dark digits straight on the silver nose (transparent decal), white on the rear-wing endplates
  const nz = 1.1, ny = top(nz) + 0.004, slope = Math.atan2(top(nz + 0.05) - top(nz - 0.05), 0.1);
  const numMat = new THREE.MeshStandardMaterial({
    map: boardTexture(String(number), 'rgba(0,0,0,0)', '#26282c', 256), transparent: true, alphaTest: 0.4,
    roughness: 0.3, metalness: 0.4, polygonOffset: true, polygonOffsetFactor: -2
  });
  addPart(car, new THREE.PlaneGeometry(0.42, 0.21), numMat, 0, ny, nz, -Math.PI / 2 - slope).castShadow = false;
  const plateMat = new THREE.MeshStandardMaterial({ map: boardTexture(String(number), '#0d0e10', '#f4f4f4', 256), roughness: 0.5 });
  for (const sx of [-1, 1]) addPart(car, new THREE.PlaneGeometry(0.3, 0.15), plateMat, sx * 0.538, 0.7, -2.42, 0, sx * Math.PI / 2);

  // --- rear wing on a single pylon, with a beam wing, DRS pod and rain light
  addPart(car, aerofoil(0.32, 0.1, 1.03), silver, 0, 0.8, -2.36, 0.15);
  addPart(car, aerofoil(0.2, 0.09, 1.03, 0.03), teal, 0, 0.885, -2.56, 0.62);
  addPart(car, aerofoil(0.18, 0.1, 0.8), black, 0, 0.36, -2.3, 0.3);
  for (const sx of [-1, 1]) {
    addPart(car, sideExtrude([[-2.15, 0.4], [-2.15, 0.96], [-2.68, 0.99], [-2.68, 0.36], [-2.4, 0.3]], 0.014, sx * 0.53), black);
    addPart(car, new THREE.BoxGeometry(0.02, 0.06, 0.5), teal, sx * 0.53, 0.955, -2.42);
  }
  strut(car, new THREE.Vector3(0, 0.33, -2.2), new THREE.Vector3(0, 0.8, -2.36), 0.022, black);
  addPart(car, new THREE.BoxGeometry(0.06, 0.05, 0.1), black, 0, 0.94, -2.5);
  addPart(car, new THREE.BoxGeometry(0.16, 0.06, 0.03), MAT.tail, 0, 0.27, -2.27);

  // --- wheels: 13" black rims, tall sidewalls, brake ducts, double wishbones
  const style = { rim: MAT.rimDark, spoke: MAT.spokeDark, spokes: 5, rimFrac: 0.5 };
  const wheels = [];
  for (const [z, w, tx] of [[WB, 0.305, 0.85], [-WB, 0.405, 0.8]]) {
    for (const sx of [-1, 1]) {
      const wh = createWheel(R, w, 0xbdbdbd, style);
      wh.group.position.set(sx * tx, R, z);
      addPart(wh.group, new THREE.CylinderGeometry(0.15, 0.17, 0.1, 20).rotateZ(Math.PI / 2), black, -sx * (w / 2 + 0.05), 0, 0);
      car.add(wh.group);
      wheels.push(wh);
      const hub = sx * (tx - w / 2 - 0.08), fr = z > 0;
      const yU = fr ? 0.5 : 0.46, yL = fr ? 0.2 : 0.18, inX = sx * (fr ? 0.16 : 0.12);
      for (const dz of [-0.2, 0.2]) {
        strut(car, new THREE.Vector3(inX, yU + 0.04, z + dz), new THREE.Vector3(hub, yU, z), 0.014, black);
        strut(car, new THREE.Vector3(inX, yL, z + dz), new THREE.Vector3(hub, yL, z), 0.014, black);
      }
      strut(car, new THREE.Vector3(hub, fr ? yL : yU, z), new THREE.Vector3(inX, fr ? 0.56 : 0.2, z + (fr ? -0.1 : 0.1)), 0.012, black);   // push / pull rod
    }
  }

  car.userData = {
    wheels,
    dustPoints: [new THREE.Vector3(-0.8, 0.12, -2.15), new THREE.Vector3(0.8, 0.12, -2.15)],
    vortexPoints: [new THREE.Vector3(-0.53, 0.99, -2.68), new THREE.Vector3(0.53, 0.99, -2.68)],
    onboard: new THREE.Vector3(0, 1.16, -0.42)  // T-cam: halo, nose and front wheels in view
  };
  return splitBody(car);
}

/* ---------- 7b. LMDh Endurance Hypercar (shape and livery after the 2023 Porsche 963) ---------- */
// Real dimensions: 5.10 m long, 2.00 m wide, 3.148 m wheelbase, ~1.06 m tall, 18" rims on 0.71 m tyres.
// The skin is one lofted surface: a height field over the car's plan (nose, fender crowns, canopy and engine
// cover blended with a smooth max), rolled over at the edges into flanks that hug the wheel arches.
// The livery is painted per pixel from the body-space position, so pin-stripes and edges stay sharp.

// Monotone cubic through [z, value] knots (never overshoots between knots), flat beyond the ends
function spline(knots) {
  knots = [...knots].sort((a, b) => a[0] - b[0]);
  const n = knots.length, xs = knots.map(k => k[0]), ys = knots.map(k => k[1]);
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const d = h.map((hi, i) => (ys[i + 1] - ys[i]) / hi);
  const m = xs.map((_, i) => {
    if (i === 0) return d[0];
    if (i === n - 1) return d[n - 2];
    if (d[i - 1] * d[i] <= 0) return 0;
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    return (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  });
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (x > xs[k + 1]) k++;
    const t = (x - xs[k]) / h[k], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m[k] + (3 * t2 - 2 * t3) * ys[k + 1] + (t3 - t2) * h[k] * m[k + 1];
  };
}

const HC_BODY = (() => {
  const ZF = 2.6, ZR = -2.48, WB = 1.574, R = 0.355, RA = 0.43;   // nose, tail, half wheelbase, tyre & arch radius
  const smax = (a, b, k) => { const q = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + q * q * k / 4; };
  const se = (t, p) => (t = Math.abs(t)) >= 1 ? 0 : Math.pow(1 - Math.pow(t, p), 1 / p);   // superellipse section

  // plan view: full width over the fenders, pinched at the doors, rounded nose corners
  const halfW = z => 1.0
    - 0.07 * smoothstep(1.1, 0.6, z) * smoothstep(-1.2, -0.65, z)
    - 0.13 * smoothstep(2.2, ZF, z) ** 2
    - 0.05 * smoothstep(-2.1, ZR, z);
  // crest heights along the car
  const deck    = spline([[ZF, 0.3], [2.3, 0.37], [1.8, 0.45], [1.25, 0.54], [0.6, 0.6], [-0.6, 0.63], [-1.6, 0.61], [ZR, 0.6]]);
  const fFender = spline([[ZF, 0.42], [2.35, 0.6], [1.95, 0.79], [1.55, 0.86], [1.15, 0.84], [0.75, 0.74], [0.3, 0.6], [-0.2, 0.5], [-0.7, 0.3]]);
  const rFender = spline([[1.0, 0.3], [0.5, 0.5], [0.0, 0.62], [-0.6, 0.78], [-1.2, 0.87], [-1.8, 0.88], [-2.25, 0.83], [ZR, 0.76]]);
  const cover   = spline([[-0.2, 0.92], [-0.9, 0.86], [-1.6, 0.77], [-2.1, 0.7], [ZR, 0.63]]);
  const roof    = spline([[1.18, 0.5], [1.0, 0.74], [0.75, 0.9], [0.45, 0.99], [0.15, 1.03], [-0.2, 1.03], [-0.55, 0.98], [-1.0, 0.87], [-1.5, 0.74]]);
  const roofW   = spline([[1.18, 0.46], [0.75, 0.52], [0.0, 0.5], [-0.6, 0.4], [-1.5, 0.22]]);

  // Crest height at (x, z) and how far the canopy stands above the rest (> 0 on the canopy)
  function crown(x, z) {
    const ax = Math.abs(x);
    let h = deck(z);
    h = smax(h, 0.3 + (fFender(z) - 0.3) * se((ax - 0.81) / 0.27, 3), 0.08);
    h = smax(h, 0.3 + (rFender(z) - 0.3) * se((ax - 0.78) / 0.33, 3.5), 0.08);
    if (z < 0) h = smax(h, 0.3 + (cover(z) - 0.3) * se(ax / 0.34, 2.2), 0.06);
    const c = z < 1.25 && z > -1.5 ? 0.3 + (roof(z) - 0.3) * se(ax / roofW(z), 2.3) : 0;
    return [smax(h, c, 0.05), c - h];
  }
  // top of the wheel-arch opening at z (-1 away from the wheels)
  const archTop = z => {
    for (const zc of [WB, -WB]) { const dz = z - zc; if (Math.abs(dz) < RA) return R + Math.sqrt(RA * RA - dz * dz); }
    return -1;
  };
  // the nose rolls under into the splitter
  // crest above the shoulder rolls over into the flank; a crest lower than the shoulder (bonnet between the fenders) stays put
  const shoulder = (y, lo, t) => y > lo ? lo + (y - lo) * se(t, 4) : y;
  const noseRoll = (y, z) => z > ZF - 0.2 ? 0.1 + (y - 0.1) * Math.sqrt(1 - 0.5 * ((z - ZF + 0.2) / 0.2) ** 2) : y;

  // Cross-section at z as [x, y, canopyLift]: left flank bottom -> over the top -> right flank bottom
  const NU = 76, NW = 6;
  function section(z) {
    const hw = halfW(z), arch = archTop(z);
    const edge = crown(hw, z)[0];
    const lo = Math.min(Math.max(0.34, arch + 0.025), edge - 0.015);   // where the shoulder turns into the flank
    let bot = arch > 0 ? arch : z < -WB - RA ? 0.25 : 0.1;
    bot = Math.min(bot, lo - 0.005);
    const under = 0.03 + 0.12 * smoothstep(1.15, 0.7, z) * smoothstep(-1.15, -0.7, z);   // flank tucks in at the doors
    const pts = [];
    const wall = sx => { for (let k = 1; k <= NW; k++) { const s = k / NW; pts.push([sx * (hw - under * s * s), lo + (bot - lo) * s, -1]); } };
    wall(-1); pts.reverse();
    for (let j = 0; j <= NU; j++) {
      const u = -1 + 2 * j / NU, x = hw * (0.35 * u + 0.65 * Math.sin(u * Math.PI / 2));
      const [y, lift] = crown(x, z);
      pts.push([x, shoulder(y, lo, x / hw), lift]);
    }
    wall(1);
    for (const p of pts) p[1] = noseRoll(p[1], z);
    return pts;
  }

  // body-space height of the skin's top at (x, z) — used to seat lights, mirrors and the roof scoop
  function surfaceY(x, z) {
    const hw = halfW(z), [y] = crown(x, z), arch = archTop(z);
    const lo = Math.min(Math.max(0.34, arch + 0.025), crown(hw, z)[0] - 0.015);
    return noseRoll(shoulder(y, lo, x / hw), z);
  }
  function surfaceNormal(x, z) {
    const e = 0.004;
    return new THREE.Vector3(surfaceY(x - e, z) - surfaceY(x + e, z), 2 * e, surfaceY(x, z - e) - surfaceY(x, z + e)).normalize();
  }

  let geo = null;
  function skin() {
    if (geo) return geo;
    // stations every 2 cm, plus a pair hugging each arch edge so the openings get crisp vertical sides
    const zs = [];
    for (let z = ZR; z < ZF; z += 0.02) zs.push(z);
    zs.push(ZF);
    for (const zc of [WB, -WB]) for (const s of [-1, 1]) zs.push(zc + s * (RA - 0.0015), zc + s * (RA + 0.0015));
    zs.sort((a, b) => a - b);
    const P = 2 * NW + NU + 1, pos = [], lift = [], idx = [];
    const rings = zs.map(z => section(z));
    rings.forEach((ring, i) => ring.forEach(([x, y, l]) => { pos.push(x, y, zs[i]); lift.push(l); }));
    for (let i = 0; i < zs.length - 1; i++) {
      for (let j = 0; j < P - 1; j++) {
        const a = i * P + j, b = a + P;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('zone', new THREE.Float32BufferAttribute(lift, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    // flat caps on the nose and tail sections
    const caps = [[rings[rings.length - 1], ZF, 1], [rings[0], ZR, -1]].map(([ring, z, dir]) => {
      const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, y]) => new THREE.Vector2(x, y)), []);
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(ring.flatMap(([x, y]) => [x, y, z]), 3));
      cg.setAttribute('zone', new THREE.Float32BufferAttribute(ring.map(() => -1), 1));
      cg.setIndex(tris.flatMap(t => {
        const [a, b, c] = t, ab = [ring[b][0] - ring[a][0], ring[b][1] - ring[a][1]], ac = [ring[c][0] - ring[a][0], ring[c][1] - ring[a][1]];
        return (ab[0] * ac[1] - ab[1] * ac[0]) * dir > 0 ? [a, b, c] : [a, c, b];
      }));
      cg.computeVertexNormals();
      return cg;
    });
    geo = { body: g, caps };
    return geo;
  }

  return { ZF, ZR, WB, R, RA, halfW, surfaceY, surfaceNormal, skin };
})();

// Body paint: white front, accent tail sweeping forward up the flank, accent fender crowns and nose pin-stripes,
// black lower body, wheel-exit vent, swoosh, canopy and tinted glass. Roughness / clearcoat change with the paint.
const HC_LIVERY_GLSL = /* glsl */`
  void livery(out vec3 col, out float rough, out float metal, out float coat) {
    vec3 p = vLp, n = normalize(vLn);
    float ax = abs(p.x);
    col = vec3(0.84, 0.85, 0.86); rough = 0.26; metal = 0.0; coat = 1.0;

    float zb = mix(-0.85, 0.12, smoothstep(0.3, 0.92, p.y));                     // white -> accent boundary
    float acc = step(p.z, zb);
    acc = max(acc, step(0.6, ax) * step(ax, 0.93) * step(1.02, p.z) * step(p.z, 2.12) * step(0.6, n.y) * step(0.77, p.y));
    float pin = step(0.06, ax) * step(ax, 0.44) * step(1.45 + 1.1 * ax, p.z) * step(0.6, n.y) * step(p.y, 0.6) * step(0.42, fract(ax * 13.0 + 0.2));
    acc = max(acc, pin);
    col = mix(col, uAccent, acc);

    float blk = 0.0;
    float door = smoothstep(-1.35, -0.85, p.z) * (1.0 - smoothstep(0.45, 1.05, p.z));
    blk = max(blk, 1.0 - step(0.27 + 0.1 * door, p.y));                            // lower body
    float swoosh = 0.45 + 0.27 * smoothstep(-2.3, -0.3, -p.z);
    blk = max(blk, step(0.8, ax) * step(abs(p.y - swoosh), 0.022) * step(p.z, zb - 0.06));
    vec2 v = vec2((p.z - 1.02) / 0.13, (p.y - 0.47) / 0.21);                        // front-wheel exit gap
    blk = max(blk, step(0.84, ax) * step(pow(abs(v.x), 4.0) + pow(abs(v.y), 4.0), 1.0));
    blk = max(blk, step(0.35, n.z) * (1.0 - step(0.25, p.y)) * step(1.9, p.z));     // nose intake
    blk = max(blk, step(n.z, -0.55));                                              // tail
    if (blk > 0.5) { col = vec3(0.012); rough = 0.55; coat = 0.25; }

    if (vZone > -0.004 && p.z > -0.75) {                                            // canopy
      col = vec3(0.014); rough = 0.4; coat = 0.6;
      bool screen = p.z > 0.16 && ax < 0.42;
      bool side = ax > 0.24 && p.z > -0.32 && p.z < 0.62 && p.y > 0.74 && p.y < 0.93;
      if (screen || side) { col = vec3(0.012, 0.016, 0.022); rough = 0.03; metal = 0.25; coat = 1.0; }
      if (ax < 0.15 && p.z < 0.1 && p.z > -0.5) { col = uAccent; rough = 0.26; coat = 1.0; }   // around the roof scoop
    }
  }`;

function hypercarPaint(accent) {
  return proceduralPaint(HC_LIVERY_GLSL, { uAccent: new THREE.Color(accent) }, { zone: true });
}

// Wing / fin profile in the side (z, y) plane, extruded across x
function sideExtrude(pts, thick, x = 0) {
  const s = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
  return g.rotateY(-Math.PI / 2).translate(x + thick / 2, 0, 0);   // shape x -> +z, extrusion -> -x
}
// Inverted (downforce) aerofoil: leading edge at +z, span along x
function aerofoil(chord, thick, span, camber = 0.05) {
  const top = [], bot = [];
  for (let i = 0; i <= 18; i++) {
    const s = (1 - Math.cos(i / 18 * Math.PI)) / 2;
    const t = 5 * thick * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1036 * s ** 4);
    const c = -camber * chord * 4 * s * (1 - s), z = chord * (0.5 - s);
    top.push([z, c + t * chord]); bot.push([z, c - t * chord]);
  }
  const g = sideExtrude([...top, ...bot.reverse().slice(1, -1)], span);
  return g;
}

function createHypercar(accent, number) {
  const car = new THREE.Group();
  const paint = hypercarPaint(accent);
  const black = new THREE.MeshPhysicalMaterial({ color: 0x0b0b0d, roughness: 0.5, metalness: 0.2, clearcoat: 0.35, clearcoatRoughness: 0.3 });
  const mirrorGlass = new THREE.MeshStandardMaterial({ color: 0x8a96a4, metalness: 1, roughness: 0.1 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xe4eeff, emissiveIntensity: 2.6 });
  const { ZF, ZR, WB, R, RA, surfaceY, surfaceNormal } = HC_BODY;

  // skin + caps
  const { body, caps } = HC_BODY.skin();
  addPart(car, body, paint);
  for (const c of caps) addPart(car, c, paint);

  // wheel-well liners seen through the arch openings
  const liner = new THREE.CylinderGeometry(RA - 0.01, RA - 0.01, 0.36, 28, 1, true, -0.35, Math.PI + 0.7).rotateZ(Math.PI / 2);
  const linerMat = black.clone(); linerMat.side = THREE.DoubleSide;
  for (const z of [WB, -WB]) for (const sx of [-1, 1]) addPart(car, liner, linerMat, sx * 0.8, R, z);

  // floor, splitter, side planks, diffuser with strakes
  addPart(car, new THREE.BoxGeometry(1.26, 0.03, 4.75), MAT.carbon, 0, 0.085, 0.15);
  addPart(car, new THREE.BoxGeometry(1.94, 0.03, 0.34), MAT.carbon, 0, 0.09, ZF - 0.08);
  for (const sx of [-1, 1]) {
    addPart(car, new THREE.BoxGeometry(0.34, 0.03, 2.2), MAT.carbon, sx * 0.79, 0.085, 0);
    addPart(car, new THREE.BoxGeometry(0.16, 0.012, 0.22), black, sx * 0.99, 0.27, ZF - 0.2, 0, sx * 0.25, sx * 0.25);   // dive planes
    addPart(car, new THREE.BoxGeometry(0.14, 0.012, 0.18), black, sx * 0.99, 0.36, ZF - 0.3, 0, sx * 0.25, sx * 0.25);
  }
  addPart(car, taperedBox(1.5, 0.3, 1.5, 0.04, 0.55), black, 0, 0.07, ZR + 0.22);
  for (let k = -3; k <= 3; k++) addPart(car, new THREE.BoxGeometry(0.012, 0.28, 0.5), black, k * 0.22, 0.08, ZR + 0.2);
  addPart(car, new THREE.BoxGeometry(0.34, 0.2, 0.3), black, 0, 0.42, ZR + 0.1);              // crash structure
  addPart(car, new THREE.BoxGeometry(0.14, 0.05, 0.02), MAT.tail, 0, 0.45, ZR - 0.06);        // rain light

  // headlights: a slim LED bar on each nose corner with the four-point cluster at its inboard end
  for (const sx of [-1, 1]) {
    const x = sx * 0.7, z = ZF - 0.07, n = surfaceNormal(x, z);
    const unit = new THREE.Group();
    unit.position.set(x, surfaceY(x, z) + 0.003, z);
    unit.quaternion.setFromUnitVectors(UP, n);
    addPart(unit, new THREE.BoxGeometry(0.46, 0.012, 0.11), black);
    addPart(unit, new THREE.BoxGeometry(0.36, 0.016, 0.034), lamp, sx * 0.03, 0, -0.02);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      addPart(unit, new THREE.BoxGeometry(0.03, 0.018, 0.022), lamp, -sx * 0.17 + dx * 0.022, 0, 0.024 + dz * 0.015);
    }
    car.add(unit);
  }
  // full-width LED tail bar across the top of the rear
  addPart(car, new THREE.BoxGeometry(1.7, 0.028, 0.02), MAT.tail, 0, 0.57, ZR - 0.005);

  // mirrors on stalks on the fender crowns, either side of the windscreen
  for (const sx of [-1, 1]) {
    const x = sx * 0.66, z = 1.0, y = surfaceY(x, z);
    const pod = addPart(car, new THREE.SphereGeometry(1, 16, 10), black, x + sx * 0.02, y + 0.075, z);
    pod.scale.set(0.075, 0.032, 0.07);
    addPart(car, new THREE.PlaneGeometry(0.13, 0.05), mirrorGlass, x + sx * 0.02, y + 0.075, z - 0.035, 0, Math.PI);
    addPart(car, new THREE.BoxGeometry(0.012, 0.07, 0.05), black, x + sx * 0.02, y + 0.03, z + 0.01);
  }

  // roof scoop and radio antenna
  addPart(car, taperedBox(0.22, 0.04, 0.24, 0.11, 0.42), black, 0, surfaceY(0, -0.2) - 0.03, -0.2);
  addPart(car, new THREE.BoxGeometry(0.2, 0.07, 0.01), new THREE.MeshStandardMaterial({ color: 0x020202, roughness: 1 }), 0, surfaceY(0, 0.0) + 0.03, 0.005);
  strut(car, new THREE.Vector3(0, surfaceY(0, 0.35), 0.35), new THREE.Vector3(0, surfaceY(0, 0.35) + 0.32, 0.31), 0.004, black);

  // shark fin from the roof to the wing, race number on both faces
  addPart(car, sideExtrude([[-0.35, 0.99], [-2.32, 1.1], [-2.44, 1.06], [-2.44, 0.6], [-1.2, 0.8], [-0.5, 0.9]], 0.022), black);
  const numMat = new THREE.MeshStandardMaterial({ map: boardTexture(String(number), '#0b0b0d', '#f4f4f4', 256), roughness: 0.5, transparent: false });
  for (const sx of [-1, 1]) addPart(car, new THREE.PlaneGeometry(0.46, 0.23), numMat, sx * 0.0125, 0.94, -1.55, 0, sx * Math.PI / 2);

  // rear wing: main plane + flap between tall endplates, on two pylons
  addPart(car, aerofoil(0.36, 0.11, 1.84), black, 0, 1.0, -2.3, 0.1);
  addPart(car, aerofoil(0.18, 0.09, 1.84, 0.03), black, 0, 1.08, -2.5, 0.55);
  for (const sx of [-1, 1]) {
    addPart(car, sideExtrude([[-2.04, 0.96], [-2.04, 1.1], [-2.62, 1.17], [-2.66, 0.66], [-2.3, 0.6], [-2.1, 0.75]], 0.018, sx * 0.93), black);
    strut(car, new THREE.Vector3(sx * 0.24, 0.6, -2.28), new THREE.Vector3(sx * 0.24, 0.98, -2.34), 0.018, black);
  }

  // wheels: black ten-spoke rims, wider rears
  const style = { rim: MAT.rimDark, spoke: MAT.spokeDark, spokes: 5 };
  const wheels = [];
  for (const [z, w] of [[WB, 0.29], [-WB, 0.34]]) {
    for (const sx of [-1, 1]) {
      const wh = createWheel(R, w, 0x7d838b, style);
      wh.group.position.set(sx * (0.98 - w / 2), R, z);
      car.add(wh.group);
      wheels.push(wh);
    }
  }

  car.userData = {
    wheels,
    dustPoints: [new THREE.Vector3(-0.85, 0.12, -2.2), new THREE.Vector3(0.85, 0.12, -2.2)],
    vortexPoints: [new THREE.Vector3(-0.94, 1.14, -2.65), new THREE.Vector3(0.94, 1.14, -2.65)],
    onboard: new THREE.Vector3(0, 1.16, 0.32)     // roof cam: canopy, bonnet and fender crowns in view
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
  { name: 'W10-Style F1 #44',      css: '#9aa0a6,#00d2be', car: createOpenWheelCar(44, 0x111111), spec: OW },
  { name: 'W10-Style F1 #77',      css: '#9aa0a6,#ffd400', car: createOpenWheelCar(77, 0xffd400), spec: { ...OW, mu: OW.mu * 0.97 } },
  { name: 'LMDh Hypercar #7',      css: '#f2f2f2,#d5001c', car: createHypercar(0xd5001c, 7), spec: HC },
  { name: 'LMDh Hypercar #8',      css: '#f2f2f2,#0e7a4a', car: createHypercar(0x0e7a4a, 8), spec: { ...HC, mu: HC.mu * 0.97 } }
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
  // F1 #44 sits in the tow of Hypercar #8 on the downhill run into the Red Water dip; the other two trail far behind
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
