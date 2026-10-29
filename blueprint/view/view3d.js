// view3d.js - Blueprint City: a converted Blueprint drawn in 3D with Three.js on WebGPU, made to look good as well as to read well,
// answering the Blueprint frictions the design discussion names, section by section:
//   1 Spaghetti / exec vs data clutter  -> exec pipes ride ABOVE the nodes, data pipes BELOW: the two never cross in one plane
//   1 Zoom blindness                     -> fly to anything by name; every box's title reads wherever it has room (nodeLabels) and its
//                                           whole face when close; island titles from afar
//   2 Hidden hierarchy                   -> each class is a district, standing over its engine parent's floor (read, not drawn by hand)
//   3 Invisible relationships            -> calls between graphs are arcs; a call by NAME (a timer) marches in orange, because nothing
//                                           else in the engine shows it; the interface is a ring every message goes through
//   5 Data as flowing water               -> pulses run the exec pipes; a graph a timer runs 100 times a second swells and burns red;
//                                           data pipes are as thick as their type is heavy (a Vector, a Rotator) and coloured like pins
//   5 Time-travel replay                  -> any path through a graph replays step by step, scrubbed back and forth, each step showing
//                                           the use case step and the requirement it serves
// Everything drawn comes from window.BPV3D (view/scene_cli.js): nothing is placed or labelled by hand.
// Measured 10-28: parts of the city, the interface among them, could not be clicked, and its node boxes were blank. So every node
// now carries its own face (nodeFace: title bar and line, ON the box), and every part city_parts.js lists is registered in Picks
// and answers a hover and a click; cityAudit() holds what was drawn to that list and says so in the badge.
import * as THREE from 'three/webgpu';
import { uv, time, color, float, fract, smoothstep, step, mix, sin, pass, mrt, output, emissive, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const D = window.BPV3D;
const C = window.CITY;                           // view/city_parts.js: what each part is, what is written on it, what it answers
const $ = (id) => document.getElementById(id);
if (!D || !C) { $('badge').textContent = (!D ? 'the city data' : 'city_parts.js') + ' did not load'; throw new Error('blueprint city: ' + (!D ? 'window.BPV3D' : 'window.CITY') + ' is missing'); }
const S = 0.01;                                  // layout pixels -> world units
const PAD = 1.2, GAP = 5, ROW = 70;

const KIND = { event: '#ff5a4f', branch: '#9aa7b8', 'for-loop': '#b77cff', call: '#3d9bff', 'pure-call': '#3fd38a', set: '#21c7a8', 'set-local': '#21c7a8',
  operator: '#8c96a6', 'get-at-index': '#f2c94c', 'make-array': '#f2c94c', 'type-test': '#ff9f43', return: '#ff5a4f' };
const TYPE = (t) => {
  if (!t) return ['#c8d0dc', 0.03];
  if (/^List/.test(t)) return ['#b388ff', 0.05];
  if (t === 'bool') return ['#e04848', 0.022];
  if (t === 'int') return ['#2fe0b0', 0.03];
  if (/^(double|float)$/.test(t)) return ['#9be15d', 0.036];
  if (t === 'Vector') return ['#f5c518', 0.065];
  if (t === 'Rotator') return ['#8fb3ff', 0.065];
  return ['#3d8bff', 0.042];                     // an object reference
};

// ------------------------------------------------------------------------------------------------ renderer, scene, post-processing
const stage = $('stage');
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
stage.appendChild(renderer.domElement);
await renderer.init();
const backend = renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 (this browser offers no WebGPU)';
$('badge').textContent = 'renderer: ' + backend;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#05080f');
scene.fog = new THREE.Fog('#05080f', 90, 260);
const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
try { const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.35; } catch (e) { /* lit by the lights alone */ }
scene.add(new THREE.HemisphereLight('#9fb8ff', '#0b0f1a', 0.7));
const sun = new THREE.DirectionalLight('#ffffff', 1.6);
sun.position.set(-40, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -120; sun.shadow.camera.right = 120; sun.shadow.camera.top = 120; sun.shadow.camera.bottom = -120;
scene.add(sun);

const post = new THREE.PostProcessing(renderer);
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, emissive }));
const glow = bloom(scenePass.getTextureNode('emissive'), 1.15, 0.45, 0.0);
post.outputNode = scenePass.getTextureNode('output').add(glow);

// the ground: a faint grid that fades into the fog
const grid = new THREE.GridHelper(600, 120, '#1c2a44', '#101a2c');
grid.position.y = -6.01;
scene.add(grid);

// ------------------------------------------------------------------------------------------------ text as sprites
function labelSprite(lines, opts) {
  const o = Object.assign({ w: 1024, h: 256, size: 3, bg: 'rgba(10,16,28,0.78)', fg: '#e6ecf7', sub: '#9fb0cc', accent: null, font: 56 }, opts || {});
  const c = document.createElement('canvas');
  c.width = o.w; c.height = o.h;
  const g = c.getContext('2d');
  const r = 26;
  g.fillStyle = o.bg;
  g.beginPath(); g.roundRect(4, 4, o.w - 8, o.h - 8, r); g.fill();
  if (o.accent) { g.fillStyle = o.accent; g.beginPath(); g.roundRect(4, 4, 16, o.h - 8, [r, 0, 0, r]); g.fill(); }
  g.textBaseline = 'middle';
  const lh = o.h / (lines.length + 0.6);
  lines.forEach((t, i) => {
    g.font = (i === 0 ? '600 ' : '400 ') + Math.round(o.font * (i === 0 ? 1 : 0.78)) + 'px Inter, "Segoe UI", sans-serif';
    g.fillStyle = i === 0 ? o.fg : o.sub;
    let s = String(t);
    while (g.measureText(s).width > o.w - 70 && s.length > 4) s = s.slice(0, -2);
    if (s !== String(t)) s = s.slice(0, -1) + '…';
    g.fillText(s, 34, lh * (i + 0.8));
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(m);
  sp.scale.set(o.size, o.size * o.h / o.w, 1);
  sp.renderOrder = 2;
  return sp;
}

// ------------------------------------------------------------------------------------------------ a node's face
/** nodeFace - a node's own face, drawn ON the top of its box the way Blueprint draws a node: a title bar in the node's kind colour
 *  carrying its title and kind, then its line (a statement's pseudo-code; an expression's value and the statement that takes it -
 *  city_parts.faceOf). It lies flat with its top edge away from the camera's home, so it reads the right way up from the overview
 *  and when flown to; it is unlit, so the text keeps its contrast in any light, while the box's own glow (hover, selection, the
 *  replay) frames it. Before 10-28 the box carried nothing and its line floated above it, inside 34 units only. */
const PPU = 200;                                 // face texels per world unit: crisp at the F-focus distance, light on a phone
const SANS = 'Inter, "Segoe UI", sans-serif', MONO = '"JetBrains Mono", Consolas, monospace';
function nodeFace(face, bw, bh, col) {
  const W = Math.min(1024, Math.max(128, Math.round(bw * PPU))), H = Math.min(512, Math.max(48, Math.round(bh * PPU)));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const pad = Math.round(Math.min(W, H) * 0.08 + 4);
  const body = face.lines.length > 0 && H >= 96;  // room for a line under the title bar
  const barH = body ? Math.round(Math.min(H * 0.42, 0.22 * PPU)) : H;
  g.fillStyle = '#10182a';
  g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, col); grad.addColorStop(1, shade(col, 0.35));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, barH);
  g.fillStyle = 'rgba(0,0,0,0.38)';                // darkened, so white reads on the yellow and green bars too
  g.fillRect(0, 0, W, barH);
  g.textBaseline = 'middle';
  // the title leads; the tag (kind and type) is smaller - beside it on a short bar, under it on a tall one (an entry's box)
  const stacked = !body && face.tag && H >= 120;
  let tPx = Math.round(barH * (body ? 0.5 : stacked ? 0.34 : 0.46));
  const tagPx = Math.max(11, Math.round(tPx * 0.62));
  g.font = '500 ' + tagPx + 'px ' + SANS;
  const tagW = face.tag && !stacked ? Math.min(W * 0.35, g.measureText(face.tag).width) : 0;
  const room = W - 2 * pad - (tagW ? tagW + pad * 0.6 : 0);
  g.font = '600 ' + tPx + 'px ' + SANS;
  while (tPx > 12 && g.measureText(face.title).width > room) { tPx--; g.font = '600 ' + tPx + 'px ' + SANS; }
  g.fillStyle = '#ffffff';
  g.fillText(fit(g, face.title, room), pad, stacked ? barH * 0.4 : barH / 2);
  if (face.tag) {
    g.font = '500 ' + tagPx + 'px ' + SANS;
    g.fillStyle = 'rgba(255,255,255,0.78)';
    if (stacked) g.fillText(fit(g, face.tag, W - 2 * pad), pad, barH * 0.74);
    else { g.textAlign = 'right'; g.fillText(fit(g, face.tag, W * 0.35), W - pad, barH / 2); g.textAlign = 'left'; }
  }
  if (body) {
    const lPx = Math.max(12, Math.min(Math.round(0.11 * PPU), Math.round((H - barH) / 3.2)));
    g.font = '400 ' + lPx + 'px ' + MONO;
    g.fillStyle = '#d6def0';
    const rows = wrap(g, face.lines.join('   '), W - 2 * pad, Math.max(1, Math.floor((H - barH - pad) / (lPx * 1.3))));
    rows.forEach((t, i) => g.fillText(t, pad, barH + pad * 0.6 + lPx * 1.3 * (i + 0.5)));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(bw * 0.97, bh * 0.94), new THREE.MeshBasicNodeMaterial({ map: tex }));
  m.rotation.x = -Math.PI / 2;
  m.userData.titleH = tPx * bh * 0.94 / H;        // its title's height in world units: nodeLabels() asks whether it reads from here
  return m;
}
function shade(hex, k) { const n = parseInt(hex.slice(1), 16), f = (s) => Math.round(((n >> s) & 255) * k); return 'rgb(' + f(16) + ',' + f(8) + ',' + f(0) + ')'; }
/** the text cut to a width, ending in an ellipsis when it was cut */
function fit(g, s, w) {
  s = String(s);
  if (g.measureText(s).width <= w) return s;
  while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}
/** a line of code broken where code breaks (after a space, a comma, an open paren, a dot) into at most max rows */
function wrap(g, text, w, max) {
  const rows = [];
  let row = '';
  for (const t of String(text).split(/(?<=[\s,(.])/)) {
    if (row && g.measureText(row + t).width > w) { rows.push(row.trimEnd()); row = t.trimStart(); } else row += t;
  }
  if (row) rows.push(row);
  const kept = rows.slice(0, max).map((s) => fit(g, s, w));
  if (rows.length > max) kept[max - 1] = fit(g, rows[max - 1] + ' ' + rows[max] + ' …', w);   // more text than room: say so
  return kept;
}

// ------------------------------------------------------------------------------------------------ picks: everything drawn answers
/** Picks - every part drawn (city_parts.parts), held with WHAT it is. A solid is hit by the ray; a pipe or an arc within a few
 *  pixels of its curve on screen, being too thin for a ray; the ground - a graph's slab, a class's floor, its parent's - only
 *  when nothing else is under the pointer, so a pipe over an island is still the pipe. byKey finds what was drawn for a part.
 *  cityAudit() holds all of it to parts(D). */
const Picks = { solids: [], lines: [], ground: [], byKey: new Map() };
function register(list, obj, what) {
  obj.userData.what = what;
  obj.userData.tier = list === Picks.solids ? 'solid' : list === Picks.lines ? 'line' : 'ground';   // only a solid glows on hover
  list.push(obj);
  const k = C.keyOf(what);
  if (!Picks.byKey.has(k)) Picks.byKey.set(k, obj);
  return obj;
}
const solid = (obj, what) => register(Picks.solids, obj, what);
const ground = (obj, what) => register(Picks.ground, obj, what);
function line(mesh, what) { mesh.userData.pts = mesh.userData.curve.getSpacedPoints(40); return register(Picks.lines, mesh, what); }

// ------------------------------------------------------------------------------------------------ materials
function stdMat(col, emi, intensity, extra) {
  const m = new THREE.MeshStandardNodeMaterial(Object.assign({ color: new THREE.Color(col), roughness: 0.45, metalness: 0.15 }, extra || {}));
  m.emissive = new THREE.Color(emi || '#000000');
  m.emissiveIntensity = intensity || 0;
  return m;
}
/** an exec pipe: white, with pulses of execution travelling along it; a graph run by a timer pulses fast and hot */
function execMat(rateHz) {
  const m = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color('#dfe6f5'), roughness: 0.3, metalness: 0.1 });
  const speed = float(rateHz ? 2.6 : 0.55);
  const band = smoothstep(0.86, 1.0, fract(uv().x.mul(2.0).sub(time.mul(speed))));
  const hot = color(rateHz ? '#ff5a3c' : '#9fd4ff');
  m.emissiveNode = hot.mul(band.mul(rateHz ? 3.2 : 2.0).add(0.05));
  return m;
}
/** a data pipe, coloured and sized like its type, a slow flow running through it */
function dataMat(col) {
  const m = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(col), roughness: 0.35, metalness: 0.2 });
  const flow = smoothstep(0.7, 1.0, fract(uv().x.mul(4.0).sub(time.mul(0.35))));
  m.emissiveNode = color(col).mul(flow.mul(1.4).add(0.12));
  return m;
}
/** a call made by NAME: dashes marching toward the callee - nothing else in the engine shows this call exists */
function byNameMat() {
  const m = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color('#ff9f43'), roughness: 0.4, metalness: 0.1, transparent: true });
  const dash = step(0.5, fract(uv().x.mul(26.0).sub(time.mul(1.6))));
  m.opacityNode = dash.mul(0.95).add(0.05);
  m.alphaTest = 0.5;
  m.emissiveNode = color('#ff8a2a').mul(dash.mul(2.2));
  return m;
}
/** a message through the interface: quieter than a call - many statements send it */
function msgMat() {
  const m = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color('#1b6b66'), roughness: 0.5, metalness: 0.1, transparent: true, opacity: 0.55 });
  const band = smoothstep(0.9, 1.0, fract(uv().x.mul(1.0).sub(time.mul(0.4))));
  m.emissiveNode = color('#2df0d0').mul(band.mul(1.2).add(0.04));
  return m;
}
function callMat() {
  const m = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color('#47d7ff'), roughness: 0.35, metalness: 0.1 });
  const band = smoothstep(0.8, 1.0, fract(uv().x.mul(1.5).sub(time.mul(0.6))));
  m.emissiveNode = color('#47d7ff').mul(band.mul(2.4).add(0.15));
  return m;
}

