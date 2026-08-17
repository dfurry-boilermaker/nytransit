// Fetch real elevation (Terrarium DEM tiles) for the NYC region and bake a
// height grid the app renders as shaded-relief topography, and that
// build-data.mjs samples so every station/line sits on the real ground.
//
// Output: public/data/terrain.json  { xMin,xMax,zMin,zMax,W,H,min,max,elev[] }
//   elev is row-major (H rows of W), meters above sea level, in the app's
//   local equirectangular world frame (+X east, -Z north).

import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'data', 'terrain.json');
const CACHE = '/tmp/terr';
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

// Projection (must match build-data.mjs / src/main.js)
const LAT0 = 40.758, LON0 = -73.978;
const M_PER_LAT = 111320, M_PER_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const toLon = (x) => x / M_PER_LON + LON0;
const toLat = (z) => -z / M_PER_LAT + LAT0;
const projX = (lon) => (lon - LON0) * M_PER_LON;
const projZ = (lat) => -(lat - LAT0) * M_PER_LAT;

// Region (lon/lat) — Newark NJ across to eastern Queens; SI up to the Bronx.
const BBOX = { lonMin: -74.20, lonMax: -73.72, latMin: 40.56, latMax: 40.92 };
const Z = 11;
const W = 256, H = 256;

const n = 2 ** Z;
const lon2px = (lon) => ((lon + 180) / 360) * 256 * n;
const lat2px = (lat) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * n;
};

// tile coverage
const pxL = lon2px(BBOX.lonMin), pxR = lon2px(BBOX.lonMax);
const pyT = lat2px(BBOX.latMax), pyB = lat2px(BBOX.latMin);
const txMin = Math.floor(pxL / 256), txMax = Math.floor(pxR / 256);
const tyMin = Math.floor(pyT / 256), tyMax = Math.floor(pyB / 256);

const tiles = new Map(); // "x_y" -> {data,width}
console.log(`Fetching DEM tiles z${Z}: x ${txMin}..${txMax}, y ${tyMin}..${tyMax}`);
for (let tx = txMin; tx <= txMax; tx++) {
  for (let ty = tyMin; ty <= tyMax; ty++) {
    const f = join(CACHE, `${Z}-${tx}-${ty}.png`);
    if (!existsSync(f)) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`;
      for (let a = 0; a < 3; a++) {
        try { execSync(`curl -sSL -m 60 "${url}" -o "${f}"`); break; }
        catch { if (a === 2) throw new Error('fetch failed ' + url); }
      }
    }
    const png = PNG.sync.read(readFileSync(f));
    tiles.set(`${tx}_${ty}`, png);
  }
}
console.log(`  ${tiles.size} tiles cached`);

function elevAtPx(px, py) {
  const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
  const png = tiles.get(`${tx}_${ty}`);
  if (!png) return 0;
  const ix = Math.min(255, Math.max(0, Math.floor(px) % 256));
  const iy = Math.min(255, Math.max(0, Math.floor(py) % 256));
  const i = (iy * 256 + ix) * 4;
  const d = png.data;
  return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
}
// bilinear sample in global pixel space (crossing tile edges is fine)
function elevAt(lon, lat) {
  const px = lon2px(lon), py = lat2px(lat);
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const fx = px - x0, fy = py - y0;
  const e00 = elevAtPx(x0, y0), e10 = elevAtPx(x0 + 1, y0);
  const e01 = elevAtPx(x0, y0 + 1), e11 = elevAtPx(x0 + 1, y0 + 1);
  return (e00 * (1 - fx) + e10 * fx) * (1 - fy) + (e01 * (1 - fx) + e11 * fx) * fy;
}

// Sample onto the world-coord grid.
const xMin = projX(BBOX.lonMin), xMax = projX(BBOX.lonMax);
const zMin = projZ(BBOX.latMax), zMax = projZ(BBOX.latMin); // note: latMax -> smaller z
const elev = new Array(W * H);
let mn = Infinity, mx = -Infinity;
for (let j = 0; j < H; j++) {
  const z = zMin + ((zMax - zMin) * j) / (H - 1);
  for (let i = 0; i < W; i++) {
    const x = xMin + ((xMax - xMin) * i) / (W - 1);
    let e = elevAt(toLon(x), toLat(z));
    if (e < -12) e = -12; // clamp bathymetry noise
    elev[j * W + i] = Math.round(e * 10) / 10;
    if (e < mn) mn = e; if (e > mx) mx = e;
  }
}

const out = {
  xMin: +xMin.toFixed(1), xMax: +xMax.toFixed(1),
  zMin: +zMin.toFixed(1), zMax: +zMax.toFixed(1),
  W, H, min: +mn.toFixed(1), max: +mx.toFixed(1), elev,
};
writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT}  (${(readFileSync(OUT).length / 1024).toFixed(0)} KB)  elevation ${mn.toFixed(0)}..${mx.toFixed(0)} m`);
