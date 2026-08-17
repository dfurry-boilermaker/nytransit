// Fetch real building footprints (OpenStreetMap via Overpass) for the Manhattan
// core, extrude-ready, capped for performance. Heights come from OSM height /
// building:levels tags where present, else a modest default.
//
// Output: public/data/buildings.json  { count, buildings:[{ring:[[x,z]...], base, h}] }

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

// terrain sampler (base each building on the real ground)
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

const CACHE = '/tmp/osm_buildings.json';
const BBOX = '40.700,-74.022,40.772,-73.940'; // south,west,north,east — Lower + Midtown Manhattan
const CAP = 3000;

if (!existsSync(CACHE)) {
  const q = `[out:json][timeout:120];(way[building](${BBOX}););out geom;`;
  const qfile = '/tmp/overpass_query.txt';
  writeFileSync(qfile, q);
  console.log('Querying Overpass for buildings…');
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  let ok = false;
  for (const ep of endpoints) {
    try {
      execSync(`curl -sSL -m 180 --data-urlencode "data@${qfile}" "${ep}" -o "${CACHE}"`);
      const t = readFileSync(CACHE, 'utf8');
      if (t.includes('"elements"')) { ok = true; break; }
    } catch { /* try next */ }
  }
  if (!ok) throw new Error('Overpass fetch failed');
}

const osm = JSON.parse(readFileSync(CACHE, 'utf8'));
console.log(`  ${osm.elements.length} raw ways`);

function heightOf(tags) {
  if (!tags) return null;
  if (tags.height) { const h = parseFloat(tags.height); if (h > 0) return h; }
  if (tags['building:levels']) { const l = parseFloat(tags['building:levels']); if (l > 0) return l * 3.5; }
  return null;
}

function shoelaceArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]);
  return Math.abs(a) / 2;
}

let builds = [];
for (const el of osm.elements) {
  if (!el.geometry || el.geometry.length < 4) continue;
  const ring = el.geometry.map((g) => [projX(g.lon), projZ(g.lat)]);
  // drop duplicate closing point
  if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  if (ring.length < 3) continue;
  const area = shoelaceArea(ring);
  if (area < 120) continue; // skip tiny footprints (perf)
  let h = heightOf(el.tags);
  if (h == null) h = Math.min(60, 8 + Math.sqrt(area) * 0.6); // rough fallback from footprint size
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  builds.push({ ring: ring.map(([x, z]) => [+x.toFixed(1), +z.toFixed(1)]), base: +ground(cx, cz).toFixed(1), h: +h.toFixed(1), area });
}

// keep the most prominent (largest footprint) for a mobile-friendly count
builds.sort((a, b) => b.area - a.area);
builds = builds.slice(0, CAP).map(({ area, ...b }) => b);

writeFileSync(OUT, JSON.stringify({ count: builds.length, buildings: builds }));
console.log(`Wrote ${OUT}  (${(readFileSync(OUT).length / 1024).toFixed(0)} KB)  ${builds.length} buildings`);