function tube(points, radius, mat, segs) {
  const curve = points.length === 2 ? new THREE.LineCurve3(points[0], points[1]) : points.length === 3 ? new THREE.QuadraticBezierCurve3(...points) : new THREE.CubicBezierCurve3(...points);
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, segs || 32, radius, 8, false), mat);
  m.userData.curve = curve;
  return m;
}

// ------------------------------------------------------------------------------------------------ the city: districts and islands
const world = new THREE.Group();
scene.add(world);
const layers = { exec: new THREE.Group(), data: new THREE.Group(), calls: new THREE.Group(), members: new THREE.Group(), questions: new THREE.Group(), hierarchy: new THREE.Group(), labels: new THREE.Group() };
for (const g of Object.values(layers)) world.add(g);
layers.members.visible = false;

const islands = new Map();        // alias -> {G, x0, z0, w, h, slab, nodes: Map(id -> {mesh, pos, n, face}), entry}
// the faces are drawn once, into canvases: the page's own fonts must be in hand first, or a canvas keeps the fallback face for good
await Promise.all([document.fonts.load('600 40px Inter'), document.fonts.load('400 24px "JetBrains Mono"')]);
const byClass = new Map();
for (const G of D.graphs) (byClass.get(G.cls) || byClass.set(G.cls, []).get(G.cls)).push(G);
const districts = [];
let dx = 0;
for (const [cls, graphs] of byClass) {
  // shelf packing: the widest graphs first, rows no wider than ROW
  const sorted = graphs.slice().sort((a, b) => b.w * b.h - a.w * a.h);
  let x = 0, z = 0, rowH = 0, maxW = 0;
  const place = [];
  for (const G of sorted) {
    const w = G.w * S + 2 * PAD, h = G.h * S + 2 * PAD;
    if (x > 0 && x + w > ROW) { x = 0; z += rowH + GAP; rowH = 0; }
    place.push({ G, x, z, w, h });
    x += w + GAP; rowH = Math.max(rowH, h); maxW = Math.max(maxW, x - GAP);
  }
  const depth = z + rowH;
  districts.push({ cls, w: maxW, d: depth, place });
}
// the districts stand in rows no wider than CITY_ROW, each row centred, front to back: a set of many classes (the asteroid shooter's
// nine) once stood in one row 631 units long, framed from beyond the fog, and the city drew black. Pong (109) and Lock-On (115) fit
// one row, as they always stood
const CITY_ROW = 150, ROW_GAP = 24, cityRows = [];
for (const dist of districts) {
  const r = cityRows[cityRows.length - 1];
  if (r && r.w + 26 + dist.w <= CITY_ROW) { dist.x0 = r.w + 26; r.w += 26 + dist.w; r.d = Math.max(r.d, dist.d); r.list.push(dist); }
  else { dist.x0 = 0; cityRows.push({ w: dist.w, d: dist.d, list: [dist] }); }
}
let rowZ = -(cityRows.reduce((s, r) => s + r.d, 0) + ROW_GAP * (cityRows.length - 1)) / 2;
for (const r of cityRows) { for (const dist of r.list) { dist.ox = dist.x0 - r.w / 2; dist.oz = rowZ + r.d / 2 - dist.d / 2; } rowZ += r.d + ROW_GAP; }
for (const dist of districts) {
  const ox = dist.ox, oz = dist.oz;
  const clsInfo = D.classes.find((c) => c.name === dist.cls) || {};
  // the district's own floor, and its engine parent's floor below - the hierarchy, read (oo.js), shown once instead of piped
  const floor = new THREE.Mesh(new RoundedBoxGeometry(dist.w + 6, 0.3, dist.d + 6, 4, 1.2), stdMat('#0d1526', '#1c3a6b', 0.25, { roughness: 0.8 }));
  floor.position.set(ox + dist.w / 2, -0.55, oz + dist.d / 2);
  floor.receiveShadow = true;
  world.add(ground(floor, { kind: 'class', cls: dist.cls }));
  const dl = labelSprite([dist.cls + (clsInfo.parent ? '  :  ' + clsInfo.parent : ''), (clsInfo.fields ? clsInfo.fields.length + ' fields, ' : '') + (clsInfo.methods ? clsInfo.methods.length + ' methods' : '') + (clsInfo.components && clsInfo.components.length ? ', ' + clsInfo.components.length + ' components' : '')], { size: 16, font: 64, accent: '#6cc4ff' });
  dl.position.set(ox + dist.w / 2, 7.5, oz - 4);
  layers.labels.add(solid(dl, { kind: 'class', cls: dist.cls }));
  if (clsInfo.parent) {
    const parent = { kind: 'parent', cls: dist.cls };
    const pf = new THREE.Mesh(new RoundedBoxGeometry(dist.w + 14, 0.25, dist.d + 14, 4, 2), stdMat('#0a101d', '#3b2a6b', 0.35, { transparent: true, opacity: 0.55 }));
    pf.position.set(ox + dist.w / 2, -6, oz + dist.d / 2);
    layers.hierarchy.add(ground(pf, parent));
    const uses = (clsInfo.uses || []).map((u) => u.name).join(', ');
    const pl = labelSprite([clsInfo.parent + ' (engine)', 'the parent, read from what ' + dist.cls + ' uses on itself: ' + uses], { size: 18, font: 54, accent: '#b388ff' });
    pl.position.set(ox + dist.w / 2, -4.2, oz + dist.d + 8);
    layers.hierarchy.add(solid(pl, parent));
    for (const [px, pz] of [[ox, oz], [ox + dist.w, oz], [ox, oz + dist.d], [ox + dist.w, oz + dist.d]]) {
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 5.5, 12), stdMat('#2a2150', '#7d5cff', 0.6, { transparent: true, opacity: 0.6 }));
      pil.position.set(px, -3.3, pz);
      layers.hierarchy.add(solid(pil, parent));
    }
  }
  for (const p of dist.place) buildIsland(p.G, ox + p.x, oz + p.z, p.w, p.h);
}

function buildIsland(G, x0, z0, w, h) {
  const I = { G, x0, z0, w, h, nodes: new Map() };
  islands.set(G.alias, I);
  const graph = { kind: 'graph', alias: G.alias };
  // hot: a graph that runs often - a timer's rate (G.rate), or the engine's Tick and a Delay loop (G.runs, scene_cli.js GraphRuns)
  const hot = !!(G.rate || G.runs);
  const slab = new THREE.Mesh(new RoundedBoxGeometry(w, 0.4, h, 4, 0.5), stdMat('#141e33', hot ? '#ff3b2f' : '#1d3d72', hot ? 0.0 : 0.18, { roughness: 0.55, metalness: 0.25 }));
  slab.position.set(x0 + w / 2, -0.2, z0 + h / 2);
  slab.receiveShadow = true;
  world.add(ground(slab, graph));
  I.slab = slab;
  if (hot) {
    // a graph that runs often swells and burns: a timer's at the rate it states, a Tick or a Delay loop as its data says (READ, never a
    // rate the paste does not hold)
    const rim = new THREE.Mesh(new RoundedBoxGeometry(w + 0.6, 0.2, h + 0.6, 4, 0.6), new THREE.MeshStandardNodeMaterial({ color: new THREE.Color('#40100c') }));
    rim.material.emissiveNode = color('#ff3b2f').mul(sin(time.mul(9.0)).mul(0.5).add(0.6).mul(2.2));
    rim.position.set(x0 + w / 2, -0.38, z0 + h / 2);
    world.add(ground(rim, graph));
    I.rim = rim;
    I.rimPhase = Math.random() * 6;
  }
  const t = labelSprite([G.title || G.alias, (G.kind === 'function' ? 'function' : 'event') + (G.rate ? '  -  runs ' + G.rate.hz + ' times a second (a timer, ' + G.rate.from + ')' : G.runs ? '  -  ' + G.runs.said : '') + '  -  ' + G.cls],
    { size: Math.min(13, Math.max(7, w * 0.5)), font: 60, accent: hot ? '#ff5a4f' : KIND.event });
  t.position.set(x0 + Math.min(w, 13) / 2 + 0.2, 2.6, z0 - 0.6);
  layers.labels.add(solid(t, graph));
  I.title = t;
  // the entry: the event or function node itself, its name on its face
  const first = G.nodes.filter((n) => n.exec).sort((a, b) => a.x - b.x || a.y - b.y)[0];
  const ez = z0 + PAD + (first ? (first.y + first.h / 2) * S : 0.5);
  const entry = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.34, 0.9, 3, 0.12), stdMat(KIND.event, KIND.event, 0.6));
  entry.position.set(x0 + 0.65, 0.17, ez);
  entry.castShadow = true;
  const ef = nodeFace(C.entryFace(G), 1.5, 0.9, hot ? '#ff5a4f' : KIND.event);
  ef.position.y = 0.17 + 0.004;
  entry.add(ef);
  world.add(solid(entry, graph));
  I.entry = { mesh: entry, pos: entry.position.clone(), bw: 1.5, top: 0.17, title: C.entryFace(G).title, col: hot ? '#ff5a4f' : KIND.event, titleH: ef.userData.titleH };
  for (const n of G.nodes) {
    const isStmt = n.id[0] === 's';
    const what = { kind: 'node', alias: G.alias, id: n.id };
    const bw = Math.max(0.5, n.w * S), bh = Math.max(0.35, n.h * S * 0.8);
    const y = isStmt ? 0.15 : 0.08;
    const col = KIND[n.kw] || '#7f8c8d';
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(bw, isStmt ? 0.3 : 0.16, bh, 3, 0.08), stdMat('#1a2338', col, isStmt ? 0.35 : 0.2, { roughness: 0.5 }));
    // its face: the title bar in the kind's colour with its title, then its line, ON the box as Blueprint draws a node
    const face = C.faceOf(G, n);
    const fm = nodeFace(face, bw, bh, col);
    fm.position.y = (isStmt ? 0.15 : 0.08) + 0.004;
    mesh.add(fm);
    mesh.position.set(x0 + PAD + (n.x + n.w / 2) * S, y, z0 + PAD + (n.y + n.h / 2) * S);
    mesh.castShadow = true;
    world.add(solid(mesh, what));
    I.nodes.set(n.id, { mesh, n, pos: mesh.position.clone(), bw, bh, face, top: y, title: face.title, col, titleH: fm.userData.titleH });
    if (isStmt && n.questions.length) {
      // a question the brainstorm raised here: red when only the author can answer it (an INFERRED requirement), amber when the code does
      const open = n.open;
      const b = new THREE.Mesh(new THREE.OctahedronGeometry(open ? 0.32 : 0.22), stdMat(open ? '#ff4d5e' : '#ffb347', open ? '#ff2d40' : '#ffa53a', open ? 2.4 : 0.9));
      b.position.set(mesh.position.x + bw / 2 - 0.25, open ? 1.9 : 1.5, mesh.position.z);
      b.userData.spin = open ? 1.6 : 0.8;
      layers.questions.add(solid(b, what));
      if (open) {
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 8), stdMat('#ff4d5e', '#ff2d40', 1.6, { transparent: true, opacity: 0.6 }));
        beam.position.set(b.position.x, 1.0, b.position.z);
        layers.questions.add(solid(beam, what));
      }
    }
  }
  // the wires the layout drew: exec ABOVE the nodes, data BELOW them; one whose end is not drawn is left to the audit (MISSING)
  G.wires.forEach((wv, i) => {
    const to = I.nodes.get(wv.to);
    const from = wv.from === 'entry' ? { pos: I.entry.pos, bw: 1.5, bh: 0.9 } : I.nodes.get(wv.from);
    if (!to || !from) return;
    const what = { kind: 'wire', alias: G.alias, i: i };
    if (wv.kind === 'exec') {
      const a = new THREE.Vector3(from.pos.x + from.bw / 2, 0.5, from.pos.z), b = new THREE.Vector3(to.pos.x - to.bw / 2, 0.5, to.pos.z);
      const k = Math.max(0.6, Math.abs(b.x - a.x) * 0.45);
      const m = tube([a, new THREE.Vector3(a.x + k, 1.15, a.z), new THREE.Vector3(b.x - k, 1.15, b.z), b], 0.034, execMat(G.rate ? G.rate.hz : (G.runs && G.runs.hz) || 0), 40);
      layers.exec.add(line(m, what));
      (I.execWires || (I.execWires = [])).push(m);
    } else {
      const src = from.n;
      const [col, rad] = TYPE(src && src.t);
      const a = new THREE.Vector3(from.pos.x + from.bw / 2, 0.06, from.pos.z), b = new THREE.Vector3(to.pos.x - to.bw / 2, 0.06, to.pos.z);
      const k = Math.max(0.4, Math.abs(b.x - a.x) * 0.4);
      layers.data.add(line(tube([a, new THREE.Vector3(a.x + k, -0.05, a.z), new THREE.Vector3(b.x - k, -0.05, b.z), b], rad, dataMat(col), 28), what));
    }
  });
}

