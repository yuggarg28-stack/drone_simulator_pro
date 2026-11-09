import * as THREE from 'three';
import { fetchChandigarhMap, createChandigarhWorld, createChandigarhMinimapLayer, CHANDIGARH_MAP_HALF_SPAN } from './chandigarh-map.js';

// Drone Simulator Pro — enhancements by Yug Garg.
// Based on the original Drone Simulator by eccc20984.
// A browser-based flight game; values are simulated, not real drone calibration.

// ------------------ SCENE AND RENDERER ------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.FogExp2(0x87ceeb, 0.01);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
// Keeping the WebGL drawing buffer enables reliable screenshots while the
// browser's MediaRecorder captures the visible 3D canvas (not HTML HUD panels).
const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
});
renderer.domElement.id = 'scene-canvas';
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const UI = {
    mode: document.getElementById('mode-display'),
    timer: document.getElementById('timer'),
    telemetry: document.getElementById('flight-hud'),
    batteryPercent: document.getElementById('battery-percent'),
    batteryFill: document.getElementById('battery-fill'),
    batteryStatus: document.getElementById('battery-status'),
    batteryWarning: document.getElementById('battery-warning'),
    healthPercent: document.getElementById('health-percent'),
    healthFill: document.getElementById('health-fill'),
    flightStatus: document.getElementById('flight-status'),
    cameraMode: document.getElementById('camera-mode'),
    cameraButton: document.getElementById('camera-toggle'),
    rthButton: document.getElementById('rth-toggle'),
    damageWarning: document.getElementById('damage-warning'),
    dynamicsPitch: document.getElementById('dyn-pitch'),
    dynamicsRoll: document.getElementById('dyn-roll'),
    dynamicsYaw: document.getElementById('dyn-yaw'),
    dynamicsVertical: document.getElementById('dyn-vertical'),
    dynamicsAcceleration: document.getElementById('dyn-acceleration'),
    dynamicsAutopilot: document.getElementById('dyn-autopilot'),
    attitudeIndicator: document.getElementById('attitude-indicator'),
    weatherLabel: document.getElementById('weather-label'),
    weatherWind: document.getElementById('weather-wind'),
    weatherHint: document.getElementById('weather-hint'),
    weatherButton: document.getElementById('weather-toggle'),
    mapCanvas: document.getElementById('minimap-canvas'),
    mapPosition: document.getElementById('minimap-position'),
    environmentSelect: document.getElementById('environment-select'),
    environmentNext: document.getElementById('environment-next'),
    environmentSummary: document.getElementById('environment-summary'),
    osmAttribution: document.getElementById('osm-attribution'),
    osmDataStatus: document.getElementById('osm-data-status'),
    lidarFront: document.getElementById('lidar-front'),
    lidarLeft: document.getElementById('lidar-left'),
    lidarRight: document.getElementById('lidar-right'),
    lidarDown: document.getElementById('lidar-down'),
    lidarStatus: document.getElementById('lidar-status'),
    lidarAvoidance: document.getElementById('lidar-avoidance'),
    lidarBeams: document.getElementById('lidar-beams'),
    gimbalPitch: document.getElementById('gimbal-pitch'),
    gimbalYaw: document.getElementById('gimbal-yaw'),
    gimbalZoom: document.getElementById('gimbal-zoom'),
    gimbalPitchValue: document.getElementById('gimbal-pitch-value'),
    gimbalYawValue: document.getElementById('gimbal-yaw-value'),
    gimbalZoomValue: document.getElementById('gimbal-zoom-value'),
    gimbalState: document.getElementById('gimbal-state'),
    gimbalStabilize: document.getElementById('gimbal-stabilize'),
    gimbalReset: document.getElementById('gimbal-reset'),
    recordButton: document.getElementById('record-toggle'),
    snapshotButton: document.getElementById('snapshot-button'),
    recordingStatus: document.getElementById('recording-status'),
    recordingIndicator: document.getElementById('record-indicator'),
    recordingTimer: document.getElementById('record-timer'),
    toast: document.getElementById('toast')
};

const droneState = {
    position: new THREE.Vector3(0, 5, 0),
    rotation: new THREE.Euler(0, 0, 0, 'YXZ'),
    velocity: new THREE.Vector3(), // scene units per SECOND
    rotationVelocity: new THREE.Euler(),
    propellerRotation: 0,
    beginnerMode: false,
    mouseX: 0,
    mouseY: 0
};

const HOME = new THREE.Vector3(0, 0, 0);
const DRONE_RADIUS = 0.75;
const MAX_PITCH = THREE.MathUtils.degToRad(30);
const MAX_ROLL = THREE.MathUtils.degToRad(25);
const GRAVITY = 9.81;
const HOVER_LIFT = 9.81;
const MAX_HORIZONTAL_SPEED = 12;
const MAX_VERTICAL_SPEED = 6;
const NORMAL_ACCEL = 6;
const TILT_ACCEL = 10;
const PROP_SPEED = 18;
const RTH_SAFE_ALTITUDE = 38; // Taller than the original game's buildings.

let cameraMode = 'THIRD_PERSON';
let batteryPercent = 100;
let health = 100;
let damageFlashUntil = 0;
let lastHitTime = -10;
let rthPhase = null; // null | 'CLIMB' | 'CRUISE' | 'DESCEND'
let rthAltitude = RTH_SAFE_ALTITUDE;
let rthAutoAttempted = false;
let rthLanded = false;
let isPointerLocked = false;
const clock = new THREE.Clock();

// ------------------ FPV GIMBAL / LOCAL MEDIA CAPTURE ------------------
// Degrees in the UI: negative tilt looks downward. Zoom changes field of view,
// it does not represent an optical lens. Stabilization is an idealized horizon lock.
const gimbal = { pitch: -12, yaw: 0, zoom: 1, stabilized: true };
let activeRecording = null;
let toastTimer = null;
const recorderAvailable = Boolean(window.MediaRecorder && renderer.domElement.captureStream);


// ------------------ SIMULATED WEATHER ------------------
// These numbers are gameplay units. They are NOT live forecasts or real GPS data.
const WEATHER_MODES = ['CLEAR', 'BREEZY', 'STORM'];
const WEATHER_PRESETS = {
    CLEAR: { baseWind: 0.15, gust: 0.1, fog: 0.01, sunlight: 1.4, sky: 0x87ceeb, rain: false },
    BREEZY: { baseWind: 3.8, gust: 1.8, fog: 0.014, sunlight: 1.1, sky: 0xa4c5d4, rain: false },
    STORM: { baseWind: 8.5, gust: 4.0, fog: 0.026, sunlight: 0.55, sky: 0x596e83, rain: true }
};
const weather = { mode: 'CLEAR', time: 0, wind: new THREE.Vector3() };
const WEATHER_DRAG = 0.60; // coupling of horizontal air mass to the drone
let flightAcceleration = 0;
const lastVelocity = new THREE.Vector3();

// Local x/z positions, not GPS coordinates. The map keeps the whole flight path.
const mapContext = UI.mapCanvas.getContext('2d');
const flightPath = [{ x: droneState.position.x, z: droneState.position.z }];
let mapSampleTime = 0;
let mapRenderTime = 0;

const keys = {
    w: false, a: false, s: false, d: false,
    ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false,
    ' ': false, Shift: false, q: false, e: false
};

// ------------------ DRONE MODEL ------------------
const droneBody = new THREE.Group();
const mainBody = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.2, 1),
    new THREE.MeshPhongMaterial({ color: 0x00dd77 })
);
droneBody.add(mainBody);
const armPositions = [
    { x: 0.4, z: 0.4, rotation: Math.PI / 4 },
    { x: -0.4, z: 0.4, rotation: -Math.PI / 4 },
    { x: 0.4, z: -0.4, rotation: -Math.PI / 4 },
    { x: -0.4, z: -0.4, rotation: Math.PI / 4 }
];
const armGeometry = new THREE.BoxGeometry(0.1, 0.1, 0.5);
const armMaterial = new THREE.MeshPhongMaterial({ color: 0x333333 });
const propellerGeometry = new THREE.BoxGeometry(0.5, 0.05, 0.05);
const propellerMaterial = new THREE.MeshPhongMaterial({ color: 0xffffff });
const propellers = [];
for (const pos of armPositions) {
    const arm = new THREE.Mesh(armGeometry, armMaterial);
    arm.position.set(pos.x, 0, pos.z);
    arm.rotation.y = pos.rotation;
    droneBody.add(arm);

    const prop = new THREE.Mesh(propellerGeometry, propellerMaterial);
    prop.position.set(pos.x, 0.1, pos.z);
    droneBody.add(prop);
    propellers.push(prop);
}
scene.add(droneBody);
const ambient = new THREE.AmbientLight(0xffffff, 0.40);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(5, 15, 5);
scene.add(sun);

const clouds = [];
for (let i = 0; i < 50; ++i) {
    const cloud = new THREE.Mesh(
        new THREE.SphereGeometry(Math.random() * 3 + 2, 8, 8),
        new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, flatShading: true })
    );
    cloud.position.set(Math.random() * 200 - 100, Math.random() * 30 + 20, Math.random() * 200 - 100);
    cloud.scale.y = 0.5;
    scene.add(cloud);
    clouds.push(cloud);
}

