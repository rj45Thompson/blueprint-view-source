#!/usr/bin/env node
// trace_cli.js - the trace (trace.js) run over a converted project, headless.
//
//   node view/trace_cli.js build <ngl dir> <paste dir|-> <out dir>
//     -> <out>/outcomes.txt, paths.txt, questions.txt (the closed sets the model's spaces extract their keys from, one per line)
//        and <out>/trace.json (graphs with each statement's text, units, decisions, paths, questions, calls, members)
//     Prints an outside count beside its own: the deciding Blueprint nodes in the paste text (IfThenElse, DynamicCast, the Compare /
//     IsValid / loop macros, Switch) against the decisions it found - a parse that silently read a fraction would show here.
//   node view/trace_cli.js suggest-eval <trace.json> <cites.json>
//     the GNN question, measured: hide each cited statement's step in turn, let message passing propose it from the rest, and
//     score it against a baseline (the step of the nearest cited statement before it in the same graph)
'use strict';
const fs = require('fs');
const path = require('path');
const TR = require('./trace.js');
const BP = require('./bp.js');

function readText(f) {
  const buf = fs.readFileSync(f);
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le').slice(1) : buf.toString('utf8').replace(/^﻿/, '');
}

function load(nglDir, pasteDir) {
  const ngl = {};
  for (const f of fs.readdirSync(nglDir).filter((x) => x.endsWith('.ngl')).sort()) ngl[f] = readText(path.join(nglDir, f));
  if (!Object.keys(ngl).length) throw new Error(nglDir + ' holds no .ngl file');
  let pastes = null;
  if (pasteDir && pasteDir !== '-') {
    pastes = {};
    for (const f of fs.readdirSync(pasteDir).filter((x) => x.endsWith('.t3d')).sort()) pastes[f] = readText(path.join(pasteDir, f));
  }
  return { ngl: ngl, pastes: pastes, T: TR.build(ngl, pastes) };
}

