#!/usr/bin/env node
// oo_cli.js - the OO assembly (oo.js) run over a converted paste set, headless.
//
//   node view/oo_cli.js assemble <paste dir> <ngl dir> <trace dir> "<the system's title>"
//     -> <ngl dir>/<set>.classes.cs   the classes AS READ (parsed whole by `U2ue.CodeGraph syntax --printed <ngl dir>`)
//        <trace dir>/classes.json     the class model, the proposals and both diagrams, for the page
//        <paste dir>/CLASSES.md       the diagrams (as read, proposed) and the procedural -> OO table
//
// The native members a class uses on itself are looked up in the engine's own headers (the install UE_ROOT names, the folder
// holding Engine/ - required, never a default path): the class that declares each, with its line, and the chain of parents those
// classes sit in (`class X : public Y`).
'use strict';
const fs = require('fs');
const path = require('path');
const TR = require('./trace.js');
const BP = require('./bp.js');
const OO = require('./oo.js');

const UE = process.env.UE_ROOT ? process.env.UE_ROOT.replace(/\\/g, '/').replace(/\/$/, '') + '/Engine/Source/Runtime' : null;
const SCAN = ['Engine/Classes', 'CoreUObject/Public/UObject'];

function readText(f) {
  const buf = fs.readFileSync(f);
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le').slice(1) : buf.toString('utf8').replace(/^\uFEFF/, '');
}

function headers() {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.h')) out.push(p); } };
  if (!UE) throw new Error('UE_ROOT is not set: name the Unreal install whose headers declare the native members (the folder holding Engine/)');
  for (const s of SCAN) { const d = path.join(UE, s); if (!fs.existsSync(d)) throw new Error('no engine headers at ' + d + ' (set UE_ROOT)'); walk(d); }
  return out;
}

/** names -> {Name: {cls, at}}: the reflected member (a UFUNCTION or UPROPERTY within the 8 lines above) of that name, and the class
 *  around it; plus the parent of every class the headers declare */
function engineFacts(names) {
  const want = new Set(names);
  const found = {};
  const parents = {};
  const CLASS = /^\s*class\s+(?:\w+_API\s+)?([AU][A-Z]\w*)\s*(?:final\s*)?:\s*public\s+([AU][A-Z]\w*)/;
  for (const f of headers()) {
    const lines = readText(f).split('\n');
    let current = null;
    for (let i = 0; i < lines.length; i++) {
      const c = CLASS.exec(lines[i]);
      if (c) { current = c[1]; if (!parents[c[1]]) parents[c[1]] = { parent: c[2], at: f.replace(/\\/g, '/').split('/Source/')[1] + ':' + (i + 1) }; continue; }
      if (!current) continue;
      for (const name of want) {
        if (found[name]) continue;
        const rx = new RegExp('(?:\\*|\\s|>)' + name + '\\s*(?:\\(|;|=)');
        if (!rx.test(lines[i])) continue;
        const above = lines.slice(Math.max(0, i - 8), i).join('\n');
        if (!/UFUNCTION|UPROPERTY/.test(above)) continue;
        found[name] = { cls: current, at: f.replace(/\\/g, '/').split('/Source/')[1] + ':' + (i + 1) };
      }
    }
  }
  return { found: found, parents: parents };
}