// ------------------ RAIN PARTICLES ------------------
// Only drawn for the Storm preset and recycled around the moving drone.
const RAIN_COUNT = 420;
const rainCoordinates = new Float32Array(RAIN_COUNT * 3);
function resetDrop(index) {
    const i = index * 3;
    rainCoordinates[i] = droneState.position.x + (Math.random() - 0.5) * 65;
    rainCoordinates[i + 1] = droneState.position.y + 10 + Math.random() * 42;
    rainCoordinates[i + 2] = droneState.position.z + (Math.random() - 0.5) * 65;
}
for (let i = 0; i < RAIN_COUNT; i++) resetDrop(i);
const rainGeometry = new THREE.BufferGeometry();
rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainCoordinates, 3));
const rain = new THREE.Points(rainGeometry, new THREE.PointsMaterial({
    color: 0xbfe8ff, size: 0.15, transparent: true, opacity: 0.8, depthWrite: false
}));
rain.visible = false;
scene.add(rain);

function updateRain(dt) {
    rain.visible = WEATHER_PRESETS[weather.mode].rain;
    if (!rain.visible) return;
    for (let i = 0; i < RAIN_COUNT; i++) {
        const p = i * 3;
        rainCoordinates[p] += weather.wind.x * dt * 0.7;
        rainCoordinates[p + 1] -= 21 * dt;
        rainCoordinates[p + 2] += weather.wind.z * dt * 0.7;
        if (rainCoordinates[p + 1] < droneState.position.y - 13 ||
            Math.abs(rainCoordinates[p] - droneState.position.x) > 39 ||
            Math.abs(rainCoordinates[p + 2] - droneState.position.z) > 39) {
            resetDrop(i);
        }
    }
    rainGeometry.attributes.position.needsUpdate = true;
}

// ------------------ RECONFIGURABLE TERRAIN AND OBSTACLES ------------------
// A world switch disposes ONLY environment meshes. Drone, rings, HUD and home pad stay.
const groundGeometry = new THREE.PlaneGeometry(200, 200, 60, 60);
const groundPositions = groundGeometry.attributes.position;
const ground = new THREE.Mesh(
    groundGeometry,
    new THREE.MeshPhongMaterial({ color: 0x1a472a, side: THREE.DoubleSide, shininess: 10, flatShading: true })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
ground.updateMatrixWorld(true);

const obstacleBoxes = []; // THREE.Box3 collision shapes, also used by the simulated LiDAR.
const environmentProps = []; // meshes/groups to dispose when changing environments
const environmentLights = [];
const ENVIRONMENTS = ['CITY', 'FOREST', 'MOUNTAINS', 'DESERT', 'NIGHT_CITY', 'CHANDIGARH_OSM'];
const ENV_SETTINGS = {
    CITY: { label:'City', ground:0x27603b, sky:0x87ceeb, fog:0.009, sun:1.3, ambient:0.55, details:'Buildings, open streets and training checkpoints.' },
    FOREST: { label:'Forest', ground:0x34662f, sky:0x9ccbc4, fog:0.012, sun:1.05, ambient:0.65, details:'Evergreen trees and uneven grassy ground.' },
    MOUNTAINS: { label:'Mountains', ground:0x858b83, sky:0xb1d6e9, fog:0.010, sun:1.4, ambient:0.7, details:'Rock formations and elevated terrain.' },
    DESERT: { label:'Desert', ground:0xc8a46a, sky:0xf5c78d, fog:0.010, sun:1.55, ambient:0.70, details:'Sand dunes, boulders and cacti.' },
    NIGHT_CITY: { label:'Night City', ground:0x1c2638, sky:0x0b122a, fog:0.014, sun:0.16, ambient:0.30, details:'Neon-lit towers and a dark city skyline.' },
    CHANDIGARH_OSM: { label:'Chandigarh · Sector 17', ground:0x345d54, sky:0x9dc9df, fog:0.0028, sun:1.4, ambient:0.8, details:'Real OpenStreetMap building footprints and road geometry; estimated heights where needed.' }
};
let environmentMode = 'CITY';
let chandigarhWorld = null;
let chandigarhMapLayer = null;
let environmentChangeToken = 0;
let mapHalfSpan = 100;
let activeRingCount = 10;
const baseTerrainHeight = (x, z, env) => {
    if (env === 'MOUNTAINS') return 2.8*Math.sin(x*0.065)*Math.cos(z*0.067) + 3.8*Math.sin(x*0.029+z*0.041);
    if (env === 'DESERT') return 1.7*Math.sin(x*0.055+z*0.023) + 1.25*Math.cos(z*0.065);
    if (env === 'FOREST') return 1.3*Math.sin(x*0.11)*Math.cos(z*0.10);
    if (env === 'CHANDIGARH_OSM') return 0; // Flat ground; OSM is not an elevation dataset.
    return 0.8*Math.sin(x*0.11)*Math.cos(z*0.10);
};

const groundRaycaster = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);
function groundHeightAt(x, z) {
    groundRaycaster.set(new THREE.Vector3(x, 200, z), down);
    const hit = groundRaycaster.intersectObject(ground, false)[0];
    return hit ? hit.point.y : 0; // game boundary outside the terrain square
}
HOME.y = groundHeightAt(HOME.x, HOME.z) + DRONE_RADIUS + 0.12;

const homePad = new THREE.Mesh(
    new THREE.CircleGeometry(2.2, 40),
    new THREE.MeshBasicMaterial({ color: 0x18b8e4, side: THREE.DoubleSide })
);
homePad.rotation.x = -Math.PI / 2;
homePad.position.set(0, groundHeightAt(0, 0) + 0.045, 0);
scene.add(homePad);

// ------------------ RING MISSION / TIMER ------------------
const ringArrows = [];
const ringPositions = [
    { x: 0, y: 10, z: -20 }, { x: 10, y: 15, z: -30 },
    { x: 20, y: 10, z: -20 }, { x: 20, y: 8, z: 0 },
    { x: 10, y: 12, z: 10 }, { x: -10, y: 15, z: 10 },
    { x: -20, y: 10, z: 0 }, { x: -20, y: 8, z: -10 },
    { x: -10, y: 12, z: -20 }, { x: 0, y: 15, z: -10 }
];
const DEFAULT_RING_POSITIONS = ringPositions.map(p => ({...p}));
const rings = [];
for (let i = 0; i < ringPositions.length; i++) {
    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2, 0.1, 16, 32),
        new THREE.MeshPhongMaterial({ color: 0xffff00 })
    );
    const p = ringPositions[i];
    ring.position.set(p.x, p.y, p.z);
    if (i < ringPositions.length - 1) {
        const next = ringPositions[i + 1];
        ring.lookAt(next.x, next.y, next.z);
    }
    scene.add(ring);
    rings.push(ring);
    if (i < ringPositions.length - 1) {
        const next = ringPositions[i + 1];
        const direction = new THREE.Vector3(next.x - p.x, next.y - p.y, next.z - p.z);
        const length = direction.length() * 0.3;
        const arrow = new THREE.ArrowHelper(direction.normalize(), ring.position, length, 0xff0000, length * 0.2, length * 0.1);
        scene.add(arrow);
        ringArrows.push(arrow);
    }
}
let timerStarted = false;
let startTime = 0;
let ringsCollected = 0;

const trailGeometry = new THREE.BufferGeometry();
const trailPositions = new Float32Array(300);
trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
const trail = new THREE.Line(
    trailGeometry,
    new THREE.LineBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 })
);
scene.add(trail);
let trailIndex = 0;

// ------------------ PROCEDURAL ENVIRONMENT GENERATOR ------------------
function seededRandom(seed) {
    return () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296;
    };
}

function clearEnvironment() {
    for (const object of environmentProps) {
        scene.remove(object);
        object.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                for (const material of (Array.isArray(child.material) ? child.material : [child.material])) material.dispose();
            }
        });
    }
    environmentProps.length = 0;
    obstacleBoxes.length = 0;
    for (const light of environmentLights) scene.remove(light);
    environmentLights.length = 0;
}
function addProp(object, collidable = true, customBounds = null) {
    scene.add(object);
    environmentProps.push(object);
    object.updateMatrixWorld(true);
    if (collidable) obstacleBoxes.push(customBounds || new THREE.Box3().setFromObject(object));
}
function isSafeSpawn(x, z, radius) {
    if (Math.hypot(x, z) < radius + 12) return false;
    for (const ring of ringPositions) {
        if (Math.hypot(x-ring.x, z-ring.z) < radius + 5.5) return false;
    }
    return true;
}
function terrainY(x, z) { return groundHeightAt(x, z); }

