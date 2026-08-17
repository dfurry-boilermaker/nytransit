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
function terrainTint(e) {
  const stops = [[-2, 0x14324f], [1, 0x2f5d43], [10, 0x4f7a44], [30, 0x8f9a52], [70, 0xa9885c], [120, 0xb9a894], [180, 0xe6e9ee]];
  for (let i = 0; i < stops.length - 1; i++) {
    const [ea, ca] = stops[i], [eb, cb] = stops[i + 1];
    if (e >= ea && e <= eb) return new THREE.Color(ca).lerp(new THREE.Color(cb), (e - ea) / (eb - ea));
  }
  return new THREE.Color(e < 0 ? 0x14324f : 0xe6e9ee);
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
renderer.setClearColor(0x05070f, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0a1428, 16000, 62000);

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
    uniforms: { top: { value: new THREE.Color(0x0a1024) }, mid: { value: new THREE.Color(0x1b2f57) }, bot: { value: new THREE.Color(0x3a2f46) } },
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

  setupAbout(data.meta);
  setupUI();
  setupPicking();
  frameStatue();

  document.getElementById('loader').classList.add('hide');
  animStart = performance.now();
  animate();
}

// ---- water ----
function buildWater() {
  const geo = new THREE.PlaneGeometry(180000, 180000);
  const mat = new THREE.MeshStandardMaterial({ color: 0x0c3350, metalness: 0.1, roughness: 0.35, transparent: true, opacity: 0.55, depthWrite: false });
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
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const vi = j * W + i, e = elev[vi];
    pos.setZ(vi, e < 1 ? -1.2 : e);
    c.copy(terrainTint(e));
    col[vi * 3] = c.r; col[vi * 3 + 1] = c.g; col[vi * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.rotateX(-Math.PI / 2);
  geo.translate((xMin + xMax) / 2, 0, (zMin + zMax) / 2);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -2;
  aboveGroup.add(mesh);
}

function buildCoastline(boroughs) {
  const g = new THREE.Group();
  for (const b of boroughs) for (const ring of b.rings) {
    const pts = ring.map(([x, z]) => new THREE.Vector3(x, 0.4, z));
    g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8fc4ff, transparent: true, opacity: 0.4 })));
  }
  aboveGroup.add(g);
}

// ---- buildings ----
function buildBuildings(list) {
  const HMAX = 85, geos = [];
  for (const b of list) {
    if (!b.ring || b.ring.length < 3) continue;
    const shape = new THREE.Shape(b.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const hDisp = HMAX * (1 - Math.exp(-b.h / HMAX));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: hDisp, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, b.base, 0);
    geos.push(geo);
  }
  if (!geos.length) return;
  const merged = BufferGeometryUtils.mergeGeometries(geos, false);
  merged.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc4d3ea, roughness: 0.6, metalness: 0.05, flatShading: true, transparent: true, opacity: 0.92 });
  aboveGroup.add(new THREE.Mesh(merged, mat));
}

// ---- lines (positions baked with the vy() transform) ----
function bakePositions(raw) {
  const out = new Array(raw.length * 3);
  for (let i = 0; i < raw.length; i++) { out[i * 3] = raw[i][0]; out[i * 3 + 1] = vy(raw[i][1]); out[i * 3 + 2] = raw[i][2]; }
  return out;
}
function makeLine(raw, color, width, opacity, dashed, year) {
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
    if (t > GROW_SPAN + GROW_DUR + 1.2) {
      for (const d of depthLines) d.line.geometry.instanceCount = d.segs;
      uTime.value = 1e6;
      animDone = true;
    }
  }
  controls.update();
  renderer.render(scene, camera);
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resolution.set(innerWidth, innerHeight);
  for (const m of lineMaterials) m.resolution.copy(resolution);
});

boot();
