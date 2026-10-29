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
// A graph a timer runs carries the rate the timer states (1 / Time, READ from its arguments) as `rate`, the one the city burns. The
// graphs that run often with no timer carry `runs` (GraphRuns below): the engine's Tick, and a loop the converter cut that waits on
// a Delay. Every other graph runs when its event fires and carries neither.
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
  const runs = graphRuns(trace, parsed);
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
      runs: rate[G.alias] ? null : runs[G.alias] || null,
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
  for (const G of graphs) if (G.runs) console.log('  %s %s', G.alias, G.runs.said);
  return check(outFile, false);
}

/** GraphRuns: the graphs that run often with no timer, each READ from the graph with where - never a rate in Hz the paste does not
 *  hold. -> {alias: {by, every, hz, from, back, delays, why, said}}
 *    the engine's Tick   a ReceiveTick graph runs once a frame while its actor ticks (Actor.h:2181-2183, UE 5.7); a tick interval
 *                        in the class defaults, which a paste of graphs does not carry, would run it less often - so no Hz
 *    a Delay loop        the graph runs a stretch of itself again: a wire the converter could not follow again (an island that "loops
 *                        back to an earlier step", standing at the line of the step it returns to), or a call to its own event. From
 *                        the step it returns to (the entry, for a call) down to the island or the call, the Delays awaited on the
 *                        way (LoopDelays) set the period: every t seconds at the fastest (t their sum, READ from their literal
 *                        durations), and at most once a frame - a Delay finishes in its once-a-frame update (DelayAction.h:27-30).
 *                        A Delay whose duration is no literal leaves that loop unread; a loop with no Delay on its way gives no t */
function graphRuns(trace, parsed) {
  const out = {};
  for (const G of trace.graphs) {
    if (G.kind === 'event' && /\.ReceiveTick$/.test(G.name)) {
      out[G.alias] = { by: 'tick', every: 'frame', hz: null, from: G.alias, said: 'runs once a frame (the engine\'s Tick)',
        why: 'ReceiveTick: the engine calls it once a frame while the actor ticks (Actor.h:2181-2183); a tick interval in the class defaults, which a paste does not carry, would call it less often' };
      continue;
    }
    const g = parsed.get(G.name);
    const own = G.name.split('.').pop();
    let best = null;
    for (const id of g.order) {
      const n = g.nodes.get(id);
      if (id[0] !== 's') continue;
      const cut = n.kw === 'island' && /loops back to an earlier step/.test(NGL.textOf(n.attrs.text) || '');
      const self = n.kw === 'call' && !n.attrs.on && NGL.termText(n.attrs.method) === own;
      if (!cut && !self) continue;
      const L = loopDelays(g, id, cut ? NGL.atLine(n) : null);
      if (L && L.t > 0 && (!best || L.t < best.t)) best = Object.assign(L, { at: G.alias + '#' + id, how: cut ? 'the converter cut the cycle at ' : 'it calls itself at ' });
    }
    if (!best) continue;
    const every = Math.round(best.t * 1e6) / 1e6;
    const back = best.back ? G.alias + '#' + best.back : G.alias + ' (its entry)';
    // hz to two decimals: a loop slower than once a second (0.8 s, 2 s) would round to a whole number that is not its rate
    out[G.alias] = { by: 'delay loop', every: every, hz: Math.round(100 / best.t) / 100, from: best.at, back: back, delays: best.delays.map((d) => G.alias + '#' + d),
      said: 'loops every ' + every + ' s at the fastest, at most once a frame (a Delay loop: ' + back + ' to ' + best.at + ')',
      why: best.how + best.at + ', running again from ' + back + ' after ' + best.delays.map((d) => G.alias + '#' + d).join(' and ') +
        ': every ' + every + ' s at the fastest, and at most once a frame (a Delay finishes in its once-a-frame update, DelayAction.h:27-30)' };
  }
  return out;
}

/** LoopDelays: the Delays awaited on the way from the step a loop returns to (the one standing at line `at`; with no line, the
 *  graph's entry) down to statement id, walking the graph's own statement tree up from id: the statements before it in its body,
 *  then its enclosing step, and so on. Only a Delay awaited on the way itself is counted - one inside a choice on the way may not
 *  run, so the sum is the fastest the loop can go round. -> {t, back, delays: ['sN Delay(0.01f)']}, or null when the step it returns
 *  to is not on the way or a Delay's duration is no literal */
