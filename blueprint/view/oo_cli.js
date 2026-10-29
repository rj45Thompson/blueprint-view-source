#!/usr/bin/env node
// oo_cli.js - the OO assembly (oo.js) run over a converted paste set, headless.
//
//   node view/oo_cli.js assemble <paste dir> <ngl dir> <trace dir> "<the system's title>"
//     -> <ngl dir>/<set>.classes.cs   the classes AS READ (parsed whole by `U2ue.CodeGraph syntax --printed <ngl dir>`)
//        <trace dir>/classes.json     the class model, the proposals and both diagrams, for the page
//        <paste dir>/CLASSES.md       the diagrams (as read, proposed) and the procedural -> OO table
//
// The native members a class uses on itself are looked up in the engine's own headers (the install UE_ROOT names, the folder
// holding Engine/ - required, never a default path): EVERY class that declares each (one name can be declared by unrelated classes:
// CapsuleComponent by ACharacter and ANavigationObjectBase), with its line, and the chain of parents those classes sit in
// (`class X : public Y`). oo.js reads the parent from them; the headers read are EngineHeaders' below.
'use strict';
const fs = require('fs');
const path = require('path');
const TR = require('./trace.js');
const BP = require('./bp.js');
const OO = require('./oo.js');

const ENGINE = process.env.UE_ROOT ? process.env.UE_ROOT.replace(/\\/g, '/').replace(/\/$/, '') + '/Engine' : null;
// read for every set: the engine's own classes and UObject's
const BASE = ['Source/Runtime/Engine/Classes', 'Source/Runtime/CoreUObject/Public/UObject'];
// folders that hold no module's reflected headers: a ThirdParty library declares no UCLASS; the rest are build output and assets
const NOT_SOURCE = new Set(['ThirdParty', 'Intermediate', 'Binaries', 'Content', 'Resources', 'Shaders', 'Config', 'Documentation', 'Extras', 'Saved', 'DerivedDataCache']);

function readText(f) {
  const buf = fs.readFileSync(f);
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le').slice(1) : buf.toString('utf8').replace(/^\uFEFF/, '');
}

/** a header's path as cited: from Engine/Source for the engine's own modules (Runtime/Engine/Classes/GameFramework/Actor.h), from
 *  Engine/ for a plugin's (Plugins/2D/Paper2D/Source/Paper2D/Classes/PaperCharacter.h) - never the install's own folder */
function cite(f) {
  const p = f.replace(/\\/g, '/');
  return p.startsWith(ENGINE + '/Source/') ? p.slice(ENGINE.length + 8) : p.slice(ENGINE.length + 1);
}

/** ModuleIndex: every module of the install by name -> its folder(s): a folder holding <Name>.Build.cs under Engine/Source or
 *  Engine/Plugins. A module's folder holds no other module, so the walk stops there */
function moduleIndex() {
  const out = new Map();
  const walk = (d) => {
    const ents = fs.readdirSync(d, { withFileTypes: true });
    const b = ents.find((e) => e.isFile() && e.name.endsWith('.Build.cs'));
    if (b) { const m = b.name.slice(0, -'.Build.cs'.length); (out.get(m) || out.set(m, []).get(m)).push(d.replace(/\\/g, '/')); return; }
    for (const e of ents) if (e.isDirectory() && !NOT_SOURCE.has(e.name)) walk(path.join(d, e.name));
  };
  for (const s of ['Source', 'Plugins']) walk(path.join(ENGINE, s));
  return out;
}

/** EngineHeaders: the headers read for a set - BASE always, and the whole folder of every module its pastes name in a
 *  /Script/<Module>. path (a class, struct or enum that module declares: /Script/Paper2D.PaperCharacter). A module the install does
 *  not hold is reported, never skipped silently. -> {files, modules: {Name: [folder]}, missing: [Name]} */