function placeBuilding(x, z, width, height, night, rand) {
    const bottom = terrainY(x, z);
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(width,height,width),
        new THREE.MeshPhongMaterial({color:night?0x27364b:new THREE.Color().setHSL(0.53+rand()*0.11,0.13,0.32+rand()*0.30),shininess:30}));
    body.position.y = height/2;
    group.add(body);
    // Decorative window bands are not collision objects; the building body is.
    if (night) {
        const hue = rand()>0.5?0x24f3ff:0xff4ebc;
        const bandMat = new THREE.MeshBasicMaterial({color:hue});
        for (let y=3; y<height-2; y+=4.5) {
            for (const facing of [-1,1]) {
                const front = new THREE.Mesh(new THREE.BoxGeometry(Math.max(1,width-1.0),0.12,0.04),bandMat);
                front.position.set(0,y,facing*(width/2+0.04));
                group.add(front);
            }
        }
    }
    group.position.set(x,bottom,z);
    // Copy using full 3D solid body as a collider (window geometry excluded).
    const collider = new THREE.Box3(new THREE.Vector3(x-width/2,bottom,z-width/2),
                                   new THREE.Vector3(x+width/2,bottom+height,z+width/2));
    addProp(group,true,collider);
}
function placeTree(x,z,rand) {
    const bottom=terrainY(x,z), height=6+rand()*7, radius=1.35+rand()*1.0;
    const group=new THREE.Group();
    const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.22,.36,height*.58,7),
        new THREE.MeshPhongMaterial({color:0x674631}));
    trunk.position.y=height*.29; group.add(trunk);
    const crown=new THREE.Mesh(new THREE.ConeGeometry(radius,height*.72,9),
        new THREE.MeshPhongMaterial({color:rand()>.4?0x17603c:0x237b49,flatShading:true}));
    crown.position.y=height*.65; group.add(crown);
    group.position.set(x,bottom,z);
    // Conservative crown-height AABB; scans hit the tree canopy.
    const collider=new THREE.Box3(new THREE.Vector3(x-radius*.85,bottom,z-radius*.85),
                                  new THREE.Vector3(x+radius*.85,bottom+height,z+radius*.85));
    addProp(group,true,collider);
}
function placeRock(x,z,rand,sizeMultiplier=1) {
    const radius=(1.0+rand()*2.1)*sizeMultiplier, y=terrainY(x,z);
    const rock=new THREE.Mesh(new THREE.DodecahedronGeometry(radius,0),
        new THREE.MeshPhongMaterial({color:rand()>.4?0x757b7e:0x9b8c7a,flatShading:true}));
    rock.scale.set(1.0,0.6+rand()*0.75,0.85+rand()*0.5);
    rock.rotation.set(rand()*.4,rand()*6.283,rand()*.3);
    rock.position.set(x,y+radius*.55,z);
    addProp(rock);
}
function placeCactus(x,z,rand) {
    const height=3+rand()*4, y=terrainY(x,z), cactus=new THREE.Group();
    const material=new THREE.MeshPhongMaterial({color:0x2a8055});
    const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.32,.42,height,7),material);
    trunk.position.y=height/2; cactus.add(trunk);
    const arm=new THREE.Mesh(new THREE.CylinderGeometry(.15,.22,height*.5,6),material);
    arm.position.set(.65,height*.6,0); cactus.add(arm);
    const link=new THREE.Mesh(new THREE.BoxGeometry(.75,.25,.25),material);
    link.position.set(.4,height*.42,0); cactus.add(link);
    cactus.position.set(x,y,z);
    addProp(cactus,true,new THREE.Box3(new THREE.Vector3(x-.9,y,z-.48),new THREE.Vector3(x+.9,y+height,z+.48)));
}
function randomPositions(rand, total, radius, maker) {
    let made=0;
    for (let attempt=0; attempt<total*32 && made<total; attempt++) {
        const x=(rand()-.5)*174,z=(rand()-.5)*174;
        if (!isSafeSpawn(x,z,radius)) continue;
        maker(x,z); made++;
    }
}
function rebuildRingPositions() {
    for (let i=0;i<rings.length;i++) {
        const p=ringPositions[i];
        rings[i].position.set(p.x,Math.max(p.y,terrainY(p.x,p.z)+5.5),p.z);
        rings[i].visible=true;
    }
    for (let i=0;i<ringArrows.length;i++) {
        const delta=rings[i+1].position.clone().sub(rings[i].position);
        ringArrows[i].position.copy(rings[i].position);
        ringArrows[i].setDirection(delta.clone().normalize());
        const length=delta.length()*.3;
        ringArrows[i].setLength(length,length*.2,length*.1);
        rings[i].lookAt(rings[i+1].position);
    }
}
function setEnvironment(mode, firstBuild=false) {
    if (!ENV_SETTINGS[mode]) return;
    const token=++environmentChangeToken;
    clearEnvironment();
    chandigarhWorld=null;chandigarhMapLayer=null;
    mapHalfSpan=mode==='CHANDIGARH_OSM'?CHANDIGARH_MAP_HALF_SPAN:100;
    activeRingCount=rings.length;
    for (let i=0;i<ringPositions.length;i++) Object.assign(ringPositions[i], DEFAULT_RING_POSITIONS[i]);
    HOME.x=0; HOME.z=0;
    UI.osmAttribution.hidden=mode!=='CHANDIGARH_OSM';
    UI.osmDataStatus.hidden=mode!=='CHANDIGARH_OSM';
    if(mode==='CHANDIGARH_OSM') UI.osmDataStatus.textContent='Loading locally bundled OpenStreetMap data…';
    environmentMode=mode;
    const preset=ENV_SETTINGS[mode];
    ground.scale.set(mode==='CHANDIGARH_OSM'?3.2:1,mode==='CHANDIGARH_OSM'?3.2:1,1);
    for(let i=0;i<groundPositions.count;i++) {
        groundPositions.setZ(i,baseTerrainHeight(groundPositions.getX(i),groundPositions.getY(i),mode));
    }
    groundPositions.needsUpdate=true;
    groundGeometry.computeVertexNormals();
    ground.geometry.computeBoundingSphere();
    ground.material.color.setHex(preset.ground);
    ground.updateMatrixWorld(true);
    const rand=seededRandom(ENVIRONMENTS.indexOf(mode)*397+1807);
    if(mode==='CITY'||mode==='NIGHT_CITY') {
        randomPositions(rand,mode==='CITY'?23:29,7,(x,z)=>placeBuilding(x,z,5+rand()*7,10+rand()*19,mode==='NIGHT_CITY',rand));
    } else if(mode==='FOREST') {
        randomPositions(rand,58,2.7,(x,z)=>placeTree(x,z,rand));
        randomPositions(rand,13,2.4,(x,z)=>placeRock(x,z,rand,.65));
    } else if(mode==='MOUNTAINS') {
        randomPositions(rand,55,3.5,(x,z)=>placeRock(x,z,rand,1.3));
    } else if(mode==='DESERT') {
        randomPositions(rand,31,2,(x,z)=>placeCactus(x,z,rand));
        randomPositions(rand,23,2.6,(x,z)=>placeRock(x,z,rand,.8));
    }
    if(mode==='NIGHT_CITY') {
        for(let i=0;i<6;i++) {
            const light=new THREE.PointLight(i%2===0?0x1bdeff:0xff3dab,3.0,28,2);
            const angle=i*Math.PI/3;
            light.position.set(38*Math.cos(angle),11,38*Math.sin(angle));
            scene.add(light); environmentLights.push(light);
        }
    }
    HOME.y=terrainY(HOME.x,HOME.z)+DRONE_RADIUS+.12;
    homePad.position.set(HOME.x,terrainY(HOME.x,HOME.z)+.05,HOME.z);
    rebuildRingPositions();
    // Environment changes restart the flight deliberately, preventing spawning inside obstacles.
    droneState.position.set(0,terrainY(0,0)+5,0);
    droneState.rotation.set(0,0,0,'YXZ');
    droneState.mouseX=0; droneState.mouseY=0;
    resetVelocities();
    rthPhase=null; rthLanded=false; rthAutoAttempted=false;
    batteryPercent=100; health=100; damageFlashUntil=0;
    timerStarted=false; ringsCollected=0; UI.timer.textContent='Time: 0.0s';
    flightPath.length=0; flightPath.push({x:0,z:0});
    trailIndex=0; trail.geometry.setDrawRange(0,100);
    UI.environmentSelect.value=mode;
    UI.environmentSummary.textContent=preset.details+' Changing environments restarts the mission.';
    UI.flightStatus.textContent=firstBuild?'MANUAL FLIGHT':'NEW ENVIRONMENT — READY';
    // Set the world atmosphere immediately, then let weather effects smoothly update it.
    scene.background.setHex(preset.sky);
    scene.fog.color.copy(scene.background);
    scene.fog.density=preset.fog;
    sun.intensity=preset.sun;
    ambient.intensity=preset.ambient;
    updateLiDAR(0,true);
    if(mode==='CHANDIGARH_OSM') {
        // Read *actual downloaded OSM data*, not an automatically generated city.
        // Cancel stale requests if the user changes worlds while loading.
        fetchChandigarhMap().then(data => {
            if(token!==environmentChangeToken || environmentMode!=='CHANDIGARH_OSM') return;
            const world=createChandigarhWorld(data,addProp);
            chandigarhWorld=world;
            chandigarhMapLayer=createChandigarhMinimapLayer(world,UI.mapCanvas.width,UI.mapCanvas.height);
            HOME.set(world.home[0], terrainY(...world.home)+DRONE_RADIUS+.12, world.home[1]);
            homePad.position.set(HOME.x,terrainY(HOME.x,HOME.z)+.05,HOME.z);
            droneState.position.set(HOME.x,HOME.y+4.6,HOME.z);
            droneState.velocity.set(0,0,0);
            activeRingCount=world.mission.length;
            for(let i=0;i<rings.length;i++) {
                if(i<world.mission.length) Object.assign(ringPositions[i],world.mission[i]);
            }
            rebuildRingPositions();
            for(let i=activeRingCount;i<rings.length;i++) rings[i].visible=false;
            flightPath.length=0; flightPath.push({x:HOME.x,z:HOME.z});
            rthPhase=null; rthLanded=false; rthAutoAttempted=false;
            updateLiDAR(0,true);
            UI.osmDataStatus.textContent=`${world.renderedBuildings} mapped buildings · ${world.roads.length} roads · ${world.estimatedCount} estimated building heights`;
            UI.environmentSummary.textContent=`Sector 17, Chandigarh · OpenStreetMap footprints and roadways. ${activeRingCount} simulated checkpoints. Not for real flight planning.`;
            UI.flightStatus.textContent='CHANDIGARH MAP READY — MANUAL';
            showToast('Chandigarh Sector 17 map loaded from OpenStreetMap');
        }).catch(error => {
            if(token!==environmentChangeToken) return;
            console.error('OSM map load failed:',error);
            setEnvironment('CITY');
            showToast('Chandigarh map not loaded. Run node scripts/fetch-chandigarh.mjs and restart Vite.');
        });
    }
}


