/**
 * Download a bounded, read-only OpenStreetMap extract for Chandigarh Sector 17.
 * Uses shared public Overpass infrastructure ONCE during development, not
 * on every visit to your Vercel site. Requires Node.js 18+.
 * Usage: node scripts/fetch-chandigarh.mjs
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CENTRE = { lat: 30.74007, lon: 76.78259 }; // Sector 17, Chandigarh
const BBOX = { south:30.73665, west:76.77835, north:30.74349, east:76.78683 };
// One scene unit represents 1/0.65 metres horizontally; heights retain
// approximate metre-like units to make nearby buildings visible in-game.
const SCALE = 0.65;
const endpoints = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];
const bbox = [BBOX.south,BBOX.west,BBOX.north,BBOX.east].join(',');
const query = `[out:json][timeout:65];(way["building"](${bbox});way["highway"~"^(primary|secondary|tertiary|residential|service|unclassified|living_street|pedestrian|footway|path|cycleway|trunk)$"](${bbox}););out geom;`;

function projected({lat,lon}) {
  return [
    +((lon-CENTRE.lon)*111320*Math.cos(CENTRE.lat*Math.PI/180)*SCALE).toFixed(2),
    +((CENTRE.lat-lat)*111320*SCALE).toFixed(2)
  ];
}
function cleanPoints(geometry) {
  if(!Array.isArray(geometry)) return [];
  const points=[];
  for(const p of geometry) {
    if(!Number.isFinite(p.lat)||!Number.isFinite(p.lon)) continue;
    const [x,z]=projected(p);
    if(!points.length||Math.hypot(x-points.at(-1)[0],z-points.at(-1)[1])>.05) points.push([x,z]);
  }
  return points;
}
function parseHeight(tags={}) {
  const text=String(tags.height??'').trim().replace(' m','');
  let meters=Number(text);
  if(Number.isFinite(meters)&&meters>=2&&meters<300) return { height:+meters.toFixed(1),estimated:false };
  const levels=parseInt(tags['building:levels'],10);
  if(Number.isFinite(levels)&&levels>0&&levels<100) return {height:+(Math.max(3,levels*3.1)).toFixed(1),estimated:true};
  // Unknown: approximate only, NOT surveyed height.
  return {height:9,estimated:true};
}
export function convertOverpass(osm) {
  if(!Array.isArray(osm?.elements)) throw new Error('Invalid Overpass response');
  const buildings=[],roads=[];
  for (const way of osm.elements) {
    if(way.type!=='way'||!way.tags) continue;
    const points=cleanPoints(way.geometry);
    if(way.tags.building) {
      if(points.length<4)continue;
      const first=points[0], last=points.at(-1);
      if(Math.hypot(first[0]-last[0],first[1]-last[1])>.8) continue; // skip partial, non-closed footprints
      points.pop(); // Shape.closePath() closes it
      if(points.length<3)continue;
      buildings.push({id:way.id,points,...parseHeight(way.tags)});
    }
    if(way.tags.highway && points.length>=2) {
      roads.push({id:way.id,kind:way.tags.highway,points,name:way.tags.name||''});
    }
  }
  // Keep nearest features in a bounded play area. Never invent missing OSM data.
  buildings.sort((a,b)=>{
    const ca=a.points.reduce((sum,p)=>sum+Math.hypot(...p),0)/a.points.length;
    const cb=b.points.reduce((sum,p)=>sum+Math.hypot(...p),0)/b.points.length;
    return ca-cb;
  });
  const result={
    source:'OpenStreetMap',
    license:'ODbL 1.0',
    attribution:'© OpenStreetMap contributors',
    center:CENTRE, bbox:BBOX, scale:SCALE,
    fetchedAt:new Date().toISOString(),
    notes:'OSM way footprints only; relation multipolygons omitted. Heights may be estimated. Not for actual flight planning.',
    buildings:buildings.slice(0,750),
    roads:roads.slice(0,1800)
  };
  return result;
}

async function saveData(data) {
  console.log(`Found ${data.buildings.length} building footprints and ${data.roads.length} roads.`);
  if(data.buildings.length<10 || data.roads.length<5) throw new Error('Insufficient returned OSM geometry; refusing an incomplete dataset.');
  const destination=join(process.cwd(),'public','maps');
  await mkdir(destination,{recursive:true});
  const path=join(destination,'chandigarh-sector17.json');
  await writeFile(path,JSON.stringify(data));
  console.log(`Saved OpenStreetMap data to ${path}`);
  console.log('Run npm run dev, then select Chandigarh (OSM) in the environment dropdown.');
}

async function download() {
  // Optional offline conversion: node scripts/fetch-chandigarh.mjs --input overpass.json
  const pathIndex=process.argv.indexOf('--input');
  if(pathIndex>=0) {
    const filename=process.argv[pathIndex+1];
    if(!filename) throw new Error('Provide the Overpass JSON filename after --input');
    const raw=JSON.parse(await readFile(resolve(filename),'utf8'));
    const data=convertOverpass(raw);
    return saveData(data);
  }
  const body=new URLSearchParams({data:query});
  for (const endpoint of endpoints) {
    try {
      console.log(`Requesting OpenStreetMap geometry from ${endpoint} ...`);
      const resp=await fetch(endpoint,{
        method:'POST',
        headers:{'content-type':'application/x-www-form-urlencoded'},
        body:body.toString(),
        signal:AbortSignal.timeout(90000)
      });
      if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw=await resp.json();
      const data=convertOverpass(raw);
      await saveData(data);
      return;
    } catch(e) {
      console.warn(`Unable to use ${endpoint}: ${e.message}`);
    }
  }
  throw new Error('Overpass servers were unavailable or rate-limited. Try again later or use a local OSM extract. No synthetic map was created.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  download().catch(error=>{console.error(error.message);process.exitCode=1;});
}