// calls between graphs: a direct call is a cyan arc; a call by NAME marches in orange
function nodePos(ref) {
  const [alias, id] = ref.split('#');
  const I = islands.get(alias);
  if (!I) return null;
  if (!id) return I.entry.pos;
  const n = I.nodes.get(id);
  return n ? n.pos : null;
}
D.calls.forEach((c, i) => {
  if (!c.to) return;
  const a = nodePos(c.from), I = islands.get(c.to);
  if (!a || !I) return;                          // an end not drawn: left to the audit, which names it MISSING
  const what = { kind: 'call', i: i };
  const b = I.entry.pos;
  const d = a.distanceTo(b);
  const mid = new THREE.Vector3((a.x + b.x) / 2, 3 + d * 0.22, (a.z + b.z) / 2);
  const m = tube([new THREE.Vector3(a.x, 0.6, a.z), mid, new THREE.Vector3(b.x, 0.6, b.z)], c.how === 'by name' ? 0.06 : 0.045, c.how === 'by name' ? byNameMat() : callMat(), 64);
  layers.calls.add(line(m, what));
  if (c.how === 'by name') {
    const l = labelSprite(['by name: "' + c.name + '"', c.method + ' - no reference an editor can find'], { size: 5, font: 52, accent: '#ff9f43' });
    l.position.copy(mid).add(new THREE.Vector3(0, 0.9, 0));
    layers.calls.add(solid(l, what));
  }
});

// the interface every message goes through (oo.js read it from the message nodes), and each statement sending it - one Blueprint
// message node reached on two paths is written as two statements, so the count of each is said (city_parts.messagesOf)
D.interfaces.forEach((I, k) => {
  const what = { kind: 'interface', name: I.name };
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.16, 16, 64), stdMat('#0f2f2f', '#2df0d0', 1.6));
  const centre = new THREE.Vector3((k - (D.interfaces.length - 1) / 2) * 9, 9, Math.min(...districts.map((d) => d.oz)) - 8);
  ring.position.copy(centre);
  ring.rotation.x = Math.PI / 2.3;
  layers.calls.add(solid(ring, what));
  const ms = C.messagesOf(D, I);
  const l = labelSprite(['interface ' + I.name, I.methods.join('; ') + '  -  ' + I.callers.length + ' message nodes, written as ' + ms.length + ' statements; who implements it is not in the pastes'], { size: 12, font: 52, accent: '#2df0d0' });
  l.position.copy(centre).add(new THREE.Vector3(0, 2.6, 0));
  layers.calls.add(solid(l, what));
  for (const m of ms) {
    const p = nodePos(m.ref);
    if (!p) continue;                            // left to the audit
    const t = tube([new THREE.Vector3(p.x, 0.6, p.z), new THREE.Vector3((p.x + centre.x) / 2, centre.y + 2, (p.z + centre.z) / 2), centre.clone()], 0.016, msgMat(), 48);
    layers.calls.add(line(t, { kind: 'message', name: I.name, ref: m.ref }));
  }
});

// member flows (off by default): every statement that writes a member, to each statement that names it - all of them (a cap of 91
// once left 40 of the 131 undrawn and unsaid)
const fieldType = new Map();
for (const c of D.classes) for (const f of c.fields) fieldType.set(f.name.replace(/\s+/g, '_'), f.type);
let flows = 0;
for (const p of C.parts(D)) {
  if (p.kind !== 'member') continue;
  const a = nodePos(p.from), b = nodePos(p.to);
  if (!a || !b) continue;                        // left to the audit
  const [col, rad] = TYPE(fieldType.get(p.name.split('.').pop()));
  const mid = new THREE.Vector3((a.x + b.x) / 2, 1.6 + a.distanceTo(b) * 0.12, (a.z + b.z) / 2);
  layers.members.add(line(tube([new THREE.Vector3(a.x, 0.3, a.z), mid, new THREE.Vector3(b.x, 0.3, b.z)], rad * 0.6, dataMat(col), 32), p));
  flows++;
}

// ------------------------------------------------------------------------------------------------ layer toggles
const LAYERS = [['exec', 'Exec (above)', '#dfe6f5'], ['data', 'Data (below)', '#9be15d'], ['calls', 'Calls and interface', '#47d7ff'], ['members', 'Member flows', '#b388ff'],
  ['questions', 'Questions', '#ff4d5e'], ['hierarchy', 'Parent classes', '#7d5cff'], ['labels', 'Labels', '#e6ecf7']];
$('layers').innerHTML = LAYERS.map(([k, t, c]) => '<label><input type="checkbox" data-layer="' + k + '"' + (layers[k].visible ? ' checked' : '') + '><span class="sw" style="background:' + c + '"></span>' + t + '</label>').join('');
$('layers').addEventListener('change', (e) => { const k = e.target.dataset.layer; if (k) layers[k].visible = e.target.checked; });

// ------------------------------------------------------------------------------------------------ members panel ("My Blueprint")
$('memberlist').innerHTML = D.classes.map((c) => '<div class="cls"><b>' + esc(c.name) + (c.parent ? ' <i style="color:var(--dim);font-weight:400">: ' + esc(c.parent) + '</i>' : '') + '</b><small>' +
  (c.parent ? 'uses ' + (c.uses || []).map((u) => esc(u.name)).join(', ') + ' on itself' : 'parent: ' + esc(c.parentWhy)) + '</small>' +
  c.methods.map((m) => '<button class="item" data-fly="' + esc(m.alias) + '">' + (m.kind === 'function' ? 'fn ' : 'ev ') + esc(m.title || m.name) + '</button>').join('') +
  c.components.map((m) => '<button class="item" data-member="' + esc(m.name) + '"><i>comp</i> ' + esc(m.name) + ' <i>' + esc(m.type) + '</i></button>').join('') +
  c.fields.map((f) => '<button class="item" data-member="' + esc(f.name) + '"><i>' + esc(f.type) + '</i> ' + esc(f.name) + '</button>').join('') + '</div>').join('');
// embedded in a page (a frame) or on a narrow screen the city opens with its side panels folded, so the city is what is seen first;
// Panels unfolds them at any width (below 820 px a media rule used to hide them in both states, so the button did nothing there)
document.body.dataset.panels = window.self !== window.top || window.innerWidth <= 820 ? '0' : '1';
$('panels').addEventListener('click', () => { document.body.dataset.panels = document.body.dataset.panels === '1' ? '0' : '1'; });
// the details close (on a narrow screen they cover the lower third of the city): the opening help comes back
const HELP = $('detailbody').innerHTML;
$('dclose').addEventListener('click', () => { $('detailbody').innerHTML = HELP; $('details').dataset.empty = '1'; viewOffset(); });
// the paste sets this page offers (view3d.html), the one drawn chosen; another is a reload with ?set=
$('setsel').innerHTML = (window.CITY_SETS || []).map(([k, t]) => '<option value="' + esc(k) + '"' + (k === window.CITY_SET ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
$('setsel').addEventListener('change', (e) => { location.search = '?set=' + encodeURIComponent(e.target.value); });
document.querySelector('#members h3').addEventListener('click', () => { $('members').dataset.closed = $('members').dataset.closed === '1' ? '0' : '1'; });
$('memberlist').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.fly) flyToIsland(b.dataset.fly);
  if (b.dataset.member) showMember(b.dataset.member);
});

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

// ------------------------------------------------------------------------------------------------ camera: home, fly to, keys
// home frames the whole city: its bounding box, seen from above and in front at the distance the field of view needs
const cityBox = new THREE.Box3();
for (const I of islands.values()) cityBox.expandByObject(I.slab);
const cityC = cityBox.getCenter(new THREE.Vector3()), cityS = cityBox.getSize(new THREE.Vector3());
const fitD = (Math.max(cityS.x / camera.aspect, cityS.z) / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
// the fog starts no nearer than what the view looks at, every frame (fogFollows, in the loop): 90 and 260 suit a one-row city seen
// from home in a wide window (Pong's home 81 away, Lock-On's 86 at 1400x900: as before), and anything framed from further off pushes
// them out. A fixed fog drew the asteroid shooter's four-row city BLACK twice: framed from beyond it at 1400 wide before the rows,
// and at 800 wide, where the game panel leaves the city a strip and the frame stands 540 away (measured 10-28)
const FOG = { near: scene.fog.near, far: scene.fog.far };
function fogFollows() {
  const d = camera.position.distanceTo(controls.target);
  scene.fog.near = Math.max(FOG.near, d);
  scene.fog.far = Math.max(FOG.far, d * 3);
}
const home = { pos: cityC.clone().add(new THREE.Vector3(0, fitD * 0.82, fitD * 0.62)), target: cityC.clone() };
camera.position.copy(home.pos);
controls.target.copy(home.target);
let flight = null;
function flyTo(target, distance) {
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.35) dir.y = 0.6;
  dir.normalize();
  flight = { t: 0, from: camera.position.clone(), fromT: controls.target.clone(), to: target.clone().add(dir.multiplyScalar(distance)), toT: target.clone() };
}
/** the distance at which a w by h stretch of ground fills the part of the view the details leave free (down the right of a wide
 *  screen), with a margin: a graph flown to is seen whole, with its boxes' labels (at 0.9 of its size the right half of a long graph
 *  sat under the details, measured on Pong 10-28) */
function fitDistance(w, h) {
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), f = freeRect();
  const free = Math.max(0.3, (f.right - f.left) / window.innerWidth), freeH = Math.max(0.3, (f.bottom - f.top) / window.innerHeight);
  return Math.max(12, w * 0.54 / (t * camera.aspect * free), h * 0.54 / (t * freeH));
}
function flyToIsland(alias) {
  const I = islands.get(alias);
  if (!I) return toast('no graph named ' + alias);
  flyTo(new THREE.Vector3(I.x0 + I.w / 2, 0, I.z0 + I.h / 2), fitDistance(I.w, I.h + 3));   // + its title, standing over the back edge
  fillPaths(alias);
}
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') { if (e.key === 'Enter' && e.target.id === 'cmdin') runCommand(e.target.value, 'typed'); return; }
  // while a game runs its keys are the game's (W A S D fly the camera otherwise): held, and pressed once per press; its pause key pauses
  const gk = e.key.toLowerCase();
  if (live.G && live.gameKeys.has(gk)) { e.preventDefault(); if (!e.repeat) live.pressed.add(gk); live.keys.add(gk); return; }
  if (live.G && gk === GAME.pauseKey) { e.preventDefault(); pauseGame(); return; }
  keys.add(e.key.toLowerCase());
  if (e.key === '/') { e.preventDefault(); $('cmdin').focus(); }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === 'f' && selected) flyTo(selected.pos, 7);
  if (e.key === '[') stepReplay(-1);
  if (e.key === ']') stepReplay(1);
});
window.addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); live.keys.delete(e.key.toLowerCase()); });