function engineHeaders(pastes) {
  if (!ENGINE) throw new Error('UE_ROOT is not set: name the Unreal install whose headers declare the native members (the folder holding Engine/)');
  const named = new Set();
  for (const text of Object.values(pastes)) for (const m of text.matchAll(/\/Script\/(\w+)\./g)) named.add(m[1]);
  const index = moduleIndex();
  const roots = BASE.map((s) => ENGINE + '/' + s);
  for (const r of roots) if (!fs.existsSync(r)) throw new Error('no engine headers at ' + r + ' (set UE_ROOT)');
  const modules = {}, missing = [];
  for (const m of [...named].sort()) { if (index.has(m)) { modules[m] = index.get(m).map(cite); roots.push(...index.get(m)); } else missing.push(m); }
  const files = new Set();
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = (d + '/' + e.name).replace(/\\/g, '/'); if (e.isDirectory()) { if (!NOT_SOURCE.has(e.name)) walk(p); } else if (e.name.endsWith('.h')) files.add(p); } };
  for (const r of roots) walk(r);
  return { files: [...files].sort(), modules: modules, missing: missing };
}

/** ReflectedDeclaration: does line i declare the member whose name starts at column col, as the engine reflects it? A UFUNCTION or
 *  UPROPERTY must stand within the 8 lines above (the original test), AND be the macro that introduces this declaration: between
 *  its closing parenthesis and the name stands no `;`, `{` or `}` (another declaration's end, or a body) and no `(` left open (a
 *  parameter of another function), comments and string literals set aside. The window alone took four lines that declare nothing
 *  as declarations on these sets: ActorChannel.h:89 and PawnMovementComponent.h:115 (plain members - the UPROPERTY above each
 *  introduces `Actor` at :86 and `PawnOwner` at :112), Pawn.h:500 (a comment) and NiagaraComponent.h:325 (a getter's body) */