// ------------------ LiDAR-STYLE RAY SENSORS / OBSTACLE AVOIDANCE ------------------
// These are idealized simulated rays against collider boxes, not physical LiDAR.
const LIDAR_RANGE=25;
const AVOID_START=12;
const LIDAR_SENSOR_ANGLES={front:0,frontLeft:Math.PI/4,frontRight:-Math.PI/4,left:Math.PI/2,right:-Math.PI/2};
const lidar={readings:{},hits:{},nearest:LIDAR_RANGE,avoidStatus:'CLEAR',visible:true,scanElapsed:0};
const lidarRays={};
for (const name of Object.keys(LIDAR_SENSOR_ANGLES)) {
    const positions=new Float32Array(6);
    const geom=new THREE.BufferGeometry();
    geom.setAttribute('position',new THREE.BufferAttribute(positions,3));
    const line=new THREE.Line(geom,new THREE.LineBasicMaterial({color:0x27e8f2,transparent:true,opacity:.72,depthWrite:false}));
    line.frustumCulled=false;
    scene.add(line);
    lidarRays[name]=line;
}
function scanObstacleRay(origin, direction, maxRange) {
    const ray=new THREE.Ray(origin,direction);
    const target=new THREE.Vector3();
    let distance=maxRange;
    let obstacle=null;
    for(const box of obstacleBoxes) {
        const point=ray.intersectBox(box,target);
        if(!point) continue;
        const d=origin.distanceTo(point);
        if(d<distance) { distance=d; obstacle=box; }
    }
    return {distance:Math.max(0,distance-DRONE_RADIUS),obstacle};
}
function updateLiDAR(dt,force=false) {
    lidar.scanElapsed+=dt;
    if(!force && lidar.scanElapsed<.065) return;
    lidar.scanElapsed=0;
    const origin=droneState.position.clone();
    origin.y+=.07;
    for(const [name,angle] of Object.entries(LIDAR_SENSOR_ANGLES)) {
        const yaw=droneState.rotation.y+angle;
        const dir=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw));
        const hit=scanObstacleRay(origin,dir,LIDAR_RANGE);
        lidar.readings[name]=hit.distance;
        lidar.hits[name]=hit;
        const line=lidarRays[name];
        const end=origin.clone().addScaledVector(dir,hit.distance+DRONE_RADIUS);
        const arr=line.geometry.attributes.position.array;
        arr.set([origin.x,origin.y,origin.z,end.x,end.y,end.z]);
        line.geometry.attributes.position.needsUpdate=true;
        line.visible=lidar.visible;
        line.material.color.setHex(hit.distance<5?0xff5a5a:hit.distance<AVOID_START?0xffd34d:0x27e8f2);
    }
    lidar.readings.down=Math.max(0,origin.y-terrainY(origin.x,origin.z));
    const speed=droneState.velocity.clone(); speed.y=0;
    if(speed.lengthSq()>.04) {
        speed.normalize();
        lidar.hits.motion=scanObstacleRay(origin,speed,LIDAR_RANGE);
        lidar.readings.motion=lidar.hits.motion.distance;
    } else {
        lidar.hits.motion=lidar.hits.front;
        lidar.readings.motion=lidar.readings.front;
    }
    lidar.nearest=Math.min(lidar.readings.front,lidar.readings.frontLeft,lidar.readings.frontRight,lidar.readings.motion);
}
function applyObstacleAvoidance(dt) {
    if(batteryPercent<=0 || health<=0 || rthLanded) { lidar.avoidStatus='OFFLINE'; return; }
    // Rate-limit the velocity component moving towards an obstacle.
    const horizontalVelocity=droneState.velocity.clone();horizontalVelocity.y=0;
    const speed=horizontalVelocity.length();
    const hit=lidar.hits.motion;
    if(speed>.15 && hit && hit.obstacle && hit.distance<AVOID_START) {
        const direction=horizontalVelocity.normalize();
        const allowedSpeed=Math.max(0,(hit.distance-1.8)*.85);
        if(speed>allowedSpeed) {
            const reduction=(speed-allowedSpeed)*Math.min(1,8*dt);
            droneState.velocity.addScaledVector(direction,-reduction);
        }
        // Steer around the obstacle when a side corridor is more open.
        const leftOpen=Math.min(lidar.readings.left??LIDAR_RANGE,lidar.readings.frontLeft??LIDAR_RANGE);
        const rightOpen=Math.min(lidar.readings.right??LIDAR_RANGE,lidar.readings.frontRight??LIDAR_RANGE);
        const side=rightOpen>=leftOpen?1:-1;
        const right=new THREE.Vector3(-direction.z,0,direction.x);
        const urgency=Math.max(0,(AVOID_START-hit.distance)/AVOID_START);
        droneState.velocity.addScaledVector(right,side*urgency*7*dt);
        lidar.avoidStatus=hit.distance<3?'BRAKING + SIDESTEP':'AVOIDING OBSTACLE';
        if(rthPhase && hit.distance<7) {
            const top=hit.obstacle.max.y+DRONE_RADIUS+3;
            if(top>droneState.position.y) droneState.velocity.y=Math.max(droneState.velocity.y,Math.min(3.5,(top-droneState.position.y)*1.1));
        }
    } else {
        lidar.avoidStatus=lidar.nearest<AVOID_START?'OBSTACLE NEARBY':'CLEAR';
    }
    // RTH also navigates the world at an altitude higher than any static obstacle.
}
function toggleLidarBeams() {
    lidar.visible=!lidar.visible;
    for(const line of Object.values(lidarRays)) line.visible=lidar.visible;
    UI.lidarBeams.textContent=lidar.visible?'Hide LiDAR beams (L)':'Show LiDAR beams (L)';
}
function updateLidarHUD() {
    const display=value=>`${(value??LIDAR_RANGE).toFixed(1)} u`;
    UI.lidarFront.textContent=display(lidar.readings.front);
    UI.lidarLeft.textContent=display(lidar.readings.left);
    UI.lidarRight.textContent=display(lidar.readings.right);
    UI.lidarDown.textContent=display(lidar.readings.down);
    UI.lidarStatus.textContent=lidar.nearest<4?'DANGER — OBSTACLE VERY CLOSE':lidar.nearest<AVOID_START?'OBSTACLE DETECTED':'ALL CLEAR';
    UI.lidarStatus.style.color=lidar.nearest<4?'#ff6b6b':lidar.nearest<AVOID_START?'#ffd15a':'#6ee7b7';
    UI.lidarAvoidance.textContent=lidar.avoidStatus;
}

setEnvironment('CITY',true);

// ------------------ INPUT / CAMERA ------------------
function changeWeather() {
    const next = (WEATHER_MODES.indexOf(weather.mode) + 1) % WEATHER_MODES.length;
    weather.mode = WEATHER_MODES[next];
    UI.weatherButton.textContent = `Change weather (V) — ${weather.mode}`;
    UI.weatherLabel.textContent = weather.mode;
}

