// oo.js - a converted Blueprint assembled as the CLASSES it is, and its procedural patterns named with the OO form that removes them.
//
// The disconnect it answers: a Blueprint project's class hierarchy is object-oriented, but the logic in its graphs is procedural -
// the hierarchy is hidden, encapsulation is lost, and casts stand where an interface call belongs. So a converted Blueprint is read
// back into the classes it belongs to, and each procedural pattern is named with the OO form that would replace it. Two answers,
// kept apart:
//   AS READ    every class the pastes touch, with its fields (typed from the pins that read or write them), its methods (the graphs),
//              its components (the bound events), the interface it is messaged through, and its parent - each READ, with where:
//              a member with a MemberGuid is a Blueprint's variable; one without, used on the class itself, is the engine's or the
//              Blueprint's own component, and ParentReading (below) tells them apart from the engine's headers (oo_cli.js finds
//              every class that declares each) and the paste's own Target pins - so the parent is the most derived native class
//              whose chain holds what the Blueprint uses on itself. Where nothing says, the field is ABSENT and the reason is
//              written, never a guess.
//   PROPOSED   the OO form for each procedural pattern the brainstorm found (view/trace.js QuestionRules), each tied to the questions
//              that motivate it. A proposal is not the code: it is labelled, and nothing here writes the Blueprint.
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const NGL = isNode ? require('./pl.js') : root.NGL;
  const BP = isNode ? require('./bp.js') : root.BP;

  const ident = (s) => String(s).replace(/[^\w]/g, '_');
  // a header's class as the editor names it: ACharacter -> Character, UObject -> Object (the engine's A/U prefix)
  const bare = (k) => String(k).replace(/^[AU](?=[A-Z])/, '');
  const article = (k) => (/^[AEIOU]/.test(k) ? 'an ' : 'a ') + k;

  /** TargetPin: the class the editor typed a member node's Target (self) pin with, READ from that pin's own line in the paste. For a
   *  self-context variable the engine types it with the class that OWNS the property (K2Node_Variable.cpp:153-202 in UE 5.7, the
   *  owner at :170-180; a member it cannot resolve gets the Blueprint's own class, :194); for a function, with the class that first
   *  declared it (BlueprintNodeStatics.cpp:28-60). A component the Blueprint adds itself is a property of its own generated class.
   *  -> {cls, native: a /Script/ class, at: 'file:line'}, or null when the node has none */
  function targetPin(file, lines, o) {
    const p = o.pins.find((x) => x.name === 'self' && x.dir === 'in');
    if (!p) return null;
    const raw = (lines[p.line - 1] || '').trim();
    const v = BP.parseStruct(raw.slice(raw.indexOf('(')))['PinType.PinSubCategoryObject'];
    if (!v || v === 'None') return null;
    return { cls: BP.shortName(v), native: BP.objectPath(v).path.startsWith('/Script/'), at: file + ':' + o.line };
  }

  /** pastes {file: text}, the trace (trace.js build), natives {Name: [{cls, at}]} - every class whose header declares each native
   *  member (oo_cli finds them), hierarchy {Cls: {parent, at}} from the same headers -> {classes, interfaces, owner} */
  function assemble(pastes, T, natives, hierarchy) {
    const classes = new Map();
    const cls = (name) => { if (!classes.has(name)) classes.set(name, { name: name, parent: null, parentChain: [], components: new Map(), fields: new Map(), methods: [], uses: new Map(), why: [] }); return classes.get(name); };
    const interfaces = new Map();
    // 1. the owner of each graph: its converted name's class, or - for a pasted function - the class whose code calls it
    const owner = new Map();
    for (const G of T.graphs) { const c = G.name.split('.')[0]; if (c !== 'Pasted') owner.set(G.alias, { cls: c, why: 'its events\' delegate pins name ' + c + ' (K2Node_Event.cpp:307-319)' }); }
    // the type of a cast's local: `OtherActor is Master_Enemy AsMaster_Enemy_1`
    const localType = new Map();
    for (const G of T.graphs) for (const id of G.g.order) { const n = G.g.nodes.get(id); if (n.kw === 'type-test' && n.attrs.pat) { const [t, v] = NGL.textOf(n.attrs.pat).split(' '); localType.set(G.alias + '|' + v, t); } }
    for (let pass = 0; pass < 4; pass++) {
      for (const c of T.calls) {
        const from = c.from.split('#')[0];
        const fo = owner.get(from);
        if (!fo) continue;
        const target = c.how === 'by name' ? c.to : c.to;
        if (!target || owner.has(target)) continue;
        if (c.how === 'call') owner.set(target, { cls: fo.cls, why: 'called on itself from ' + c.from + ', whose class is ' + fo.cls });
        else {
          const G = T.byAlias.get(from);
          const sid = c.from.split('#')[1];
          const n = G.g.nodes.get(sid);
          const obj = n ? NGL.termText(NGL.listOf(n.attrs.args)[0]) : null;
          if (obj === 'this') owner.set(target, { cls: fo.cls, why: 'run by name on `this` at ' + c.from + ' (a timer finds the function on its Object, KismetSystemLibrary.cpp:673)' });
          else if (obj && localType.has(from + '|' + obj)) owner.set(target, { cls: localType.get(from + '|' + obj), why: 'run by name on ' + obj + ', a ' + localType.get(from + '|' + obj) + ' (the cast at ' + from + '), at ' + c.from + ' (a timer finds the function on its Object, KismetSystemLibrary.cpp:673)' });
        }
      }
    }
    // 2. methods: one per graph, on its owner
    for (const G of T.graphs) {
      const o = owner.get(G.alias);
      const c = cls(o ? o.cls : 'Pasted');
      const params = NGL.listOf(G.g.attrs.params).map((p) => NGL.termText(p).split(':')).map(([n, t]) => t + ' ' + n);
      const outs = NGL.listOf(G.g.attrs.outs).map((p) => NGL.termText(p).split(':')).map(([n, t]) => 'out ' + t + ' ' + n);
      const ret = NGL.termText(G.g.attrs.returns) || 'void';
      c.methods.push({ name: G.name.split('.').pop(), alias: G.alias, title: G.title, kind: G.kind, sig: ret + ' ' + G.name.split('.').pop() + '(' + params.concat(outs).join(', ') + ')', owner: o ? o.why : 'no call in the set says which class runs it' });
    }
    // 3. fields, components, interfaces and the members a class uses on itself, from the nodes
    for (const [file, text] of Object.entries(pastes)) {
      const graphs = T.graphs.filter((G) => G.file.replace(/\.ngl$/, '') === file.replace(/\.t3d$/, ''));
      const fileOwner = graphs.map((G) => owner.get(G.alias)).find(Boolean);
      const selfCls = fileOwner ? fileOwner.cls : 'Pasted';
      const lines = text.split(/\r?\n/);
      const objs = BP.parseText(text).objects.filter((x) => !x.outer);
      const byName = new Map(objs.map((x) => [x.name, x]));
      for (const o of objs) {
        if (o.cls === 'K2Node_VariableGet' || o.cls === 'K2Node_VariableSet') {
          const ref = BP.parseStruct(o.props.VariableReference || '()');
          const name = String(ref.MemberName || '').replace(/^"|"$/g, '');
          if (!name) continue;
          const pin = o.pins.find((p) => p.name === name && p.cat !== 'exec');
          const type = pin ? BP.typeOf(pin) : '?';
          const where = file + ':' + o.line;
          // no MemberGuid: not a Blueprint variable. Used on the class itself, it is a member its parent declares or a component the
          // Blueprint adds (an added component carries no guid either) - ParentReading tells which. Read through another object, it
          // belongs to the class the MemberParent names: a native one (/Script/...) is the engine's, never a class of the set (it
          // drew "Character : Character" and "PaperCharacter : BillboardComponent"); a Blueprint's (a designer widget, a component)
          // is no member used on itself, so no evidence for a parent - neither is assembled here
          if (!ref.MemberGuid) { if (ref.bSelfContext === 'True' || !ref.MemberParent) recordUse(selfCls, name, 'field', where, targetPin(file, lines, o)); continue; }
          const memberOf = ref.bSelfContext === 'True' ? selfCls : ref.MemberParent ? BP.shortName(ref.MemberParent) : selfCls;
          const c = cls(memberOf);
          if (!c.fields.has(name)) c.fields.set(name, { type: type, where: [], external: false });
          c.fields.get(name).where.push(where);
          // read through another class's object (its MemberParent named): part of what that class shows the outside
          if (ref.bSelfContext !== 'True' && ref.MemberParent) c.fields.get(name).external = true;
        } else if (o.cls === 'K2Node_ComponentBoundEvent') {
          const comp = String(o.props.ComponentPropertyName || '').replace(/^"|"$/g, '');
          const base = o.props.DelegateOwnerClass ? BP.shortName(o.props.DelegateOwnerClass) : '?';
          const c = cls(selfCls);
          if (!c.components.has(comp)) c.components.set(comp, { type: base, why: 'bound by ' + BP.eventTitle(o) + ' at ' + file + ':' + o.line + '; its own class is not in the paste - its delegate is declared on ' + base });
        } else if (o.cls === 'K2Node_Message') {
          const fr = BP.parseStruct(o.props.FunctionReference || '()');
          const iface = fr.MemberParent ? BP.shortName(fr.MemberParent) : '?';
          const fn = String(fr.MemberName || '').replace(/^"|"$/g, '');
          if (!interfaces.has(iface)) interfaces.set(iface, { name: iface, methods: new Map(), callers: [], senders: new Set(), targets: new Map() });
          const I = interfaces.get(iface);
          I.senders.add(selfCls);
          const params = o.pins.filter((p) => p.dir === 'in' && p.cat !== 'exec' && p.name !== 'self').map((p) => BP.typeOf(p) + ' ' + ident(p.name));
          I.methods.set(fn, fn + '(' + params.join(', ') + ')');
          I.callers.push(file + ':' + o.line);
          // MessageTarget: the type of what the message is sent to - the pin wired into its Target (a knot carries the wire's
          // type), or the class itself when nothing is wired. proposedShape reuses an interface's name only for a type it is
          // messaged on
          const self = o.pins.find((p) => p.name === 'self' && p.dir === 'in');
          const wired = (self ? self.linked : []).map((l) => { const n = byName.get(l.node); const sp = n && n.pins.find((q) => q.id === l.pin); return sp && sp.subObj; });
          for (const t of wired.length ? wired : [selfCls]) if (t) (I.targets.get(t) || I.targets.set(t, []).get(t)).push(file + ':' + o.line);
        } else if (o.cls === 'K2Node_CallFunction') {
          const fr = BP.parseStruct(o.props.FunctionReference || '()');
          if (fr.bSelfContext === 'True' && !fr.MemberGuid) recordUse(selfCls, String(fr.MemberName || '').replace(/^"|"$/g, ''), 'function', file + ':' + o.line, targetPin(file, lines, o));
        }
      }
    }
    // a member the class uses on itself with no MemberGuid: where it is used, every class the headers say declares one of that name,
    // and the class its Target pin names
    function recordUse(memberOf, name, kind, where, target) {
      const c = cls(memberOf);
      if (!c.uses.has(name)) c.uses.set(name, { kind: kind, where: [], declarers: (natives && natives[name]) || [], targets: new Map(), declared: null, own: false, why: '' });
      const u = c.uses.get(name);
      u.where.push(where);
      if (target) { if (!u.targets.has(target.cls)) u.targets.set(target.cls, { cls: target.cls, native: target.native, at: [] }); u.targets.get(target.cls).at.push(target.at); }
    }
    // 4. the parent of each class, read from the members it uses on itself (ParentReading)
    for (const c of classes.values()) readParent(c, hierarchy || {});
    return { classes: classes, interfaces: interfaces, owner: owner };
  }

  /** ParentReading: a Blueprint's native parent, from the members it uses on itself, on two channels.
   *    the headers  every class whose header declares a member of that name (oo_cli engineFacts) is a candidate; a candidate's chain
   *                 is itself and the parents the same headers declare (`class X : public Y`), and it scores the members its chain
   *                 declares. The most wins; winners all on one chain give the most derived.
   *    the paste    each member's Target pin names the class that owns it (TargetPin). A candidate whose chain does not hold that
   *                 class is contradicted. Winners on different branches are decided by the one the Target pins do not contradict;
   *                 a winner they contradict is no parent.
   *  No winner left: ABSENT, naming the winners and their common ancestor (said as that, never as the parent). A member no class on
   *  the parent's chain declares is the Blueprint's own (a component or variable its paste does not declare) - never evidence for
   *  the parent - when its Target pin names the Blueprint itself; a Target pin naming another class is said, not hidden.
   *  Sets c.parent ('Character'), c.parentWhy, c.parentChain [{cls, at}] and each use's declared {cls, at}, own and why */
  function readParent(c, hierarchy) {
    const uses = [...c.uses.entries()];
    const chainOf = (k) => { const out = []; for (let x = k; x && !out.includes(x); x = hierarchy[x] && hierarchy[x].parent) out.push(x); return out; };
    const cand = new Map();
    for (const [, u] of uses) for (const d of u.declarers) if (!cand.has(d.cls)) cand.set(d.cls, { chain: chainOf(d.cls), covers: [] });
    for (const [k, x] of cand) x.covers = uses.filter(([, u]) => u.declarers.some((d) => x.chain.includes(d.cls))).map(([n]) => n);
    // the Target pins a candidate's chain does not hold, among the members it claims
    const contradicted = (k) => cand.get(k).covers.flatMap((n) => [...c.uses.get(n).targets.values()].filter((t) => !cand.get(k).chain.some((x) => bare(x) === t.cls)).map((t) => n + '\'s Target pin names ' + t.cls + ' (' + t.at[0] + ')'));
    const top = (ws) => ws.find((w) => ws.every((v) => cand.get(w).chain.includes(v))) || null;
    const best = cand.size ? Math.max(...[...cand.values()].map((x) => x.covers.length)) : 0;
    const winners = [...cand.keys()].filter((k) => cand.get(k).covers.length === best).sort();
    let W = top(winners), decided = '', absent = '';
    if (!uses.length) absent = 'no native member it uses on itself names a class';
    else if (!cand.size) absent = 'none of the ' + uses.length + ' members it uses on itself is declared in the engine headers read (' + uses.map(([n]) => n).join(', ') + ')';
    else if (W && contradicted(W).length) { absent = 'the headers\' best chain is ' + W + '\'s (' + best + ' of the ' + uses.length + ' members it uses on itself), but ' + contradicted(W).join('; ') + ', which that chain does not hold'; W = null; }
    else if (!W) {
      const ok = winners.filter((k) => !contradicted(k).length);
      const W2 = top(ok);
      const common = winners.map((k) => cand.get(k).chain).reduce((a, ch) => a.filter((x) => ch.includes(x)))[0];
      const tie = 'the headers declare ' + best + ' of the ' + uses.length + ' members it uses on itself on each of ' + winners.length + ' chains that part: ' + winners.join(', ');
      if (W2) { W = W2; decided = '; ' + tie + ' - ' + [...new Set(winners.filter((k) => contradicted(k).length).map((k) => contradicted(k)[0]))].join('; ') + ', which ' + W2 + '\'s chain holds and the others\' do not'; }
      else absent = tie + (common ? '. Their common ancestor is ' + common + ' (' + (hierarchy[common] ? hierarchy[common].at : 'its header not read') + '): it is at least ' + article(bare(common)) + ', which of them is not read' : '; they share no ancestor in the headers read');
    }
    // each member: the declaration C++ finds first from the parent (the most derived on its chain), else whose it is
    const chain = W ? cand.get(W).chain : [];
    for (const [n, u] of uses) {
      const d = chain.map((k) => u.declarers.find((x) => x.cls === k)).find(Boolean);
      const t = [...u.targets.values()];
      if (d) { u.declared = { cls: d.cls, at: d.at }; u.own = false; u.why = 'declared on ' + d.cls + ' (' + d.at + ')' + (t.length ? '; its Target pin names ' + t.map((x) => x.cls).join(', ') : ''); continue; }
      u.declared = null;
      const elsewhere = u.declarers.length ? '; the headers declare one of that name only on ' + u.declarers.map((x) => x.cls + ' (' + x.at + ')').join(', ') : '';
      if (t.length === 1 && !t[0].native && t[0].cls === c.name) { u.own = true; u.why = 'its own: a component or variable ' + c.name + ' adds, which its paste does not declare - its Target pin names ' + c.name + ' itself (' + t[0].at[0] + ')' + elsewhere; }
      else if (!t.length && W) { u.own = true; u.why = 'its own: no class on ' + W + '\'s chain declares it, and no Target pin says where it is declared' + elsewhere; }
      else if (!t.length) { u.own = false; u.why = 'no Target pin says where it is declared' + (u.declarers.length ? elsewhere.replace(/^; /, ', and ') : ', and no header read declares it'); }
      else { u.own = false; u.why = 'its Target pin names ' + t.map((x) => x.cls + (x.native ? '' : ' (a Blueprint)') + ' (' + x.at[0] + ')').join(', ') + (W ? ', which ' + W + '\'s chain does not hold in the headers read' : '') + elsewhere; }
    }
    const own = uses.filter(([, u]) => u.own).map(([n]) => n);
    const ownSaid = own.length ? '. Its own, not on that chain: ' + own.join(', ') : '';
    if (!W) {
      c.parent = null; c.parentChain = [];
      c.parentWhy = absent + (own.length ? '. Its own (each Target pin names ' + c.name + '): ' + own.join(', ') : '');
      return;
    }
    c.parent = bare(W);
    c.parentChain = chain.map((k) => ({ cls: k, at: hierarchy[k] ? hierarchy[k].at : null }));
    const runners = [...cand.entries()].filter(([k, x]) => !chain.includes(k) && x.covers.length).sort((a, b) => b[1].covers.length - a[1].covers.length || (a[0] < b[0] ? -1 : 1));
    const next = runners.length ? runners[0][1].covers.length : 0;
    c.parentWhy = 'uses ' + uses.filter(([, u]) => u.declared).map(([n, u]) => n + ' (' + u.declared.at + ')').join(', ') + ' on itself: ' + article(c.parent) + ' or a child of it' + decided +
      (runners.length && !decided ? '. Its chain declares ' + best + ' of the ' + uses.length + ' members it uses on itself; the next best, ' + next + ' (' + runners.filter(([, x]) => x.covers.length === next).map(([k]) => k).join(', ') + ')' : '') + ownSaid;
  }

  /** C# for the classes AS READ: every member with where it was read; method bodies are the converted graphs (pl.js printCs) */
  function printClasses(A, T, label) {
    const L = [];
    L.push('// ' + label + ' - ASSEMBLED by view/oo.js from the pasted Blueprint text: the classes it is, read back from its graphs.');
    L.push('// Every member is READ from the pastes, with where. A parent comes from the native members a class uses on itself; a class');
    L.push('// whose parent nothing states has none written. This is a reading form: no engine declarations, so it parses, it does not compile.');
    L.push('using System.Collections.Generic;');
    L.push('');
    for (const I of A.interfaces.values()) {
      L.push('/// <summary>A Blueprint interface, messaged at ' + I.callers.length + ' place(s) (' + I.callers.slice(0, 3).join(', ') + '); who implements it is not in the pastes</summary>');
      L.push('public interface ' + ident(I.name) + ' {');
      for (const sig of I.methods.values()) L.push('    void ' + sig + ';');
      L.push('}');
      L.push('');
    }
    for (const c of A.classes.values()) {
      L.push('/// <summary>' + c.name + ': ' + (c.parent ? c.parentWhy : 'parent ABSENT - ' + c.parentWhy) + '</summary>');
      L.push('public partial class ' + ident(c.name) + (c.parent ? ' : ' + ident(c.parent) : ''));
      L.push('{');
      for (const [n, comp] of c.components) L.push('    public ' + ident(comp.type) + ' ' + ident(n) + ';   // component: ' + comp.why);
      for (const [n, f] of c.fields) L.push('    public ' + f.type + ' ' + ident(n) + ';   // read at ' + f.where.slice(0, 3).join(', ') + (f.where.length > 3 ? ' (+' + (f.where.length - 3) + ')' : ''));
      const usedAs = (f) => [...c.uses].filter(([, u]) => f(u)).map(([n]) => n);
      if (usedAs((u) => u.declared).length) L.push('    // uses on itself (native, declared on its parent\'s chain): ' + usedAs((u) => u.declared).join(', '));
      if (usedAs((u) => u.own).length) L.push('    // uses on itself (its own: components or variables its paste does not declare): ' + usedAs((u) => u.own).join(', '));
      if (usedAs((u) => !u.declared && !u.own).length) L.push('    // uses on itself (where each is declared is not read here): ' + usedAs((u) => !u.declared && !u.own).join(', '));
      for (const m of c.methods) {
        const G = T.byAlias.get(m.alias);
        L.push('');
        L.push('    /// <summary>' + (m.title || m.name) + ' (' + m.kind + '; ' + m.owner + ')</summary>');
        L.push('    public ' + m.sig);
        for (const line of NGL.printCs(G.g).split('\n')) L.push('    ' + line);
      }
      L.push('}');
      L.push('');
    }
    return L.join('\n');
  }

  /** CopyOrigin: where the copies of a run the trace finds written twice (QuestionRules DUP) come from, told apart by the Blueprint
   *  nodes behind each statement (the trace's units, by their line in the paste). The converter writes a node that several exec
   *  wires reach once per path (bp.js; it notes the later prints "shared: this step is also reached by another path"), so one run of
   *  nodes can stand in the code twice: every position of every copy from the SAME nodes is that reprint - one rule in the
   *  Blueprint, nothing to extract. Every position from nodes no other copy shares is a copy the author drew.
   *  -> {kind: 'reprint' | 'copy' | 'mixed' | 'unread', positions, same and apart (the positions each way), first: each copy's
   *  first node (file:line), run: the first copy's nodes, sig: every copy's nodes, which DupReading compares} */
  // a trace -> Map(statement ref -> the Blueprint node(s) it was written from, file:line): its OWN nodes, not the pure ones written
  // inline into it (those feed several statements, so they tell no copy apart)
  const NODES = new WeakMap();
  const byLine = (a, b) => { const [fa, la] = a.split(':'), [fb, lb] = b.split(':'); return fa < fb ? -1 : fa > fb ? 1 : la - lb; };
  function copyOrigin(T, q) {
    if (!NODES.has(T)) { const m = new Map(); for (const u of T.units) if (!u.inline) for (const r of u.refs) (m.get(r) || m.set(r, new Set()).get(r)).add(u.file + ':' + u.line); NODES.set(T, m); }
    const nodesOf = (ref) => [...(NODES.get(T).get(ref) || [])].sort(byLine);
    const body = (ref) => { const o = T.outcomes.find((x) => x.ref === ref); return o ? o.body.map((id) => ref.split('#')[0] + '#' + id) : []; };
    const copies = q.refs.map(body);
    const n = Math.min(...copies.map((b) => b.length));
    let same = 0, apart = 0, unread = 0;
    for (let k = 0; k < n; k++) {
      const sets = copies.map((b) => nodesOf(b[k]));
      if (sets.some((s) => !s.length)) { unread++; continue; }
      if (sets.every((s) => s.join() === sets[0].join())) same++;
      else if (sets.every((s, i) => sets.every((s2, j) => i === j || !s.some((x) => s2.includes(x))))) apart++;
    }
    const kind = !n || unread ? 'unread' : same === n ? 'reprint' : apart === n ? 'copy' : 'mixed';
    return { kind: kind, same: same, apart: apart, positions: n, first: copies.map((b) => nodesOf(b[0])[0]), run: copies[0].slice(0, n).map((r) => nodesOf(r)[0]),
      sig: kind === 'unread' ? null : copies.map((b) => b.slice(0, n).map((r) => nodesOf(r).join('+')).join(',')).sort().join(' | ') };
  }

  /** DupReading: each run the trace finds written twice (QuestionRules DUP), in question order, read by CopyOrigin. A reprint is
   *  never proposed; copies drawn from the very Blueprint nodes of copies already read are that duplication again, reached by
   *  another path of each graph (Swing_down#s39 and Punch#s39 print the nodes of Swing_down#s22 and Punch#s22), so it is proposed
   *  once. -> [{q, o: CopyOrigin, again: the question id it repeats, or null}] */
  function dupReadings(T, Q) {
    const seen = new Map();
    return Q.filter((q) => q.rule === 'DUP').map((q) => {
      const o = copyOrigin(T, q);
      const again = o.sig && o.kind !== 'reprint' && seen.has(o.sig) ? seen.get(o.sig) : null;
      if (o.sig && !seen.has(o.sig)) seen.set(o.sig, q.id);
      return { q: q, o: o, again: again };
    });
  }

  /** the runs the trace finds written twice that are no duplication to extract (DupReading): ONE run of Blueprint nodes the converter
   *  wrote once per path, or copies already proposed, reached again by another path. Listed with their nodes, never proposed
   *  -> [{refs, nodes, why, question}] */
  function reprints(T, Q) {
    return dupReadings(T, Q).filter((d) => d.o.kind === 'reprint' || d.again).map(({ q, o, again }) => ({ refs: q.refs, nodes: again ? o.first : o.run, question: q.id,
      why: again ? 'the copies of ' + again + ' again - the same Blueprint nodes, statement for statement (first statements ' + o.first.join(', ') + ') - reached by another path of each graph, which the converter writes once per path: proposed once, there'
        : 'each of its ' + o.positions + ' statements comes from the same Blueprint node(s) in every copy (' + o.run.join(', ') + '): one run in the Blueprint that ' + q.refs.length + ' paths reach, which the converter writes once per path - nothing to extract' }));
  }

  /** the procedural patterns the brainstorm found, each with the OO form that removes it - PROPOSED, never applied */
  function proposals(A, T, Q) {
    const out = [];
    const by = (rule) => Q.filter((q) => q.rule === rule);
    const castCount = T.graphs.reduce((s, G) => s + G.g.order.filter((id) => G.g.nodes.get(id).kw === 'type-test').length, 0);
    if (castCount) out.push({ pattern: 'the casting trap: ' + castCount + ' Cast To nodes test an actor\'s class before using it', oo: 'an interface the cast class implements, holding the members the code reads through the cast; the code asks the interface instead of casting', questions: by('ELSE').filter((q) => /\(\w+ is \w+ \w+\)/.test(q.text)).map((q) => q.id), section: '2: The Casting Trap' });
    // a run written twice is proposed for extraction only when the author drew it twice (CopyOrigin), and once (DupReading): the
    // copies' own nodes say so
    for (const { q, o, again } of dupReadings(T, Q)) {
      if (o.kind === 'reprint' || again) continue;
      const said = o.kind === 'copy' ? ', each copy drawn from its own Blueprint nodes (first statements: ' + o.first.join(', ') + ')'
        : o.kind === 'mixed' ? ', drawn from their own Blueprint nodes at ' + o.apart + ' of its ' + o.positions + ' statements and from the same nodes at ' + o.same + ' (first statements: ' + o.first.join(', ') + ')'
        : ' (the Blueprint nodes behind some of its statements are not read)';
      out.push({ pattern: 'the same statements written twice (' + q.refs.join(', ') + ')' + said, oo: 'extract one method and call it from ' + (q.refs.length === 2 ? 'both places' : 'all ' + q.refs.length + ' places'), questions: [q.id], section: '2: The Lack of Encapsulation' });
    }
    const ev = by('EVENTCALL');
    if (ev.length) out.push({ pattern: ev.length + ' events fired like function calls (' + ev.map((q) => q.id.split('.').pop()).join(', ') + ')', oo: 'private methods of the class: called in order, can return a result, cannot be fired from outside', questions: ev.map((q) => q.id), section: '2: The Lack of Encapsulation' });
    const nm = by('NAME');
    if (nm.length) out.push({ pattern: nm.length + ' functions run by a NAME in a string (' + nm.map((q) => q.id.split('.').pop()).join(', ') + ')', oo: 'a delegate bound to the method itself: a rename is a compile error, and the reference shows in a search', questions: nm.map((q) => q.id), section: '3: Invisible Relationships' });
    const wr = by('WRITE');
    for (const q of wr) out.push({ pattern: q.id.split('.').pop() + ' written by ' + new Set(q.refs.map((r) => r.split('#')[0])).size + ' graphs', oo: 'one owner: a private field behind a single method that changes it (and tells whoever must know)', questions: [q.id], section: '2: The Lack of Encapsulation' });
    // cohesion: the members of the Blueprint class that only the lock-on uses -> a component
    for (const c of A.classes.values()) {
      if (c.fields.size >= 5 && c.components.size) out.push({ pattern: c.name + ' carries ' + c.fields.size + ' fields, ' + c.components.size + (c.components.size === 1 ? ' component' : ' components') + ' and ' + c.methods.length + ' methods that are all one behaviour', oo: 'one component any ' + (c.parent || 'owner') + ' can add (composition), named after the system: ' + c.name + ' keeps being a ' + (c.parent || 'what it is') + ', the behaviour moves out of its graph', questions: [], section: '2: The Hiding of the Hierarchy' });
    }
    const tm = by('TIMER');
    if (tm.length) out.push({ pattern: 'state polled by looping timers (' + tm.map((q) => q.id.split('.').pop()).join(', ') + ')', oo: 'ask when needed instead of polling: compute the value where it is used, and update on the owner\'s own tick', questions: tm.map((q) => q.id), section: '5: Data as Flowing Water' });
    return out;
  }

  /** the OO shape PROPOSED for what was read, generated - never written per sample: the class a cast tests for, with the members
   *  read through it, becomes an interface - named I<Class>, or, when the pastes show ONE Blueprint interface messaged on that very
   *  type (MessageTarget) and on no other cast target, that interface, extended; the Blueprint class's own fields and methods become
   *  one component named after the system's own title (the author's word for it). Two proposed interfaces never share a name */
  function proposedShape(A, T, title) {
    const castTo = new Set();
    for (const G of T.graphs) for (const id of G.g.order) { const n = G.g.nodes.get(id); if (n.kw === 'type-test' && n.attrs.pat) castTo.add(NGL.textOf(n.attrs.pat).split(' ')[0]); }
    const shape = { interfaces: [], components: [] };
    for (const X of castTo) {
      const target = A.classes.get(X);
      const on = [...A.interfaces.values()].filter((I) => I.targets.has(X));
      const reuse = on.length === 1 && ![...castTo].some((Y) => Y !== X && on[0].targets.has(Y)) ? on[0] : null;
      const reads = target ? [...target.fields.entries()].filter(([, f]) => f.external) : [];
      shape.interfaces.push({ name: reuse ? ident(reuse.name) : 'I' + ident(X), implementer: X,
        members: reads.map(([n, f]) => f.type + ' ' + ident(n) + ' { get; }').concat(on.flatMap((I) => [...I.methods.values()].map((s) => 'void ' + s))),
        why: 'the code casts to ' + X + ' to reach ' + (reads.length ? reads.map(([n]) => n).join(', ') : 'its members') +
          (on.length ? ', and messages it through ' + on.map((I) => { const at = I.targets.get(X); return I.name + ' (sent to ' + article(X) + ' at ' + at.slice(0, 2).join(', ') + (at.length > 2 ? ' and ' + (at.length - 2) + ' more' : '') + ')'; }).join(', ') : '') });
    }
    const names = shape.interfaces.map((I) => I.name);
    const twice = names.filter((n, i) => names.indexOf(n) !== i);
    if (twice.length) throw new Error('two proposed interfaces share the name ' + twice.join(', ') + ': ' + shape.interfaces.map((I) => I.name + ' <- ' + I.implementer).join(', '));
    for (const c of A.classes.values()) {
      if (!c.components.size || !c.fields.size) continue;
      shape.components.push({ name: ident(String(title || c.name).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join('')) + 'Component', owner: c.name,
        fields: [...c.fields.keys()], components: [...c.components.keys()], methods: c.methods.map((m) => m.title || m.name) });
    }
    return shape;
  }

  /** mermaid class diagrams: as read, and the proposed shape (proposedShape), both generated */
  function diagrams(A, P, shape) {
    const read = ['classDiagram'];
    for (const I of A.interfaces.values()) { read.push('  class ' + ident(I.name) + ' {', '    <<interface>>'); for (const m of I.methods.keys()) read.push('    +' + ident(m) + '()'); read.push('  }'); }
    for (const c of A.classes.values()) {
      read.push('  class ' + ident(c.name) + ' {');
      for (const [n, f] of c.fields) read.push('    +' + f.type.replace(/[<>]/g, '~') + ' ' + ident(n));
      // the method's REAL name (a bound event's is long: BndEvt__...), so the diagram can be held to the code by uml.py check
      for (const m of c.methods) read.push('    +' + ident(m.name) + '()');
      read.push('  }');
      if (c.parent) read.push('  ' + ident(c.parent) + ' <|-- ' + ident(c.name));
      for (const [n, comp] of c.components) read.push('  ' + ident(c.name) + ' *-- ' + ident(comp.type) + ' : ' + ident(n));
    }
    for (const I of A.interfaces.values()) for (const s of I.senders) read.push('  ' + ident(s) + ' ..> ' + ident(I.name) + ' : messages');
    const prop = ['classDiagram'];
    for (const I of shape.interfaces) {
      prop.push('  class ' + I.name + ' {', '    <<interface>>');
      for (const m of I.members) prop.push('    +' + m.replace(/[<>]/g, '~').replace(/\{ get; \}/, '').trim());
      prop.push('  }', '  ' + I.name + ' <|.. ' + ident(I.implementer));
    }
    for (const C of shape.components) {
      prop.push('  class ' + C.name + ' {');
      for (const f of C.fields) prop.push('    -' + ident(f));
      for (const m of C.methods) prop.push('    +' + ident(m).replace(/_+/g, '_') + '()');
      prop.push('  }', '  ' + ident(C.owner) + ' *-- ' + C.name);
      const owner = A.classes.get(C.owner);
      if (owner && owner.parent) prop.push('  ' + ident(owner.parent) + ' <|-- ' + ident(C.owner));
      for (const I of shape.interfaces) prop.push('  ' + C.name + ' --> ' + I.name + ' : asks, never casts');
    }
    return { read: read.join('\n'), proposed: prop.join('\n') };
  }

  const api = { assemble: assemble, printClasses: printClasses, proposals: proposals, reprints: reprints, copyOrigin: copyOrigin, diagrams: diagrams, proposedShape: proposedShape, readParent: readParent };
  if (isNode) module.exports = api;
  else root.OO = api;
})(typeof self !== 'undefined' ? self : this);
