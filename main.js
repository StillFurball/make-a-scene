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
scene.fog = new THREE.Fog(0xd9a882, 140, 820);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.62;   // allow low "looking-up" angles
controls.minDistance = 3;
controls.maxDistance = 600;

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
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 450 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(hemi, ambient, sun, sun.target);

/* =====================================================================
   3. TRACK (CatmullRomCurve3 + custom ribbon geometry)
   ===================================================================== */
const TRACK_HALF_W = 6.5;
const N = 1400; // samples along the loop

// Hairpin -> downhill straight -> dip (Red Water) -> esses climbing (Raidillon) -> crest -> long straight -> return loop
const controlPoints = [
  [-120, 18, 60], [-80, 12, 50], [-40, 4, 40], [-10, 0, 30],
  [5, 1.5, 18], [10, 6, 0], [5, 12, -20], [12, 18, -45],
  [25, 23, -80], [50, 25, -120], [90, 25, -140], [130, 22, -110],
  [140, 19, -40], [120, 17, 40], [70, 18, 100], [-20, 20, 120],
  [-100, 20, 110], [-140, 19, 80]
].map(p => new THREE.Vector3(...p));

const curve = new THREE.CatmullRomCurve3(controlPoints, true, 'centripetal');

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
  const S = 512;
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
  return { map, roughnessMap };
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
  const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x4f7d33, roughness: 0.95 });
  for (const side of [-1, 1]) {
    const edge = side < 0 ? flatEdge(-W - 4, -W, -0.38, -0.01) : flatEdge(W, W + 4, -0.01, -0.38);
    const sh = new THREE.Mesh(buildStrip({ edge }), shoulderMat);
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

function naturalHeight(x, z) {
  let h = 14 * Math.sin(x * 0.008 + 0.5) * Math.cos(z * 0.009)
        + 7 * Math.sin(x * 0.021 + 2.0) * Math.sin(z * 0.017 + 1.0)
        + 2.2 * Math.sin(x * 0.06) * Math.cos(z * 0.05);
  const r = Math.hypot(x, z + 10);
  h += Math.max(0, r - 250) * 0.2;        // ring of taller hills in the distance
  return h + 15;
}

const FLAT = TRACK_HALF_W + 10, BLEND = 42;
function groundHeight(x, z) {
  const nat = naturalHeight(x, z);
  if (Math.hypot(x, z + 10) > 240) return nat;
  const n = nearestTrack(x, z);
  return lerp(n.y - 0.35, nat, smoothstep(FLAT, FLAT + BLEND, n.d));
}

function createTerrain() {
  const SIZE = 1400, SEG = 280;
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
    if (Math.hypot(x, z + 10) < 240) {
      const d = nearestTrack(x, z).d;
      c.lerp(cMown, 1 - smoothstep(FLAT - 2, FLAT + 8, d));
    }
    c.lerp(cRock, smoothstep(45, 90, y) * 0.6);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96 }));
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

function boardTexture(text, bg, fg) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 1024, 128);
  g.fillStyle = fg; g.font = '800 82px "Barlow Condensed", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 512, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
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
  addGrandstand(Math.floor(N * 0.93), 27, 9, 40)
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
function createForest(count = 2200) {
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 2.4, 6).translate(0, 1.2, 0);
  const lowGeo = new THREE.ConeGeometry(2.4, 5.2, 8).translate(0, 4.4, 0);
  const highGeo = new THREE.ConeGeometry(1.65, 4.2, 8).translate(0, 7.4, 0);
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
    const ang = rand() * Math.PI * 2, rad = 25 + Math.sqrt(rand()) * 520;
    const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad - 10;
    // patchy forest density
    const dens = 0.5 + 0.5 * Math.sin(x * 0.018 + 1.3) * Math.cos(z * 0.021 - 0.4);
    if (rand() > dens + 0.25) continue;
    if (Math.hypot(x, z + 10) < 260 && nearestTrack(x, z).d < TRACK_HALF_W + 15) continue;
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
  addPart(spin, new THREE.CylinderGeometry(r, r, w, 32).rotateZ(Math.PI / 2), MAT.tire);
  addPart(spin, new THREE.CylinderGeometry(r * 0.64, r * 0.64, w + 0.012, 24).rotateZ(Math.PI / 2), MAT.rim);
  for (let k = 0; k < 5; k++) {
    addPart(spin, new THREE.BoxGeometry(w + 0.024, 0.045, r * 1.2), MAT.spoke, 0, 0, 0, k * Math.PI / 5);
  }
  const ringMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.5 });
  for (const sx of [-1, 1]) {
    addPart(spin, new THREE.TorusGeometry(r * 0.83, 0.013, 6, 36).rotateY(Math.PI / 2), ringMat, sx * (w / 2 + 0.002));
  }
  return { group, spin, r };
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