function updateWeather(dt) {
    weather.time += dt;
    const preset = WEATHER_PRESETS[weather.mode];
    const gust = preset.gust * (
        0.75 * Math.sin(weather.time * 0.75) +
        0.25 * Math.sin(weather.time * 2.7)
    );
    const speed = Math.max(0, preset.baseWind + gust);
    const direction = 0.6 + Math.sin(weather.time * 0.12) * 0.5;
    weather.wind.set(Math.cos(direction) * speed, 0, Math.sin(direction) * speed);

    // Change ambience gradually, rather than snapping between weather presets.
    const smoothing = 1 - Math.exp(-1.8 * dt);
    const env=ENV_SETTINGS[environmentMode];
    const skyTarget = weather.mode==='CLEAR' ? env.sky : environmentMode==='NIGHT_CITY'
        ? (weather.mode==='STORM'?0x050a17:0x14223b)
        : preset.sky;
    scene.background.lerp(new THREE.Color(skyTarget), smoothing);
    scene.fog.color.copy(scene.background);
    scene.fog.density = THREE.MathUtils.lerp(scene.fog.density, Math.max(preset.fog,env.fog), smoothing);
    sun.intensity = THREE.MathUtils.lerp(sun.intensity, Math.min(env.sun,preset.sunlight), smoothing);
    ambient.intensity = THREE.MathUtils.lerp(ambient.intensity,env.ambient,smoothing);
    const cloudColor = new THREE.Color(weather.mode === 'STORM' ? 0x8394a8 : 0xffffff);
    for (const cloud of clouds) cloud.material.color.lerp(cloudColor, smoothing);

    // Physical effect: wind pushes the drone sideways. Manual flight and RTH
    // use the same wind field, so autopilot must compensate for gusts.
    updateRain(dt);
}

function applyWind(dt) {
    if (rthLanded && !keys[' '] && !rthPhase) return;
    droneState.velocity.x += (weather.wind.x - droneState.velocity.x) * WEATHER_DRAG * dt;
    droneState.velocity.z += (weather.wind.z - droneState.velocity.z) * WEATHER_DRAG * dt;
}

function resetVelocities() {
    droneState.velocity.set(0, 0, 0);
    droneState.rotationVelocity.set(0, 0, 0);
}

function toggleCamera() {
    cameraMode = cameraMode === 'FPV' ? 'THIRD_PERSON' : 'FPV';
    UI.cameraMode.textContent = cameraMode === 'FPV' ? 'First-person (FPV)' : 'Third-person';
    UI.cameraButton.textContent = cameraMode === 'FPV' ? 'Switch to third-person (C)' : 'Switch to FPV (C)';
    droneBody.visible = cameraMode !== 'FPV';
}

function startReturnHome() {
    if (batteryPercent <= 0 || health <= 0 || rthPhase) return;
    rthLanded = false;
    rthPhase = 'CLIMB';
    const highestObstacle=obstacleBoxes.reduce((max,box)=>Math.max(max,box.max.y),0);
    rthAltitude = Math.max(RTH_SAFE_ALTITUDE, highestObstacle+6, droneState.position.y + 2);
    UI.flightStatus.textContent = 'AUTO RTH: CLIMBING';
}

function toggleReturnHome() {
    if (rthPhase) {
        rthPhase = null;
        UI.flightStatus.textContent = 'RTH CANCELLED — MANUAL';
    } else {
        startReturnHome();
    }
}

function showToast(message) {
    UI.toast.textContent = message;
    UI.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => UI.toast.classList.remove('visible'), 3200);
}

function syncGimbalUI() {
    UI.gimbalPitch.value = String(gimbal.pitch);
    UI.gimbalYaw.value = String(gimbal.yaw);
    UI.gimbalZoom.value = String(gimbal.zoom);
    UI.gimbalPitchValue.textContent = `${gimbal.pitch > 0 ? '+' : ''}${gimbal.pitch}°`;
    UI.gimbalYawValue.textContent = `${gimbal.yaw > 0 ? '+' : ''}${gimbal.yaw}°`;
    UI.gimbalZoomValue.textContent = `${gimbal.zoom.toFixed(1)}×`;
    UI.gimbalState.textContent = gimbal.stabilized ? 'STABILIZED' : 'FOLLOW BODY';
    UI.gimbalStabilize.textContent = gimbal.stabilized ? 'Stabilization ON' : 'Stabilization OFF';
    UI.gimbalStabilize.classList.toggle('active', gimbal.stabilized);
    UI.gimbalStabilize.setAttribute('aria-pressed', String(gimbal.stabilized));
}
function resetGimbal() {
    gimbal.pitch = -12;
    gimbal.yaw = 0;
    gimbal.zoom = 1;
    gimbal.stabilized = true;
    syncGimbalUI();
    showToast('Gimbal reset · FPV framing ready');
}
function downloadCapturedFile(blob, extension, prefix) {
    if (!blob || !blob.size) {
        showToast('No video frames were captured. Try recording again.');
        return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // The delayed revoke gives the browser time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function takePhoto() {
    renderer.domElement.toBlob(blob => {
        if (!blob) { showToast('Photo capture is unavailable in this browser.'); return; }
        downloadCapturedFile(blob, 'png', 'dronesim-photo');
        showToast('Snapshot saved as PNG');
    }, 'image/png');
}
function recordingMimeType() {
    if (!window.MediaRecorder) return '';
    return [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4'
    ].find(type => MediaRecorder.isTypeSupported(type)) || '';
}
function renderRecordingUI() {
    const active = activeRecording;
    const running = Boolean(active && active.recorder.state === 'recording');
    const stopping = Boolean(active && active.recorder.state === 'inactive' && !active.finished);
    UI.recordButton.classList.toggle('recording', running);
    UI.recordButton.classList.toggle('primary', !running);
    UI.recordButton.querySelector('span').textContent = running ? 'Stop recording (O)' : 'Record (O)';
    UI.recordButton.disabled = stopping;
    UI.recordingIndicator.style.display = running ? 'flex' : 'none';
    UI.recordingStatus.classList.toggle('recording', running);
    if (running) {
        const seconds = Math.floor((performance.now() - active.startedAt) / 1000);
        const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        UI.recordingTimer.textContent = `REC ${time}`;
        UI.recordingStatus.textContent = `Recording ${time} · ${active.extension.toUpperCase()} · click Stop to download`;
    } else if (stopping) {
        UI.recordingStatus.textContent = 'Saving the video file…';
    }
}
function startRecording() {
    if (activeRecording) return;
    if (!recorderAvailable) {
        UI.recordingStatus.textContent = 'Recording unavailable: requires MediaRecorder and canvas captureStream.';
        showToast('This browser does not support canvas video recording.');
        return;
    }
    let stream;
    try {
        const mimeType = recordingMimeType();
        stream = renderer.domElement.captureStream(30);
        const options = mimeType ? { mimeType, videoBitsPerSecond: 4500000 } : { videoBitsPerSecond: 4500000 };
        const recorder = new MediaRecorder(stream, options);
        const session = {
            recorder, stream, chunks: [], startedAt: performance.now(),
            extension: (recorder.mimeType || mimeType).includes('mp4') ? 'mp4' : 'webm',
            finished: false
        };
        activeRecording = session;
        recorder.addEventListener('dataavailable', event => {
            if (event.data && event.data.size > 0) session.chunks.push(event.data);
        });
        recorder.addEventListener('stop', () => {
            session.finished = true;
            session.stream.getTracks().forEach(track => track.stop());
            const blob = new Blob(session.chunks, { type: recorder.mimeType || 'video/webm' });
            if (activeRecording === session) activeRecording = null;
            renderRecordingUI();
            UI.recordingStatus.textContent = blob.size ? `Saved flight video · ${(blob.size / (1024 * 1024)).toFixed(1)} MB` : 'No recorded frames available';
            if (blob.size) {
                downloadCapturedFile(blob, session.extension, 'dronesim-flight');
                showToast('Flight recording downloaded');
            }
        }, { once: true });
        recorder.addEventListener('error', event => {
            console.error('Video recorder error', event);
            UI.recordingStatus.textContent = 'Recording failed. Please retry.';
            showToast('Recording failed — check browser permissions and support.');
            try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_error) { /* ignore */ }
        });
        recorder.start(1000);
        renderRecordingUI();
        showToast('Recording the 3D flight view · press O to stop');
    } catch (error) {
        stream?.getTracks().forEach(track => track.stop());
        activeRecording = null;
        UI.recordingStatus.textContent = `Recording unavailable: ${error.message}`;
        showToast('Unable to start recording in this browser.');
    }
}
function toggleRecording() {
    if (!activeRecording) { startRecording(); return; }
    if (activeRecording.recorder.state === 'recording') {
        try { activeRecording.recorder.stop(); } catch (error) { console.error(error); }
        renderRecordingUI();
    }
}

