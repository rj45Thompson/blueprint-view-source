#!/usr/bin/env node
// bp_cli.js - the Blueprint converter (bp.js) run over files of Unreal Blueprint text, headless (the page runs the same bp.js).
//
//   node view/bp_cli.js convert <in dir of *.t3d> <out dir>
//     every Blueprint -> <out>/<name>.ngl (the graph language) and <out>/<name>.printed.txt (each method's C#, for the syntax gate);
//     the .ngl is read back with pl.js and printed as C#, C++ and pseudo-code before it counts as converted
//   node view/bp_cli.js plant <one .t3d>   a broken line planted in a copy must be refused, naming its line (BC-1)
'use strict';
const fs = require('fs');
const path = require('path');
const BP = require('./bp.js');
const NGL = require('./pl.js');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.t3d')) out.push(p);
  }
  return out;
}

// the exporter writes UTF-16 when the text holds a character outside ASCII (measured: TP_UEIntro_BP/BP_GM_Template)
function readText(f) {
  const buf = fs.readFileSync(f);
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le').slice(1) : buf.toString('utf8').replace(/^﻿/, '');
}

/** every value line must sit, in the file's indentation tree, under the statement that reads it - that tree is the row a value is
 *  drawn beside. Returns the values that do not: one nothing reads, or one under another statement. Measured 2026-10-28: a
 *  branch's condition, built before its statement line was placed, sat under the step before the branch */
function rowGate(g) {
  const consumer = new Map();
  for (const id of g.order) {
    for (const v of Object.values(g.nodes.get(id).attrs)) {
      for (const x of v.list || [v]) {
        if (x.ref) consumer.set(x.ref, id);
        const t = x.term !== undefined ? x.term : x.str;
        if (typeof t === 'string' && t.indexOf('#') >= 0) for (const r of NGL.refsIn(t)) consumer.set(r, id);
      }
    }
  }
  const bad = [];
  for (const id of g.order) {
    if (id[0] !== 'e') continue;
    let c = id;
    for (let k = 0; c && c[0] === 'e' && k < 100000; k++) c = consumer.get(c);
    if (!c) { bad.push(id + ': nothing reads it'); continue; }
    const row = NGL.rowOf(g, g.nodes.get(id));
    if (c[0] === 's' && row !== c) bad.push(id + ': sits under ' + row + ', but ' + c + ' reads it');
  }
  return bad;
}

