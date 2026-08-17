import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

// --- vertical model ---------------------------------------------------------
// Depths (below sea level) are exaggerated by VE (the slider) so the subway's
// real depth reads at a glance. Above-ground terrain & buildings use a gentle
// FIXED factor so hills and towers stay believable instead of becoming spikes.
const ABOVE = 3;
let VE = 50;
const vy = (y) => (y >= 0 ? y * ABOVE : y * VE); // meters -> world Y

function colorForElevation(y) {
  const stops = [[150, 0xf2f4f8], [60, 0xffd24a], [8, 0x6fe0a6], [-10, 0x4aa3ff], [-35, 0xc56bff]];
  for (let i = 0; i < stops.length - 1; i++) {
    const [ya, ca] = stops[i], [yb, cb] = stops[i + 1];
    if (y <= ya && y >= yb) return new THREE.Color(ca).lerp(new THREE.Color(cb), (ya - y) / (ya - yb));
  }
  return new THREE.Color(y > 0 ? 0xf2f4f8 : 0xc56bff);
}

// Approximate first-service year per line, for the "network grows" animation.
const ROUTE_YEARS = {
  '1': 1904, '2': 1904, '3': 1904, '4': 1904, '5': 1905, '6': 1904, '6X': 1904, S: 1904, GS: 1904,
  '7': 1915, '7X': 1915, SI: 1925,
  N: 1918, Q: 1920, R: 1918, W: 1918, J: 1918, Z: 1918, L: 1924, FS: 1920, H: 1956,
  A: 1932, C: 1932, E: 1933, B: 1936, D: 1936, F: 1936, M: 1936, G: 1933,
  'PATH-NWK': 1911, 'PATH-HOB': 1909, 'PATH-JSQ': 1910,
};
const YEAR_MIN = 1904, YEAR_MAX = 1940, GROW_SPAN = 8.0, GROW_DUR = 1.7;
const timeForYear = (y) => Math.max(0, Math.min(GROW_SPAN, ((y - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * GROW_SPAN));

// ===========================================================================
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const isMobile = matchMedia('(max-width: 760px)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x0a2438, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x2b6786, 15000, 60000); // teal haze -> underwater feel

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 5, 400000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxDistance = 90000;
controls.minDistance = 250;
controls.maxPolarAngle = Math.PI * 0.99;

{ // sky dome
  const geo = new THREE.SphereGeometry(180000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(0x4a86c4) }, mid: { value: new THREE.Color(0xcfe8f7) }, bot: { value: new THREE.Color(0x06304a) } },
    vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 bot; void main(){ float h=normalize(vP).y; vec3 c=h>0.0?mix(mid,top,h):mix(mid,bot,-h); gl_FragColor=vec4(c,1.0);}',
  });
  scene.add(new THREE.Mesh(geo, mat));
}
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a3852, 1.35));
scene.add(new THREE.AmbientLight(0x8092b8, 0.35));
const sun = new THREE.DirectionalLight(0xffe6c2, 1.25);
sun.position.set(-9000, 8000, 10000);
scene.add(sun);

const aboveGroup = new THREE.Group(); // terrain, buildings, water — fixed gentle scale
aboveGroup.scale.y = ABOVE;
scene.add(aboveGroup);

const resolution = new THREE.Vector2(innerWidth, innerHeight);
const lineMaterials = [];
const depthLines = []; // { line, raw, dashed, segs, startT }
let META = null, stationData = [], stationsPts = null, stationReveal = null;
const uTime = { value: 0 };
let animStart = null;
let introEls = null, lastYear = -1, lastPhase = '';
// intro camera fly: high above ground -> down below the waterline as lines finish
const introCam = { active: true, a0: new THREE.Vector3(), a1: new THREE.Vector3(), b0: new THREE.Vector3(), b1: new THREE.Vector3() };
const _tmpT = new THREE.Vector3();

// ===========================================================================
async function boot() {
  const [data, terrain, buildings] = await Promise.all([
    fetch('./data/transit.json').then((r) => r.json()),
    fetch('./data/terrain.json').then((r) => r.json()).catch(() => null),
    fetch('./data/buildings.json').then((r) => r.json()).catch(() => null),
  ]);
  META = data.meta;

  buildWater();
  if (terrain) buildTerrain(terrain);
  buildCoastline(data.boroughs);
  if (buildings) buildBuildings(buildings.buildings);
  buildSubway(data.routes);
  buildPath(data.path || []);
  buildBuses(data.buses);
  buildStations(data.stations);

  introEls = { root: document.getElementById('intro'), phase: document.getElementById('intro-phase'), year: document.getElementById('intro-year'), fill: document.getElementById('intro-fill') };
  setupAbout(data.meta);
  setupUI();
  setupPicking();
  setupIntroCam();

  document.getElementById('loader').classList.add('hide');
  animStart = performance.now();
  animate();
}