/* ---------- 7a. F-Style Open Wheel Racer ---------- */
function createOpenWheelCar() {
  const car = new THREE.Group();
  const body = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, metalness: 0.75, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.06
  });
  const cyan = new THREE.MeshPhysicalMaterial({ color: 0x1fe0ff, metalness: 0.6, roughness: 0.3, clearcoat: 1 });

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
  // every part using the livery material gets the blue -> cyan gradient
  for (const m of car.children) if (m.material === body) paintGradient(m, 0x1fe0ff, 0x0a2bb8, 2.6, -1.8);

  // wheels + suspension
  const wheels = [];
  const R = 0.36;
  for (const [z, w, tx] of [[1.8, 0.36, 0.82], [-1.75, 0.44, 0.8]]) {
    for (const sx of [-1, 1]) {
      const wh = createWheel(R, w, 0x1fe0ff);
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
    vortexPoints: [new THREE.Vector3(-0.54, 1.12, -2.55), new THREE.Vector3(0.54, 1.12, -2.55)]
  };
  return car;
}

/* ---------- 7b. LM-Style Endurance Hypercar ---------- */
function createHypercar() {
  const car = new THREE.Group();
  const red = new THREE.MeshPhysicalMaterial({ color: 0xb5121b, roughness: 0.52, metalness: 0.12, clearcoat: 0.25, clearcoatRoughness: 0.6 });
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

  // Wheels
  const wheels = [];
  for (const z of [WB, -WB]) {
    for (const sx of [-1, 1]) {
      const wh = createWheel(R, 0.38, 0xb5121b);
      wh.group.position.set(sx * 0.82, R, z);
      car.add(wh.group);
      wheels.push(wh);
    }
  }

  car.userData = {
    wheels,
    dustPoints: [new THREE.Vector3(-0.85, 0.12, -2.2), new THREE.Vector3(0.85, 0.12, -2.2)],
    vortexPoints: [new THREE.Vector3(-0.99, 1.2, -2.65), new THREE.Vector3(0.99, 1.2, -2.65)]
  };
  return car;
}

const openWheel = createOpenWheelCar();
const hypercar = createHypercar();
scene.add(openWheel, hypercar);

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
const dustTrail = new ParticleTrail(3200, 0xc9ac86, 0.45);
const wakeTrail = new ParticleTrail(1600, 0xf4f1ea, 0.55);
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
   9. CAMERA MODES
   ===================================================================== */
let cameraMode = 'lowangle';
const focus = new THREE.Vector3();
const lastFocus = new THREE.Vector3();

function setLowAngle() {
  // Low, just off the asphalt in the dip, looking up the climb
  const s = samples[(iDip - 22 + N) % N];
  const p = s.p.clone().addScaledVector(s.x, -(TRACK_HALF_W + 2.5));
  camera.position.set(p.x, s.p.y + 0.55, p.z);
  const t = samples[(iDip + 115) % N].p;
  controls.target.set(t.x, t.y + 2.5, t.z);
  camera.fov = 42;
  camera.updateProjectionMatrix();
}
function setFollow() {
  const f = frameAt(state.dist);
  controls.target.copy(focus);
  camera.position.copy(focus).addScaledVector(f.t, -14).addScaledVector(f.x, 9).addScaledVector(UP, 4);
  camera.fov = 48; camera.updateProjectionMatrix();
}
function setAerial() {
  controls.target.set(10, 12, -10);
  camera.position.set(-230, 190, 260);
  camera.fov = 48; camera.updateProjectionMatrix();
}