function build(nglDir, pasteDir, outDir) {
  const { pastes, T } = load(nglDir, pasteDir);
  const Q = TR.questions(T);
  // a unit that became no graph node is one of three things: a comment box (a note beside the code, never code); a node nothing in its
  // copy runs - every wire into its exec input comes from a node the copy does not hold, or none does, so here it never runs (siljaZ's
  // EnemyShipsSpawning copied its timer without the call that sets it); or a node the trace failed to place, the one that fails. The
  // first two carry their reason into trace.json (`why`), where tools/logic_map.py writes it as the unit's cell
  const docs = pastes ? Object.fromEntries(Object.entries(pastes).map(([f, t]) => [f, BP.parseText(t)])) : {};
  const reasonOf = (u) => {
    if (/^EdGraphNode_Comment/.test(u.name)) return 'a comment box: a note beside the code, never code';
    const doc = docs[u.file], n = doc && doc.objects.find((o) => o.name === u.name && !o.outer);
    const held = new Set(doc ? doc.objects.filter((o) => !o.outer).map((o) => o.name) : []);
    const ins = n ? n.pins.filter((p) => p.cat === 'exec' && p.dir === 'in') : [];
    return ins.length && ins.every((p) => p.linked.every((l) => !held.has(l.node))) ? 'nothing in its copy runs it: every wire into it comes from a node the copy does not hold' : null;
  };
  for (const u of T.units) if (!u.refs.length && reasonOf(u)) u.why = reasonOf(u);
  fs.mkdirSync(outDir, { recursive: true });
  const head = (what) => '# ' + what + ' - written by view/trace_cli.js build from ' + nglDir.replace(/\\/g, '/') + '. Generated: never edit.\n';
  fs.writeFileSync(path.join(outDir, 'outcomes.txt'), head('every outcome of every decision') + T.outcomes.map((o) => 'outcome ' + o.ref + '\n').join(''));
  fs.writeFileSync(path.join(outDir, 'paths.txt'), head('every path from a graph entry to an exit') + T.paths.map((p) => 'path ' + p.ref + ' = ' + (p.outs.join(' ') || '(no choice)') + '\n').join(''));
  fs.writeFileSync(path.join(outDir, 'questions.txt'), head('every question the brainstorm rules raise') + Q.map((q) => 'question ' + q.id + ' :: ' + q.rule + ' :: ' + q.refs.join(' ') + ' :: ' + q.text + '\n').join(''));
  const json = {
    source: nglDir.replace(/\\/g, '/'),
    graphs: T.graphs.map((G) => ({ alias: G.alias, name: G.name, file: G.file, kind: G.kind, title: G.title, at: G.at,
      statements: G.pseudo.filter((l) => l.id && l.id[0] === 's').reduce((acc, l) => { if (!acc.some((x) => x.id === l.id)) acc.push({ id: l.id, depth: l.depth, text: l.text, kw: G.g.nodes.get(l.id).kw, under: G.g.nodes.get(l.id).under, at: G.g.nodes.get(l.id).attrs.at ? G.g.nodes.get(l.id).attrs.at.term : null }); return acc; }, []),
      pseudo: G.pseudo })),
    units: T.units, decisions: T.decisions.map((d) => ({ ref: d.ref, graph: d.graph, kw: d.kw, text: d.text, outcomes: d.outcomes.map((o) => ({ ref: o.ref, label: o.label, body: o.body })) })),
    paths: T.paths, questions: Q, calls: T.calls,
    members: [...T.members].map(([name, m]) => ({ name: name, writes: m.writes, reads: m.reads, nulls: m.nulls, valid: m.valid })),
    rules: TR.RULES,
  };
  fs.writeFileSync(path.join(outDir, 'trace.json'), JSON.stringify(json, null, 1));
  // the outside count: deciding nodes as the Blueprint text has them
  let bpDecide = null;
  if (pastes) {
    bpDecide = 0;
    for (const text of Object.values(pastes)) {
      const top = BP.parseText(text).objects.filter((x) => !x.outer);
      // a DoOnce or a FlipFlop decides once it has a code form, which it has in an event graph - where a copy holding an event
      // node came from (bp.js EVENT_GRAPH_ONLY, the engine's rule): its branches stand at its own source line, one place
      const eventGraph = top.some((x) => BP.EVENT_GRAPH_ONLY.test(x.cls));
      for (const o of top) {
        const macro = o.props.MacroGraphReference ? (/:(\w+)/.exec(o.props.MacroGraphReference.replace(/"/g, '')) || [])[1] : '';
        // a Compare macro is ONE Blueprint node with three outputs and becomes two nested branches; a loop macro one loop
        if (o.cls === 'K2Node_IfThenElse' || o.cls === 'K2Node_DynamicCast' || /^K2Node_Switch/.test(o.cls) || macro === 'IsValid' || /ForEachLoop|ForLoop|WhileLoop/.test(macro)) bpDecide += 1;
        if ((macro === 'DoOnce' || macro === 'FlipFlop') && eventGraph) bpDecide += 1;
        if (macro === 'CompareFloat' || macro === 'CompareInt') bpDecide += 2;
        if (o.cls === 'K2Node_VariableGet' && o.pins.some((p) => p.cat === 'exec')) bpDecide += 1;
      }
    }
  }
  const nDecWritten = T.decisions.length;
  console.log('trace build: %d graphs, %d statements, %d decisions (%d outcomes), %d paths, %d units (%d written inline), %d calls between graphs (%d by name), %d questions',
    T.graphs.length, json.graphs.reduce((s, G) => s + G.statements.length, 0), nDecWritten, T.outcomes.length, T.paths.length, T.units.length,
    T.units.filter((u) => u.inline).length, T.calls.length, T.calls.filter((c) => c.how === 'by name').length, Q.length);
  const byRule = {};
  for (const q of Q) byRule[q.rule] = (byRule[q.rule] || 0) + 1;
  console.log('  questions by rule: ' + Object.entries(byRule).map(([k, v]) => k + ' ' + v).join(', '));
  const unplaced = T.units.filter((u) => !u.refs.length);
  const notes = unplaced.filter((u) => /^a comment box/.test(u.why || '')), dead = unplaced.filter((u) => /^nothing in its copy/.test(u.why || ''));
  const orphanUnits = unplaced.filter((u) => !u.why);
  if (notes.length) console.log('  comment boxes, notes beside the code: %d', notes.length);
  if (dead.length) console.log('  never runs, nothing in its copy runs it: ' + dead.map((u) => u.file + ':' + u.name).join(', '));
  if (orphanUnits.length) console.log('  units that became no graph node: ' + orphanUnits.map((u) => u.file + ':' + u.name).join(', '));
  if (bpDecide !== null) {
    // the converter writes a step reached by two paths again (14 here), so the graph holds MORE decisions than the Blueprint when a
    // shared step decides; the outside count is held against the distinct decisions by source line
    const distinct = new Set(T.decisions.map((d) => d.graph.split('#')[0] + ':' + (json.graphs.find((G) => G.alias === d.graph).statements.find((s) => s.id === d.ref.split('#')[1]) || {}).at)).size;
    const lines = new Set();
    for (const d of T.decisions) { const G = json.graphs.find((x) => x.alias === d.graph); const s = G.statements.find((x) => x.id === d.ref.split('#')[1]); lines.add(G.file + ':' + s.at + (d.kw === 'branch' && /^if .* [<>] /.test(d.text) ? ':' + d.text : '')); }
    console.log('  outside count: %d deciding nodes in the Blueprint text; %d decisions at distinct source places in the graphs (%d written, shared steps counted again)', bpDecide, lines.size, nDecWritten);
    if (lines.size !== bpDecide) { console.log('  FAIL: the decisions found do not match the deciding nodes the text holds'); return 1; }
  }
  if (orphanUnits.length) { console.log('  FAIL: a Blueprint node the trace cannot place'); return 1; }
  return 0;
}

/** leave-one-out over the cited statements: message passing vs the nearest-cite baseline */
function suggestEval(traceDir, citesFile) {
  const nglDir = JSON.parse(fs.readFileSync(path.join(traceDir, 'trace.json'), 'utf8')).source;
  const { T } = load(nglDir, null);
  const cites = JSON.parse(fs.readFileSync(citesFile, 'utf8'));        // {ref: [every step citing it]}
  const truth = new Map(Object.entries(cites).filter(([r]) => /#s\d+$/.test(r)));
  const labels = new Map([...truth].map(([r, steps]) => [r, steps[0]]));
  const ucOf = (step) => step.replace(/\.\d+[a-z]?$/, '');
  if (labels.size < 10) { console.log('suggest-eval: only %d cited statements - too few to measure anything', labels.size); return 1; }
  let hit = 0, base = 0, none = 0, n = 0, hitUc = 0, baseUc = 0;
  const misses = [];
  for (const [ref] of labels) {
    const all = truth.get(ref);
    const rest = new Map(labels);
    rest.delete(ref);
    const s = TR.suggest(T, rest).get(ref);
    n++;
    if (!s) none++;
    else if (all.includes(s.label)) hit++;
    else misses.push(ref + ' -> ' + s.label + ' (is ' + all.join(' or ') + ')');
    if (s && all.some((x) => ucOf(x) === ucOf(s.label))) hitUc++;
    // baseline: the step of the nearest cited statement before it in its graph's statement order, else after it
    const [ga, id] = ref.split('#');
    const G = T.byAlias.get(ga);
    const order = G.g.order.filter((x) => x[0] === 's');
    const k = order.indexOf(id);
    let guess = null;
    for (let j = k - 1; j >= 0 && guess === null; j--) if (rest.has(ga + '#' + order[j])) guess = rest.get(ga + '#' + order[j]);
    for (let j = k + 1; j < order.length && guess === null; j++) if (rest.has(ga + '#' + order[j])) guess = rest.get(ga + '#' + order[j]);
    if (guess !== null && all.includes(guess)) base++;
    if (guess !== null && all.some((x) => ucOf(x) === ucOf(guess))) baseUc++;
  }
  console.log('suggest-eval: %d cited statements, each hidden in turn', n);
  console.log('  message passing: %d right (%s%%), %d wrong, %d with no proposal', hit, (100 * hit / n).toFixed(1), n - hit - none, none);
  console.log('  baseline (nearest cite in the same graph): %d right (%s%%)', base, (100 * base / n).toFixed(1));
  console.log('  which USE CASE (not which step): message passing %d (%s%%), baseline %d (%s%%)', hitUc, (100 * hitUc / n).toFixed(1), baseUc, (100 * baseUc / n).toFixed(1));
  for (const m of misses.slice(0, 8)) console.log('    missed: ' + m);
  return 0;
}

const [verb, a, b, c] = process.argv.slice(2);
try {
  if (verb === 'build' && a && b && c) process.exit(build(a, b, c));
  if (verb === 'suggest-eval' && a && b) process.exit(suggestEval(a, b));
} catch (e) { console.error('trace: ' + e.message); process.exit(2); }
console.error('usage: node view/trace_cli.js build <ngl dir> <paste dir|-> <out dir> | suggest-eval <trace dir> <cites.json>');
process.exit(2);