// ------------------------------------------------------------------------------------------------ picking and details
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
const pv = new THREE.Vector3();
let selected = null, hover = null, downAt = null;
const shown = (o) => { for (let p = o; p; p = p.parent) if (p.visible === false) return false; return true; };
/** pickAt - what is under a point on the screen (client pixels): a solid, else a pipe within 7 px, else the ground; null over nothing */
function pickAt(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const s = ray.intersectObjects(Picks.solids.filter(shown), false)[0];
  if (s) return s.object;
  const l = nearLine(cx - r.left, cy - r.top, r.width, r.height, 7);
  if (l) return l;
  const g = ray.intersectObjects(Picks.ground.filter(shown), false)[0];
  return g ? g.object : null;
}
/** the pipe or arc whose curve, as drawn on the screen, passes nearest a point - within so many pixels */
function nearLine(px, py, w, h, within) {
  let best = null, bestD = within;
  for (const m of Picks.lines) {
    if (!shown(m)) continue;
    let ax = null, ay = 0;
    for (const p of m.userData.pts) {
      pv.copy(p).project(camera);
      if (pv.z > 1) { ax = null; continue; }     // behind the camera
      const bx = (pv.x + 1) / 2 * w, by = (1 - pv.y) / 2 * h;
      if (ax !== null) { const d = segDist(px, py, ax, ay, bx, by); if (d < bestD) { bestD = d; best = m; } }
      ax = bx; ay = by;
    }
  }
  return best;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
/** a mesh's glow from its state alone - its own base, the replay's light, the hover, the selection - never stacked by hand (the
 *  hover used to save the selection's glow as the base, so a node once selected stayed lit) */
function light(o) {
  if (!o || !o.isMesh || !o.material || o.material.emissiveIntensity === undefined) return;
  const u = o.userData;
  if (u.baseI === undefined) u.baseI = o.material.emissiveIntensity;
  o.material.emissiveIntensity = (u.lit === 'now' ? 3.2 : u.lit === 'past' ? 1.3 : u.baseI) + (u.heat || 0) * 2.6 + (o === hover && u.tier === 'solid' ? 0.9 : 0) +
    (selected && o === selected.mesh ? 1.6 : 0);     // heat: the running game ran it just now (liveGame)
}
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; $('tip').hidden = true; });
renderer.domElement.addEventListener('wheel', () => { $('tip').hidden = true; }, { passive: true });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  const hit = pickAt(e.clientX, e.clientY);
  if (hit) show(hit.userData.what);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  const hit = pickAt(e.clientX, e.clientY);
  const was = hover;
  hover = hit;
  light(was); light(hit);
  renderer.domElement.style.cursor = hit ? 'pointer' : 'default';
  // the hover names what is under the pointer, whatever it is (a mouse only: a touch has no hover, its tap opens the details)
  if (hit && e.pointerType === 'mouse') {
    $('tip').textContent = C.nameOf(D, hit.userData.what);
    $('tip').style.left = Math.min(e.clientX + 14, window.innerWidth - $('tip').offsetWidth - 8) + 'px';
    $('tip').style.top = (e.clientY + 18) + 'px';
    $('tip').hidden = false;
  } else $('tip').hidden = true;
});
renderer.domElement.addEventListener('pointerleave', () => { $('tip').hidden = true; });

/** show - a click's answer: a node or a graph opens its details (tabs, chain, requirements); any other part what city_parts says */
function show(what) {
  if (what.kind === 'node') return select(what.alias, what.id);
  if (what.kind === 'graph') return select(what.alias, null);
  $('detailbody').innerHTML = C.explain(D, what);
  $('details').dataset.empty = '0';
  viewOffset();
}
/** a part by its key (a link in the details): shown, and flown to - the middle of what was drawn for it */
function goKey(key) {
  const o = Picks.byKey.get(key);
  if (!o) return toast('nothing is drawn for ' + key);
  const w = o.userData.what;
  show(w);
  if (w.kind === 'node') return flyTo(selected.pos, 8);
  if (w.kind === 'graph') return flyToIsland(w.alias);
  // back far enough to see it whole with its title (the interface's ring at 10 units was all ring and the title a wall of letters)
  const box = new THREE.Box3().setFromObject(o);
  flyTo(o.userData.curve ? o.userData.curve.getPoint(0.5) : box.getCenter(new THREE.Vector3()), Math.max(18, box.getSize(new THREE.Vector3()).length() * 1.4));
}

// ------------------------------------------------------------------------------------------------ the Unreal reference, in 2D
/** the selected graph's paste drawn the way the Blueprint editor draws it (view/unreal2d.js, data from scene_cli.js): its author's own
 *  node positions, pins and wires, the nodes the selected statement came from lit. A node clicked there selects, here, what it became */
let paste2d = null;              // the paste the 2D view shows (node names repeat across pastes: a duplicated Blueprint keeps them)
function open2d() {
  if (!window.UE2D || !D.bp2d || !D.bp2d.length) return toast('the 2D reference is not in this page');
  const alias = selected ? selected.alias : D.graphs[0].alias;
  const G = D.graphs.find((g) => g.alias === alias);
  const P = D.bp2d.find((p) => p.name === G.paste);
  if (!P) return toast('no paste is recorded for ' + alias);
  paste2d = P;
  const lit = new Set();
  if (selected && selected.n) {
    for (const u of selected.n.units) { const m = /^(\S+) \([^,]+, ([^:]+):\d+\)$/.exec(u); if (m && m[2] === P.name + '.t3d') lit.add(m[1]); }
  } else for (const n of P.model.nodes) if (n.refs.includes(alias)) lit.add(n.name);
  $('u2title').textContent = P.title + ' - as the Blueprint editor draws it';
  $('u2note').textContent = 'From the paste: its author\'s node positions, pins and wires; titles in the engine\'s formats, each function\'s from its header; the editor\'s colours. ' +
    'Ours: box sizes, curves, grid.' + (P.model.notes.length ? ' ' + P.model.notes.length + ' title(s) by the engine\'s naming rule.' : '') +
    // nothing selected yet lights the graph's own event: the first press, before any click (it threw on `selected.id` - found on the
    // published page, 10-28; every test had selected something first)
    (lit.size ? ' Lit: what ' + (selected && selected.id ? alias + '#' + selected.id : alias) + ' came from.' : '');
  $('u2link').href = P.url;
  $('u2body').innerHTML = window.UE2D.svg(P.model, { highlight: lit });
  // each node gets a ring the running game lights when it runs what that node became (liveGame)
  live.u2 = [];
  for (const g of $('u2body').querySelectorAll('g[data-node]')) {
    const n = P.model.nodes.find((x) => x.name === g.dataset.node);
    if (!n || !n.refs.length || !n.w) continue;
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('class', 'fire');
    for (const [k, v] of [['x', -4], ['y', -4], ['width', n.w + 8], ['height', n.h + 8], ['rx', 10]]) r.setAttribute(k, v);
    r.style.opacity = 0;
    g.appendChild(r);
    live.u2.push({ r: r, refs: n.refs });
  }
  $('ue2d').hidden = false;
  const first = [...$('u2body').querySelectorAll('g[data-node]')].find((g) => lit.has(g.dataset.node));
  if (first && $('u2body').dataset.fit !== '1') first.scrollIntoView({ block: 'center', inline: 'center' });
}
$('open2d').addEventListener('click', open2d);
$('u2close').addEventListener('click', () => { $('ue2d').hidden = true; });
$('u2fit').addEventListener('click', () => { const b = $('u2body'); b.dataset.fit = b.dataset.fit === '1' ? '0' : '1'; $('u2fit').textContent = b.dataset.fit === '1' ? '1:1' : 'Fit'; });
$('u2body').addEventListener('click', (e) => {
  const g = e.target.closest('g[data-node]');
  if (!g) return;
  const n = paste2d && paste2d.model.nodes.find((x) => x.name === g.dataset.node);
  if (!n || !n.refs.length) return toast(g.dataset.node + ' became no statement of its own (written inline, or never reached)');
  const [a, id] = n.refs[0].split('#');
  $('ue2d').hidden = true;
  select(a, id || null);
  if (id) flyTo(selected.pos, 8); else flyToIsland(a);
});

let codeTab = 'blueprint';
function select(alias, id) {
  const I = islands.get(alias);
  if (!I) return;
  const was = selected && selected.mesh;
  const N = id ? I.nodes.get(id) : null;
  selected = N ? { alias, id, mesh: N.mesh, pos: N.pos, n: N.n } : { alias, id: null, mesh: I.entry.mesh, pos: I.entry.pos, n: null };
  light(was); light(selected.mesh);
  fillPaths(alias);
  renderDetails();
}

/** the chain above a statement: each step citing it, its use case, the use case's parents up to the epic */
function chainOf(label) {
  const out = [];
  let uc = D.usecases.find((u) => u.legs.some((l) => l.label === label));
  const leg = uc && uc.legs.find((l) => l.label === label);
  if (!uc) return out;
  out.push('<div class="chain"><b>' + esc(label) + '</b> ' + esc(leg.text) + '</div>');
  while (uc) {
    out.push('<div class="chain"><span>in</span> ' + esc(uc.id) + ' ' + esc(uc.name) + ' <span>(' + esc(uc.level) + ')</span></div>');
    uc = uc.parent ? D.usecases.find((u) => u.id === uc.parent.uc) : null;
  }
  return out;
}
function reqHtml(id) {
  const r = D.requirements.find((x) => x.id === id);
  if (!r) return '';
  return '<div class="req' + (r.kind === 'inferred' ? ' ir' : '') + '"><b>' + esc(r.id) + '</b> ' + esc(r.text) + (r.kind === 'inferred' ? '<br><span style="color:var(--dim)">a question for the author: ' + esc(r.why) + '</span>' : '') + '</div>';
}
function renderDetails() {
  const G = D.graphs.find((g) => g.alias === selected.alias);
  const n = selected.n;
  const tabs = ['blueprint', 'code', 'pseudo', 'graph code'].map((t) => '<button class="btn" data-tab="' + t + '" data-on="' + (codeTab === t ? 1 : 0) + '">' + t + '</button>').join('');
  let body = '<h3>' + esc(G.title || G.alias) + '</h3><div class="kv"><span>class</span><span>' + esc(G.cls) + '</span><span>graph</span><span>' + esc(G.alias) + ' (' + esc(G.kind) + ')</span>' +
    (G.rate ? '<span>runs</span><span style="color:var(--bad)">' + G.rate.hz + ' times a second, by a timer at ' + esc(G.rate.from) + '</span>' : '') +
    (G.runs ? '<span>runs</span><span style="color:var(--bad)">' + esc(G.runs.said) + '</span>' : '') + '</div>';
  if (n) {
    const stmt = n.id[0] === 's';
    // an expression is cited through the statement that takes its value: its chain is that statement's, said as such
    const via = stmt ? [n] : C.feeds(G, n.id).map((id) => G.nodes.find((x) => x.id === id)).filter(Boolean);
    const steps = [...new Set(via.flatMap((x) => x.steps))], reqs = [...new Set(via.flatMap((x) => x.reqs))];
    body += '<h3 style="margin-top:12px">' + esc(n.title) + ' <span style="color:var(--dim);text-transform:none;letter-spacing:0">' + esc(selected.alias + '#' + n.id) + '</span></h3>';
    if (!stmt) body += '<div class="chain">An expression (' + esc(C.faceOf(G, n).tag) + '): its value is taken by ' + (via.map((x) => '<button class="item" style="display:inline;width:auto" data-key="' + esc(C.keyOf({ kind: 'node', alias: G.alias, id: x.id })) + '">' + esc(x.id + ' ' + x.title) + '</button>').join(', ') || 'no statement') + '</div>';
    body += '<div class="tabs">' + tabs + '</div>';
    if (codeTab === 'blueprint') body += '<div class="kv"><span>Blueprint' + (stmt ? '' : ' (its statement\'s)') + '</span><span>' + (n.units.length ? n.units.map(esc).join('<br>') : 'written inline into a statement') + '</span></div>';
    if (codeTab === 'code') body += '<pre class="code">' + esc(n.cs || n.text) + '</pre>';
    if (codeTab === 'pseudo') body += '<pre class="code">' + esc(n.text) + '</pre>';
    if (codeTab === 'graph code') body += codeWithHighlight(G, n);
    body += '<h3 style="margin-top:12px">The use case step it ' + (stmt ? 'realises' : 'serves, through ' + esc(via.map((x) => x.id).join(', ') || 'no statement')) + '</h3>' + (steps.length ? steps.map((l) => chainOf(l).join('')).join('<hr style="border:0;border-top:1px solid var(--line)">') : '<div class="chain">no step cites it</div>');
    body += '<h3 style="margin-top:12px">Requirements it serves</h3>' + (reqs.map(reqHtml).join('') || '<div class="chain">none</div>');
    if (n.questions.length) body += '<h3 style="margin-top:12px">The brainstorm here</h3>' + n.questions.map((qid) => { const q = D.questions.find((x) => x.id === qid); return '<div class="q"><b>' + esc(q.id) + '</b> ' + esc(q.text) + '<br>answered by ' + q.answers.map((a) => '<b style="color:' + (/^IR-/.test(a) ? 'var(--bad)' : 'var(--ok)') + '">' + esc(a) + '</b>').join(', ') + '</div>'; }).join('');
  } else {
    body += '<h3 style="margin-top:12px">The whole graph</h3><div class="kv"><span>Blueprint</span><span>' + (G.entryUnits.map(esc).join('<br>') || '-') + '</span></div>' + codeWithHighlight(G, null);
  }
  body += '<h3 style="margin-top:12px">Bookmark</h3><div style="display:flex;gap:6px"><input id="marknote" placeholder="a note for this place" style="flex:1;min-width:0;background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:8px;color:var(--fg);padding:5px 8px;font:12px var(--sans)"><button class="btn" id="marksave">Save</button></div>';
  $('detailbody').innerHTML = body;
  $('details').dataset.empty = '0';
  $('marksave').addEventListener('click', saveMark);
  viewOffset();
}

