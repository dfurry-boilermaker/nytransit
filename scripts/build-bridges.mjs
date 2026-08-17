// Real bridge + tram geometry from OpenStreetMap. Takes the longest matching
// OSM way per crossing, projects it, and drapes a gentle arch (OSM has no deck
// height). Falls back to a hand-drawn span if a crossing isn't returned.
//
// Output: public/data/crossings.json  [{ id, name, color, dashed, points }]

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'data', 'crossings.json');
const CACHE = '/tmp/osm_bridges.json';

const LAT0 = 40.758, LON0 = -73.978;
const M_PER_LAT = 111320, M_PER_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const projX = (lon) => (lon - LON0) * M_PER_LON;
const projZ = (lat) => -(lat - LAT0) * M_PER_LAT;
const BR = '#d8cdb2';

const DEFS = [
  { id: 'br-bk', match: /Brooklyn Bridge/, tag: 'highway', bbox: '40.695,-74.006,40.712,-73.985', deck: 40, color: BR, fb: [[-74.0006, 40.7057], [-73.9952, 40.7042], [-73.9903, 40.7003]] },
  { id: 'br-mn', match: /Manhattan Bridge/, tag: 'highway', bbox: '40.695,-74.001,40.712,-73.982', deck: 41, color: BR, fb: [[-73.9903, 40.7108], [-73.9884, 40.7053], [-73.9860, 40.6998]] },
  { id: 'br-wb', match: /Williamsburg Bridge/, tag: 'highway', bbox: '40.704,-73.990,40.719,-73.958', deck: 43, color: BR, fb: [[-73.9800, 40.7155], [-73.9710, 40.7143], [-73.9619, 40.7128]] },
  { id: 'br-qb', match: /Queensboro/, tag: 'highway', bbox: '40.750,-73.970,40.763,-73.928', deck: 42, color: BR, fb: [[-73.9625, 40.7577], [-73.9515, 40.7570], [-73.9400, 40.7566]] },
  { id: 'br-rfk', match: /Kennedy|Triborough/, tag: 'highway', bbox: '40.780,-73.938,40.805,-73.912', deck: 43, color: BR, fb: [[-73.9333, 40.8006], [-73.9280, 40.7975], [-73.9225, 40.7958]] },
  { id: 'br-gwb', match: /George Washington Bridge/, tag: 'highway', bbox: '40.844,-73.982,40.859,-73.938', deck: 65, color: BR, fb: [[-73.9470, 40.8517], [-73.9600, 40.8517], [-73.9730, 40.8517]] },
  { id: 'br-vz', match: /Verrazzano/, tag: 'highway', bbox: '40.596,-74.058,40.617,-74.018', deck: 70, color: BR, fb: [[-74.0347, 40.6066], [-74.0400, 40.6040], [-74.0455, 40.6015]] },
  { id: 'br-hg', match: /Hell Gate/, tag: 'railway', bbox: '40.778,-73.932,40.793,-73.903', deck: 45, color: BR, fb: [[-73.9245, 40.7830], [-73.9210, 40.7862], [-73.9180, 40.7895]] },
  { id: 'tram', match: /Roosevelt Island Tram/, tag: 'aerialway', bbox: '40.753,-73.968,40.763,-73.946', deck: 55, color: '#e23b32', dashed: true, fb: [[-73.9636, 40.7614], [-73.9575, 40.7607], [-73.9506, 40.7601]] },
];

if (!existsSync(CACHE)) {
  // Query each tag within its bbox, then filter by name in JS.
  const clauses = DEFS.map((d) => `way["${d.tag}"](${d.bbox});`).join('\n');
  const q = `[out:json][timeout:120];(\n${clauses}\n);out geom;`;
  writeFileSync('/tmp/br_q.txt', q);
  let ok = false;
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try { execSync(`curl -sSL -m 150 --data-urlencode "data@/tmp/br_q.txt" "${ep}" -o "${CACHE}"`); if (readFileSync(CACHE, 'utf8').includes('"elements"')) { ok = true; break; } } catch { /* retry */ }
  }
  if (!ok) console.warn('OSM bridge fetch failed — using fallbacks');
}

let osm = { elements: [] };
try { osm = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { /* fallbacks */ }

// longest matching way per crossing id
const best = {};
for (const el of osm.elements || []) {
  const name = el.tags && el.tags.name;
  if (!name || !el.geometry) continue;
  for (const d of DEFS) {
    if (d.match.test(name)) {
      if (!best[d.id] || el.geometry.length > best[d.id].length) best[d.id] = el.geometry.map((g) => [g.lon, g.lat]);
    }
  }
}

function arch(lonlat, deck, endLow) {
  const seg = [];
  let total = 0;
  for (let i = 0; i < lonlat.length - 1; i++) { const l = Math.hypot(lonlat[i + 1][0] - lonlat[i][0], lonlat[i + 1][1] - lonlat[i][1]); seg.push(l); total += l; }
  const N = Math.max(18, lonlat.length);
  const out = [];
  for (let k = 0; k <= N; k++) {
    const s = k / N;
    let d = s * total, i = 0;
    while (i < seg.length && d > seg[i]) { d -= seg[i]; i++; }
    i = Math.min(i, lonlat.length - 2);
    const tt = seg[i] ? d / seg[i] : 0;
    const lon = lonlat[i][0] + (lonlat[i + 1][0] - lonlat[i][0]) * tt;
    const lat = lonlat[i][1] + (lonlat[i + 1][1] - lonlat[i][1]) * tt;
    const p = projX(lon), z = projZ(lat);
    out.push([+p.toFixed(1), +(endLow + (deck - endLow) * Math.sin(Math.PI * s)).toFixed(1), +z.toFixed(1)]);
  }
  return out;
}

const crossings = DEFS.map((d) => {
  const geom = best[d.id] || d.fb;
  const real = !!best[d.id];
  return { id: d.id, name: d.match.source.replace(/\\.*/, ''), color: d.color, dashed: !!d.dashed, real, points: arch(geom, d.deck, d.id === 'tram' ? 14 : 8) };
});
writeFileSync(OUT, JSON.stringify(crossings));
console.log(`Wrote ${OUT}`);
for (const c of crossings) console.log(`  ${c.id}: ${c.real ? 'OSM' : 'fallback'} (${c.points.length} pts)`);
