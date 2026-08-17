// Real NYC building footprints WITH real roof heights, from NYC Open Data
// "Building Footprints" (5zhs-2jue): height_roof + ground_elevation (feet),
// the_geom (lon/lat MultiPolygon). We keep the tallest N so the skyline is
// accurate rather than a uniform field of boxes.
//
// Output: public/data/buildings.json  { count, dropped, buildings:[{ring,base,h}] }

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'data', 'buildings.json');

const LAT0 = 40.758, LON0 = -73.978;
const M_PER_LAT = 111320, M_PER_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const projX = (lon) => (lon - LON0) * M_PER_LON;
const projZ = (lat) => -(lat - LAT0) * M_PER_LAT;
const FT = 0.3048;

// base each building on the same DEM the app renders, so they sit on the ground
const TERRAIN = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'data', 'terrain.json'), 'utf8'));
function ground(x, z) {
  const { xMin, xMax, zMin, zMax, W, H, elev } = TERRAIN;
  const fx = ((x - xMin) / (xMax - xMin)) * (W - 1);
  const fz = ((z - zMin) / (zMax - zMin)) * (H - 1);
  if (fx < 0 || fx > W - 1 || fz < 0 || fz > H - 1) return 4;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const x1 = Math.min(W - 1, x0 + 1), z1 = Math.min(H - 1, z0 + 1);
  const tx = fx - x0, tz = fz - z0;
  const a = elev[z0 * W + x0], b = elev[z0 * W + x1], c = elev[z1 * W + x0], d = elev[z1 * W + x1];
  return Math.max(0, (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz);
}

// Manhattan core: Battery up to ~72nd St (the harbor-facing skyline).
const N = 40.775, W_ = -74.022, S = 40.700, E = -73.940;
const CAP = 14000; // keep the tallest this many
const CACHE = '/tmp/nyc_buildings.json';

if (!existsSync(CACHE)) {
  const url = 'https://data.cityofnewyork.us/resource/5zhs-2jue.json';
  const where = `height_roof>25 AND within_box(the_geom,${N},${W_},${S},${E})`;
  const cmd = `curl -sSL -m 240 --compressed -G "${url}"` +
    ` --data-urlencode '$select=the_geom,height_roof'` +
    ` --data-urlencode '$where=${where}'` +
    ` --data-urlencode '$limit=80000' -o "${CACHE}"`;
  console.log('Querying NYC building footprints…');
  let ok = false;
  for (let a = 0; a < 3; a++) {
    try {
      execSync(cmd);
      const t = readFileSync(CACHE, 'utf8');
      if (t.trim().startsWith('[')) { ok = true; break; }
    } catch { /* retry */ }
  }
  if (!ok) throw new Error('NYC building fetch failed');
}

const rows = JSON.parse(readFileSync(CACHE, 'utf8'));
console.log(`  ${rows.length} raw buildings`);

function shoelace(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a) / 2;
}

let builds = [];
for (const r of rows) {
  const h = parseFloat(r.height_roof) * FT; // ft -> m
  if (!(h > 3)) continue;
  const g = r.the_geom;
  if (!g || g.type !== 'MultiPolygon') continue;
  const outer = g.coordinates[0][0];
  if (!outer || outer.length < 4) continue;
  const ring = outer.map(([lon, lat]) => [projX(lon), projZ(lat)]);
  if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  if (ring.length < 3) continue;
  const area = shoelace(ring);
  if (area < 60) continue;
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  builds.push({ ring: ring.map(([x, z]) => [+x.toFixed(1), +z.toFixed(1)]), base: +ground(cx, cz).toFixed(1), h: +h.toFixed(1) });
}

const total = builds.length;
builds.sort((a, b) => b.h - a.h);      // tallest first -> real skyline
const dropped = Math.max(0, total - CAP);
builds = builds.slice(0, CAP);

writeFileSync(OUT, JSON.stringify({ count: builds.length, dropped, buildings: builds }));
const kb = (readFileSync(OUT).length / 1024).toFixed(0);
console.log(`Wrote ${OUT}  (${kb} KB)  ${builds.length} buildings kept, ${dropped} shorter ones dropped`);
console.log(`  tallest: ${builds[0].h} m, median-ish: ${builds[Math.floor(builds.length / 2)].h} m`);