function convertAll(inDir, outDir) {
  const total = { files: 0, graphs: 0, methods: 0, nodes: 0, comments: 0, unreached: 0, empty: 0, cycles: 0, shared: 0, converted: {}, islands: {}, notCode: {}, failed: [], printed: 0, notes: 0, rows: 0 };
  // a set's manifest (SOURCES.json) may declare the owner of a copy whose own events name none, with its reason
  const manifest = path.join(inDir, 'SOURCES.json');
  const declared = new Map(fs.existsSync(manifest) ? JSON.parse(readText(manifest)).pastes.filter((p) => p.owner).map((p) => [p.name, { owner: p.owner, why: p.owner_why }]) : []);
  for (const f of walk(inDir)) {
    const rel = path.relative(inDir, f).split(path.sep).join('/').replace(/\.t3d$/, '');
    total.files++;
    let r;
    try {
      r = BP.convert(readText(f), rel, declared.get(rel));
    } catch (e) {
      total.failed.push(rel + ': ' + e.message);
      continue;
    }
    const target = path.join(outDir, rel + '.ngl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, r.ngl);
    // read it back and print every form: a graph that does not print is not converted
    let printed = '';
    try {
      const gs = NGL.parse(r.ngl, rel);
      const find = NGL.fileFinder(gs);
      for (const g of gs) {
        printed += '//@graph ' + NGL.termText(g.attrs.at) + ' ' + g.name + '\n' + NGL.printCs(g, find) + '\n';
        NGL.printCpp(g, find);
        NGL.printPseudo(g, find);
        total.printed++;
        const bad = rowGate(g);
        total.rows += bad.length;
        if (bad.length) throw new Error(g.name + ': ' + bad.length + ' value(s) not under the statement that reads them, e.g. ' + bad[0]);
      }
    } catch (e) {
      total.failed.push(rel + ': read back or print: ' + e.message);
      continue;
    }
    fs.writeFileSync(path.join(outDir, rel + '.printed.txt'), printed);
    const rep = r.report;
    for (const k of ['graphs', 'methods', 'nodes', 'comments', 'unreached', 'empty', 'cycles', 'shared']) total[k] += rep[k];
    for (const [c, n] of Object.entries(rep.converted)) total.converted[c] = (total.converted[c] || 0) + n;
    for (const [c, n] of Object.entries(rep.islands)) total.islands[c] = (total.islands[c] || 0) + n;
    for (const [c, n] of Object.entries(rep.notCode)) total.notCode[c] = (total.notCode[c] || 0) + n;
    total.notes += rep.notes.length;
  }
  // where these graphs came from, for the page's header (pl_cli.js bundle reads it): the engine's version READ from its
  // Build.version, or said to be unread - never guessed from a folder name
  // UE_ROOT names the install (the folder holding Engine/), as every tool here reads it: unset, the version is said to be unread
  const engine = process.env.UE_ROOT ? path.join(process.env.UE_ROOT, 'Engine') : null;
  let version = engine ? 'an engine version not read (no ' + engine.replace(/\\/g, '/') + '/Build/Build.version)' : 'an engine version not read (UE_ROOT not set)';
  try {
    if (!engine) throw new Error('UE_ROOT not set');
    const v = JSON.parse(fs.readFileSync(path.join(engine, 'Build', 'Build.version'), 'utf8'));
    version = 'Unreal Engine ' + v.MajorVersion + '.' + v.MinorVersion + '.' + v.PatchVersion + ' (changelist ' + v.Changelist + ')';
  } catch (e) { /* the sentence above says it was not read */ }
  fs.writeFileSync(path.join(outDir, 'SOURCE.txt'), '# where these graphs came from (view/bp_cli.js convert); pl_cli.js bundle shows it in the page\n' +
    'source ' + total.files + ' Blueprints of the ' + version + ' templates, exported headless by tools/export_templates.ps1\n');
  const islands = Object.values(total.islands).reduce((a, b) => a + b, 0);
  console.log('bp convert: ' + total.files + ' Blueprints, ' + total.graphs + ' graphs (the ones each Blueprint lists as its own), ' + total.methods +
    ' methods, ' + total.printed + ' printed as C#, C++ and pseudo-code; ' + total.nodes + ' nodes (' + total.comments + ' comment boxes beside them), ' +
    islands + ' kept as marked islands, ' + total.unreached + ' dead (no entry leads to them), ' + total.empty + ' events with nothing wired after them, ' +
    total.shared + ' shared steps written again, ' +
    total.cycles + ' cycles; ' + total.failed.length + ' Blueprint(s) FAILED');
  console.log('  converted by class: ' + Object.entries(total.converted).sort((a, b) => b[1] - a[1]).map(([c, n]) => c.replace('K2Node_', '') + ' ' + n).join(', '));
  console.log('  islands by class: ' + (islands ? Object.entries(total.islands).sort((a, b) => b[1] - a[1]).map(([c, n]) => c.replace('K2Node_', '') + ' ' + n).join(', ') : 'none'));
  console.log('  graphs that are another language, not converted: ' + (Object.keys(total.notCode).length ? Object.entries(total.notCode).map(([c, n]) => c + ' (' + n + ' nodes)').join(', ') : 'none'));
  for (const f of total.failed.slice(0, 8)) console.log('  FAILED ' + f);
  return total.failed.length ? 1 : 0;
}

function plant(file) {
  const text = readText(file).split('\n');
  const i = text.findIndex((l) => l.trim().startsWith('CustomProperties Pin'));
  if (i < 0) { console.log('plant: no pin line to break in ' + file); return 1; }
  const cases = [
    ['a pin line cut short', (t) => { t[i] = t[i].slice(0, 40); return t; }],
    ['a stray line', (t) => { t.splice(i, 0, '      this is not Blueprint text'); return t; }],
    ['an End Object too many', (t) => { t.push('End Object'); return t; }],
    // UE 5.0 writes Class'"path"': a quoted path that never closes is refused, as the engine's ReadToken refuses it (Property.cpp:656)
    ['an object path whose quote does not close', (t) => { const k = t.findIndex((l) => /'"\/[^"']+"'/.test(l)); if (k < 0) return null; t[k] = t[k].replace(/('"\/[^"']+)"'/, "$1'"); return t; }],
  ];
  let ok = true;
  for (const [what, fn] of cases) {
    let refused = '';
    const broken = fn(text.slice());
    if (!broken) { console.log('  plant %s -> not applicable: the file has no such text', what); continue; }
    try { BP.convert(broken.join('\n'), 'plant'); } catch (e) { refused = e.message; }
    const good = /line \d+|ends inside|End Object/.test(refused);
    ok &= good;
    console.log('  plant %s -> %s', what, refused ? 'REFUSED: ' + refused.slice(0, 110) : 'accepted - WRONG');
  }
  console.log('bp plant: ' + (ok ? 'PASS - every broken text refused, naming where' : 'FAIL'));
  return ok ? 0 : 1;
}

const [verb, a, b] = process.argv.slice(2);
if (verb === 'convert' && a && b) process.exit(convertAll(a, b));
if (verb === 'plant' && a) process.exit(plant(a));
console.error('usage: node bp_cli.js convert <in dir> <out dir> | plant <file.t3d>');
process.exit(2);