// ---- water ----
function buildWater() {
  const geo = new THREE.PlaneGeometry(180000, 180000);
  const mat = new THREE.MeshStandardMaterial({ color: 0x0e6f97, metalness: 0.35, roughness: 0.16, transparent: true, opacity: 0.68, depthWrite: false });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = -3;
  aboveGroup.add(m);
}

// ---- DEM terrain ----
function buildTerrain(t) {
  const { xMin, xMax, zMin, zMax, W, H, elev } = t;
  const geo = new THREE.PlaneGeometry(xMax - xMin, zMax - zMin, W - 1, H - 1);
  const pos = geo.attributes.position;
  const aElev = new Float32Array(pos.count);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const vi = j * W + i, e = elev[vi];
    pos.setZ(vi, e < 1 ? -1.2 : e);
    aElev[vi] = e;
  }
  geo.setAttribute('aElev', new THREE.BufferAttribute(aElev, 1));
  geo.rotateX(-Math.PI / 2);
  geo.translate((xMin + xMax) / 2, 0, (zMin + zMax) / 2);
  geo.computeVertexNormals();
  // Grayscale stepped-contour relief: light = high, dark = low, with contour
  // lines every few metres so it reads as a topographic model.
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0, transparent: true, opacity: 0.66, depthWrite: false, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float aElev;\nvarying float vElev;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vElev = aElev;');
    sh.fragmentShader = 'varying float vElev;\n' +
      sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float g = pow(clamp((vElev + 16.0) / 195.0, 0.0, 1.0), 0.82);
        vec3 grey = mix(vec3(0.13,0.15,0.19), vec3(0.95,0.96,0.99), g);
        float e2 = fract(vElev / 6.0);
        float edge = min(e2, 1.0 - e2);
        float line = smoothstep(0.0, 0.08, edge);
        grey *= mix(0.58, 1.0, line);
        diffuseColor.rgb = grey;`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -2;
  aboveGroup.add(mesh);
}

function buildCoastline(boroughs) {
  const g = new THREE.Group();
  for (const b of boroughs) for (const ring of b.rings) {
    if (ring.length < 2) continue;
    const flat = [];
    for (const [x, z] of ring) flat.push(x, 1.0, z);
    flat.push(ring[0][0], 1.0, ring[0][1]); // close the loop
    const geo = new LineGeometry();
    geo.setPositions(flat);
    const mat = new LineMaterial({ color: 0xeaf6ff, linewidth: 2.4, transparent: true, opacity: 0.92, worldUnits: false });
    mat.resolution.copy(resolution);
    lineMaterials.push(mat);
    g.add(new Line2(geo, mat));
  }
  aboveGroup.add(g);
}

// ---- buildings ----
function buildBuildings(list) {
  const geos = [];
  for (const b of list) {
    if (!b.ring || b.ring.length < 3) continue;
    const shape = new THREE.Shape(b.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: b.h, bevelEnabled: false }); // real roof height
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, b.base, 0);
    geos.push(geo);
  }
  if (!geos.length) return;
  const merged = BufferGeometryUtils.mergeGeometries(geos, false);
  merged.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0xe2e7ee, roughness: 0.72, metalness: 0.04, flatShading: true, transparent: true, opacity: 0.96 });
  aboveGroup.add(new THREE.Mesh(merged, mat));
}

// Chaikin corner-cutting: rounds hard corners into smooth, runnable curves.
function chaikin(pts, iters) {
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2] * 0.75 + b[2] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, a[2] * 0.25 + b[2] * 0.75]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

// ---- lines (positions baked with the vy() transform) ----
function bakePositions(raw) {
  const out = new Array(raw.length * 3);
  for (let i = 0; i < raw.length; i++) { out[i * 3] = raw[i][0]; out[i * 3 + 1] = vy(raw[i][1]); out[i * 3 + 2] = raw[i][2]; }
  return out;
}
function makeLine(rawIn, color, width, opacity, dashed, year) {
  const raw = rawIn.length >= 3 ? chaikin(rawIn, 3) : rawIn; // smooth hard corners
  const geo = new LineGeometry();
  geo.setPositions(bakePositions(raw));
  const mat = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, transparent: true, opacity, worldUnits: false, dashed: !!dashed, dashSize: 55, gapSize: 35 });
  mat.resolution.copy(resolution);
  lineMaterials.push(mat);
  const line = new Line2(geo, mat);
  if (dashed) line.computeLineDistances();
  const segs = raw.length - 1;
  const startT = timeForYear(year ?? 1930);
  line.geometry.instanceCount = 0; // grow in during the intro animation
  depthLines.push({ line, raw, dashed, segs, startT });
  scene.add(line);
  return line;
}
function buildSubway(routes) { for (const r of routes) if (r.points.length >= 2) makeLine(r.points, r.color, 3.2, 0.95, false, ROUTE_YEARS[r.id]); }
function buildPath(path) { for (const p of path) if (p.points.length >= 2) makeLine(p.points, '#20c4d6', 3.4, 0.98, true, ROUTE_YEARS[p.id] ?? 1910); }
function buildBuses(buses) { for (const b of buses) if (b.points.length >= 2) makeLine(b.points, 0xf2f6ff, 1.6, 0.5, false, 1938); }

// ---- stations ----
function discTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(32, 32, 27, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.35)'; g.stroke();
  return new THREE.CanvasTexture(c);
}
function buildStations(stations) {
  stationData = stations;
  const n = stations.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), reveal = new Float32Array(n);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const s = stations[i];
    pos[i * 3] = s.x; pos[i * 3 + 1] = vy(s.y); pos[i * 3 + 2] = s.z;
    c.copy(colorForElevation(s.y));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    const yr = Math.min(...s.routes.map((r) => ROUTE_YEARS[r] ?? 1930));
    reveal[i] = timeForYear(isFinite(yr) ? yr : 1930) + GROW_DUR * 0.5;
  }
  stationReveal = reveal;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aReveal', new THREE.BufferAttribute(reveal, 1));
  const mat = new THREE.PointsMaterial({ size: isMobile ? 7 : 8, sizeAttenuation: false, vertexColors: true, map: discTexture(), alphaTest: 0.5, transparent: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = 'attribute float aReveal;\nuniform float uTime;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n if (aReveal > uTime) { transformed += vec3(0.0, 1.0e9, 0.0); }');
  };
  stationsPts = new THREE.Points(geo, mat);
  scene.add(stationsPts);
}

// ---- vertical exaggeration ----
function applyVE(v) {
  VE = v;
  for (const d of depthLines) {
    d.line.geometry.setPositions(bakePositions(d.raw));
    if (d.dashed) d.line.computeLineDistances();
  }
  if (stationsPts) {
    const p = stationsPts.geometry.attributes.position;
    for (let i = 0; i < stationData.length; i++) p.setY(i, vy(stationData[i].y));
    p.needsUpdate = true;
  }
  document.getElementById('ve-val').textContent = v + '×';
}

// ---- framing ----
function setActive(id) { for (const b of document.querySelectorAll('#dock .views button')) b.classList.toggle('active', b.id === id); }
function frameStatue() {
  const [sx, sz] = META.camera.statue;
  const [tx, , tz] = META.camera.target;
  controls.target.set(tx, 220, tz);
  camera.position.set(sx - 900, 950, sz + 1700);
  controls.update();
  setActive('view-harbor');
}
function frameTop() {
  const [tx, , tz] = META.camera.center;
  controls.target.set(tx, 0, tz);
  camera.position.set(tx + 300, 32000, tz + 1);
  controls.update();
  setActive('view-top');
}
function frameCut() {
  const [tx, , tz] = META.camera.target;
  controls.target.set(tx, -3 * VE, tz + 2500);
  camera.position.set(tx + 9000, 700, tz + 2500);
  controls.update();
  setActive('view-cut');
}
// Intro fly: begins high above the harbor, descends below the waterline as the
// network finishes drawing, ending on the plunging under-river tubes.
function setupIntroCam() {
  const [sx, sz] = META.camera.statue;
  const [tx, , tz] = META.camera.target;
  introCam.a0.set(sx - 1600, 9200, sz + 5200);   // camera: high aerial
  introCam.a1.set(tx, 500, tz);                    // look at the surface
  introCam.b0.set(tx - 700, -520, tz + 3200);      // camera: below the waterline
  introCam.b1.set(tx, 40, tz + 800);               // look up at the tubes / skyline
  introCam.active = true;
  camera.position.copy(introCam.a0);
  camera.lookAt(introCam.a1);
  controls.enabled = false;
  setActive('view-harbor');
}
function finishIntro() {
  if (animDone) return;
  for (const d of depthLines) d.line.geometry.instanceCount = d.segs;
  uTime.value = 1e6;
  animDone = true;
  introCam.active = false;
  camera.position.copy(introCam.b0);
  controls.target.copy(introCam.b1);
  controls.enabled = true;
  controls.update();
  hideIntro();
}

function setupUI() {
  const ve = document.getElementById('ve');
  ve.value = VE;
  ve.addEventListener('input', () => applyVE(+ve.value));
  document.getElementById('view-harbor').onclick = frameStatue;
  document.getElementById('view-top').onclick = frameTop;
  document.getElementById('view-cut').onclick = frameCut;
}

// ---- picking ----
function setupPicking() {
  const tip = document.getElementById('tooltip');
  const v = new THREE.Vector3();
  let last = -1;
  function handle(cx, cy) {
    let best = 16 * 16, bi = -1;
    for (let i = 0; i < stationData.length; i++) {
      const s = stationData[i];
      v.set(s.x, vy(s.y), s.z).project(camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
      const dx = sx - cx, dy = sy - cy, d = dx * dx + dy * dy;
      if (d < best) { best = d; bi = i; }
    }
    if (bi >= 0) {
      if (bi !== last) { last = bi; renderTip(tip, stationData[bi]); }
      tip.hidden = false; tip.style.left = cx + 'px'; tip.style.top = cy + 'px';
      document.body.style.cursor = 'pointer'; return true;
    }
    tip.hidden = true; last = -1; document.body.style.cursor = ''; return false;
  }
  addEventListener('pointermove', (e) => handle(e.clientX, e.clientY));
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; if (t) handle(t.clientX, t.clientY); }, { passive: true });
}

const ROUTE_COLORS = {
  '1': '#EE352E', '2': '#EE352E', '3': '#EE352E', '4': '#00933C', '5': '#00933C', '6': '#00933C', '7': '#B933AD',
  A: '#0039A6', C: '#0039A6', E: '#0039A6', B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
  G: '#6CBE45', J: '#996633', Z: '#996633', L: '#A7A9AC', N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
  S: '#808183', SI: '#0039A6', PATH: '#20c4d6',
};
const routeColor = (r) => ROUTE_COLORS[r] || '#6b7280';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderTip(tip, s) {
  const seaTxt = s.y >= 0 ? `${s.y.toFixed(0)} m above sea level` : `${Math.abs(s.y).toFixed(0)} m below sea level`;
  const bullets = s.routes.map((r) => `<span class="bullet" style="background:${routeColor(r)}">${esc(r)}</span>`).join('');
  const meta = esc(s.structure) + (s.depthFt > 0 ? ` · ${s.depthFt} ft below street` : '');
  tip.innerHTML = `<div class="name">${esc(s.name)}</div><div class="bullets">${bullets}</div><div class="meta">${meta}</div><div class="depth">${seaTxt}</div>`;
}

function setupAbout(meta) {
  document.getElementById('about-body').textContent = meta.disclaimer;
  document.getElementById('about-sources').innerHTML = meta.sources.map((s) => `<li>${s}</li>`).join('');
  const modal = document.getElementById('about');
  document.getElementById('about-btn').onclick = () => (modal.hidden = false);
  document.getElementById('about-close').onclick = () => (modal.hidden = true);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
}

// ---- loop (drives the network-grows-on-refresh animation) ----
function updateIntro(t) {
  if (!introEls) return;
  const total = GROW_SPAN + GROW_DUR;
  const p = Math.min(1, t / total);
  const year = Math.min(1940, Math.floor(1904 + p * (1940 - 1904)));
  if (year !== lastYear) { introEls.year.textContent = year; lastYear = year; }
  const phase = p < 0.15 ? 'Surveying the route' : p < 0.35 ? 'Digging tunnels'
    : p < 0.6 ? 'Laying track' : p < 0.8 ? 'Electrifying the third rail'
    : p < 0.97 ? 'Opening stations' : 'Now serving New York';
  if (phase !== lastPhase) { introEls.phase.textContent = phase; lastPhase = phase; }
  introEls.fill.style.width = (p * 100).toFixed(1) + '%';
}
function hideIntro() { if (introEls) { introEls.root.classList.add('hide'); setTimeout(() => { introEls.root.hidden = true; }, 900); } }

let animDone = false;
function animate() {
  requestAnimationFrame(animate);
  const t = (performance.now() - animStart) / 1000;
  if (!animDone) {
    uTime.value = t;
    for (const d of depthLines) {
      const p = Math.max(0, Math.min(1, (t - d.startT) / GROW_DUR));
      d.line.geometry.instanceCount = Math.ceil(p * d.segs);
    }
    updateIntro(t);
    if (introCam.active) {
      const p = Math.min(1, t / (GROW_SPAN + GROW_DUR));
      const e = p * p * (3 - 2 * p); // smoothstep
      camera.position.lerpVectors(introCam.a0, introCam.b0, e);
      _tmpT.lerpVectors(introCam.a1, introCam.b1, e);
      camera.lookAt(_tmpT);
    }
    if (t > GROW_SPAN + GROW_DUR + 0.4) finishIntro();
  }
  if (!introCam.active) controls.update(); // don't let OrbitControls fight the fly
  renderer.render(scene, camera);
}
// let the user skip the intro with any interaction
['pointerdown', 'wheel', 'touchstart', 'keydown'].forEach((ev) =>
  addEventListener(ev, () => { if (!animDone) finishIntro(); }, { passive: true }));
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resolution.set(innerWidth, innerHeight);
  for (const m of lineMaterials) m.resolution.copy(resolution);
});

boot();
