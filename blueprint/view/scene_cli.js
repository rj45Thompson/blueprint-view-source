#!/usr/bin/env node
// scene_cli.js - the data the 3D view (view3d.js) draws, built from what the other tools wrote - nothing here is drawn by hand.
//
//   node view/scene_cli.js build <set dir> <out.js> "<title>"
//     <set dir>/graphs/*.ngl (bp_cli convert), <set dir>/trace/{trace,chain,classes}.json (trace_cli, logic_map, oo_cli),
//     <set dir>/SOURCES.json -> window.BPV3D = {meta, classes, interfaces, graphs (each node placed by pl.js's own layout, with its
//     pseudo-code, its C# line, the Blueprint nodes it came from, the steps citing it, their requirements, its questions), calls,
//     members, paths (with what each means), usecases, requirements, questions, proposals}; then checks it, as below
//   node view/scene_cli.js check <out.js> [--selftest]
//     the city's parts held to that data (city_parts.check): a node with nothing to write on its face, a pipe, call or member flow
//     whose end is no node, a part no hover or click can answer. Exit 1 on any. --selftest plants each fault on a copy instead.
// A graph a timer runs carries the rate the timer states (1 / Time, READ from its arguments); every other graph runs when its event
// fires and carries no rate.
'use strict';
const fs = require('fs');
const path = require('path');
const NGL = require('./pl.js');
const CITY = require('./city_parts.js');
const UE2D = require('./unreal2d.js');
const TITLES = require('./bp_titles.js');

