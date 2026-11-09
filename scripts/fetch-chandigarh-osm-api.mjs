/**
 * One-time small-area import from the official OpenStreetMap API, bypassing
 * dependence on shared public Overpass interpreters.
 *
 * Run from the project root:
 *    node scripts/fetch-chandigarh-osm-api.mjs
 * Or convert an OSM API JSON file you already downloaded:
 *    node scripts/fetch-chandigarh-osm-api.mjs --file path/to/map.json
 *
 * The resulting file has the exact schema expected by chandigarh-map.js.
 * Never run this on every website visit: commit the JSON to your repo.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convertOverpass } from './fetch-chandigarh.mjs';

export const BBOX = {south:30.73665, west:76.77835, north:30.74349, east:76.78683};
const bboxString = `${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}`;
const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${bboxString}`;

export function normalizeApiJson(data) {
  if (!data || !Array.isArray(data.elements)) throw new Error('Expected OSM API JSON with elements array.');
  if (data.elements.some(e=>e?.error)) throw new Error('OSM API returned incomplete data with an error element.');
  const lookup = new Map();
  for (const el of data.elements) {
    if (el.type==='node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
      lookup.set(el.id, {lat:el.lat,lon:el.lon});
    }
  }
  const ways = [];
  for (const el of data.elements) {
    if (el.type!=='way'|| !el.tags) continue;
    if (!el.tags.building && !el.tags.highway) continue;
    let geometry = Array.isArray(el.geometry) ? el.geometry : null;
    if (!geometry && Array.isArray(el.nodes)) {
      geometry = el.nodes.map(id=>lookup.get(id));
    }
    // Never manufacture shapes from missing nodes.
    if (!geometry || geometry.some(point=>!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon))) continue;
    ways.push({type:'way', id:el.id, tags:el.tags, geometry});
  }
  return {elements:ways};
}

async function downloadApiJson() {
  console.log('Requesting one small map extract from the official OpenStreetMap API ...');
  console.log(url);
  const response=await fetch(url,{
    headers:{
      Accept:'application/json',
      // A descriptive UA helps operators identify legitimate one-off downloads.
      'User-Agent':'DroneSimulatorPro-OSM-Import/1.0 (+https://github.com/yuggarg28-stack/drone-simulator-pro)'
    },
    signal:AbortSignal.timeout(120000)
  });
  if (!response.ok) {
    throw new Error(`OpenStreetMap API HTTP ${response.status}. Do not keep retrying. Use the local PBF option in README if this persists.`);
  }
  return response.json();
}

async function run() {
  const fileAt=process.argv.indexOf('--file');
  let raw;
  if(fileAt>=0) {
    const p=process.argv[fileAt+1];
    if(!p) throw new Error('Provide a path after --file.');
    raw=JSON.parse(await readFile(resolve(p),'utf8'));
  } else raw=await downloadApiJson();
  const converted = convertOverpass(normalizeApiJson(raw));
  if(converted.buildings.length<10 || converted.roads.length<5) {
    throw new Error(`Only ${converted.buildings.length} buildings and ${converted.roads.length} roads found. Refusing incomplete data.`);
  }
  const target=join(process.cwd(),'public','maps','chandigarh-sector17.json');
  await mkdir(join(process.cwd(),'public','maps'),{recursive:true});
  await writeFile(target,JSON.stringify(converted));
  console.log(`SUCCESS: ${converted.buildings.length} buildings, ${converted.roads.length} roads`);
  console.log(`Map saved to: ${target}`);
  console.log('Select Chandigarh in the simulator. The app will serve this committed JSON statically.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(e=>{console.error('Import failed:',e.message);process.exitCode=1;});
}