function loopDelays(g, id, at) {
  // the body that holds a step: a branch's side, a loop's or a block's body, or a switch's sections - those hold sections ('k'),
  // which are alternatives, not steps: only a statement ('s') is a step a loop returns to or a Delay on its way (a section stands at
  // its switch's line, so it would otherwise be taken for the switch)
  const holder = (n, x) => ['then', 'else', 'body', 'sections'].map((k) => NGL.listOf(n.attrs[k]).map(NGL.idOf)).find((l) => l.includes(x)) || null;
  const step = (x) => x && x.id[0] === 's';
  let id2 = id, t = 0;
  const delays = [];
  for (;;) {
    const n = g.nodes.get(id2);
    const up = n.under ? g.nodes.get(n.under) : null;
    const list = up ? holder(up, id2) : NGL.listOf(g.attrs.body).map(NGL.idOf);
    if (!list) return null;
    for (let k = list.indexOf(id2) - 1; k >= 0; k--) {
      const s = g.nodes.get(list[k]);
      if (!step(s)) continue;
      if (at !== null && NGL.atLine(s) === at) return { t: t, back: list[k], delays: delays };
      const e = s.kw === 'await' && s.attrs.a && s.attrs.a.ref ? g.nodes.get(s.attrs.a.ref) : null;
      if (!e || !/^(Delay|RetriggerableDelay)$/.test(NGL.termText(e.attrs.method) || '')) continue;
      const d = String(NGL.termText(NGL.listOf(e.attrs.args)[0]) || '');
      if (!/^\d+(\.\d+)?f?$/.test(d)) return null;
      t += parseFloat(d);
      delays.push(list[k] + ' ' + NGL.termText(e.attrs.method) + '(' + d + ')');
    }
    if (!up) return at === null ? { t: t, back: null, delays: delays } : null;
    if (at !== null && step(up) && NGL.atLine(up) === at) return { t: t, back: up.id, delays: delays };
    id2 = up.id;
  }
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

/** GraphRuns held to graphs written here: a cut cycle round a Delay and a call to itself after one are read, with their period; the
 *  engine's Tick is once a frame; a Delay whose duration is no literal, or one inside a choice on the way, gives no period */
function runsSelftest() {
  const island = (at) => 'island text=~"/* Blueprint K2Node_IfThenElse \\"K2Node_IfThenElse_1\\": loops back to an earlier step; the wire is not followed again (pins: execute) */" at=' + at;
  const delay = (id, e, arg, at) => id + ' await a=#' + e + ' at=' + at + '\n' + '      ' + e + ' pure-call on=KismetSystemLibrary method=Delay args=[' + arg + '] params=[Duration] at=' + at;
  const text = [
    'graph X.Cut kind=event at=1:1 returns=void body=[s1]', '  s1 branch cond=Go then=[s2 s3] at=10', '    ' + delay('s2', 'e1', '0.25f', 20), '    s3 ' + island(10), 'end',
    'graph X.Again kind=event at=2:1 returns=void body=[s1 s2]', '  ' + delay('s1', 'e1', '2f', 30).replace('\n      ', '\n    '), '  s2 call method=Again args=[] params=[] at=31', 'end',
    'graph X.ReceiveTick kind=event at=3:1 returns=void body=[s1]', '  s1 call method=Again args=[] params=[] at=40', 'end',
    'graph X.Unread kind=event at=4:1 returns=void body=[s1]', '  s1 branch cond=Go then=[s2 s4 s3] at=50', '    ' + delay('s2', 'e1', 'Wait', 60), '    ' + delay('s4', 'e2', '1f', 61), '    s3 ' + island(50), 'end',
    'graph X.Maybe kind=event at=5:1 returns=void body=[s1 s3]', '  s1 branch cond=Go then=[s2] at=70', '    ' + delay('s2', 'e1', '1f', 80), '  s3 call method=Maybe args=[] params=[] at=81', 'end',
    'graph X.Sib kind=event at=6:1 returns=void body=[s1 s2 s3]', '  s1 set target=N op== value=0 at=85', '  ' + delay('s2', 'e1', '0.5f', 86).replace('\n      ', '\n    '), '  s3 ' + island(85), 'end',
    'graph X.Sw kind=event at=7:1 returns=void body=[s1]', '  s1 switch on=Mode sections=[k2 k3] at=90', '    k2 section labels=[default] body=[s4] at=90', '      s4 section-break at=90',
    '    k3 section labels=[case 0] body=[s5 s6] at=90', '      ' + delay('s5', 'e1', '0.5f', 91).replace('\n      ', '\n        '), '      s6 ' + island(90), 'end', ''].join('\n');
  const parsed = new Map(NGL.parse(text, 'x.ngl').map((g) => [g.name, g]));
  const R = graphRuns({ graphs: [...parsed.values()].map((g) => ({ alias: g.name.split('.').pop(), name: g.name, kind: NGL.termText(g.attrs.kind) })) }, parsed);
  const rows = [
    ['a cut cycle round a Delay is read with its period', R.Cut && R.Cut.by === 'delay loop' && R.Cut.every === 0.25 && R.Cut.back === 'Cut#s1', JSON.stringify(R.Cut)],
    ['a call to itself after a Delay is read', R.Again && R.Again.every === 2 && /its entry/.test(R.Again.back), JSON.stringify(R.Again)],
    ['the engine\'s Tick runs once a frame, with no Hz', R.ReceiveTick && R.ReceiveTick.by === 'tick' && R.ReceiveTick.hz === null, JSON.stringify(R.ReceiveTick)],
    ['a Delay whose duration is no literal gives no period', !R.Unread, JSON.stringify(R.Unread)],
    ['a Delay inside a choice on the way gives no period', !R.Maybe, JSON.stringify(R.Maybe)],
    ['a cycle back to a step before it in its own body is read', R.Sib && R.Sib.every === 0.5 && R.Sib.back === 'Sib#s1', JSON.stringify(R.Sib)],
    ['a cycle back to a switch returns to the switch, not to a section standing at its line', R.Sw && R.Sw.back === 'Sw#s1' && R.Sw.every === 0.5, JSON.stringify(R.Sw)],
  ];
  for (const [what, ok, said] of rows) console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what, ok ? '' : ' - ' + said);
  const bad = rows.filter((r) => !r[1]).length;
  console.log('runs selftest: %d checks, %d failed - %s', rows.length, bad, bad ? 'FAIL' : 'PASS');
  return bad ? 1 : 0;
}

const [verb, a, b, c] = process.argv.slice(2);
try {
  if (verb === 'build' && a && b) process.exit(build(a, b, c));
  if (verb === 'check' && a) process.exit(check(a, b === '--selftest'));
  if (verb === 'runs-selftest') process.exit(runsSelftest());
} catch (e) { console.error('scene: ' + e.stack); process.exit(2); }
console.error('usage: node view/scene_cli.js build <set dir> <out.js> "<title>" | check <out.js> [--selftest] | runs-selftest');
process.exit(2);