document.querySelectorAll('#controls [data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    cameraMode = btn.dataset.mode;
    document.querySelectorAll('#controls [data-mode]').forEach(b => b.classList.toggle('active', b === btn));
    controls.enabled = cameraMode !== 'chase';
    if (cameraMode === 'lowangle') setLowAngle();
    if (cameraMode === 'follow') setFollow();
    if (cameraMode === 'aerial') setAerial();
    if (cameraMode === 'chase') {
      const f = racers[0].frame;
      camera.position.copy(focus).addScaledVector(f.t, -11).addScaledVector(f.y, 3.2);
      camera.fov = 58; camera.updateProjectionMatrix();
    }
    lastFocus.copy(focus);
  });
});

/* =====================================================================
   10. ANIMATION LOOP
   ===================================================================== */
const state = { dist: samples[iDip].dist - 70, time: 0, paused: false, speedFactor: 1 };
const BASE_SPEED = 64; // m/s
const spdA = document.getElementById('spdA'), spdB = document.getElementById('spdB');
document.getElementById('speed').addEventListener('input', e => state.speedFactor = parseFloat(e.target.value));
const pauseBtn = document.getElementById('pause');
pauseBtn.addEventListener('click', () => {
  state.paused = !state.paused;
  pauseBtn.textContent = state.paused ? 'Lanjut' : 'Jeda';
  pauseBtn.classList.toggle('active', state.paused);
});

const racers = [
  { car: openWheel, lane: -2.6, phase: 0,   lastDist: null, el: spdA },
  { car: hypercar,  lane: 2.6,  phase: Math.PI, lastDist: null, el: spdB }
];
const basis = new THREE.Matrix4();
let hudTimer = 0;

function placeCars(dt) {
  focus.set(0, 0, 0);
  for (const r of racers) {
    // the two cars trade the lead and weave slightly within their lane
    const gap = 3.2 * Math.sin(state.time * 0.33 + r.phase);
    const d = state.dist + gap;
    const f = frameAt(d);
    const lateral = r.lane + 0.45 * Math.sin(state.time * 0.7 + r.phase * 1.3);
    r.car.position.copy(f.p).addScaledVector(f.x, lateral);
    basis.makeBasis(f.x, f.y, f.t);
    r.car.quaternion.setFromRotationMatrix(basis);
    r.car.updateMatrixWorld();

    const speed = r.lastDist === null || dt === 0 ? 0 : (d - r.lastDist) / dt;
    r.lastDist = d;
    r.speed = speed;
    for (const w of r.car.userData.wheels) w.spin.rotation.x += (speed * dt) / w.r;
    if (dt > 0) emitFromCar(r.car, f, speed, dt);
    focus.add(r.car.position);
    r.frame = f;
  }
  focus.multiplyScalar(0.5);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = state.paused ? 0 : Math.min(clock.getDelta(), 0.05);
  if (state.paused) clock.getDelta();

  if (dt > 0) {
    state.time += dt;
    // slow on the climb, faster downhill
    const slope = frameAt(state.dist).t.y;
    state.dist += BASE_SPEED * state.speedFactor * (1 - slope * 0.9) * dt;
  }
  placeCars(dt);
  dustTrail.update(dt);
  wakeTrail.update(dt);

  // shadows follow the action
  sun.position.copy(focus).addScaledVector(SUN_DIR, 180);
  sun.target.position.copy(focus);

  if (cameraMode === 'follow') {
    const delta = focus.clone().sub(lastFocus);
    camera.position.add(delta);
    controls.target.add(delta);
  } else if (cameraMode === 'chase') {
    const f = racers[0].frame;
    const want = focus.clone().addScaledVector(f.t, -11).addScaledVector(f.y, 3.2);
    camera.position.lerp(want, 1 - Math.exp(-6 * (dt || 0.016)));
    controls.target.copy(focus).addScaledVector(f.t, 10);
    camera.lookAt(controls.target);
  }
  lastFocus.copy(focus);

  if (cameraMode !== 'chase') controls.update();
  sky.position.copy(camera.position);

  hudTimer += dt;
  if (hudTimer > 0.15) {
    hudTimer = 0;
    for (const r of racers) r.el.textContent = `${Math.round(Math.max(0, r.speed) * 3.6)} km/j`;
  }
  renderer.render(scene, camera);
}

const clock = new THREE.Clock();
placeCars(0);
lastFocus.copy(focus);
setLowAngle();
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  dustTrail.material.uniforms.uScale.value = wakeTrail.material.uniforms.uScale.value = window.innerHeight * 0.5;
});