// bookmarks (Unreal's Bookmarks panel; NV-6): a place - the selection and the camera - with a note; kept in this browser only
const MARKS = 'bpv3d.marks.' + D.meta.title;
function loadMarks() { try { return JSON.parse(localStorage.getItem(MARKS) || '[]'); } catch (e) { return []; } }
function saveMark() {
  if (!selected) return;
  const m = loadMarks();
  m.push({ alias: selected.alias, id: selected.id, note: $('marknote').value.trim() || (selected.alias + (selected.id ? '#' + selected.id : '')), cam: camera.position.toArray(), tgt: controls.target.toArray() });
  try { localStorage.setItem(MARKS, JSON.stringify(m)); } catch (e) { toast('bookmarks cannot be kept in this browser'); }
  drawMarks();
  toast('bookmarked');
}
function drawMarks() {
  const m = loadMarks();
  if (!m.length) return;
  $('marks').innerHTML = m.map((b, i) => '<button class="item" data-mark="' + i + '">' + esc(b.note) + ' <i>' + esc(b.alias + (b.id ? '#' + b.id : '')) + '</i></button>').join('');
}
$('marks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mark]');
  if (!b) return;
  const k = loadMarks()[+b.dataset.mark];
  select(k.alias, k.id);
  flight = { t: 0, from: camera.position.clone(), fromT: controls.target.clone(), to: new THREE.Vector3().fromArray(k.cam), toT: new THREE.Vector3().fromArray(k.tgt) };
});
drawMarks();
/** the graph's C#, the selected statement's line lit; click a line to select its node - Blueprint and code, both ways */
function codeWithHighlight(G, n) {
  const lines = G.cs.split('\n');
  const map = codeLines(G);
  const at = n ? map.get(n.id) : -1;
  return '<pre class="code">' + lines.map((l, i) => { const id = [...map].find(([, v]) => v === i); return '<span class="ln' + (i === at ? ' hl' : '') + '"' + (id ? ' data-sel="' + id[0] + '"' : '') + '>' + esc(l) + '</span>'; }).join('\n') + '</pre>';
}
const codeMaps = new Map();
function codeLines(G) {
  if (codeMaps.has(G.alias)) return codeMaps.get(G.alias);
  const lines = G.cs.split('\n').map((l) => l.trim());
  const m = new Map();
  let from = 0;
  const stmts = G.nodes.filter((n) => n.id[0] === 's' && n.cs).sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10));
  for (const n of stmts) {
    const want = n.cs.trim();
    let k = lines.findIndex((l, i) => i >= from && (l === want || l.startsWith(want)));
    if (k < 0) k = lines.findIndex((l) => l === want || l.startsWith(want));
    if (k >= 0) { m.set(n.id, k); from = k + 1; }
  }
  codeMaps.set(G.alias, m);
  return m;
}
$('details').addEventListener('click', (e) => {
  const k = e.target.closest('[data-key]');
  if (k) { goKey(k.dataset.key); return; }
  const t = e.target.closest('[data-tab]');
  if (t) { codeTab = t.dataset.tab; renderDetails(); return; }
  const l = e.target.closest('[data-sel]');
  if (l && selected) { select(selected.alias, l.dataset.sel); flyTo(selected.pos, 8); }
});
function showMember(name) {
  const key = name.replace(/\s+/g, '_');
  const m = D.members.find((x) => x.name === key || x.name.endsWith('.' + key));
  layers.members.visible = true;
  document.querySelector('[data-layer="members"]').checked = true;
  const html = '<h3>Member ' + esc(name) + '</h3>' + (m ? '<div class="kv"><span>written at</span><span>' + m.writes.map(esc).join('<br>') + '</span><span>named at</span><span>' + (m.reads.map(esc).join('<br>') || '-') + '</span></div>' : '<div class="chain">no statement in these graphs writes it</div>');
  $('detailbody').innerHTML = html;
  $('details').dataset.empty = '0';
  if (m && m.writes[0]) { const p = nodePos(m.writes[0]); if (p) flyTo(p, 16); }
}

// ------------------------------------------------------------------------------------------------ replay: a path, step by step
// the replay's pulse rides ABOVE the step it lights, smaller and softer than it was, so the node's face under it stays readable
const PULSE_Y = 1.35;
const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), stdMat('#ffffff', '#9fe0ff', 2.6));
pulse.visible = false;
scene.add(pulse);
const pulseLight = new THREE.PointLight('#8fd6ff', 6, 9, 1.6);
pulse.add(pulseLight);
let replay = { alias: null, path: null, k: 0, t: 0, playing: false, lit: [] };
function fillPaths(alias) {
  if (replay.alias === alias) return;
  replay = { alias, path: null, k: 0, t: 0, playing: false, lit: [] };
  const ps = D.paths.filter((p) => p.graph === alias);
  $('pathsel').innerHTML = ps.map((p, i) => '<option value="' + i + '">' + esc(p.ref) + ' - ' + esc(meaning(p)) + '</option>').join('');
  setPath(0);
}
function meaning(p) {
  if (!p.means) return 'not covered';
  if (!Array.isArray(p.means)) return 'cannot happen: ' + p.means.excluded;
  return p.means.join(', ');
}
function setPath(i) {
  unlight();
  const ps = D.paths.filter((p) => p.graph === replay.alias);
  replay.path = ps[i] || null;
  replay.k = 0; replay.t = 0;
  $('scrub').max = replay.path ? Math.max(0, replay.path.stmts.length - 1) : 0;
  $('scrub').value = 0;
  showStep();
}
function unlight() { for (const m of replay.lit) { m.userData.lit = null; light(m); } replay.lit = []; }
function showStep() {
  const p = replay.path;
  if (!p) { $('ticker').textContent = 'no path'; pulse.visible = false; return; }
  const I = islands.get(p.graph);
  unlight();
  for (let j = 0; j <= replay.k; j++) {
    const N = I.nodes.get(p.stmts[j]);
    if (!N) continue;
    N.mesh.userData.lit = j === replay.k ? 'now' : 'past';
    light(N.mesh);
    replay.lit.push(N.mesh);
  }
  const N = I.nodes.get(p.stmts[replay.k]);
  if (N) { pulse.visible = true; pulse.position.set(N.pos.x, PULSE_Y, N.pos.z); }
  const n = N ? N.n : null;
  const outs = p.outs.filter((o) => o.split(':')[0] === p.graph + '#' + p.stmts[replay.k]);
  $('ticker').innerHTML = 'step <b>' + (replay.k + 1) + '/' + p.stmts.length + '</b> &nbsp;' + esc(p.graph + '#' + p.stmts[replay.k]) + ' &nbsp;<b>' + esc(n ? n.text : '') + '</b>' +
    (outs.length ? ' &nbsp;goes <b>' + esc(outs[0].split(':')[1]) + '</b>' : '') + (n && n.steps.length ? ' &nbsp;- serves ' + esc(n.steps.join(', ')) + ' [' + esc(n.reqs.join(', ')) + ']' : '');
  $('scrub').value = replay.k;
}
function stepReplay(d) { if (!replay.path) return; replay.k = Math.max(0, Math.min(replay.path.stmts.length - 1, replay.k + d)); replay.t = 0; showStep(); }
function togglePlay() {
  // no path chosen: the selected graph's first, else the first graph's - and none at all is said, never played (measured 10-29: "play
  // 2" on a one-path graph left no path, and Play threw on it)
  if (!replay.path) { if (!replay.alias) fillPaths(D.graphs[0].alias); setPath(0); }
  if (!replay.path) { toast('no path to replay here'); return; }
  replay.playing = !replay.playing; $('play').textContent = replay.playing ? 'Pause' : 'Play'; if (replay.playing && replay.k >= replay.path.stmts.length - 1) { replay.k = 0; showStep(); } }
$('pathsel').addEventListener('change', (e) => setPath(+e.target.value));
$('scrub').addEventListener('input', (e) => { replay.k = +e.target.value; replay.t = 0; showStep(); });
$('play').addEventListener('click', togglePlay);
$('prev').addEventListener('click', () => stepReplay(-1));
$('next').addEventListener('click', () => stepReplay(1));

// ------------------------------------------------------------------------------------------------ commands, typed or spoken
// A command reaches the city two ways, typed into the bar or said to the Mic, and both go through heard() and parse(): heard() turns
// what a recognizer wrote into the command a person meant, parse() reads it into one action, and runCommand() does it and says
// what it did. heard()'s rewrites are each one a recognizer was MEASURED making on this page (tools/dictation_check.py,
// results/DICTATION.md: Chrome 156 wrote "fly to" as "flight" and Random_Roam as "random room"), or plain form: case,
// punctuation, number words. A name is matched on its letters and digits alone, so Random_Roam is reachable by saying it.
let ragIndex = null;
function rag() {
  if (ragIndex || !window.RAG) return ragIndex;
  const trace = { graphs: D.graphs.map((G) => ({ alias: G.alias, kind: G.kind, title: G.title, name: G.name, statements: G.nodes.filter((n) => n.id[0] === 's').map((n) => ({ id: n.id, text: n.text })) })), questions: D.questions };
  const answers = {};
  for (const q of D.questions) answers[q.id] = q.answers;
  ragIndex = window.RAG.index(trace, { classes: D.classes }, { usecases: D.usecases, requirements: D.requirements, answers: answers, asks: D.asks });
  return ragIndex;
}
/** a name as its letters and digits, lower case: "Random_Roam", "random roam" and "RandomRoam" are one name to a listener */
const bare = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** a name the way a person says it: words split at case changes and underscores, a bracketed qualifier dropped
 *  ("OnSeePawn(PawnSensing)" -> "on see pawn") - what the city offers as an example to say */