function reflectedAt(lines, i, col) {
  if (!/UFUNCTION|UPROPERTY/.test(lines.slice(Math.max(0, i - 8), i).join('\n'))) return false;
  const own = lines[i].slice(0, col);
  if (/^\s*(\*|\/\/|\/\*)/.test(lines[i]) || /\/\/|\/\*/.test(own)) return false;               // a comment line, or the name in one
  let t = lines.slice(Math.max(0, i - 8), i).join('\n') + '\n' + own;
  t = t.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (/\/\*/.test(t)) return false;                                                               // inside a comment opened above
  t = t.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n').replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  let m, last = null;
  const rx = /\b(?:UPROPERTY|UFUNCTION)\s*\(/g;
  while ((m = rx.exec(t))) last = m;
  if (!last) return false;
  let k = last.index + last[0].length, depth = 1;
  while (k < t.length && depth) { if (t[k] === '(') depth++; else if (t[k] === ')') depth--; k++; }
  if (depth) return false;                                                                        // the name is inside the macro's own arguments
  const rest = t.slice(k);
  if (/[;{}]/.test(rest)) return false;
  let d = 0;
  for (const ch of rest) { if (ch === '(') d++; else if (ch === ')' && --d < 0) return false; }
  return d === 0;
}

/** the names line i of a header declares, among those rx (a global regex whose group 1 is a name) finds on it */
function declaredNames(L, i, rx) {
  const out = [];
  rx.lastIndex = 0;
  let m;
  while ((m = rx.exec(L[i]))) if (reflectedAt(L, i, m.index + m[0].indexOf(m[1], 1))) out.push(m[1]);
  return out;
}

/** names, the set's pastes -> {found: {Name: [{cls, at}]} - EVERY class whose header declares a reflected member of that name
 *  (ReflectedDeclaration), each with the line; parents: {Cls: {parent, at}} - the parent each class declares; conflicts: a class
 *  declared twice with two parents; scan: what was read and how long it took}. A name that is not a C++ identifier ("Healthbar
 *  Widget", "LevelText:") is no header's to declare: it is listed as such, not searched for */
function engineFacts(names, pastes) {
  const t0 = Date.now();
  const H = engineHeaders(pastes);
  const tWalk = Date.now() - t0;
  const want = [...new Set(names)].filter((n) => /^[A-Za-z_]\w*$/.test(n)).sort();
  const notIdent = [...new Set(names)].filter((n) => !/^[A-Za-z_]\w*$/.test(n)).sort();
  const NAME = want.length ? new RegExp('(?:\\*|\\s|>)(' + want.join('|') + ')\\s*(?:\\(|;|=)', 'g') : null;
  const CLASS = /^\s*class\s+(?:\w+_API\s+)?([AU][A-Z]\w*)\s*(?:final\s*)?:\s*public\s+([AU][A-Z]\w*)/;
  const found = {}, parents = {}, conflicts = [];
  let lines = 0;
  for (const f of H.files) {
    const L = readText(f).split('\n');
    lines += L.length;
    let current = null;
    for (let i = 0; i < L.length; i++) {
      const c = CLASS.exec(L[i]);
      if (c) {
        current = c[1];
        if (!parents[c[1]]) parents[c[1]] = { parent: c[2], at: cite(f) + ':' + (i + 1) };
        else if (parents[c[1]].parent !== c[2]) conflicts.push(c[1] + ': ' + parents[c[1]].at + ' and ' + cite(f) + ':' + (i + 1));
        continue;
      }
      if (!current || !NAME) continue;
      for (const n of declaredNames(L, i, NAME)) {
        const list = found[n] || (found[n] = []);
        if (!list.some((x) => x.cls === current)) list.push({ cls: current, at: cite(f) + ':' + (i + 1) });
      }
    }
  }
  return { found: found, parents: parents, conflicts: conflicts, notIdent: notIdent,
    scan: { headers: H.files.length, lines: lines, modules: H.modules, missing: H.missing, msFind: tWalk, msRead: Date.now() - t0 - tWalk } };
}

const count = (n, what) => n + ' ' + what + (n === 1 ? '' : 's');

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
  const facts = engineFacts([...natives], pastes);
  const A = OO.assemble(pastes, T, facts.found, facts.parents);
  const shape = OO.proposedShape(A, T, title);
  const P = OO.proposals(A, T, Q);
  const R = OO.reprints(T, Q);
  const D = OO.diagrams(A, P, shape);
  const set = path.basename(path.resolve(pasteDir));
  const cs = OO.printClasses(A, T, set + '.classes.cs');
  fs.writeFileSync(path.join(nglDir, set + '.classes.cs'), cs);
  const json = {
    title: title,
    classes: [...A.classes.values()].map((c) => ({ name: c.name, parent: c.parent, parentWhy: c.parentWhy, parentChain: c.parentChain, components: [...c.components].map(([n, x]) => ({ name: n, type: x.type, why: x.why })),
      fields: [...c.fields].map(([n, f]) => ({ name: n, type: f.type, where: f.where })), methods: c.methods,
      uses: [...c.uses].map(([n, u]) => ({ name: n, kind: u.kind, declared: u.declared, own: u.own, why: u.why, target: [...u.targets.values()].map((t) => ({ cls: t.cls, native: t.native, at: t.at })), declarers: u.declarers, where: u.where })) })),
    interfaces: [...A.interfaces.values()].map((I) => ({ name: I.name, methods: [...I.methods.values()], callers: I.callers, senders: [...I.senders], targets: [...I.targets].map(([t, at]) => ({ type: t, at: at })) })),
    proposals: P, notProposed: R, shape: shape, diagrams: D,
    natives: { asked: [...natives].sort(), found: facts.found, notIdentifiers: facts.notIdent,
      headers: { modules: facts.scan.modules, missing: facts.scan.missing, files: facts.scan.headers, conflicts: facts.conflicts } },
  };
  fs.writeFileSync(path.join(traceDir, 'classes.json'), JSON.stringify(json, null, 1));
  const md = ['# ' + title + ' as classes', '', 'Generated by `view/oo_cli.js`: the Blueprint\'s procedural graphs read back as classes. AS READ: every member from the pasted text, each parent from the',
    'native members a class uses on itself (the engine header that declares each). PROPOSED: the OO shape for what the brainstorm found -',
    'a proposal, not the code.', '', '## As read', '', '```mermaid', D.read, '```', '',
    ...json.classes.map((c) => '- **' + c.name + '**: ' + (c.parent ? (/^[AEIOU]/.test(c.parent) ? 'an ' : 'a ') + c.parent + ' - ' + c.parentWhy : 'parent ABSENT: ' + c.parentWhy) + '; ' + count(c.fields.length, 'field') + ', ' + count(c.methods.length, 'method') + ', ' + count(c.components.length, 'component')),
    '', '## Proposed', '', '```mermaid', D.proposed, '```', '', '## Procedural pattern -> the OO form that removes it', '',
    ...P.map((p) => '- **' + p.pattern + '** (section ' + p.section + '): ' + p.oo + (p.questions.length ? ' - from ' + p.questions.join(', ') : '')), '',
    ...(R.length ? ['## Written twice by the converter, not by the author (not proposed)', '',
      ...R.map((r) => '- **' + r.refs.join(', ') + '**: ' + r.why + ' - ' + r.question), ''] : [])];
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
  console.log('  engine headers: %d (%d lines) of %d modules the pastes name (%s) and the engine\'s own classes; found in %d ms, read in %d ms%s',
    facts.scan.headers, facts.scan.lines, Object.keys(facts.scan.modules).length, Object.keys(facts.scan.modules).join(', '), facts.scan.msFind, facts.scan.msRead,
    facts.scan.missing.length ? '; NOT in the install: ' + facts.scan.missing.join(', ') : '');
  if (facts.conflicts.length) console.log('  classes declared twice with two parents: ' + facts.conflicts.join('; '));
  for (const c of json.classes) console.log('  %s : %s  fields %d, methods %d, components %d%s', c.name, c.parent || '(parent ABSENT)', c.fields.length, c.methods.length, c.components.length, c.parent ? '' : ' - ' + c.parentWhy);
  for (const c of json.classes) { const own = c.uses.filter((u) => u.own); if (own.length) console.log('  %s\'s own, used on itself (components or variables its paste does not declare): %s', c.name, own.map((u) => u.name).join(', ')); }
  for (const c of json.classes) for (const u of c.uses.filter((x) => !x.own && !x.declared)) console.log('  %s.%s: %s', c.name, u.name, u.why);
  if (R.length) console.log('  not proposed: %d run(s) written twice by the converter, not by the author (%s)', R.length, R.map((r) => r.refs[0]).join(', '));
  return 0;
}

