// Build the app's transit.json from raw MTA + GTFS + coastline data.
//
// Inputs  (data/raw/):
//   mta_stations.json  — MTA "Subway Stations" (structure type, coords, routes)
//   gtfs_shapes.txt    — GTFS line geometry
//   gtfs_trips.txt     — GTFS route_id -> shape_id mapping
//   gtfs_routes.txt    — GTFS route colors / names
//   boroughs.geojson   — 5 NYC borough polygons (coastline)
//
// Output  (public/data/transit.json):
//   { meta, boroughs, routes, stations, buses }
//
// Vertical model: y is METERS relative to MEAN SEA LEVEL (y=0). The app
// applies a vertical-exaggeration multiplier for legibility. Depths and
// ground elevations are approximate and documented in meta.sources.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, '..', 'data', 'raw');
const OUT = join(__dirname, '..', 'public', 'data', 'transit.json');

const FT = 0.3048; // feet -> meters

// ---------------------------------------------------------------------------
// Projection: local equirectangular, meters, centered on Midtown Manhattan.
// worldX = east (+), worldZ = north (-)  [north points toward -Z]
// ---------------------------------------------------------------------------
const LAT0 = 40.758;
const LON0 = -73.978;
const M_PER_LAT = 111320;
const M_PER_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const project = (lon, lat) => ({
  x: (lon - LON0) * M_PER_LON,
  z: -(lat - LAT0) * M_PER_LAT,
});

// ---------------------------------------------------------------------------
// Minimal CSV parser (handles quoted fields with embedded commas).
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// ---------------------------------------------------------------------------
// GROUND ELEVATION — sampled from the real DEM baked by build-terrain.mjs.
// ---------------------------------------------------------------------------
let TERRAIN = null;
try { TERRAIN = JSON.parse(readFileSync(join(RAW, '..', '..', 'public', 'data', 'terrain.json'), 'utf8')); }
catch { console.warn('terrain.json missing — run `node scripts/build-terrain.mjs` first'); }