const sayable = (s) => String(s || '').replace(/\(.*?\)/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
/** heard - what was typed or recognized, in the form parse() reads */
function heard(raw) {
  let c = String(raw || '').toLowerCase().replace(/[.,!?;:"]+/g, ' ').replace(/\s+/g, ' ').trim();
  c = c.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g, (w) => String(NUMBER_WORDS[w]));
  // measured (results/DICTATION.md): "fly to distance to Frank" -> "flight distance to Frank", "fly to random roam" -> "flight to random room"
  c = c.replace(/^flight\s+(?:to\s+)?/, 'fly to ');
  c = c.replace(/^(?:please\s+)?(?:take me|bring me|jump|zoom in|head)\s+to\s+/, 'fly to ');
  return c;
}
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}
/** findByName - a part a command names: a graph (by its name, its title or its name as said), the interface, a class, a statement
 *  (by id or by its text); last, the NEAREST name, for a word a recognizer heard slightly wrong - within a fifth of the name's letters,
 *  and only when no other name is as near. A near match is said as one, so a person sees what was taken */
function findByName(s) {
  const t = bare(s);
  if (!t) return null;
  const g = D.graphs.find((G) => bare(G.alias) === t || bare(sayable(G.alias)) === t) || D.graphs.find((G) => bare(G.alias).includes(t) || bare(G.title).includes(t));
  if (g) return { alias: g.alias };
  const iface = D.interfaces.find((x) => bare(x.name) === t);
  if (iface) return { key: C.keyOf({ kind: 'interface', name: iface.name }) };
  const cls = [...new Set(D.graphs.map((G) => G.cls))].find((x) => bare(x) === t);
  if (cls) return { key: C.keyOf({ kind: 'class', cls: cls }) };
  for (const G of D.graphs) for (const n of G.nodes) if (bare(G.alias + '#' + n.id) === t) return { alias: G.alias, id: n.id };
  for (const G of D.graphs) for (const n of G.nodes) if (n.id[0] === 's' && bare(n.text).includes(t)) return { alias: G.alias, id: n.id };
  const all = D.graphs.map((G) => ({ k: bare(G.alias), label: G.alias, hit: { alias: G.alias } }))
    .concat(D.interfaces.map((x) => ({ k: bare(x.name), label: x.name, hit: { key: C.keyOf({ kind: 'interface', name: x.name }) } })))
    .concat([...new Set(D.graphs.map((G) => G.cls))].map((x) => ({ k: bare(x), label: x, hit: { key: C.keyOf({ kind: 'class', cls: x }) } })));
  const scored = all.map((x) => ({ x: x, d: editDistance(t, x.k) })).sort((a, b) => a.d - b.d);
  const best = scored[0], next = scored.find((y) => y.x.label !== best.x.label);
  if (best && best.d <= Math.max(1, Math.floor(best.x.k.length / 5)) && (!next || next.d > best.d)) return Object.assign({ near: best.x.label }, best.x.hit);
  return null;
}
/** what to say here: this set's own names, so an example never names a graph another set has */
function examples() {
  const G0 = D.graphs.find((G) => G.kind === 'event') || D.graphs[0];
  return ['fly to ' + sayable(G0.alias), 'play 2', 'next', 'questions', 'show the code', 'whole code', 'ask what ' + sayable(G0.alias) + ' does'];
}
/** parse - one command into one action, or null; nothing runs here, so a recognizer's alternatives can be tried in turn */
function parse(raw) {
  const c = heard(raw);
  let m;
  if (!c) return null;
  if (/^(?:show |open |read )?(?:me )?(?:the )?(?:whole|entire|full|all(?: the)?) (?:blueprint )?(?:as )?code\b/.test(c)) return { kind: 'whole code' };
  if (/^(?:go |step )?(?:back|previous|backward|backwards)\b/.test(c)) return { kind: 'step', d: -1 };
  if (/^(?:go |step )?(?:next|forward)\b/.test(c)) return { kind: 'step', d: 1 };
  if (/^(?:pause|stop)\b/.test(c)) return { kind: 'pause' };
  if (/^(?:play|replay|run)\b/.test(c)) return { kind: 'play', n: (m = /(\d+)/.exec(c)) ? +m[1] : null };
  if (/^(?:show |open )?(?:me )?(?:the )?(?:code|c#|c sharp|csharp)(?=\s|$)/.test(c)) return { kind: 'tab', tab: 'graph code' };
  if (/^(?:show |open )?(?:me )?(?:the )?(?:blueprint|blue print|nodes)\b/.test(c)) return { kind: 'tab', tab: 'blueprint' };
  if (/^(?:show |open )?(?:me )?(?:the )?pseudo/.test(c)) return { kind: 'tab', tab: 'pseudo' };
  if (/^(?:overview|home|reset|zoom out)\b/.test(c)) return { kind: 'overview' };
  if (/^(?:show |open |list )?(?:me )?(?:the )?(?:open )?questions\b/.test(c)) return { kind: 'questions' };
  if (/^(?:ask|why|what|how|which|where|who|when|does|is|can)\b/.test(c)) return { kind: 'ask', q: c };
  if ((m = /^(?:fly|go|show|open|find)\s+(?:me\s+)?(?:to\s+)?(?:the\s+)?(.+)$/.exec(c))) { const hit = findByName(m[1]); return hit ? { kind: 'fly', hit: hit } : { kind: 'unknown name', name: m[1] }; }
  const hit = findByName(c);
  return hit ? { kind: 'fly', hit: hit } : null;
}
/** runCommand - parse it, do it, and say what was done: a spoken command says what was heard first, so a person can tell a
 *  recognizer's slip from the city's */
function runCommand(raw, how) {
  const said = String(raw || '').trim();
  if (!said) return;
  const p = parse(said);
  const out = act(p);
  toast((how === 'spoken' ? 'heard "' + said + '": ' : '') + (out || 'not a command: try ' + examples().map((e) => '"' + e + '"').join(', ')));
}
function firstStatement(alias) { const G = D.graphs.find((g) => g.alias === alias); const n = G && G.nodes.find((x) => x.id[0] === 's'); return n ? n.id : null; }
function act(p) {
  if (!p) return null;
  if (p.kind === 'unknown name') return 'nothing named "' + p.name + '" here: try ' + examples().slice(0, 1).map((e) => '"' + e + '"').join('');
  if (p.kind === 'fly') {
    const hit = p.hit, near = hit.near ? ' (the nearest name)' : '';
    if (hit.key) { goKey(hit.key); return 'flying to ' + hit.key.split('|').slice(1).join(' ') + near; }
    if (hit.id) { select(hit.alias, hit.id); flyTo(selected.pos, 8); } else { select(hit.alias, null); flyToIsland(hit.alias); }
    return 'flying to ' + (hit.id ? hit.alias + '#' + hit.id : hit.alias) + near;
  }
  if (p.kind === 'whole code') {
    if (!window.CITY_CODE) return 'this copy of the city has no whole-code page';
    const url = window.CITY_CODE.replace('{set}', window.CITY_SET || '');
    // the city is framed by the site's own city page (same origin): the code page replaces that page; a frame the host forbids to
    // navigate its parent opens the code page in itself
    try { window.top.location.href = new URL(url, location.href).href; } catch (e) { location.href = url; }
    return 'opening the whole Blueprint as code';
  }
  if (p.kind === 'play') {
    const ps = replay.alias ? D.paths.filter((x) => x.graph === replay.alias) : [];
    if (p.n && replay.alias && (p.n < 1 || p.n > ps.length)) return replay.alias + ' has ' + ps.length + ' path' + (ps.length === 1 ? '' : 's') + ': say "play 1"' + (ps.length > 1 ? ' to "play ' + ps.length + '"' : '');
    if (p.n && replay.alias) { setPath(p.n - 1); $('pathsel').value = p.n - 1; }
    if (!replay.playing) togglePlay();
    return 'replaying ' + (replay.path ? replay.path.graph + ' path ' + (+$('pathsel').value + 1) : 'a path');
  }
  if (p.kind === 'pause') { if (replay.playing) togglePlay(); return 'paused'; }
  if (p.kind === 'step') { if (!replay.path) return 'no path to step: fly to a graph and say "play" first'; stepReplay(p.d); return 'step ' + (replay.k + 1) + ' of ' + replay.path.stmts.length; }
  if (p.kind === 'tab') {
    codeTab = p.tab;
    if (!selected) return 'showing ' + p.tab + ' once something is selected: fly to a graph first';
    // the tabs belong to a statement: a graph selected opens its first one, so the view the command names is on screen
    if (!selected.n) { const id = firstStatement(selected.alias); if (id) select(selected.alias, id); else renderDetails(); } else renderDetails();
    return 'showing ' + p.tab + ' for ' + selected.alias + (selected.id ? '#' + selected.id : '');
  }
  if (p.kind === 'overview') { flight = { t: 0, from: camera.position.clone(), fromT: controls.target.clone(), to: home.pos.clone(), toT: home.target.clone() }; return 'back to the overview'; }
  if (p.kind === 'questions') {
    const open = D.questions.filter((q) => q.answers.some((a) => /^IR-/.test(a)));
    $('detailbody').innerHTML = '<h3>Questions only the author can answer: ' + open.length + ' of ' + D.questions.length + '</h3>' + open.map((q) => '<div class="q" data-goq="' + esc(q.refs[0] || '') + '"><b>' + esc(q.id) + '</b> ' + esc(q.text) + '<br>-> ' + q.answers.map(esc).join(', ') + '</div>').join('');
    $('details').dataset.empty = '0';
    return open.length + ' questions only the author can answer';
  }
  if (p.kind === 'ask') {
    const I = rag();
    if (!I) return 'the retrieval layer is not loaded';
    const c = p.q;
    const r = window.RAG.retrieve(I, c, 3000);
    $('detailbody').innerHTML = '<h3>Asked: ' + esc(c) + '</h3><p style="color:var(--dim);font-size:11px">The pieces of the trace this question touches (view/rag.js) - what a model would be handed instead of the files, about ' + Math.round(r.context.length / 3.3) + ' tokens.</p><pre class="code" style="white-space:pre-wrap">' + esc(r.context) + '</pre>';
    $('details').dataset.empty = '0';
    const firstCode = r.ids.find((id) => /#s\d+$/.test(id));
    if (firstCode) { const [a, id] = firstCode.split('#'); select(a, id); flyTo(selected.pos, 10); renderDetails(); $('detailbody').insertAdjacentHTML('afterbegin', '<h3>Asked: ' + esc(c) + '</h3><pre class="code" style="white-space:pre-wrap;max-height:30vh">' + esc(r.context) + '</pre>'); }
    return 'answered from the trace: ' + r.ids.length + ' pieces';
  }
  return null;
}
$('go').addEventListener('click', () => runCommand($('cmdin').value, 'typed'));
// the command hint names this set's own graphs, as said (it once named Lock-On's in every set)
$('cmdin').placeholder = examples().slice(0, 5).join(' / ');
$('help').insertAdjacentHTML('beforeend', '<br><br><b>Say or type</b> a command: ' + examples().map((e) => '<code>' + esc(e) + '</code>').join(', ') +
  '. To speak one, press <b>Mic</b> (Chrome, Edge and Safari hear speech; elsewhere the button says so, and typing does the same).');
$('detailbody').addEventListener('click', (e) => { const q = e.target.closest('[data-goq]'); if (q && q.dataset.goq) { const [a, id] = q.dataset.goq.split('#'); select(a, id); flyTo(selected.pos, 8); } });
// the whole Blueprint as code, one click away: the site's code page for this set, where the page that hosts the city has one
if (window.CITY_CODE) { $('allcode').href = window.CITY_CODE.replace('{set}', window.CITY_SET || ''); $('allcode').hidden = false; }
// dictation: the browser's own speech recognition, where it is offered; said plainly where it is not
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) { $('mic').disabled = true; $('mic').title = 'this browser offers no speech recognition: type the command'; $('mic').textContent = 'Mic (n/a)'; }
else {
  const rec = new SR();
  let answered = false;
  rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 3;
  // the first alternative the city understands is taken; the recognizer's own first choice when none is
  rec.onresult = (e) => {
    answered = true;
    const alts = [...e.results[0]].map((a) => a.transcript.trim()).filter(Boolean);
    if (!alts.length) return toast('heard nothing clear: say it again, or type it');
    const said = alts.find((a) => { const p = parse(a); return p && p.kind !== 'unknown name'; }) || alts[0];
    $('cmdin').value = said;
    runCommand(said, 'spoken');
  };
  rec.onnomatch = () => { answered = true; toast('did not catch that: say it again, or type it'); };
  rec.onerror = (e) => { answered = true; toast('speech: ' + (e.error === 'not-allowed' ? 'the microphone was refused here - type the command' : e.error === 'no-speech' ? 'heard nothing - press Mic and speak, or type it' : e.error)); };
  rec.onstart = () => { answered = false; };
  rec.onend = () => { $('mic').dataset.on = '0'; if (!answered) toast('heard nothing: press Mic and speak, or type it'); };
  $('mic').addEventListener('click', () => { try { rec.start(); $('mic').dataset.on = '1'; toast('listening...'); } catch (err) { toast('speech: ' + err.message); } });
}

let toastT = 0;
function toast(s) { $('toast').textContent = s; $('toast').dataset.on = '1'; toastT = performance.now() + 2600; }

// ------------------------------------------------------------------------------------------------ the game: the Blueprint, running
/** liveGame - the set's own game (view/games/<game>.js) played on the set's converted graphs (view/run.js running D.ngl), every node
 *  lit as it runs, in the city and in Unreal 2D, so a person watches the Blueprint run while the game plays.
 *  What the game DOES is the paste's code; the engine under it - the court, the sizes, the Speed values, the keys, the computer
 *  player - is authored, and the panel lists each such value as authored. A node run every frame (a Tick, an input axis) glows
 *  steadily; one an event runs flashes, and the panel names what it did and the requirement it serves. A fault in the converted
 *  code stops the game and is shown, never stepped over. */
const gameSet = (window.CITY_SETS || []).find((x) => x[0] === window.CITY_SET);
const GAME = gameSet && gameSet[2] && window.CITY_GAMES ? window.CITY_GAMES[gameSet[2]] : null;
// the keys a game takes, the one that pauses it, its panel line and its touch mapping are the game's own (view/games/<game>.js)
const live = { G: null, paused: false, keys: new Set(), pressed: new Set(), gameKeys: new Set(GAME ? GAME.keyset : []), heat: new Map(), heat2d: new Map(),
  acc: 0, last: null, shown: 0, u2: [], touch: null, error: null, runs: new Map() };
const byGraphName = new Map(D.graphs.map((G) => [G.name, G]));
const everyFrame = (G) => /\.ReceiveTick$/.test(G.name) || /^InputAxis /.test(G.title || '');
function onRun(name, id) {
  const G = byGraphName.get(name);
  if (!G) throw new Error('the game ran ' + name + ', a graph this city does not draw');
  const I = islands.get(G.alias);
  const N = id === 'entry' ? I.entry : I.nodes.get(id);
  if (!N) throw new Error('the game ran ' + name + '#' + id + ', a node this city does not draw');
  live.heat.set(N.mesh, 1);
  // a graph's runs, counted here: a game that opens a level makes a new machine, and the count must outlive it
  if (id === 'entry') { live.heat2d.set(G.alias, 1); live.runs.set(G.name, (live.runs.get(G.name) || 0) + 1); }
  else if (id[0] === 's') { live.heat2d.set(G.alias + '#' + id, 1); if (!everyFrame(G)) live.last = { G: G, n: N.n }; }
}
function startGame() {
  if (!GAME) return toast('this set has no game');
  if (live.G) return;
  const graphs = [];
  for (const [f, text] of Object.entries(D.ngl || {})) graphs.push(...window.NGL.parse(text, f));
  // reset before the game is made: making it opens its first level, whose BeginPlay events run (and are counted) at once
  live.paused = false; live.acc = 0; live.error = null; live.last = null; live.runs.clear(); live.pressed.clear();
  live.G = GAME.create({ graphs: graphs, seed: window.CITY_GAME_SEED || (Date.now() % 100000) + 1, onNode: onRun });
  $('game').hidden = false;
  $('gamebtn').hidden = true;
  document.body.dataset.game = '1';
  $('gtitle').textContent = GAME.title + ': its converted Blueprint, running';
  $('gkeys').textContent = GAME.keys;
  $('gpause').textContent = 'Pause';
  $('gnow').innerHTML = 'The Blueprint runs as you play: every node it runs lights up in the city, and in Unreal 2D.';
  $('gmadebody').innerHTML = madeOf();
  viewOffset();
  flyTo(cityC.clone(), fitDistance(cityS.x + 8, cityS.z + 10));
}
function stopGame() {
  live.G = null;
  $('game').hidden = true;
  $('gamebtn').hidden = !GAME;
  delete document.body.dataset.game;
  for (const m of live.heat.keys()) { m.userData.heat = 0; light(m); }
  live.heat.clear(); live.heat2d.clear();
  for (const u of live.u2) u.r.style.opacity = 0;
  viewOffset();
  // back to the whole city, as it opens without a game
  flight = { t: 0, from: camera.position.clone(), fromT: controls.target.clone(), to: home.pos.clone(), toT: home.target.clone() };
}
function pauseGame() { live.paused = !live.paused; $('gpause').textContent = live.paused ? 'Resume' : 'Pause'; }
/** what runs is the paste's and what the engine under it is - each authored value listed by the game itself */
function madeOf() {
  const byCls = new Map();
  for (const G of D.graphs) (byCls.get(G.cls) || byCls.set(G.cls, []).get(G.cls)).push(G.title || G.alias);
  return '<p style="margin:6px 0 2px"><b>The paste\'s, run as converted</b> - every behaviour you see:</p><ul style="margin:0;padding-left:18px">' +
    [...byCls].map(([c, gs]) => '<li>' + esc(c) + ': ' + gs.map(esc).join(', ') + '</li>').join('') + '</ul>' +
    '<p style="margin:8px 0 2px"><b>This page\'s, authored</b> - the engine the pastes do not carry:</p><ul style="margin:0;padding-left:18px">' +
    GAME.authored.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>';
}
function stepGame(dt) {
  if (!live.G) return;
  if (!live.paused && !live.error) {
    live.acc = Math.min(live.acc + dt, 0.25);
    const input = new Set(live.keys);
    input.touch = live.touch;
    input.pressed = live.pressed;
    try {
      // a press is the first step's to see, once: kept for a frame with no step, cleared after one
      while (live.acc >= 1 / 60) { live.G.step(1 / 60, input); live.acc -= 1 / 60; input.pressed = live.pressed = new Set(); }
    } catch (e) {                                    // a fault in the converted code: the game stops, and says so
      live.error = e;
      $('gnow').innerHTML = '<b style="color:var(--bad)">The converted code stopped:</b> ' + esc(e.message);
      console.error('blueprint game stopped', e);
    }
  }
  const c = $('gcan'), r = c.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio, 2);
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  live.G.draw(ctx, r.width, r.height);
  // what ran glows, and fades in about a third of a second
  const k = Math.exp(-dt / 0.3);
  for (const [m, h] of live.heat) { m.userData.heat = h; light(m); if (h * k < 0.03) { live.heat.delete(m); m.userData.heat = 0; light(m); } else live.heat.set(m, h * k); }
  if (!$('ue2d').hidden) for (const u of live.u2) u.r.style.opacity = Math.max(0, ...u.refs.map((x) => live.heat2d.get(x) || 0)).toFixed(2);
  for (const [x, h] of live.heat2d) { if (h * k < 0.03) live.heat2d.delete(x); else live.heat2d.set(x, h * k); }
  if (performance.now() - live.shown > 250 && !live.error) {
    live.shown = performance.now();
    $('gwho').textContent = live.G.who();
    $('gruns').innerHTML = D.graphs.map((G) => '<span title="' + esc(G.name) + '">' + esc(G.alias) + (everyFrame(G) ? ' (every frame)' : '') + '</span><span>' +
      (live.runs.get(G.name) || 0).toLocaleString('en-US') + ' runs</span>').join('');
    if (live.last) {
      const n = live.last.n;
      $('gnow').innerHTML = '<b>' + esc(live.last.G.alias + '#' + n.id) + '</b> just ran: ' + esc(n.text) +
        (n.steps.length ? '<br>it serves ' + esc(n.steps.join(', ')) + (n.reqs.length ? ' [' + esc(n.reqs.join(', ')) + ']' : '') : '');
    }
  }
}
// the canvas takes a finger or a held mouse button; what it means is the game's (GAME.touch: Pong a paddle's place, Asteroids an aim)
function touchAt(e) {
  const v = live.G && live.G.view;
  if (!v) return;
  const r = $('gcan').getBoundingClientRect();
  live.touch = GAME.touch(v, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
}
$('gcan').addEventListener('pointerdown', (e) => { $('gcan').setPointerCapture(e.pointerId); touchAt(e); });
$('gcan').addEventListener('pointermove', (e) => { if (e.buttons) touchAt(e); });
$('gcan').addEventListener('pointerup', () => { live.touch = null; });
$('gcan').addEventListener('pointercancel', () => { live.touch = null; });
$('gamebtn').addEventListener('click', startGame);
$('gclose').addEventListener('click', stopGame);
$('gpause').addEventListener('click', pauseGame);

// ------------------------------------------------------------------------------------------------ the boxes' titles, where they read
/** nodeLabels - each box's title where a person can read it (the published Pong city of 10-28 read as boxes with no labels).
 *  Every box carries its face, but a face lies flat on a box a few tenths of a unit deep: from the opening view its
 *  title is under a pixel, and flown to its graph it is about 7 px and under the glow (measured on the published page). So while a
 *  face's title would show smaller than LEGIBLE, the box's title is written over the box in screen space at a size that reads, as a
 *  map writes its towns: statements first, then expressions, the biggest boxes first, the type sized to the box and the text cut to
 *  half again its width; each on its box, else just above or below it; never over another label, a title standing in the city or a
 *  panel. An entry is named by its graph's title, which stands over it and says the same. Close in, the face reads by itself and
 *  takes over. labels() says which boxes read - by their face, a label or their graph's title - and where each label went. */
const LEGIBLE = 12, LABEL_MIN_BOX = 10, LABEL_MAX_W = 220;       // px
const lcan = document.createElement('canvas');
lcan.id = 'labels';
stage.appendChild(lcan);
const lg = lcan.getContext('2d');
const boxes = [];
for (const I of islands.values()) {
  boxes.push({ id: I.G.alias + '#entry', rank: 0, B: I.entry, sign: I.title });
  for (const [id, N] of I.nodes) boxes.push({ id: I.G.alias + '#' + id, rank: id[0] === 's' ? 1 : 2, B: N });
}
const LB = { sig: '', placed: [], reads: [], small: 0 };
const lv = new THREE.Vector3(), lw = new THREE.Vector3();
function toScreen(p, w, h) { lv.copy(p).project(camera); return lv.z > 1 ? null : [(lv.x + 1) / 2 * w, (1 - lv.y) / 2 * h]; }
/** a title sprite's rectangle on the screen: a label never goes over one */
function spriteRect(o, w, h) {
  const c = o.getWorldPosition(lw), s = toScreen(c, w, h);
  if (!s) return null;
  const k = (h / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / -c.applyMatrix4(camera.matrixWorldInverse).z;
  return [s[0] - o.scale.x / 2 * k, s[1] - o.scale.y / 2 * k, s[0] + o.scale.x / 2 * k, s[1] + o.scale.y / 2 * k];
}
function nodeLabels(force) {
  const w = lcan.clientWidth, h = lcan.clientHeight, dpr = Math.min(window.devicePixelRatio, 2), o0 = lcan.getBoundingClientRect();
  // the panels over the city (the bar, the layers, the members, the details, the replay): a box under one is out of sight, and a
  // label is never put under one; the pointer's tip and the toast come and go, and are not panels
  const panels = [...document.querySelectorAll('.glass:not(#tip):not(#toast)')].filter((el) => el.getClientRects().length).map((el) => {
    const r = el.getBoundingClientRect(); return [r.left - o0.left, r.top - o0.top, r.right - o0.left, r.bottom - o0.top]; });
  const sig = camera.matrixWorld.elements.join() + camera.projectionMatrix.elements.join() + w + 'x' + h + layers.labels.visible + layers.calls.visible + layers.hierarchy.visible + panels.join();
  if (!force && sig === LB.sig) return LB;
  LB.sig = sig;
  if (lcan.width !== Math.round(w * dpr) || lcan.height !== Math.round(h * dpr)) { lcan.width = Math.round(w * dpr); lcan.height = Math.round(h * dpr); }
  lg.setTransform(dpr, 0, 0, dpr, 0, 0);
  lg.clearRect(0, 0, w, h);
  LB.placed = []; LB.reads = []; LB.titled = []; LB.small = 0; LB.hidden = 0;
  const on = layers.labels.visible;                // off, only what the faces say by themselves is counted
  const under = (x, y) => panels.some((q) => x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3]);
  const taken = panels.slice();
  for (const L of [layers.labels, layers.calls, layers.hierarchy]) if (L.visible) for (const o of L.children) if (o.isSprite) { const r = spriteRect(o, w, h); if (r) taken.push(r); }
  const want = [];
  for (const b of boxes) {
    const B = b.B, p = B.mesh.position, y = p.y + B.top;
    const c = toScreen(lw.set(p.x, y, p.z), w, h);
    if (!c || c[0] < 0 || c[0] > w || c[1] < 0 || c[1] > h) continue;                      // not in view
    if (under(c[0], c[1])) { LB.hidden++; continue; }                                         // under a panel: out of sight
    const t = toScreen(lw.set(p.x, y, p.z - B.titleH), w, h);
    if (t && Math.hypot(t[0] - c[0], t[1] - c[1]) >= LEGIBLE) { LB.reads.push(b.id); continue; }   // its face reads by itself
    if (!on) continue;
    if (b.sign) {                                                                               // an entry: its graph's title says it
      const s = toScreen(b.sign.getWorldPosition(lw), w, h);
      if (s && s[0] >= 0 && s[0] <= w && s[1] >= 0 && s[1] <= h && !under(s[0], s[1])) { LB.titled.push(b.id); continue; }
    }
    const l = toScreen(lw.set(p.x - B.bw / 2, y, p.z), w, h), r = toScreen(lw.set(p.x + B.bw / 2, y, p.z), w, h);
    const across = l && r ? Math.hypot(r[0] - l[0], r[1] - l[1]) : 0;
    if (across < LABEL_MIN_BOX) { LB.small++; continue; }                                       // too far off to own a label
    want.push({ b, c, across, left: Math.min(l[0], r[0]), right: Math.max(l[0], r[0]) });
  }
  if (!on) return LB;
  want.sort((a, b) => a.b.rank - b.b.rank || b.across - a.across);
  lg.textBaseline = 'middle';
  for (const { b, c, across, left, right } of want) {
    const B = b.B, px = across >= 120 ? 12 : across >= 60 ? 11 : 10, lh = px + 6;
    lg.font = '600 ' + px + 'px ' + SANS;
    const text = fit(lg, B.title, Math.min(LABEL_MAX_W, Math.max(72, across * 1.5)) - 12);
    if (text !== String(B.title) && text.length < 7) continue;                                 // cut to a stub that says nothing
    const lwd = Math.ceil(lg.measureText(text).width) + 12;
    // on the box, then over it and under it, then a row further out; centred, then from the box's left edge, then to its right edge
    const at = [c[0] - lwd / 2, left, right - lwd].flatMap((x) => [[x, c[1] - lh / 2], [x, c[1] - lh - 6], [x, c[1] + 6], [x, c[1] - 2 * lh - 8], [x, c[1] + lh + 8]]).find(([x, y]) =>
      x >= 0 && y >= 0 && x + lwd <= w && y + lh <= h && !taken.some((q) => x < q[2] + 2 && x + lwd > q[0] - 2 && y < q[3] + 2 && y + lh > q[1] - 2));
    if (!at) continue;
    taken.push([at[0], at[1], at[0] + lwd, at[1] + lh]);
    LB.placed.push({ id: b.id, text: text, px: px, x: Math.round(at[0]), y: Math.round(at[1]), w: lwd, h: lh });
    lg.fillStyle = 'rgba(8,13,24,0.86)';
    lg.beginPath(); lg.roundRect(at[0], at[1], lwd, lh, 4); lg.fill();
    lg.fillStyle = B.col;
    lg.beginPath(); lg.roundRect(at[0], at[1], 3, lh, [4, 0, 0, 4]); lg.fill();
    lg.fillStyle = '#ffffff';
    lg.fillText(text, at[0] + 7, at[1] + lh / 2 + 0.5);
  }
  return LB;
}

// ------------------------------------------------------------------------------------------------ the loop
const clock = new THREE.Clock();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
$('sub').textContent = D.meta.title + ' by ' + D.meta.author + ' (UE ' + D.meta.ue + ', blueprintue.com) - ' + D.graphs.length + ' graphs, ' + D.graphs.reduce((s, G) => s + G.nodes.length, 0) + ' nodes, ' + D.paths.length + ' paths, ' + D.questions.length + ' questions';
/** the part of the screen the panels leave the city: open details cover the right side of a wide screen (a sheet over the lower
 *  middle of a narrow one), a running game the left side (the top of a narrow one) */
function freeRect() {
  const W = window.innerWidth, H = window.innerHeight, narrow = W <= 820;
  const d = $('details').dataset.empty !== '1' ? $('details').getBoundingClientRect() : null, g = $('game').hidden ? null : $('game').getBoundingClientRect();
  const f = { left: 0, right: W, top: 0, bottom: H };
  if (narrow) { if (d) f.bottom = d.top; if (g) f.top = g.bottom; } else { if (d) f.right = d.left - 12; if (g) f.left = g.right + 12; }
  return f;
}
/** the view is shifted to the middle of the free part, so what was flown to stays in sight (on a wide screen the details once hid
 *  the right half of a graph flown to, and the labels its boxes needed with it) */
function viewOffset() {
  const W = window.innerWidth, H = window.innerHeight, f = freeRect();
  const ox = W / 2 - (f.left + f.right) / 2, oy = H / 2 - (f.top + f.bottom) / 2;
  if (ox || oy) camera.setViewOffset(W, H, ox, oy, W, H); else camera.clearViewOffset();
}
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); viewOffset(); });
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  if (flight) {
    flight.t = Math.min(1, flight.t + dt / 1.1);
    const k = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - Math.pow(-2 * flight.t + 2, 3) / 2;
    camera.position.lerpVectors(flight.from, flight.to, k);
    controls.target.lerpVectors(flight.fromT, flight.toT, k);
    if (flight.t >= 1) flight = null;
  }
  if (keys.size) {
    // the speed follows how far the view stands from what it looks at: a fixed 16 a second crept from the asteroid shooter's game
    // view, 225 units out, so W looked as if it did nothing (10-28); a third of the distance a second crosses that city in about
    // two seconds (half of it overshot the whole city in 1.5 s, measured); up close it stays 16, Shift still runs
    const sp = Math.max(16, camera.position.distanceTo(controls.target) * 0.3) * (keys.has('shift') ? 2.5 : 1) * dt;
    camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    right.crossVectors(fwd, camera.up).normalize();
    const mv = new THREE.Vector3();
    if (keys.has('w') || keys.has('arrowup')) mv.add(fwd);
    if (keys.has('s') || keys.has('arrowdown')) mv.sub(fwd);
    if (keys.has('d') || keys.has('arrowright')) mv.add(right);
    if (keys.has('a') || keys.has('arrowleft')) mv.sub(right);
    if (keys.has('e')) mv.y += 1;
    if (keys.has('q')) mv.y -= 1;
    mv.multiplyScalar(sp);
    camera.position.add(mv); controls.target.add(mv);
  }
  controls.update();
  fogFollows();
  for (const q of layers.questions.children) if (q.userData.spin) q.rotation.y += dt * q.userData.spin;
  if (replay.playing && replay.path) {
    replay.t += dt;
    if (replay.t > 0.75) { replay.t = 0; if (replay.k < replay.path.stmts.length - 1) { replay.k++; showStep(); } else { togglePlay(); } }
    else if (replay.k < replay.path.stmts.length - 1) {
      const I = islands.get(replay.path.graph);
      const a = I.nodes.get(replay.path.stmts[replay.k]), b = I.nodes.get(replay.path.stmts[replay.k + 1]);
      if (a && b) { const u = replay.t / 0.75; pulse.position.set(a.pos.x + (b.pos.x - a.pos.x) * u, PULSE_Y + Math.sin(u * Math.PI) * 0.8, a.pos.z + (b.pos.z - a.pos.z) * u); }
    }
  }
  if (toastT && performance.now() > toastT) { $('toast').dataset.on = '0'; toastT = 0; }
  stepGame(dt);
  post.render();
  nodeLabels();
});
// ------------------------------------------------------------------------------------------------ the audit
/** cityAudit - what was drawn, held to what the data says is drawn (city_parts.parts): MISSING is a part nothing was drawn for,
 *  EXTRA a pick whose part the data does not list, LOOSE a mesh or sprite in the world that answers as no part (a thing a person
 *  can see and cannot ask about), BLANK a node whose face has no title. The city published on 10-28 had 148 blank faces and every
 *  expression node, pipe, call, title and floor loose; this is the check that would have said so before a reader did. */