/** ClassReadingPlants: each rule of the class reading held to a case it must take and a plant it must refuse - a narrowed or widened
 *  rule that has only ever passed is indistinguishable from one switched off. No engine install needed: the header lines and the
 *  set are written here, after the cases measured on the sample sets (the line each copies is named) */
function selftest() {
  const rows = [];
  const row = (what, ok, said) => { rows.push(ok); console.log('  %s %s%s', ok ? 'ok  ' : 'FAIL', what, ok ? '' : ' - ' + said); };
  const decl = (text, name) => { const L = text.split('\n'); const rx = new RegExp('(?:\\*|\\s|>)(' + name + ')\\s*(?:\\(|;|=)', 'g'); return L.some((l, i) => declaredNames(L, i, rx).includes(name)); };
  // ReflectedDeclaration: two real declarations taken, the four non-declarations of the sets refused, the 8-line window kept
  row('a UPROPERTY member is a declaration (Character.h:262-263)', decl('\tUPROPERTY(Category=Character, VisibleAnywhere, meta=(AllowPrivateAccess = "true"))\n\tTObjectPtr<UCapsuleComponent> CapsuleComponent;', 'CapsuleComponent'), 'refused');
  row('a macro over several lines, a ; inside its string', decl('UPROPERTY(EditAnywhere,\n  meta=(ToolTip="a; b"))\nfloat CustomTimeDilation;', 'CustomTimeDilation'), 'refused');
  row('a plain field under another member\'s UPROPERTY refused (ActorChannel.h:85-89)', !decl('\tUPROPERTY()\n\tTObjectPtr<AActor> Actor;\n\n\tFNetworkGUID\tActorNetGUID;\n\tfloat\t\t\tCustomTimeDilation;', 'CustomTimeDilation'), 'taken');
  row('a comment refused (Pawn.h:500)', !decl('\tUFUNCTION(BlueprintCallable)\n\tFVector GetPendingMovementInputVector() const;\n\n\t/**\n\t * PlayerController -> MovementComponent -> Pawn -> Mesh (animations)', 'Mesh'), 'taken');
  row('a comment opened more than 8 lines above refused', !decl('/**\n' + ' * text\n'.repeat(9) + ' * Members carry UPROPERTY() so the editor sees them.\n * Pawn -> Mesh (animations)\n */', 'Mesh'), 'taken');
  row('a getter\'s body refused (NiagaraComponent.h:324-325)', !decl('\tUFUNCTION(BlueprintCallable, Category = Niagara)\n\tfloat GetCustomTimeDilation() const { return CustomTimeDilation; }', 'CustomTimeDilation'), 'taken');
  row('a parameter refused', !decl('\tUFUNCTION(BlueprintCallable)\n\tvoid SetDilation(float CustomTimeDilation = 1.f);', 'CustomTimeDilation'), 'taken');
  row('a macro more than 8 lines above refused (the original window)', !decl('UPROPERTY()\n\n\n\n\n\n\n\n\nfloat Far;', 'Far'), 'taken');
  // ParentReading on a set written here: AOne and ATwo both declare R, ABase above both declares G
  const H = { AOne: { parent: 'ABase', at: 'One.h:1' }, ATwo: { parent: 'ABase', at: 'Two.h:1' }, ABase: { parent: 'UObject', at: 'Base.h:1' } };
  const use = (declarers, targets) => ({ kind: 'field', where: ['p.t3d:1'], declarers: declarers.map((k) => ({ cls: k, at: k + '.h:9' })), targets: new Map(targets.map(([k, nat]) => [k, { cls: k, native: nat, at: ['p.t3d:1'] }])), declared: null, own: false, why: '' });
  const read = (uses) => { const cl = { name: 'BP_X', uses: new Map(uses) }; OO.readParent(cl, H); return cl; };
  let c = read([['R', use(['AOne', 'ATwo'], [['One', true]])], ['G', use(['ABase'], [['Base', true]])]]);
  row('chains that tie are decided by the Target pin that names one', c.parent === 'One' && /ATwo/.test(c.parentWhy), c.parent + ': ' + c.parentWhy);
  c = read([['R', use(['AOne', 'ATwo'], [])], ['G', use(['ABase'], [])]]);
  row('chains that tie with no Target pin: ABSENT, their common ancestor named as that', c.parent === null && /common ancestor is ABase/.test(c.parentWhy), c.parent + ': ' + c.parentWhy);
  c = read([['R', use(['AOne'], [['Two', true]])]]);
  row('a Target pin the best chain does not hold: ABSENT, both named', c.parent === null && /Two/.test(c.parentWhy), c.parent + ': ' + c.parentWhy);
  c = read([['G', use(['ABase'], [['Base', true]])], ['Own', use([], [['BP_X', false]])], ['Far', use([], [['Elsewhere', true]])]]);
  row('a member its Target pin gives the Blueprint itself is its own; one given another class is not', c.parent === 'Base' && c.uses.get('Own').own && !c.uses.get('Far').own && /Elsewhere/.test(c.uses.get('Far').why), JSON.stringify([c.parent, c.uses.get('Own').own, c.uses.get('Far').own]));
  // CopyOrigin: one run of nodes written twice is a reprint, two runs are copies, the same copies on another path are proposed once
  const T = { units: [{ file: 'p.t3d', line: 10, refs: ['G#s2', 'G#s5'] }, { file: 'p.t3d', line: 11, refs: ['G#s3', 'G#s6'] }, { file: 'p.t3d', line: 20, refs: ['H#s2', 'H#s8'] },
    { file: 'p.t3d', line: 21, refs: ['H#s3', 'H#s9'] }, { file: 'p.t3d', line: 30, refs: ['K#s2', 'K#s8'] }, { file: 'p.t3d', line: 31, refs: ['K#s3', 'K#s9'] }],
  outcomes: [['G#s1:then', ['s2', 's3']], ['G#s4:then', ['s5', 's6']], ['H#s1:then', ['s2', 's3']], ['K#s1:then', ['s2', 's3']], ['H#s7:then', ['s8', 's9']], ['K#s7:then', ['s8', 's9']]].map(([ref, body]) => ({ ref: ref, body: body })) };
  const Q = [{ id: 'Q-DUP.G#s1:then', rule: 'DUP', refs: ['G#s1:then', 'G#s4:then'] }, { id: 'Q-DUP.H#s1:then', rule: 'DUP', refs: ['H#s1:then', 'K#s1:then'] }, { id: 'Q-DUP.H#s7:then', rule: 'DUP', refs: ['H#s7:then', 'K#s7:then'] }];
  const Rp = OO.reprints(T, Q).map((r) => r.question).join();
  row('one run of nodes printed on two paths is not proposed; the same copies again are not proposed twice', Rp === 'Q-DUP.G#s1:then,Q-DUP.H#s7:then', Rp);
  const Pp = OO.proposals({ classes: new Map() }, Object.assign({ graphs: [] }, T), Q).map((p) => p.questions[0]).join();
  row('copies the author drew are proposed, once', Pp === 'Q-DUP.H#s1:then', Pp);
  // proposedShape: a Blueprint interface's name only for the type it is messaged on; two proposals never share a name
  const G = TR.build({ 'x.ngl': 'graph X.Test kind=event at=1:1 returns=void body=[s1 s2]\n  s1 branch cond=#e1 at=2\n    e1 type-test a=Other pat=~"BP_A AsBP_A" t=bool at=3\n' +
    '  s2 branch cond=#e2 at=4\n    e2 type-test a=Other pat=~"BP_B AsBP_B" t=bool at=5\nend\n' });
  const iface = (name, on) => [name, { name: name, methods: new Map([['M', 'M()']]), targets: new Map(on.map((t) => [t, ['p.t3d:1']])), callers: [], senders: new Set() }];
  let S = OO.proposedShape({ classes: new Map(), interfaces: new Map([iface('Hits', ['BP_A', 'Actor'])]) }, G, 'T').interfaces.map((I) => I.name + '<-' + I.implementer).join();
  row('an interface messaged on BP_A names BP_A\'s proposal only', S === 'Hits<-BP_A,IBP_B<-BP_B', S);
  S = OO.proposedShape({ classes: new Map(), interfaces: new Map([iface('Hits', ['Actor'])]) }, G, 'T').interfaces.map((I) => I.name).join();
  row('one messaged on another type names neither', S === 'IBP_A,IBP_B', S);
  let threw = '';
  try { OO.proposedShape({ classes: new Map(), interfaces: new Map([iface('IBP_B', ['BP_A'])]) }, G, 'T'); } catch (e) { threw = e.message; }
  row('two proposals of one name refused', /share the name IBP_B/.test(threw), threw || 'not refused');
  const bad = rows.filter((x) => !x).length;
  console.log('oo selftest: %d checks, %d failed - %s', rows.length, bad, bad ? 'FAIL' : 'PASS');
  return bad ? 1 : 0;
}

const [verb, a, b, c, d] = process.argv.slice(2);
try {
  if (verb === 'assemble' && a && b && c) process.exit(assemble(a, b, c, d || path.basename(path.resolve(a))));
  if (verb === 'selftest') process.exit(selftest());
} catch (e) { console.error('oo: ' + e.message); process.exit(2); }
console.error('usage: node view/oo_cli.js assemble <paste dir> <ngl dir> <trace dir> "<title>" | selftest');
process.exit(2);