function groundElevation(lon, lat) {
  if (!TERRAIN) return 8;
  const { xMin, xMax, zMin, zMax, W, H, elev } = TERRAIN;
  const p = project(lon, lat);
  const fx = ((p.x - xMin) / (xMax - xMin)) * (W - 1);
  const fz = ((p.z - zMin) / (zMax - zMin)) * (H - 1);
  if (fx < 0 || fx > W - 1 || fz < 0 || fz > H - 1) return 6;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const x1 = Math.min(W - 1, x0 + 1), z1 = Math.min(H - 1, z0 + 1);
  const tx = fx - x0, tz = fz - z0;
  const a = elev[z0 * W + x0], b = elev[z0 * W + x1];
  const c = elev[z1 * W + x0], d = elev[z1 * W + x1];
  return Math.max(0, (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz);
}

// ---------------------------------------------------------------------------
// DEPTH MODEL  (see meta.sources for provenance)
// ---------------------------------------------------------------------------

// Documented deep stations: depth in FEET below street level.
// Matched by stop_name (+ route where two stations share a name).
const DEEP_STATIONS = [
  { match: (n, r) => n === '191 St', ft: 173 },
  { match: (n, r) => n === '190 St', ft: 140 },
  { match: (n, r) => /34 St-Hudson Yards/.test(n), ft: 125 },
  { match: (n, r) => n === '181 St' && /\b1\b/.test(r), ft: 120 },
  { match: (n, r) => n === '181 St' && /\bA\b/.test(r), ft: 110 },
  { match: (n, r) => n === '175 St', ft: 90 },
  { match: (n, r) => n === '168 St', ft: 105 },
  { match: (n, r) => n === '163 St-Amsterdam Av', ft: 70 },
  { match: (n, r) => n === 'Roosevelt Island', ft: 100 },
  { match: (n, r) => n === 'Clark St', ft: 80 },
];

// Structure-based default DEPTH (ft below street) for underground stations
// when not in the deep table. Cut-and-cover box ≈ 25 ft (heuristic).
const CUT_AND_COVER_FT = 25;

function stationVertical(st) {
  const g = groundElevation(+st.gtfs_longitude, +st.gtfs_latitude);
  const s = st.structure;
  const name = st.stop_name;
  const routes = st.daytime_routes || '';

  if (s === 'Elevated' || s === 'Viaduct') return { y: g + 8.5, ground: g, depthFt: 0, kind: 'elevated' };
  if (s === 'At Grade') return { y: g + 0.5, ground: g, depthFt: 0, kind: 'surface' };
  if (s === 'Embankment') return { y: g + 4, ground: g, depthFt: 0, kind: 'surface' };
  if (s === 'Open Cut') return { y: g - 4, ground: g, depthFt: 13, kind: 'shallow' };

  // "Subway" (underground)
  let ft = CUT_AND_COVER_FT;
  for (const d of DEEP_STATIONS) if (d.match(name, routes)) { ft = d.ft; break; }
  return { y: g - ft * FT, ground: g, depthFt: ft, kind: ft >= 70 ? 'deep' : 'underground' };
}

// Under-river tube depth (m below sea level) as a function of location.
// East River ≈ 90 ft; deeper at 59-63 St (60th/63rd St tubes); Harlem ≈ 60 ft;
// Hudson (PATH) ≈ 97 ft.
function tubeDepthBelowSea(lon, lat) {
  // Harlem River (north, between Manhattan and the Bronx)
  if (lat > 40.80) return 60 * FT;
  // East River around the 59th–63rd St crossings (deep bored tubes)
  if (lat > 40.745 && lat < 40.775 && lon > -73.97) return 118 * FT;
  // Hudson (west of Manhattan) — PATH
  if (lon < -74.01) return 97 * FT;
  // Default East River
  return 92 * FT;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray casting) over borough MultiPolygons, bbox-prefiltered.
// ---------------------------------------------------------------------------
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function buildLandIndex(geo) {
  // Collect outer rings (lon/lat) with bounding boxes for fast rejection.
  const polys = [];
  for (const f of geo.features) {
    const coords = f.geometry.coordinates;
    const parts = f.geometry.type === 'MultiPolygon' ? coords : [coords];
    for (const poly of parts) {
      const outer = poly[0];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [lx, ly] of outer) {
        if (lx < minX) minX = lx; if (lx > maxX) maxX = lx;
        if (ly < minY) minY = ly; if (ly > maxY) maxY = ly;
      }
      polys.push({ outer, minX, minY, maxX, maxY });
    }
  }
  return (lon, lat) => {
    for (const p of polys) {
      if (lon < p.minX || lon > p.maxX || lat < p.minY || lat > p.maxY) continue;
      if (ringContains(p.outer, lon, lat)) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const dist2 = (ax, az, bx, bz) => {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
};

// Decimate a lon/lat ring: keep points at least `minM` meters apart.
function decimateRing(ring, minM) {
  const out = [];
  let last = null;
  for (const [lon, lat] of ring) {
    const p = project(lon, lat);
    if (!last || dist2(p.x, p.z, last.x, last.z) > minM * minM) {
      out.push([+p.x.toFixed(1), +p.z.toFixed(1)]);
      last = p;
    }
  }
  if (out.length >= 3) return out;
  return null;
}

// Moving-average smoothing of a numeric array (window radius w).
function smooth(arr, w) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let k = -w; k <= w; k++) {
      const j = i + k;
      if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
    }
    out[i] = s / n;
  }
  return out;
}

// ===========================================================================
// MAIN
// ===========================================================================
console.log('Reading raw data…');
const stationsRaw = JSON.parse(readFileSync(join(RAW, 'mta_stations.json'), 'utf8'));
const routesRaw = parseCSV(readFileSync(join(RAW, 'gtfs_routes.txt'), 'utf8'));
const tripsRaw = parseCSV(readFileSync(join(RAW, 'gtfs_trips.txt'), 'utf8'));
const boroughsGeo = JSON.parse(readFileSync(join(RAW, 'boroughs.geojson'), 'utf8'));

const onLand = buildLandIndex(boroughsGeo);

// --- Route colors / names ---------------------------------------------------
const routeMeta = {};
for (const r of routesRaw) {
  routeMeta[r.route_id] = {
    color: '#' + (r.route_color || '888888'),
    name: r.route_long_name || r.route_id,
  };
}

// --- Stations ---------------------------------------------------------------
console.log('Projecting stations…');
const stations = stationsRaw.map((st) => {
  const p = project(+st.gtfs_longitude, +st.gtfs_latitude);
  const v = stationVertical(st);
  return {
    name: st.stop_name,
    routes: (st.daytime_routes || '').split(' ').filter(Boolean),
    borough: st.borough,
    structure: st.structure,
    x: +p.x.toFixed(1),
    z: +p.z.toFixed(1),
    y: +v.y.toFixed(1),
    ground: +v.ground.toFixed(1),
    depthFt: v.depthFt,
    kind: v.kind,
  };
});