window.addEventListener('keydown', (event) => {
    // Arrow keys in sliders/selects remain usable, and Space can activate buttons.
    if (event.target instanceof Element && event.target.closest('input,select,textarea,button')) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.preventDefault();
    const key = event.key.length === 1 && event.key !== ' ' ? event.key.toLowerCase() : event.key;
    if (Object.prototype.hasOwnProperty.call(keys, key)) keys[key] = true;
    if (event.repeat) return;
    if (key === 'b') {
        droneState.beginnerMode = !droneState.beginnerMode;
        droneState.mouseX = droneState.rotation.y / (Math.PI * 2);
        droneState.mouseY = droneState.rotation.x / Math.PI;
        resetVelocities();
        UI.mode.textContent = droneState.beginnerMode ? 'Beginner Mode' : 'Normal Mode';
        if (!droneState.beginnerMode && document.pointerLockElement) document.exitPointerLock();
    }
    if (key === 'c') toggleCamera();
    if (key === 'v') changeWeather();
    if (key === 'n') {
        const next=(ENVIRONMENTS.indexOf(environmentMode)+1)%ENVIRONMENTS.length;
        setEnvironment(ENVIRONMENTS[next]);
    }
    if (key === 'l') toggleLidarBeams();
    if (key === 'g') { gimbal.pitch = Math.max(-75, gimbal.pitch - 5); syncGimbalUI(); }
    if (key === 't') { gimbal.pitch = Math.min(30, gimbal.pitch + 5); syncGimbalUI(); }
    if (key === 'z') { gimbal.zoom = Math.min(3, +(gimbal.zoom + 0.1).toFixed(1)); syncGimbalUI(); }
    if (key === 'x') { gimbal.zoom = Math.max(1, +(gimbal.zoom - 0.1).toFixed(1)); syncGimbalUI(); }
    if (key === 'o') toggleRecording();
    if (key === 'p') takePhoto();
    if (key === 'h') toggleReturnHome();
    if (key === 'r') {
        if (activeRecording) showToast('Stop and download your recording before restarting.');
        else location.reload();
    }
});
window.addEventListener('keyup', (event) => {
    const key = event.key.length === 1 && event.key !== ' ' ? event.key.toLowerCase() : event.key;
    if (Object.prototype.hasOwnProperty.call(keys, key)) keys[key] = false;
});
window.addEventListener('blur', () => {
    for (const key of Object.keys(keys)) keys[key] = false;
});
renderer.domElement.addEventListener('click', () => {
    if (droneState.beginnerMode && !isPointerLocked) document.body.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
    isPointerLocked = document.pointerLockElement === document.body;
});
document.addEventListener('mousemove', (event) => {
    if (isPointerLocked && droneState.beginnerMode) {
        droneState.mouseX -= event.movementX * 0.0005;
        droneState.mouseY -= event.movementY * 0.0005;
        droneState.mouseY = THREE.MathUtils.clamp(droneState.mouseY, -MAX_PITCH / Math.PI, MAX_PITCH / Math.PI);
    }
});
UI.cameraButton.addEventListener('click', toggleCamera);
UI.rthButton.addEventListener('click', toggleReturnHome);
UI.weatherButton.addEventListener('click', changeWeather);
UI.environmentSelect.addEventListener('change',event=>setEnvironment(event.target.value));
UI.environmentNext.addEventListener('click',()=>{
    const next=(ENVIRONMENTS.indexOf(environmentMode)+1)%ENVIRONMENTS.length;
    setEnvironment(ENVIRONMENTS[next]);
});
UI.lidarBeams.addEventListener('click',toggleLidarBeams);
UI.gimbalPitch.addEventListener('input', event => {
    gimbal.pitch = THREE.MathUtils.clamp(Number(event.target.value), -75, 30);
    syncGimbalUI();
});
UI.gimbalYaw.addEventListener('input', event => {
    gimbal.yaw = THREE.MathUtils.clamp(Number(event.target.value), -90, 90);
    syncGimbalUI();
});
UI.gimbalZoom.addEventListener('input', event => {
    gimbal.zoom = THREE.MathUtils.clamp(Number(event.target.value), 1, 3);
    syncGimbalUI();
});
UI.gimbalStabilize.addEventListener('click', () => {
    gimbal.stabilized = !gimbal.stabilized;
    syncGimbalUI();
});
UI.gimbalReset.addEventListener('click', resetGimbal);
UI.recordButton.addEventListener('click', toggleRecording);
UI.snapshotButton.addEventListener('click', takePhoto);
syncGimbalUI();
if (!recorderAvailable) {
    UI.recordingStatus.textContent = 'Video capture is not supported in this browser.';
    UI.recordButton.disabled = true;
}


// ------------------ FLIGHT PHYSICS ------------------
function updateManualFlight(dt) {
    const powered = batteryPercent > 0 && health > 0;
    if (droneState.beginnerMode) {
        const targetPitch = THREE.MathUtils.clamp(droneState.mouseY * Math.PI, -MAX_PITCH, MAX_PITCH);
        droneState.rotation.x = THREE.MathUtils.damp(droneState.rotation.x, targetPitch, 6, dt);
        droneState.rotation.y = droneState.mouseX * Math.PI * 2;
        droneState.rotation.z = THREE.MathUtils.damp(droneState.rotation.z, 0, 6, dt);
    } else {
        const pitchInput = Number(keys.ArrowDown) - Number(keys.ArrowUp);
        const rollInput = Number(keys.a) - Number(keys.d);
        droneState.rotation.x = THREE.MathUtils.damp(droneState.rotation.x, pitchInput * MAX_PITCH, 6, dt);
        droneState.rotation.z = THREE.MathUtils.damp(droneState.rotation.z, rollInput * MAX_ROLL, 6, dt);
        droneState.rotation.y += (Number(keys.q) - Number(keys.e)) * 1.35 * dt;
    }

    if (!powered) {
        droneState.velocity.y -= GRAVITY * dt;
        droneState.rotation.x = THREE.MathUtils.damp(droneState.rotation.x, 0, 1.5, dt);
        droneState.rotation.z = THREE.MathUtils.damp(droneState.rotation.z, 0, 1.5, dt);
    } else {
        const yaw = droneState.rotation.y;
        const forwardX = -Math.sin(yaw);
        const forwardZ = -Math.cos(yaw);
        const rightX = Math.cos(yaw);
        const rightZ = -Math.sin(yaw);

        let foreAccel = -Math.sin(droneState.rotation.x) * TILT_ACCEL;
        let lateralAccel = -Math.sin(droneState.rotation.z) * TILT_ACCEL;
        if (droneState.beginnerMode) {
            if (keys.w) foreAccel += NORMAL_ACCEL;
        } else {
            foreAccel += (Number(keys.w) - Number(keys.s)) * NORMAL_ACCEL;
            lateralAccel += (Number(keys.d) - Number(keys.a)) * NORMAL_ACCEL;
        }
        droneState.velocity.x += (forwardX * foreAccel + rightX * lateralAccel) * dt;
        droneState.velocity.z += (forwardZ * foreAccel + rightZ * lateralAccel) * dt;

        const liftFactor = Math.cos(droneState.rotation.x) * Math.cos(droneState.rotation.z);
        const verticalAccel = HOVER_LIFT * liftFactor - GRAVITY
            + (Number(keys[' ']) - Number(keys.Shift)) * 11;
        droneState.velocity.y += verticalAccel * dt;
    }

    // Stable, frame-rate-independent damping and speed limits.
    const horizontalDamping = Math.exp(-1.5 * dt);
    droneState.velocity.x *= horizontalDamping;
    droneState.velocity.z *= horizontalDamping;
    if (powered) droneState.velocity.y *= Math.exp(-1.5 * dt);
    const horizontalSpeed = Math.hypot(droneState.velocity.x, droneState.velocity.z);
    if (horizontalSpeed > MAX_HORIZONTAL_SPEED) {
        const scale = MAX_HORIZONTAL_SPEED / horizontalSpeed;
        droneState.velocity.x *= scale;
        droneState.velocity.z *= scale;
    }
    droneState.velocity.y = THREE.MathUtils.clamp(droneState.velocity.y, -MAX_VERTICAL_SPEED * 2, MAX_VERTICAL_SPEED);
}

function updateAutopilot(dt) {
    if (batteryPercent <= 0 || health <= 0) {
        rthPhase = null;
        updateManualFlight(dt); // Unpowered, gravity-driven descent.
        return;
    }
    droneState.rotation.x = THREE.MathUtils.damp(droneState.rotation.x, 0, 5, dt);
    droneState.rotation.z = THREE.MathUtils.damp(droneState.rotation.z, 0, 5, dt);

    const pos = droneState.position;
    const deltaHome = new THREE.Vector3(HOME.x - pos.x, 0, HOME.z - pos.z);
    const horizontalDistance = deltaHome.length();
    const desired = new THREE.Vector3();

    if (rthPhase === 'CLIMB') {
        desired.y = THREE.MathUtils.clamp((rthAltitude - pos.y) * 2, 0, 4);
        if (pos.y >= rthAltitude - 0.6) rthPhase = 'CRUISE';
    } else if (rthPhase === 'CRUISE') {
        if (horizontalDistance > 0.01) deltaHome.normalize().multiplyScalar(Math.min(7, horizontalDistance * 1.5));
        desired.x = deltaHome.x;
        desired.z = deltaHome.z;
        desired.y = THREE.MathUtils.clamp((rthAltitude - pos.y) * 2, -3, 3);
        if (horizontalDistance < 1.1) rthPhase = 'DESCEND';
    } else if (rthPhase === 'DESCEND') {
        desired.x = THREE.MathUtils.clamp((HOME.x - pos.x) * 1.6, -2, 2);
        desired.z = THREE.MathUtils.clamp((HOME.z - pos.z) * 1.6, -2, 2);
        desired.y = THREE.MathUtils.clamp((HOME.y - pos.y) * 1.3, -2, 0);
        if (horizontalDistance < 0.55 && Math.abs(pos.y - HOME.y) < 0.25) {
            rthPhase = null;
            rthLanded = true;
            droneState.velocity.set(0, 0, 0);
            droneState.position.set(HOME.x, HOME.y, HOME.z);
            UI.flightStatus.textContent = 'LANDED AT HOME';
            return;
        }
    }

    if(Math.hypot(desired.x,desired.z)>0.2) {
        const targetYaw=Math.atan2(-desired.x,-desired.z);
        const difference=Math.atan2(Math.sin(targetYaw-droneState.rotation.y),Math.cos(targetYaw-droneState.rotation.y));
        droneState.rotation.y+=difference*Math.min(1,2.8*dt);
    }
    droneState.velocity.lerp(desired, Math.min(1, 2.5 * dt));
    UI.flightStatus.textContent = `AUTO RTH: ${rthPhase}`;
}

