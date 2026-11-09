import * as THREE from 'three';

// The scene consumes a locally bundled, bounded OSM extract produced by
// scripts/fetch-chandigarh.mjs. No live requests to public Overpass endpoints.
const MAP_HALF_SPAN = 320;
export const CHANDIGARH_MAP_HALF_SPAN = MAP_HALF_SPAN;
export const CHANDIGARH_DATA_URL = '/maps/chandigarh-sector17.json';

function buildingBounds(building) {
  const xs = building.points.map(p => p[0]);
  const zs = building.points.map(p => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}
function outsideBuilding(x, z, boxes, clearance = 4.5) {
  for (const b of boxes) {
    if (x > b.min.x - clearance && x < b.max.x + clearance &&
        z > b.min.z - clearance && z < b.max.z + clearance) return false;
  }
  return true;
}
function sampleRoadPoints(roads) {
  const points = [];
  for (const road of roads) {
    const coords = road.points || [];
    for (let i = 0; i < coords.length; i++) {
      const [x,z] = coords[i];
      if (Number.isFinite(x) && Number.isFinite(z) && Math.abs(x)<285 && Math.abs(z)<285)
        points.push([x,z]);
      if (i > 0) {
        const [px,pz] = coords[i-1];
        const dist = Math.hypot(x-px,z-pz);
        const subdivisions = Math.min(10, Math.floor(dist/15));
        for(let k=1;k<=subdivisions;k++) {
          const f=k/(subdivisions+1);
          points.push([px+(x-px)*f, pz+(z-pz)*f]);
        }
      }
    }
  }
  return points;
}
function buildRoadMesh(roads, isPedestrian) {
  const vertices = [];
  for (const road of roads) {
    const foot = ['footway','pedestrian','path','steps','cycleway'].includes(road.kind);
    if (foot !== isPedestrian) continue;
    const width = foot ? 1.25 : ['primary','secondary','trunk'].includes(road.kind) ? 3.2 : 2.2;
    for (let i=1; i<road.points.length; ++i) {
      const [ax,az] = road.points[i-1], [bx,bz]=road.points[i];
      const dx=bx-ax, dz=bz-az, len=Math.hypot(dx,dz);
      if (len<0.02) continue;
      const offX=dz/len*width/2, offZ=-dx/len*width/2;
      const y = foot ? 0.07 : 0.055;
      const a=[ax+offX,y,az+offZ], b=[ax-offX,y,az-offZ];
      const c=[bx+offX,y,bz+offZ], d=[bx-offX,y,bz-offZ];
      vertices.push(...a,...b,...c,...b,...d,...c);
    }
  }
  if (!vertices.length) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom,new THREE.MeshBasicMaterial({color:isPedestrian?0x9bafb4:0x536979,side:THREE.DoubleSide}));
  mesh.name = isPedestrian?'OSM walkways':'OSM roads';
  return mesh;
}
export async function fetchChandigarhMap() {
  const response=await fetch(CHANDIGARH_DATA_URL,{cache:'default'});
  if (!response.ok) throw new Error(`OSM dataset missing (HTTP ${response.status}). Run node scripts/fetch-chandigarh.mjs.`);
  const data=await response.json();
  if (data?.source!=='OpenStreetMap' || !Array.isArray(data.buildings) || !Array.isArray(data.roads))
    throw new Error('Chandigarh map data is invalid. Re-run the download script.');
  if (data.buildings.length < 1 || data.roads.length < 1)
    throw new Error('Map data has no buildings or roads. Check the Overpass download.');
  return data;
}