// Spatial helper: nearest station y for a world point (used to drape lines).
function nearestStationY(x, z) {
  let best = Infinity, y = -8;
  for (const s of stations) {
    const d = dist2(x, z, s.x, s.z);
    if (d < best) { best = d; y = s.y; }
  }
  return y;
}

// --- Routes: pick the longest GTFS shape per route -------------------------
console.log('Reading GTFS shapes (large)…');
const shapesText = readFileSync(join(RAW, 'gtfs_shapes.txt'), 'utf8');
// Parse shapes manually for speed (no quotes in this file).
const shapePts = new Map(); // shape_id -> [[lon,lat],...]
{
  const lines = shapesText.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const [id, seq, lat, lon] = line.split(',');
    if (!id) continue;
    let a = shapePts.get(id);
    if (!a) shapePts.set(id, (a = []));
    a.push([+lon, +lat, +seq]);
  }
  for (const a of shapePts.values()) a.sort((p, q) => p[2] - q[2]);
}

// route_id -> best (longest) shape_id
const routeShapes = new Map();
const shapeCount = new Map();
for (const t of tripsRaw) {
  if (!t.shape_id) continue;
  shapeCount.set(t.shape_id, (shapePts.get(t.shape_id) || []).length);
  const cur = routeShapes.get(t.route_id);
  if (!cur || (shapeCount.get(t.shape_id) || 0) > (shapeCount.get(cur) || 0)) {
    routeShapes.set(t.route_id, t.shape_id);
  }
}

console.log('Draping routes over the depth model…');
const routes = [];
for (const [routeId, shapeId] of routeShapes) {
  const pts = shapePts.get(shapeId);
  if (!pts || pts.length < 2) continue;
  const meta = routeMeta[routeId] || { color: '#888', name: routeId };

  // Project + assign a base y (nearest station), diving under rivers.
  const xs = [], zs = [], ys = [];
  let last = null;
  for (const [lon, lat] of pts) {
    const p = project(lon, lat);
    if (last && dist2(p.x, p.z, last.x, last.z) < 25 * 25) continue; // decimate ~25m
    last = p;
    let y;
    if (onLand(lon, lat)) {
      y = nearestStationY(p.x, p.z);
    } else {
      y = -tubeDepthBelowSea(lon, lat);
    }
    xs.push(+p.x.toFixed(1));
    zs.push(+p.z.toFixed(1));
    ys.push(y);
  }
  if (xs.length < 2) continue;
  const ysm = smooth(ys, 3).map((v) => +v.toFixed(1));
  const points = xs.map((x, i) => [x, ysm[i], zs[i]]);
  routes.push({ id: routeId, color: meta.color, name: meta.name, points });
}
routes.sort((a, b) => a.id.localeCompare(b.id));

// --- Boroughs (coastline) for the landmass ---------------------------------
console.log('Building landmass polygons…');
const boroughs = [];
for (const f of boroughsGeo.features) {
  const name = f.properties.name || f.properties.boro_name || 'NYC';
  const coords = f.geometry.coordinates;
  const parts = f.geometry.type === 'MultiPolygon' ? coords : [coords];
  const rings = [];
  for (const poly of parts) {
    const r = decimateRing(poly[0], 12);
    if (r) rings.push(r);
  }
  if (rings.length) boroughs.push({ name, rings });
}