function assemble(pasteDir, nglDir, traceDir, title) {
  const ngl = {}, pastes = {};
  for (const f of fs.readdirSync(nglDir).filter((x) => x.endsWith('.ngl')).sort()) ngl[f] = readText(path.join(nglDir, f));
  for (const f of fs.readdirSync(pasteDir).filter((x) => x.endsWith('.t3d')).sort()) pastes[f] = readText(path.join(pasteDir, f));
  const T = TR.build(ngl, pastes);
  const Q = TR.questions(T);
  // the native members used on a class itself: no MemberGuid, self context
  const natives = new Set();
  for (const text of Object.values(pastes)) for (const o of BP.parseText(text).objects.filter((x) => !x.outer)) {
    const raw = o.props.VariableReference || o.props.FunctionReference;
    if (!raw) continue;
    const r = BP.parseStruct(raw);
    if (r.bSelfContext === 'True' && !r.MemberGuid) natives.add(String(r.MemberName).replace(/^"|"$/g, ''));
  }
  const facts = engineFacts([...natives]);
  const A = OO.assemble(pastes, T, facts.found, facts.parents);
  const shape = OO.proposedShape(A, T, title);
  const P = OO.proposals(A, T, Q);
  const D = OO.diagrams(A, P, shape);
  const set = path.basename(path.resolve(pasteDir));
  const cs = OO.printClasses(A, T, set + '.classes.cs');
  fs.writeFileSync(path.join(nglDir, set + '.classes.cs'), cs);
  const json = {
    title: title,
    classes: [...A.classes.values()].map((c) => ({ name: c.name, parent: c.parent, parentWhy: c.parentWhy, components: [...c.components].map(([n, x]) => ({ name: n, type: x.type, why: x.why })),
      fields: [...c.fields].map(([n, f]) => ({ name: n, type: f.type, where: f.where })), methods: c.methods, uses: [...c.uses].map(([n, u]) => ({ name: n, kind: u.kind, declared: u.declared, where: u.where })) })),
    interfaces: [...A.interfaces.values()].map((I) => ({ name: I.name, methods: [...I.methods.values()], callers: I.callers, senders: [...I.senders] })),
    proposals: P, shape: shape, diagrams: D,
    natives: { asked: [...natives].sort(), found: facts.found },
  };
  fs.writeFileSync(path.join(traceDir, 'classes.json'), JSON.stringify(json, null, 1));
  const md = ['# ' + title + ' as classes', '', 'Generated by `view/oo_cli.js`: the Blueprint\'s procedural graphs read back as classes. AS READ: every member from the pasted text, each parent from the',
    'native members a class uses on itself (the engine header that declares each). PROPOSED: the OO shape for what the brainstorm found -',
    'a proposal, not the code.', '', '## As read', '', '```mermaid', D.read, '```', '',
    ...json.classes.map((c) => '- **' + c.name + '**: ' + (c.parent ? 'a ' + c.parent + ' - ' + c.parentWhy : 'parent ABSENT: ' + c.parentWhy) + '; ' + c.fields.length + ' fields, ' + c.methods.length + ' methods, ' + c.components.length + ' components'),
    '', '## Proposed', '', '```mermaid', D.proposed, '```', '', '## Procedural pattern -> the OO form that removes it', '',
    ...P.map((p) => '- **' + p.pattern + '** (section ' + p.section + '): ' + p.oo + (p.questions.length ? ' - from ' + p.questions.join(', ') : '')), ''];
  fs.writeFileSync(path.join(pasteDir, 'CLASSES.md'), md.join('\n'));
  // the AS READ diagram alone, for the toolkit's UML gate (uml.py check --doc): every name in it must be in the assembled code
  // the names in backticks are what the gate reads (a name inside the mermaid block is drawing, not a claim it can check): every type
  // and every Type.Method() of the diagram, each held to THAT type by uml.py's dotted rule
  const names = [];
  for (const c of json.classes) { names.push('`' + c.name + '`'); for (const m of c.methods) names.push('`' + c.name + '.' + m.name + '()`'); }
  for (const I of json.interfaces) names.push('`' + I.name + '`');
  fs.writeFileSync(path.join(pasteDir, 'CLASSES_AS_READ.md'), ['# ' + title + ': the classes as read', '',
    'Generated by view/oo_cli.js; held to the assembled C# by uml.py check --names-only.', '', '```mermaid', D.read, '```', '',
    'Names held to the code: ' + names.join(', '), ''].join('\n'));
  console.log('oo assemble: %d classes, %d interfaces, %d proposals; native members asked %d, found in the engine %d',
    json.classes.length, json.interfaces.length, P.length, natives.size, Object.keys(facts.found).length);
  for (const c of json.classes) console.log('  %s : %s  fields %d, methods %d, components %d%s', c.name, c.parent || '(parent ABSENT)', c.fields.length, c.methods.length, c.components.length, c.parent ? '' : ' - ' + c.parentWhy);
  const missing = [...natives].filter((n) => !facts.found[n]);
  if (missing.length) console.log('  native members not found in the scanned headers: ' + missing.join(', '));
  return 0;
}

const [verb, a, b, c, d] = process.argv.slice(2);
try {
  if (verb === 'assemble' && a && b && c) process.exit(assemble(a, b, c, d || path.basename(path.resolve(a))));
} catch (e) { console.error('oo: ' + e.message); process.exit(2); }
console.error('usage: node view/oo_cli.js assemble <paste dir> <ngl dir> <trace dir> "<title>"');
process.exit(2);