function readText(f) { const b = fs.readFileSync(f); return b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le').slice(1) : b.toString('utf8'); }

function build(setDir, outFile, title) {
  // the set's own name ("Pong", "Lock-On System"): it was written here once as 'Lock-On System' for every set
  if (!title) throw new Error('build needs the title of the set: node view/scene_cli.js build <set dir> <out.js> "<title>"');
  const j = (f) => JSON.parse(readText(path.join(setDir, f)));
  const trace = j('trace/trace.json'), chain = j('trace/chain.json'), classes = j('trace/classes.json'), sources = j('SOURCES.json');
  const parsed = new Map();
  // the graph files themselves ride along: the page RUNS them (view/run.js) when the set has a game (view/games/<set>.js)
  const nglFiles = {};
  for (const f of fs.readdirSync(path.join(setDir, 'graphs')).filter((x) => x.endsWith('.ngl')).sort()) {
    nglFiles[f] = readText(path.join(setDir, 'graphs', f));
    for (const g of NGL.parse(nglFiles[f], f)) parsed.set(g.name, g);
  }
  // who cites each statement, and what it is answered by
  const stepsOf = new Map(), reqsOf = new Map();
  for (const u of chain.usecases) for (const l of u.legs) for (const s of l.statements) {
    (stepsOf.get(s) || stepsOf.set(s, []).get(s)).push(l.label);
    for (const r of l.reqs) { const a = reqsOf.get(s) || reqsOf.set(s, new Set()).get(s); a.add(r); }
  }
  const qsOf = new Map();
  for (const q of trace.questions) for (const r of q.refs) (qsOf.get(r) || qsOf.set(r, []).get(r)).push(q.id);
  const unitsOf = new Map();
  for (const u of trace.units) for (const r of u.refs) (unitsOf.get(r) || unitsOf.set(r, []).get(r)).push(u.name + ' (' + u.cls.replace('K2Node_', '') + ', ' + u.file + ':' + u.line + ')');
  const ownerOf = new Map();
  for (const c of classes.classes) for (const m of c.methods) ownerOf.set(m.alias, c.name);
  // a timer's rate: K2_SetTimer(object, "Name", Time, looping=true) -> 1 / Time for the graph named
  const rate = {};
  for (const c of trace.calls.filter((x) => x.how === 'by name' && /SetTimer/.test(x.method || '') && x.to)) {
    const [ga, sid] = c.from.split('#');
    const G = trace.graphs.find((x) => x.alias === ga);
    const g = parsed.get(G.name);
    const n = g.nodes.get(sid);
    const args = NGL.listOf(n.attrs.args).map(NGL.termText), params = NGL.listOf(n.attrs.params).map(NGL.termText);
    const t = parseFloat(String(args[params.indexOf('Time')]).replace(/f$/, ''));
    if (args[params.indexOf('bLooping')] === 'true' && t > 0) rate[c.to] = { hz: Math.round(1 / t), from: c.from, every: t };
  }
  const graphs = trace.graphs.map((G) => {
    const g = parsed.get(G.name);
    const L = NGL.layout(g);
    const nodes = [];
    for (const [id, b] of L.boxes) {
      const ref = G.alias + '#' + (id[0] === 's' ? id : NGL.rowOf(g, g.nodes.get(id)));
      const st = G.statements.find((s) => s.id === id);
      const qs = id[0] === 's' ? (qsOf.get(G.alias + '#' + id) || []) : [];
      nodes.push({ id: id, kw: b.kw, title: b.title, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), exec: !!b.exec,
        t: g.nodes.get(id) && g.nodes.get(id).attrs.t ? NGL.termText(g.nodes.get(id).attrs.t) : '',
        text: st ? st.text : (G.pseudo.find((l) => l.id === id) || {}).text || b.title,
        cs: id[0] === 's' ? NGL.printCsStatement(g, id) : '',
        units: unitsOf.get(ref) || [], steps: id[0] === 's' ? stepsOf.get(G.alias + '#' + id) || [] : [], reqs: id[0] === 's' ? [...(reqsOf.get(G.alias + '#' + id) || [])] : [],
        questions: qs, open: qs.some((q) => [].concat(chain.answers[q] || []).some((a) => /^IR-/.test(a))) });
    }
    return { alias: G.alias, name: G.name, paste: path.basename(G.file || '', '.ngl'), cls: ownerOf.get(G.alias) || 'Pasted', kind: G.kind, title: G.title, rate: rate[G.alias] || null,
      w: Math.round(L.w), h: Math.round(L.h), nodes: nodes, wires: L.wires.map((w) => ({ kind: w.kind, from: w.from, to: w.to, pin: w.fromPin || '' })),
      cs: NGL.printCs(g), entryUnits: unitsOf.get(G.alias) || [] };
  });
  // members: which statements write them and which name them (a statement's text naming the member, writers apart)
  // a member the trace named with its Blueprint (BP_Ball.Velocity: two Blueprints of the set each hold one of that name) is read
  // only in that Blueprint's graphs - the paddle's own Velocity is not the ball's
  const owners = new Set(trace.graphs.map((G) => G.name.split('.')[0]));
  const members = trace.members.filter((m) => m.writes.length).map((m) => {
    const key = m.name.split('.').pop();
    const own = m.name.includes('.') && owners.has(m.name.split('.')[0]) ? m.name.split('.')[0] + '.' : '';
    const rx = new RegExp('\\b' + key.replace(/[^\w]/g, '') + '\\b');
    const reads = [];
    for (const G of trace.graphs) for (const s of G.statements) { const r = G.alias + '#' + s.id; if (!m.writes.includes(r) && (!own || G.name.startsWith(own)) && rx.test(s.text)) reads.push(r); }
    return { name: m.name, writes: m.writes, reads: reads };
  });
  // each paste as the Blueprint editor draws it (view/unreal2d.js): its author's own node positions, pins and wires, titled from the
  // engine's headers (view/bp_titles.js) - the reference beside the city; each node carries the statements it became (trace units)
  const refsOf = new Map();
  for (const u of trace.units) refsOf.set(u.file + '|' + u.name, u.refs.slice());   // a statement (Alias#sN), or the graph its event is
  const bp2d = sources.pastes.map((p) => {
    const file = p.name + '.t3d';
    const m = UE2D.model(readText(path.join(setDir, file)), TITLES);
    for (const n of m.nodes) n.refs = refsOf.get(file + '|' + n.name) || [];
    return { name: p.name, title: p.title, url: p.url, model: m };
  });
  const data = {
    meta: { title: title || sources.set, author: sources.pastes[0].author, ue: sources.pastes[0].ue, pastes: sources.pastes.map((p) => ({ name: p.name, title: p.title, url: p.url, nodes: p.nodes })), about: sources.about },
    bp2d: bp2d,
    classes: classes.classes, interfaces: classes.interfaces, proposals: classes.proposals, diagrams: classes.diagrams,
    graphs: graphs, calls: trace.calls, members: members,
    paths: trace.paths.map((p) => Object.assign({}, p, { means: chain.paths[p.ref] || null })),
    usecases: chain.usecases, requirements: chain.requirements, asks: chain.asks || [],
    questions: trace.questions.map((q) => ({ id: q.id, rule: q.rule, refs: q.refs, text: q.text, answers: [].concat(chain.answers[q.id] || []) })),
    rules: trace.rules,
    ngl: nglFiles,
  };
  // the data folder holds only what builds write, so a fresh clone has none (10-28: the first release clone's build stopped here)
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, '// ' + path.basename(outFile) + ' - written by view/scene_cli.js from ' + setDir.replace(/\\/g, '/') + '; never edit by hand.\nwindow.BPV3D = ' + JSON.stringify(data) + ';\n');
  const nNodes = graphs.reduce((s, G) => s + G.nodes.length, 0), nWires = graphs.reduce((s, G) => s + G.wires.length, 0);
  console.log('scene build: %d graphs, %d nodes, %d wires, %d calls (%d by name), %d member flows, %d paths, %d questions -> %s (%d KB)',
    graphs.length, nNodes, nWires, trace.calls.length, trace.calls.filter((c) => c.how === 'by name').length, members.length, data.paths.length, data.questions.length, outFile, Math.round(fs.statSync(outFile).size / 1024));
  for (const G of graphs) if (G.rate) console.log('  %s runs %d times a second (%s every %s s)', G.alias, G.rate.hz, G.rate.from, G.rate.every);
  return check(outFile, false);
}