// --- Representative surface bus corridors ----------------------------------
// NOTE: real MTA bus routing is a separate GTFS feed; these are hand-drawn
// major Manhattan corridors to convey the ground-level bus layer. Clearly
// labeled as representative in the UI.
const BUS_CORRIDORS = [
  { id: 'M15', name: 'M15 · 1 Av / 2 Av', pts: [[-74.014, 40.702], [-73.992, 40.714], [-73.981, 40.731], [-73.972, 40.757], [-73.951, 40.79], [-73.938, 40.802]] },
  { id: 'M101', name: 'M101 · 3 Av / Lexington Av', pts: [[-73.99, 40.71], [-73.984, 40.735], [-73.972, 40.758], [-73.956, 40.785], [-73.938, 40.808]] },
  { id: 'M104', name: 'M104 · Broadway', pts: [[-73.984, 40.75], [-73.982, 40.758], [-73.99, 40.774], [-73.997, 40.79], [-73.966, 40.81]] },
  { id: 'M5', name: 'M5 · 5 Av / Riverside Dr', pts: [[-73.99, 40.735], [-73.982, 40.755], [-73.981, 40.768], [-73.99, 40.79], [-73.97, 40.84]] },
  { id: 'M42', name: 'M42 · 42 St crosstown', pts: [[-74.002, 40.7595], [-73.99, 40.756], [-73.976, 40.7515], [-73.965, 40.748]] },
  { id: 'M34', name: 'M34 · 34 St crosstown', pts: [[-74.003, 40.7527], [-73.99, 40.749], [-73.975, 40.744], [-73.966, 40.741]] },
  { id: 'M86', name: 'M86 · 86 St crosstown', pts: [[-73.982, 40.788], [-73.968, 40.782], [-73.95, 40.777]] },
  { id: 'M60', name: 'M60 · 125 St ↔ LGA', pts: [[-73.958, 40.811], [-73.937, 40.804], [-73.912, 40.775], [-73.87, 40.773]] },
  { id: 'M23', name: 'M23 · 23 St crosstown', pts: [[-74.009, 40.746], [-73.995, 40.742], [-73.981, 40.739], [-73.972, 40.736]] },
  { id: 'M14', name: 'M14 · 14 St crosstown', pts: [[-74.009, 40.739], [-73.997, 40.736], [-73.982, 40.732], [-73.972, 40.729]] },
];
const buses = BUS_CORRIDORS.map((b) => {
  const points = b.pts.map(([lon, lat]) => {
    const p = project(lon, lat);
    const g = groundElevation(lon, lat);
    return [+p.x.toFixed(1), +(g + 3).toFixed(1), +p.z.toFixed(1)];
  });
  return { id: b.id, name: b.name, points };
});

// --- PATH: trans-Hudson tubes (Manhattan ↔ New Jersey) ----------------------
// Not in the MTA feed. Hand-built from real station coordinates; the Hudson
// tubes descend ~97 ft (~30 m) below sea level (Downtown/Uptown Hudson Tubes).
const PATH_STATIONS = {
  newark:      { name: 'Newark Penn (PATH)', lon: -74.1644, lat: 40.7347, y: 4, structure: 'At Grade' },
  harrison:    { name: 'Harrison (PATH)', lon: -74.1557, lat: 40.7393, y: 6, structure: 'Elevated' },
  journalsq:   { name: 'Journal Square (PATH)', lon: -74.0634, lat: 40.7327, y: -8, structure: 'Open Cut' },
  grove:       { name: 'Grove St (PATH)', lon: -74.0430, lat: 40.7196, y: -8, structure: 'Subway' },
  exchange:    { name: 'Exchange Place (PATH)', lon: -74.0335, lat: 40.7167, y: -20, structure: 'Subway' },
  newport:     { name: 'Newport (PATH)', lon: -74.0338, lat: 40.7272, y: -10, structure: 'Subway' },
  hoboken:     { name: 'Hoboken (PATH)', lon: -74.0270, lat: 40.7349, y: 1, structure: 'At Grade' },
  wtc:         { name: 'World Trade Center (PATH)', lon: -74.0113, lat: 40.7126, y: -14, structure: 'Subway' },
  christopher: { name: 'Christopher St (PATH)', lon: -74.0071, lat: 40.7331, y: -10, structure: 'Subway' },
  ninth:       { name: '9 St (PATH)', lon: -73.9976, lat: 40.7343, y: -10, structure: 'Subway' },
  fourteenth:  { name: '14 St (PATH)', lon: -73.9967, lat: 40.7376, y: -10, structure: 'Subway' },
  twentythird: { name: '23 St (PATH)', lon: -73.9930, lat: 40.7429, y: -10, structure: 'Subway' },
  thirtythird: { name: '33 St (PATH)', lon: -73.9884, lat: 40.7485, y: -12, structure: 'Subway' },
};
const HUDSON_TUBE_Y = -30; // ~97 ft below sea level mid-river
const PATH_LINES = [
  { id: 'PATH-NWK', color: '#d93a30', name: 'PATH · Newark ↔ World Trade Center', stops: ['newark', 'harrison', 'journalsq', 'grove', 'exchange', 'wtc'] },
  { id: 'PATH-HOB', color: '#4db847', name: 'PATH · Hoboken ↔ World Trade Center', stops: ['hoboken', 'newport', 'exchange', 'wtc'] },
  { id: 'PATH-JSQ', color: '#f4c400', name: 'PATH · Journal Square ↔ 33 St (via Hoboken)', stops: ['journalsq', 'grove', 'newport', 'hoboken', 'christopher', 'ninth', 'fourteenth', 'twentythird', 'thirtythird'] },
];