function cityAudit() {
  const want = new Set(C.parts(D).map(C.keyOf));
  const missing = [...want].filter((k) => !Picks.byKey.has(k));
  const extra = [...Picks.byKey.keys()].filter((k) => !want.has(k));
  const loose = [];
  world.traverse((o) => {
    if (!o.isMesh && !o.isSprite) return;
    let p = o;
    while (p && p !== world && !p.userData.what) p = p.parent;
    if (!p || p === world) loose.push(o.type + ' ' + (o.geometry ? o.geometry.type : ''));
  });
  const blank = [];
  for (const I of islands.values()) for (const [id, N] of I.nodes) if (!N.face || !String(N.face.title).trim()) blank.push(I.G.alias + '#' + id);
  return { parts: want.size, drawn: Picks.byKey.size, missing: missing, extra: extra, loose: loose, blank: blank, ok: !missing.length && !extra.length && !loose.length && !blank.length };
}
const audit = cityAudit();
// short on the bar (the command box keeps its room), whole in the badge's tooltip
$('badge').textContent = backend.split(' ')[0] + '  ·  ' + (audit.ok ? audit.parts + ' parts, all clickable' : 'AUDIT FAILED');
$('badge').title = 'renderer: ' + backend + '\naudit: ' + audit.parts + ' parts in the data, ' + audit.drawn + ' drawn and registered for a hover and a click; ' +
  audit.missing.length + ' missing, ' + audit.extra.length + ' extra, ' + audit.loose.length + ' loose, ' + audit.blank.length + ' blank';