/** the city's parts held to the data written (city_parts.check), or each fault planted on a copy of it (city_parts.selftest) */
function check(file, selftest) {
  const t = readText(file);
  const k = t.indexOf('window.BPV3D = ');
  if (k < 0) throw new Error(file + ' holds no window.BPV3D');
  const D = JSON.parse(t.slice(k + 'window.BPV3D = '.length, t.lastIndexOf(';')));
  if (selftest) {
    const r = CITY.selftest(D);
    for (const [what, ok, said] of r.rows) console.log('  %s %s - %s', ok ? 'ok  ' : 'FAIL', what, said);
    console.log('city_parts selftest: %s', r.ok ? 'PASS' : 'FAIL');
    return r.ok ? 0 : 1;
  }
  const r = CITY.check(D);
  console.log('city check: %d parts (%s), %d problem(s)', r.parts, r.byKind.map(([kind, n]) => n + ' ' + kind).join(', '), r.bad.length);
  for (const b of r.bad.slice(0, 40)) console.log('  %s: %s', b.key, b.why);
  if (r.bad.length > 40) console.log('  ... and %d more', r.bad.length - 40);
  return r.bad.length ? 1 : 0;
}

const [verb, a, b, c] = process.argv.slice(2);
try {
  if (verb === 'build' && a && b) process.exit(build(a, b, c));
  if (verb === 'check' && a) process.exit(check(a, b === '--selftest'));
} catch (e) { console.error('scene: ' + e.stack); process.exit(2); }
console.error('usage: node view/scene_cli.js build <set dir> <out.js> "<title>" | check <out.js> [--selftest]');
process.exit(2);