const path = PATH_LINES.map((line) => {
  const pts = [];
  for (let k = 0; k < line.stops.length; k++) {
    const s = PATH_STATIONS[line.stops[k]];
    const p = project(s.lon, s.lat);
    pts.push([+p.x.toFixed(1), s.y, +p.z.toFixed(1)]);
    // Insert a deep midpoint when a segment crosses the Hudson (NJ side x<~-4500 to NY side)
    if (k < line.stops.length - 1) {
      const t = PATH_STATIONS[line.stops[k + 1]];
      const pt = project(t.lon, t.lat);
      const crossesHudson = (s.lon < -74.02 && t.lon > -74.02) || (s.lon > -74.02 && t.lon < -74.02);
      if (crossesHudson) {
        pts.push([+((p.x + pt.x) / 2).toFixed(1), HUDSON_TUBE_Y, +((p.z + pt.z) / 2).toFixed(1)]);
      }
    }
  }
  return { id: line.id, color: line.color, name: line.name, points: pts, isPath: true };
});

// PATH stations join the station layer (colored by elevation like the rest).
for (const key of Object.keys(PATH_STATIONS)) {
  const s = PATH_STATIONS[key];
  const p = project(s.lon, s.lat);
  stations.push({
    name: s.name, routes: ['PATH'], borough: s.lon < -74.02 ? 'NJ' : 'M',
    structure: s.structure, x: +p.x.toFixed(1), z: +p.z.toFixed(1), y: s.y,
    ground: +groundElevation(s.lon, s.lat).toFixed(1),
    depthFt: s.y < 0 ? Math.round(-s.y / FT) : 0,
    kind: s.y < -18 ? 'deep' : s.y < 0 ? 'underground' : 'surface',
  });
}

// --- Camera presets ---------------------------------------------------------
const statue = project(-74.0445, 40.6892); // Statue of Liberty
const battery = project(-74.0134, 40.7033); // Battery / Lower Manhattan (the view target)
const manhattanStations = stations.filter((s) => s.borough === 'M');
const cx = manhattanStations.reduce((a, s) => a + s.x, 0) / manhattanStations.length;
const cz = manhattanStations.reduce((a, s) => a + s.z, 0) / manhattanStations.length;

const out = {
  meta: {
    generated: 'via scripts/build-data.mjs',
    projection: { lat0: LAT0, lon0: LON0, note: 'local equirectangular, meters; +X east, -Z north; y = meters vs sea level' },
    counts: { stations: stations.length, routes: routes.length, boroughs: boroughs.length, buses: buses.length, path: path.length },
    seaLevelY: 0,
    camera: {
      // The default view is the Statue of Liberty vantage: sit at the statue,
      // south-southwest in the harbor, looking north-northeast at Lower Manhattan.
      statue: [+statue.x.toFixed(1), +statue.z.toFixed(1)],
      target: [+battery.x.toFixed(1), 0, +battery.z.toFixed(1)],
      center: [+cx.toFixed(1), 0, +cz.toFixed(1)],
    },
    disclaimer:
      'Depths and ground elevations are APPROXIMATE. Deep-station and river-tunnel figures are researched (see sources); most other underground stations use a cut-and-cover heuristic (~25 ft). Bus corridors are representative, not exact routing.',
    sources: [
      'MTA Subway Stations (data.ny.gov 39hk-dx4f) — structure type, coordinates, routes',
      'MTA GTFS static feed — line shapes, route colors',
      'Terrain: Terrarium DEM elevation tiles (AWS elevation-tiles-prod)',
      'Borough coastline: codeforgermany/click_that_hood NYC boroughs GeoJSON',
      'PATH: hand-built from real station coordinates; Hudson tube depth ~97 ft below sea level',
      'Depths: Wikipedia (191/190/181/168 St, 34 St-Hudson Yards, Roosevelt Island, Joralemon/60th/63rd St tunnels, Downtown/Uptown Hudson Tubes) + cut-and-cover heuristic',
    ],
  },
  boroughs,
  routes,
  stations,
  buses,
  path,
};

writeFileSync(OUT, JSON.stringify(out));
const kb = (readFileSync(OUT).length / 1024).toFixed(0);
console.log(`\nWrote ${OUT}  (${kb} KB)`);
console.log(`  stations: ${stations.length}  routes: ${routes.length}  boroughs: ${boroughs.length}  buses: ${buses.length}`);