if (!audit.ok) { $('badge').style.color = 'var(--bad)'; console.error('blueprint city audit FAILED', JSON.stringify(audit)); }

/** a point on the screen (client pixels) where a click lands on this part, or null when none is in view or every one is covered */
function screenOf(key) {
  const o = Picks.byKey.get(key);
  if (!o) return null;
  const r = renderer.domElement.getBoundingClientRect();
  let pts;
  if (o.userData.pts) pts = o.userData.pts.slice(3, -3);
  else if (o.isSprite) pts = [o.getWorldPosition(new THREE.Vector3())];
  else {
    const b = new THREE.Box3().setFromObject(o), s = b.getSize(new THREE.Vector3());
    pts = [b.getCenter(new THREE.Vector3())];
    for (const fx of [0.25, 0.5, 0.75]) for (const fz of [0.25, 0.5, 0.75]) pts.push(new THREE.Vector3(b.min.x + s.x * fx, b.max.y, b.min.z + s.z * fz));
  }
  for (const p of pts) {
    pv.copy(p).project(camera);
    if (pv.z > 1 || Math.abs(pv.x) > 0.97 || Math.abs(pv.y) > 0.97) continue;
    const x = Math.round(r.left + (pv.x + 1) / 2 * r.width), y = Math.round(r.top + (1 - pv.y) / 2 * r.height);
    if (document.elementFromPoint(x, y) !== renderer.domElement) continue;   // a panel covers it there
    const hit = pickAt(x, y);
    if (hit && C.keyOf(hit.userData.what) === key) return [x, y];
  }
  return null;
}
// what a test (tools/test_real.py) and a person at the console can ask: the audit, again after a change; a key under a point; where
// on the screen a part can be clicked; the parts drawn, by kind; the world, so a planted mesh can prove the audit still fails
window.__city = { islands: islands.size, nodes: [...islands.values()].reduce((s, I) => s + I.nodes.size, 0), exec: layers.exec.children.length, data: layers.data.children.length,
  calls: D.calls.filter((c) => c.to).length, backend: backend, flows: flows, audit: audit, rerun: cityAudit, world: world, screenOf: screenOf, go: goKey,
  pickAt: (x, y) => { const o = pickAt(x, y); return o ? C.keyOf(o.userData.what) : null; },
  whatOf: (key) => { const o = Picks.byKey.get(key); return o ? o.userData.what : null; }, flying: () => !!flight,
  labels: () => { const L = nodeLabels(true); return { boxes: boxes.length, placed: L.placed.slice(), reads: L.reads.slice(), titled: L.titled.slice(), small: L.small, hidden: L.hidden }; },
  game: () => (live.G ? { t: live.G.state.t, hits: live.G.state.hits, goals: live.G.state.goals, count: live.G.state.count, level: live.G.state.level,
    runs: Object.fromEntries(live.runs), glowing: live.heat.size,
    lit2d: live.u2.filter((u) => +u.r.style.opacity > 0).length, last: live.last ? live.last.G.alias + '#' + live.last.n.id : null, error: live.error ? live.error.message : null } : null),
  startGame: startGame, stopGame: stopGame,
  // where the view stands and what it looks at, and the fog it draws with: a city framed beyond its fog draws black (10-28, twice)
  view: () => ({ camera: camera.position.toArray().map(Math.round), target: controls.target.toArray().map(Math.round),
    distance: Math.round(camera.position.distanceTo(controls.target)), fog: [Math.round(scene.fog.near), Math.round(scene.fog.far)], far: camera.far }),
  keys: (kind) => [...Picks.byKey.keys()].filter((k) => !kind || k.startsWith(kind + '|')) };
console.log('blueprint city', JSON.stringify({ islands: window.__city.islands, nodes: window.__city.nodes, exec: window.__city.exec, data: window.__city.data, calls: window.__city.calls,
  backend: backend, flows: flows, parts: audit.parts, drawn: audit.drawn, audit: audit.ok ? 'ok' : 'FAILED' }));
// a set that is a game opens playing it, the computer at both ends until someone takes a paddle: the Blueprint is seen running first
if (GAME) { $('gamebtn').textContent = 'Play ' + GAME.title; startGame(); }