function applyDamage(amount, reason, elapsed) {
    if (elapsed - lastHitTime < 0.75 || health <= 0) return;
    lastHitTime = elapsed;
    health = Math.max(0, health - amount);
    damageFlashUntil = elapsed + 2.2;
    UI.damageWarning.textContent = health <= 0 ? 'DRONE DESTROYED — PRESS R TO RESTART' : `${reason} — -${Math.ceil(amount)} HEALTH`;
    if (health <= 0) {
        rthPhase = null;
        UI.flightStatus.textContent = 'DRONE DESTROYED';
    }
}

function moveWithCollisions(dt, elapsed) {
    if (rthLanded && !keys[' '] && !rthPhase) {
        droneState.velocity.set(0, 0, 0);
        return;
    }
    if (rthLanded && keys[' ']) rthLanded = false;

    const previous = droneState.position.clone();
    const next = previous.clone().addScaledVector(droneState.velocity, dt);
    const impactSpeed = droneState.velocity.length();

    // Drone-radius against the selected world's obstacle colliders.
    let buildingHit = false;
    for (const box of obstacleBoxes) {
        if (box.distanceToPoint(next) < DRONE_RADIUS) {
            buildingHit = true;
            break;
        }
    }
    if (buildingHit) {
        next.copy(previous);
        droneState.velocity.multiplyScalar(-0.15);
        applyDamage(THREE.MathUtils.clamp((impactSpeed - 1) * 5, 8, 40), 'OBSTACLE COLLISION', elapsed);
        if (rthPhase) UI.flightStatus.textContent = 'RTH BLOCKED: COLLISION';
    }

    // Ground is a height-varying Three.js mesh, not necessarily y=0.
    const minimumY = groundHeightAt(next.x, next.z) + DRONE_RADIUS;
    if (next.y <= minimumY) {
        if (droneState.velocity.y < -3.1 && !rthPhase && !rthLanded) {
            applyDamage(THREE.MathUtils.clamp(-droneState.velocity.y * 3.5, 9, 45), 'HARD LANDING', elapsed);
        }
        next.y = minimumY;
        droneState.velocity.y = Math.max(0, droneState.velocity.y);
        droneState.velocity.x *= 0.82;
        droneState.velocity.z *= 0.82;
    }

    // Bounded world: 200x200 for procedural worlds, 640x640 for the OSM extract.
    const boundary=mapHalfSpan-2;
    if (Math.abs(next.x) > boundary || Math.abs(next.z) > boundary) {
        next.x = THREE.MathUtils.clamp(next.x, -boundary, boundary);
        next.z = THREE.MathUtils.clamp(next.z, -boundary, boundary);
        droneState.velocity.x = 0;
        droneState.velocity.z = 0;
    }
    droneState.position.copy(next);
}

function updateBattery(dt) {
    const active = rthPhase !== null || Object.entries(keys).some(([key, pressed]) => key !== 'q' && key !== 'e' && pressed);
    const drainPerSecond = 0.04 + (active ? 0.12 : 0) + (weather.mode === 'STORM' ? 0.06 : 0);
    batteryPercent = Math.max(0, batteryPercent - drainPerSecond * dt);

    if (batteryPercent <= 10 && batteryPercent > 0 && !rthAutoAttempted && !rthLanded) {
        rthAutoAttempted = true;
        startReturnHome();
    }
    UI.batteryPercent.textContent = `${Math.ceil(batteryPercent)}%`;
    UI.batteryFill.style.width = `${batteryPercent}%`;
    let color = '#22c55e';
    let message = 'Battery Healthy';
    let warning = '';
    if (batteryPercent <= 0) {
        color = '#ef4444'; message = 'BATTERY EMPTY'; warning = 'BATTERY EMPTY — POWER LOST';
    } else if (batteryPercent <= 10) {
        color = '#ef4444'; message = 'Critical Battery'; warning = 'CRITICAL BATTERY — AUTO RETURN TO HOME';
    } else if (batteryPercent <= 20) {
        color = '#facc15'; message = 'Low Battery'; warning = 'LOW BATTERY — RETURN TO HOME';
    }
    UI.batteryFill.style.background = color;
    UI.batteryStatus.style.color = color;
    UI.batteryStatus.textContent = message;
    UI.batteryWarning.textContent = warning;
    UI.batteryWarning.style.display = warning ? 'block' : 'none';
}

function updateCamera(dt) {
    droneBody.visible = cameraMode !== 'FPV';
    // In FPV the camera is mounted ahead of the fuselage but can pan and tilt
    // independently. In chase view the camera follows with a natural 75° FOV.
    const targetFov = cameraMode === 'FPV' ? 75 / gimbal.zoom : 75;
    const nextFov = THREE.MathUtils.damp(camera.fov, targetFov, 10, dt);
    if (Math.abs(nextFov - camera.fov) > 0.005) {
        camera.fov = nextFov;
        camera.updateProjectionMatrix();
    }
    if (cameraMode === 'FPV') {
        const bodyOrientation = new THREE.Quaternion().setFromEuler(droneState.rotation);
        const offset = new THREE.Vector3(0, 0.14, -0.65).applyQuaternion(bodyOrientation);
        camera.position.copy(droneState.position).add(offset);
        if (gimbal.stabilized) {
            // Horizon lock eliminates simulated roll and body pitch; the camera
            // still follows drone heading and the gimbal's pan/tilt settings.
            const stabilizedAttitude = new THREE.Euler(
                THREE.MathUtils.degToRad(gimbal.pitch),
                droneState.rotation.y + THREE.MathUtils.degToRad(gimbal.yaw),
                0, 'YXZ'
            );
            camera.quaternion.setFromEuler(stabilizedAttitude);
        } else {
            const localGimbal = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                THREE.MathUtils.degToRad(gimbal.pitch),
                THREE.MathUtils.degToRad(gimbal.yaw),
                0, 'YXZ'
            ));
            camera.quaternion.copy(bodyOrientation).multiply(localGimbal);
        }
    } else {
        const behind = new THREE.Vector3(0, 2.8, 8).applyAxisAngle(new THREE.Vector3(0, 1, 0), droneState.rotation.y);
        const wanted = droneState.position.clone().add(behind);
        camera.position.lerp(wanted, 1 - Math.exp(-6 * dt));
        const forward = new THREE.Vector3(-Math.sin(droneState.rotation.y), 0, -Math.cos(droneState.rotation.y));
        camera.lookAt(droneState.position.clone().addScaledVector(forward, 1.7));
    }
}

function updateMission(now, dt) {
    const positions = trail.geometry.attributes.position.array;
    positions[trailIndex * 3] = droneState.position.x;
    positions[trailIndex * 3 + 1] = droneState.position.y;
    positions[trailIndex * 3 + 2] = droneState.position.z;
    trailIndex = (trailIndex + 1) % 100;
    trail.geometry.attributes.position.needsUpdate = true;

    rings.forEach((ring, i) => {
        if (!ring.visible) return;
        if (droneState.position.distanceTo(ring.position) < 2) {
            ring.visible = false;
            ringsCollected++;
            if (!timerStarted) { timerStarted = true; startTime = now; }
            if (ringsCollected === activeRingCount) {
                UI.timer.textContent = `Completed in: ${((now - startTime) / 1000).toFixed(1)}s`;
            }
        }
        if (ring.visible) {
            ring.rotation.y += dt * 0.6;
            ring.position.y += Math.sin(now * 0.001 + i) * 0.02 * dt * 60;
        }
    });
    if (timerStarted && ringsCollected < activeRingCount) {
        UI.timer.textContent = `Time: ${((now - startTime) / 1000).toFixed(1)}s`;
    }
}