// addProp registers scene meshes AND their collision bounds with the existing
// simulator so LiDAR rays and collision damage automatically include OSM buildings.
export function createChandigarhWorld(data, addProp) {
  const pedestrian = buildRoadMesh(data.roads,true);
  const streets = buildRoadMesh(data.roads,false);
  if (streets) addProp(streets,false);
  if (pedestrian) addProp(pedestrian,false);
  let maxBuildingHeight = 0;
  let estimatedCount=0;
  let renderedBuildings=0;
  const buildingsForMap=[];
  // A conservative upper bound to keep browser draw calls manageable.
  const selectedBuildings=data.buildings.slice(0,750);
  for (const building of selectedBuildings) {
    const points=building.points;
    if (!Array.isArray(points) || points.length<3) continue;
    const bounds=buildingBounds(building);
    if (bounds.minX < -MAP_HALF_SPAN || bounds.maxX > MAP_HALF_SPAN ||
        bounds.minZ < -MAP_HALF_SPAN || bounds.maxZ > MAP_HALF_SPAN) continue;
    const height=Math.max(2,Math.min(55,Number(building.height)||8));
    const shape=new THREE.Shape();
    shape.moveTo(points[0][0],-points[0][1]);
    for (let i=1;i<points.length;i++) shape.lineTo(points[i][0],-points[i][1]);
    shape.closePath();
    let geometry;
    try { geometry=new THREE.ExtrudeGeometry(shape,{depth:height,bevelEnabled:false,curveSegments:1,steps:1}); }
    catch { continue; }
    const color=building.estimated?0x8baca9:0xa3bdce;
    const mesh=new THREE.Mesh(geometry,new THREE.MeshLambertMaterial({color,side:THREE.DoubleSide}));
    mesh.rotation.x=-Math.PI/2;
    mesh.position.y=0.10;
    mesh.name=`OSM building ${building.id}`;
    const collider = new THREE.Box3(
      new THREE.Vector3(bounds.minX,.10,bounds.minZ),
      new THREE.Vector3(bounds.maxX,height+.10,bounds.maxZ)
    );
    addProp(mesh,true,collider);
    buildingsForMap.push(points);
    maxBuildingHeight=Math.max(maxBuildingHeight,height);
    if(building.estimated) estimatedCount++;
    renderedBuildings++;
  }
  const boxes=[];
  // Use footprint rectangles for safe launch and mission checkpoints.
  for(const b of selectedBuildings) {
    if (!b.points || b.points.length<3) continue;
    const bounds=buildingBounds(b);
    boxes.push(new THREE.Box3(
      new THREE.Vector3(bounds.minX,0,bounds.minZ),
      new THREE.Vector3(bounds.maxX,55,bounds.maxZ)
    ));
  }
  const candidates=sampleRoadPoints(data.roads);
  let home=[0,0], homeScore=Infinity;
  for(const [x,z] of candidates) {
    if(!outsideBuilding(x,z,boxes,4.5)) continue;
    const score=Math.hypot(x,z);
    if(score<homeScore) {homeScore=score; home=[x,z];}
  }
  if(homeScore===Infinity) throw new Error('Could not find a safe launch site near mapped roads.');
  const mission=[];
  for (const [x,z] of candidates) {
    if (!outsideBuilding(x,z,boxes,5)) continue;
    const distance=Math.hypot(x-home[0],z-home[1]);
    if (distance<18 || distance>175) continue;
    if (mission.some(p=>Math.hypot(p.x-x,p.z-z)<19)) continue;
    mission.push({x,z,y:Math.max(9,12+mission.length%3*2)});
    if(mission.length===10) break;
  }
  // If road geometry lacks ten distinct points, allow fewer checkpoints.
  const bounds={half:MAP_HALF_SPAN};
  return {home,mission,maxBuildingHeight,renderedBuildings,estimatedCount,roads:data.roads,buildingFootprints:buildingsForMap,bounds};
}

// The basemap is rendered once and cached, not repainted from geometry every frame.
export function createChandigarhMinimapLayer(world, width, height) {
  const canvas=document.createElement('canvas'); canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');
  const toX=x=>(x+MAP_HALF_SPAN)*width/(MAP_HALF_SPAN*2);
  const toY=z=>(z+MAP_HALF_SPAN)*height/(MAP_HALF_SPAN*2);
  ctx.fillStyle='#142f37';ctx.fillRect(0,0,width,height);
  ctx.strokeStyle='#304d56';ctx.lineWidth=.65;
  for(let n=-300;n<=300;n+=50) {
    ctx.beginPath();ctx.moveTo(toX(n),0);ctx.lineTo(toX(n),height);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,toY(n));ctx.lineTo(width,toY(n));ctx.stroke();
  }
  ctx.fillStyle='#5f838c';
  for(const poly of world.buildingFootprints) {
    if(poly.length<3)continue;
    ctx.beginPath();ctx.moveTo(toX(poly[0][0]),toY(poly[0][1]));
    for(let j=1;j<poly.length;j++)ctx.lineTo(toX(poly[j][0]),toY(poly[j][1]));
    ctx.closePath();ctx.fill();
  }
  for(const road of world.roads) {
    if(road.points.length<2)continue;
    ctx.beginPath();ctx.moveTo(toX(road.points[0][0]),toY(road.points[0][1]));
    for(let j=1;j<road.points.length;j++)ctx.lineTo(toX(road.points[j][0]),toY(road.points[j][1]));
    ctx.strokeStyle='#b7bfb9';ctx.lineWidth=['primary','secondary','trunk'].includes(road.kind)?2:1;
    ctx.stroke();
  }
  return canvas;
}
