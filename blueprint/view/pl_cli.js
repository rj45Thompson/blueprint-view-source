#!/usr/bin/env node
// pl_cli.js - pl.js run over a folder of graph files, headless (the page runs the same pl.js in the browser).
//
//   node view/pl_cli.js print-cs <graphs dir> <out dir>   every graph printed as C#, one <file>.printed.txt per .ngl (the round trip
//                                                          compares them with the source: U2ue.CodeGraph roundtrip --printed <out dir>)
//   node view/pl_cli.js stats <graphs dir>                 graphs, nodes by keyword, and the census's long-wire count computed
//                                                          from the graphs' own reads
'use strict';
const fs = require('fs');
const path = require('path');
const NGL = require('./pl.js');

function nglFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ngl') && e.name !== 'VOCABULARY.ngl') out.push(p);
    }
  })(dir);
  return out;
}

function load(dir) {
  return nglFiles(dir).map((f) => {
    const rel = path.relative(dir, f).split(path.sep).join('/');
    return { rel: rel, graphs: NGL.parse(fs.readFileSync(f, 'utf8'), rel) };
  });
}

function printCs(dir, outDir) {
  let graphs = 0;
  let failed = 0;
  for (const { rel, graphs: gs } of load(dir)) {
    const find = NGL.fileFinder(gs);
    let text = '';
    for (const g of gs) {
      graphs++;
      let body;
      try { body = NGL.printCs(g, find); } catch (e) { failed++; body = '/* PRINT FAILED: ' + e.message.replace(/\*\//g, '* /') + ' */'; console.error('print failed: ' + rel + ' ' + g.name + ': ' + e.message); }
      text += '//@graph ' + NGL.termText(g.attrs.at) + ' ' + g.name + '\n' + body + '\n';
    }
    const target = path.join(outDir, rel.replace(/\.ngl$/, '.printed.txt'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  console.log('print-cs: ' + graphs + ' graphs printed from ' + dir + (failed ? ', ' + failed + ' FAILED to print' : '') + ' -> ' + outDir);
  return failed ? 1 : 0;
}

/** the census's wire measure, from the graphs: a value is LONG when its last read is >= 6 statements after it was made */
function stats(dir) {
  const LONG = 6;
  let graphs = 0, nodes = 0, values = 0, long = 0, graphsWithLong = 0;
  const byKw = {};
  for (const { graphs: gs } of load(dir)) {
    for (const g of gs) {
      graphs++;
      for (const id of g.order) { const kw = g.nodes.get(id).kw; byKw[kw] = (byKw[kw] || 0) + 1; if (!/^(block|section|catch|arm|empty|section-break)$/.test(kw)) nodes++; }
      const span = new Map();
      for (const r of NGL.readsOf(g)) {
        const key = r.name + '@' + r.made;
        span.set(key, Math.max(span.get(key) || 0, NGL.ordinal(r.row) - NGL.ordinal(r.madeRow)));
      }
      let here = 0;
      for (const s of span.values()) { values++; if (s >= LONG) here++; }
      long += here;
      if (here) graphsWithLong++;
    }
  }
  console.log('stats: ' + graphs + ' graphs, ' + nodes + ' nodes; values read ' + values + ', long (last read >= ' + LONG + ' statements after it was made) ' + long + ' in ' + graphsWithLong + ' graphs');
  console.log('  ' + Object.entries(byKw).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(', '));
  return 0;
}

/** PLAN.md phase 2's layout observable: no drawn wire spans >= LONG statement rows (the census's long wires become Get chips),
 *  and the layout is a pure function - laying every graph out twice, from two separate reads of its file, gives the same picture */
function layoutGate(dir) {
  let graphs = 0, wires = 0, chips = 0, longDrawn = 0, longValues = 0, moved = 0, maxLen = 0, failed = 0, undrawn = 0;
  for (const f of nglFiles(dir)) {
    const text = fs.readFileSync(f, 'utf8');
    const first = NGL.parse(text, f), second = NGL.parse(text, f);
    first.forEach((g, i) => {
      graphs++;
      let L1, L2;
      try { L1 = NGL.layout(g); L2 = NGL.layout(second[i]); } catch (e) { failed++; console.error('layout failed: ' + f + ' ' + g.name + ': ' + e.message); return; }
      const s = NGL.layoutStats(g, L1);
      wires += s.wires; chips += s.chips; longDrawn += s.longDrawn; longValues += s.longValues; maxLen = Math.max(maxLen, s.maxLen);
      for (const [id, b] of L1.boxes) { const c = L2.boxes.get(id); if (!c || c.x !== b.x || c.y !== b.y || c.w !== b.w || c.h !== b.h) moved++; }
      // every node a reader could need is drawn: each exec, data and local-function node has a box (structure k-nodes are not nodes)
      for (const id of g.order) if (id[0] !== 'k' && g.nodes.get(id).kw !== 'empty' && !L1.boxes.has(id)) { undrawn++; if (undrawn <= 3) console.error('undrawn: ' + f + ' ' + g.name + ' ' + id + ' ' + g.nodes.get(id).kw); }
    });
  }
  const ok = failed === 0 && longDrawn === 0 && moved === 0 && undrawn === 0;
  console.log('layout-gate: ' + graphs + ' graphs, ' + wires + ' wires drawn, ' + longDrawn + ' of them span >= ' + NGL.LONG +
    ' statements; ' + chips + ' far reads drawn as Get chips (' + longValues + ' long values); ' + moved + ' nodes moved between two layouts; ' + undrawn + ' nodes not drawn; ' +
    (failed ? failed + ' FAILED to lay out; ' : '') + 'longest wire ' + maxLen + ' px - ' + (ok ? 'PASS' : 'FAIL'));
  return ok ? 0 : 1;
}

/** every projection printed from every graph: none may throw; the C++ form's untranslated share is measured, not claimed */
function projections(dir) {
  let graphs = 0, failed = 0, pseudoLines = 0;
  const cpp = { nodes: 0, untranslated: 0 };
  for (const { rel, graphs: gs } of load(dir)) {
    const find = NGL.fileFinder(gs);
    for (const g of gs) {
      graphs++;
      try { pseudoLines += NGL.printPseudo(g, find).length; NGL.printCpp(g, find, cpp); } catch (e) { failed++; if (failed <= 5) console.error('projection failed: ' + rel + ' ' + g.name + ': ' + e.message); }
    }
  }
  console.log('projections: ' + graphs + ' graphs, ' + failed + ' failed; pseudo-code ' + pseudoLines + ' lines; C++ reading form ' + cpp.nodes +
    ' nodes, ' + cpp.untranslated + ' printed as marked C# (' + (100 * cpp.untranslated / Math.max(1, cpp.nodes)).toFixed(1) + '%)');
  return failed ? 1 : 0;
}

/** the page's data: each project's .ngl files as one script (a page opened from disk can load a script, not fetch a file).
 *  The bundle is checked against the files it came from before it is written: the page reads exactly the graphs the gate read. */
function bundle(root, outDir, extra) {
  fs.mkdirSync(outDir, { recursive: true });
  const projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, dir: path.join(root, e.name) }))
    .sort((x, y) => (x.name < y.name ? -1 : 1));
  // more projects from anywhere, as name=dir (the Blueprint converter's output: node view/bp_cli.js convert ... runs/bp)
  for (const x of extra || []) {
    const k = x.indexOf('=');
    if (k < 1 || !fs.existsSync(x.slice(k + 1))) { console.error('bundle: ' + x + ' is not name=<existing dir>'); return 2; }
    projects.push({ name: x.slice(0, k), dir: x.slice(k + 1) });
  }
  const manifest = [];
  for (const { name: p, dir } of projects) {
    const files = {};
    for (const f of nglFiles(dir)) files[path.relative(dir, f).split(path.sep).join('/')] = fs.readFileSync(f, 'utf8');
    const voc = path.join(dir, 'VOCABULARY.ngl');
    // where the graphs came from, READ from each file's own first line: the converter writes "converted from Unreal Blueprint text"
    const fromBp = Object.keys(files).length > 0 && Object.values(files).every((t) => /^# .*converted from Unreal Blueprint text/.test(t));
    // what the graphs were read from, for the page's header (round 1 T-Q-A2-9: the page named no commit): the project's own
    // SOURCE.txt `source` line, or the sandbox's snapshot commit for the reader's projects
    let source = '';
    const own = path.join(dir, 'SOURCE.txt'), snap = path.join(root, '..', 'sandbox', 'SOURCE.txt');
    // the sandbox's snapshot speaks for the projects under the graphs root only: an extra project (name=dir) says where it came
    // from in its own SOURCE.txt, or nothing - never the sandbox's commit (that would give another project the sandbox's source)
    const underRoot = path.resolve(dir).startsWith(path.resolve(root) + path.sep);
    if (fs.existsSync(own)) source = ((/^source (.*)$/m.exec(fs.readFileSync(own, 'utf8')) || [])[1] || '');
    else if (underRoot && fs.existsSync(snap)) {
      const m = /^commit (\w+) (\S+)/m.exec(fs.readFileSync(snap, 'utf8'));
      if (m) source = 'game commit ' + m[1].slice(0, 7) + ' (' + m[2] + '), copied into the sandbox';
    }
    const body = 'NGL_BUNDLES.push(' + JSON.stringify({ project: p, ext: fromBp ? '.t3d' : '.cs', source: source, files: files, vocabulary: fs.existsSync(voc) ? fs.readFileSync(voc, 'utf8') : '' }) + ');\n';
    const target = path.join(outDir, p.replace(/[^\w.-]+/g, '_') + '.js');
    fs.writeFileSync(target, body);
    // read it back the way the page will, and hold every file to its source
    const sandboxGlobal = { NGL_BUNDLES: [] };
    new Function('NGL_BUNDLES', fs.readFileSync(target, 'utf8'))(sandboxGlobal.NGL_BUNDLES);
    const back = sandboxGlobal.NGL_BUNDLES[0].files;
    const differ = Object.keys(files).filter((k) => back[k] !== fs.readFileSync(path.join(dir, k), 'utf8'));
    if (differ.length || Object.keys(back).length !== Object.keys(files).length) { console.error('bundle: ' + p + ' does not hold its files: ' + differ.slice(0, 3)); return 1; }
    manifest.push({ project: p, script: path.basename(target), files: Object.keys(files).length });
    console.log('bundle: ' + p + ' ' + Object.keys(files).length + ' files, ' + (body.length / 1048576).toFixed(1) + ' MB, every file read back equal');
  }
  fs.writeFileSync(path.join(outDir, 'index.js'), 'var NGL_BUNDLES = []; var NGL_MANIFEST = ' + JSON.stringify(manifest) + ';\n');
  return 0;
}

/** click-through: every call's `def` must name a graph that exists (file:line of its declaration in the same project), and every
 *  `binds` (a callee with no body) must NOT - so a click either opens a graph or says why there is none */
function links(root) {
  const projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const at = new Set();
  const all = [];
  for (const p of projects) for (const { rel, graphs: gs } of load(path.join(root, p))) for (const g of gs) { at.add(p + '/' + rel.replace(/\.ngl$/, '.cs') + ':' + NGL.termText(g.attrs.at).split(':')[0]); all.push({ p: p, rel: rel, g: g }); }
  let defs = 0, broken = 0, decls = 0, declWithGraph = 0;
  const kinds = {};
  for (const { p, rel, g } of all) {
    for (const id of g.order) {
      const n = g.nodes.get(id);
      const key = (v) => { const t = NGL.termText(v); const m = /^\.\.\/([^/]+)\/(.*)$/.exec(t); return m ? m[1] + '/' + m[2] : p + '/' + t; };
      if (n.attrs.def) { defs++; if (!at.has(key(n.attrs.def))) { broken++; if (broken <= 3) console.error('def to no graph: ' + rel + ' ' + g.name + ' ' + id + ' -> ' + NGL.termText(n.attrs.def)); } }
      if (n.attrs.binds) { decls++; const k = NGL.termText(n.attrs.bindskind); kinds[k] = (kinds[k] || 0) + 1; if (at.has(key(n.attrs.binds))) declWithGraph++; }
    }
  }
  console.log('links: ' + defs + ' click-throughs, ' + broken + ' to no graph; ' + decls + ' calls to a member with no graph (' +
    Object.entries(kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => k + ' ' + n).join(', ') + '), ' + declWithGraph + ' of them wrongly have one');
  return broken === 0 && declWithGraph === 0 ? 0 : 1;
}

const [verb, a, b] = process.argv.slice(2);
if (verb === 'links' && a) process.exit(links(a));
if (verb === 'projections' && a) process.exit(projections(a));
if (verb === 'bundle' && a && b) process.exit(bundle(a, b, process.argv.slice(5)));
if (verb === 'print-cs' && a && b) process.exit(printCs(a, b));
if (verb === 'stats' && a) process.exit(stats(a));
if (verb === 'layout-gate' && a) process.exit(layoutGate(a));
console.error('usage: node pl_cli.js print-cs <graphs dir> <out dir> | stats <graphs dir> | layout-gate <graphs dir>');
process.exit(2);