// ------------------ GPS-STYLE LOCAL MAP ------------------
// North/up is -Z. Mapping covers the simulator's 200 x 200-unit terrain.
function drawMinimap(dt) {
    mapSampleTime += dt;
    mapRenderTime += dt;
    if (mapSampleTime >= 0.12) {
        mapSampleTime = 0;
        const previous = flightPath[flightPath.length - 1];
        if (Math.hypot(droneState.position.x - previous.x, droneState.position.z - previous.z) > 0.08) {
            flightPath.push({ x: droneState.position.x, z: droneState.position.z });
            // Keep memory bounded for long simulator sessions.
            if (flightPath.length > 3500) flightPath.shift();
        }
    }
    if (mapRenderTime < 0.08) return; // ~12 redraws per second
    mapRenderTime = 0;

    const ctx = mapContext;
    const width = UI.mapCanvas.width;
    const height = UI.mapCanvas.height;
    const toX = x => (x + mapHalfSpan) * width / (mapHalfSpan*2);
    const toY = z => (z + mapHalfSpan) * height / (mapHalfSpan*2);
    ctx.clearRect(0, 0, width, height);
    if (environmentMode==='CHANDIGARH_OSM' && chandigarhMapLayer) {
        ctx.drawImage(chandigarhMapLayer,0,0);
    } else {
        ctx.fillStyle = '#102737';
        ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = '#2d495c';
        ctx.lineWidth = 1;
        for (let n = -mapHalfSpan; n <= mapHalfSpan; n += 25) {
            ctx.beginPath(); ctx.moveTo(toX(n), 0); ctx.lineTo(toX(n), height); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, toY(n)); ctx.lineTo(width, toY(n)); ctx.stroke();
        }
        ctx.fillStyle = environmentMode==='FOREST'?'#4a9b66':environmentMode==='DESERT'?'#bf8550':environmentMode==='MOUNTAINS'?'#9da3aa':'#66899b';
        for (const box of obstacleBoxes) {
            ctx.fillRect(toX(box.min.x), toY(box.min.z),
                (box.max.x - box.min.x) * width / (mapHalfSpan*2),
                (box.max.z - box.min.z) * height / (mapHalfSpan*2));
        }
    }

    // Remaining race checkpoint locations.
    ctx.fillStyle = '#facc15';
    for (const ring of rings) {
        if (!ring.visible) continue;
        ctx.beginPath(); ctx.arc(toX(ring.position.x), toY(ring.position.z), 3, 0, Math.PI * 2); ctx.fill();
    }

    // Flight path, retained for the whole recent trip.
    if (flightPath.length > 1) {
        ctx.beginPath();
        ctx.moveTo(toX(flightPath[0].x), toY(flightPath[0].z));
        for (let i = 1; i < flightPath.length; i++) {
            ctx.lineTo(toX(flightPath[i].x), toY(flightPath[i].z));
        }
        ctx.strokeStyle = '#40e3ce';
        ctx.lineWidth = 2.5;
        ctx.stroke();
    }

    // Home pad in blue.
    ctx.beginPath();
    ctx.arc(toX(HOME.x), toY(HOME.z), 6, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8'; ctx.fill();
    ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke();

    // A triangle whose heading follows the simulated drone's yaw.
    ctx.save();
    ctx.translate(toX(droneState.position.x), toY(droneState.position.z));
    ctx.rotate(-droneState.rotation.y);
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(-7, 7); ctx.lineTo(7, 7); ctx.closePath();
    ctx.fillStyle = '#fb7185'; ctx.fill();
    ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#e2e8f0'; ctx.font = '12px Arial';
    ctx.fillText('N', width / 2 - 5, 15);
    UI.mapPosition.textContent = environmentMode==='CHANDIGARH_OSM'
        ? `OSM Chandigarh · X ${droneState.position.x.toFixed(1)} / Z ${droneState.position.z.toFixed(1)}`
        : `X ${droneState.position.x.toFixed(1)} | Z ${droneState.position.z.toFixed(1)}`;
}

function updateHUD(elapsed) {
    const relativeAltitude = droneState.position.y - groundHeightAt(droneState.position.x, droneState.position.z);
    UI.telemetry.textContent = `Altitude: ${relativeAltitude.toFixed(1)} units | Speed: ${droneState.velocity.length().toFixed(1)} u/s | Rings: ${ringsCollected}/${activeRingCount}`;
    UI.healthPercent.textContent = `${Math.ceil(health)}%`;
    UI.healthFill.style.width = `${health}%`;
    UI.healthFill.style.background = health <= 30 ? '#ef4444' : health <= 60 ? '#facc15' : '#22c55e';
    UI.cameraMode.textContent = cameraMode === 'FPV' ? 'First-person (FPV)' : 'Third-person';
    // Flight dynamics (Euler attitude angles are simulated, not IMU measurements).
    const pitch = THREE.MathUtils.radToDeg(droneState.rotation.x);
    const roll = THREE.MathUtils.radToDeg(droneState.rotation.z);
    const yaw = ((THREE.MathUtils.radToDeg(droneState.rotation.y) % 360) + 360) % 360;
    UI.dynamicsPitch.textContent = `${pitch.toFixed(1)}°`;
    UI.dynamicsRoll.textContent = `${roll.toFixed(1)}°`;
    UI.dynamicsYaw.textContent = `${yaw.toFixed(0)}°`;
    UI.dynamicsVertical.textContent = `${droneState.velocity.y >= 0 ? '+' : ''}${droneState.velocity.y.toFixed(1)} u/s`;
    UI.dynamicsAcceleration.textContent = `${flightAcceleration.toFixed(1)} u/s²`;
    UI.dynamicsAutopilot.textContent = rthPhase ? `RTH — ${rthPhase}` : rthLanded ? 'LANDED' : 'MANUAL';
    UI.attitudeIndicator.style.transform = `translate(-50%, -50%) translateY(${THREE.MathUtils.clamp(pitch * 1.2, -36, 36)}px) rotate(${-roll}deg)`;
    UI.weatherLabel.textContent = weather.mode;
    UI.weatherWind.textContent = `${weather.wind.length().toFixed(1)} u/s`;
    UI.weatherHint.textContent = weather.mode === 'STORM'
        ? 'Rain, poor visibility, gusty wind and extra battery drain'
        : weather.mode === 'BREEZY'
            ? 'Gusts cause sideways drift during manual flight and RTH'
            : 'Clear skies with very light wind';
    UI.rthButton.textContent = rthPhase ? 'Cancel Return-to-Home (H)' : 'Return-to-Home (H)';
    updateLidarHUD();
    UI.damageWarning.style.display = elapsed < damageFlashUntil ? 'block' : 'none';
    if (!rthPhase && health > 0 && !rthLanded && batteryPercent > 0) UI.flightStatus.textContent = 'MANUAL FLIGHT';
    if (!rthPhase && health > 0 && batteryPercent === 0) UI.flightStatus.textContent = 'POWER LOST — DESCENDING';
}

// Development-only battery testing from the browser console.
if (import.meta.env.DEV) {
    window.droneDebug = {
        setBattery(value) { batteryPercent = THREE.MathUtils.clamp(Number(value), 0, 100); },
        setWeather(value) { if (WEATHER_PRESETS[String(value).toUpperCase()]) weather.mode = String(value).toUpperCase(); },
        setEnvironment(value) { setEnvironment(String(value).toUpperCase()); },
        getLidar() { return {readings:{...lidar.readings},avoidance:lidar.avoidStatus,environment:environmentMode}; },
        getState() { return { batteryPercent, health, cameraMode, rthPhase, weather: weather.mode, wind: weather.wind.toArray(), position: droneState.position.toArray() }; }
    };
}

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.max(0.001, Math.min(clock.getDelta(), 0.033));
    const now = Date.now();
    const elapsed = performance.now() / 1000;

    updateWeather(dt);
    updateBattery(dt);
    lastVelocity.copy(droneState.velocity);
    updateLiDAR(dt);
    if (rthPhase) updateAutopilot(dt);
    else updateManualFlight(dt);
    applyWind(dt);
    applyObstacleAvoidance(dt);
    moveWithCollisions(dt, elapsed);
    flightAcceleration = THREE.MathUtils.lerp(
        flightAcceleration,
        Math.min(droneState.velocity.distanceTo(lastVelocity) / dt, 60),
        1 - Math.exp(-5 * dt)
    );

    droneBody.position.copy(droneState.position);
    droneBody.rotation.copy(droneState.rotation);
    if (batteryPercent > 0 && health > 0 && !rthLanded) droneState.propellerRotation += PROP_SPEED * dt;
    propellers.forEach((prop, i) => { prop.rotation.y = droneState.propellerRotation + (i % 2 ? Math.PI : 0); });
    clouds.forEach((cloud, i) => {
        cloud.position.x += (weather.wind.x * 0.16 + Math.sin(now * 0.001 + i) * 0.3) * dt;
        cloud.position.z += (weather.wind.z * 0.16 + Math.cos(now * 0.001 + i) * 0.3) * dt;
    });
    updateCamera(dt);
    updateMission(now, dt);
    drawMinimap(dt);
    updateHUD(elapsed);
    renderer.render(scene, camera);
    if (activeRecording) renderRecordingUI();
}
window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
});
updateHUD(0);
animate();
