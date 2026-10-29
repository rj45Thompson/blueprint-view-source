// oo.js - a converted Blueprint assembled as the CLASSES it is, and its procedural patterns named with the OO form that removes them.
//
// The disconnect it answers: a Blueprint project's class hierarchy is object-oriented, but the logic in its graphs is procedural -
// the hierarchy is hidden, encapsulation is lost, and casts stand where an interface call belongs. So a converted Blueprint is read
// back into the classes it belongs to, and each procedural pattern is named with the OO form that would replace it. Two answers,
// kept apart:
//   AS READ    every class the pastes touch, with its fields (typed from the pins that read or write them), its methods (the graphs),
//              its components (the bound events), the interface it is messaged through, and its parent - each READ, with where:
//              a member with a MemberGuid is declared by a Blueprint; one without is native, and the engine header that declares it
//              (found by oo_cli.js) names the class it belongs to - so the parent is the most derived native class the Blueprint
//              uses on itself. Where nothing says, the field is ABSENT and the reason is written, never a guess.
//   PROPOSED   the OO form for each procedural pattern the brainstorm found (view/trace.js QuestionRules), each tied to the questions
//              that motivate it. A proposal is not the code: it is labelled, and nothing here writes the Blueprint.
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const NGL = isNode ? require('./pl.js') : root.NGL;
  const BP = isNode ? require('./bp.js') : root.BP;

  const ident = (s) => String(s).replace(/[^\w]/g, '_');

  /** pastes {file: text}, the trace (trace.js build), natives {Name: {cls, at}} for the native members (oo_cli finds them) ->
   *  {classes, interfaces, natives used, evidence} */
  function assemble(pastes, T, natives, hierarchy) {
    const classes = new Map();
    const cls = (name) => { if (!classes.has(name)) classes.set(name, { name: name, parent: null, components: new Map(), fields: new Map(), methods: [], uses: new Map(), why: [] }); return classes.get(name); };
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
    // 3. fields, components, interfaces and native members, from the nodes
    for (const [file, text] of Object.entries(pastes)) {
      const graphs = T.graphs.filter((G) => G.file.replace(/\.ngl$/, '') === file.replace(/\.t3d$/, ''));
      const fileOwner = graphs.map((G) => owner.get(G.alias)).find(Boolean);
      const selfCls = fileOwner ? fileOwner.cls : 'Pasted';
      for (const o of BP.parseText(text).objects.filter((x) => !x.outer)) {
        if (o.cls === 'K2Node_VariableGet' || o.cls === 'K2Node_VariableSet') {
          const ref = BP.parseStruct(o.props.VariableReference || '()');
          const name = String(ref.MemberName || '').replace(/^"|"$/g, '');
          if (!name) continue;
          const pin = o.pins.find((p) => p.name === name && p.cat !== 'exec');
          const type = pin ? BP.typeOf(pin) : '?';
          const where = file + ':' + o.line;
          const native = !ref.MemberGuid;
          const memberOf = ref.bSelfContext === 'True' ? selfCls : ref.MemberParent ? BP.shortName(ref.MemberParent) : selfCls;
          if (native) { recordNative(memberOf, name, 'field', where); continue; }
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
          if (!interfaces.has(iface)) interfaces.set(iface, { name: iface, methods: new Map(), callers: [], senders: new Set() });
          const I = interfaces.get(iface);
          I.senders.add(selfCls);
          const params = o.pins.filter((p) => p.dir === 'in' && p.cat !== 'exec' && p.name !== 'self').map((p) => BP.typeOf(p) + ' ' + ident(p.name));
          I.methods.set(fn, fn + '(' + params.join(', ') + ')');
          I.callers.push(file + ':' + o.line);
        } else if (o.cls === 'K2Node_CallFunction') {
          const fr = BP.parseStruct(o.props.FunctionReference || '()');
          if (fr.bSelfContext === 'True' && !fr.MemberGuid) recordNative(selfCls, String(fr.MemberName || '').replace(/^"|"$/g, ''), 'function', file + ':' + o.line);
        }
      }
    }
    function recordNative(memberOf, name, kind, where) {
      if (!classes.has(memberOf) && memberOf !== 'Pasted' && !(natives && natives[name])) return;
      const c = cls(memberOf);
      if (!c.uses.has(name)) c.uses.set(name, { kind: kind, where: [], declared: natives && natives[name] ? natives[name] : null });
      c.uses.get(name).where.push(where);
    }
    // 4. the parent: the most derived native class among those declaring what the class uses on itself (the hierarchy READ from
    //    the same headers); none -> ABSENT, said
    for (const c of classes.values()) {
      const declaring = [...c.uses.values()].map((u) => u.declared && u.declared.cls).filter(Boolean);
      if (!declaring.length || !hierarchy) { c.parent = null; c.parentWhy = 'no native member it uses on itself names a class'; continue; }
      const depth = (k) => { let d = 0; for (let x = k; x && hierarchy[x]; x = hierarchy[x].parent) d++; return d; };
      const best = [...new Set(declaring)].sort((a, b) => depth(b) - depth(a))[0];
      const chainOk = [...new Set(declaring)].every((k) => { for (let x = best; x; x = hierarchy[x] && hierarchy[x].parent) if (x === k) return true; return false; });
      if (!chainOk) { c.parent = null; c.parentWhy = 'the native members it uses are declared on classes that are not one chain: ' + [...new Set(declaring)].join(', '); continue; }
      c.parent = best.replace(/^[AU]/, '');
      c.parentWhy = 'uses ' + [...c.uses.entries()].filter(([, u]) => u.declared).map(([n, u]) => n + ' (' + u.declared.at + ')').join(', ') + ' on itself: ' + (/^[AEIOU]/.test(c.parent) ? 'an ' : 'a ') + c.parent + ' or a child of it';
    }
    return { classes: classes, interfaces: interfaces, owner: owner };
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
      if (c.uses.size) L.push('    // uses on itself (native): ' + [...c.uses.keys()].join(', '));
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

  /** the procedural patterns the brainstorm found, each with the OO form that removes it - PROPOSED, never applied */
  function proposals(A, T, Q) {
    const out = [];
    const by = (rule) => Q.filter((q) => q.rule === rule);
    const castCount = T.graphs.reduce((s, G) => s + G.g.order.filter((id) => G.g.nodes.get(id).kw === 'type-test').length, 0);
    if (castCount) out.push({ pattern: 'the casting trap: ' + castCount + ' Cast To nodes test an actor\'s class before using it', oo: 'an interface the cast class implements, holding the members the code reads through the cast; the code asks the interface instead of casting', questions: by('ELSE').filter((q) => /\(\w+ is \w+ \w+\)/.test(q.text)).map((q) => q.id), section: '2: The Casting Trap' });
    for (const q of by('DUP')) out.push({ pattern: 'the same statements written twice (' + q.refs.join(', ') + ')', oo: 'extract one method and call it from both places', questions: [q.id], section: '2: The Lack of Encapsulation' });
    const ev = by('EVENTCALL');
    if (ev.length) out.push({ pattern: ev.length + ' events fired like function calls (' + ev.map((q) => q.id.split('.').pop()).join(', ') + ')', oo: 'private methods of the class: called in order, can return a result, cannot be fired from outside', questions: ev.map((q) => q.id), section: '2: The Lack of Encapsulation' });
    const nm = by('NAME');
    if (nm.length) out.push({ pattern: nm.length + ' functions run by a NAME in a string (' + nm.map((q) => q.id.split('.').pop()).join(', ') + ')', oo: 'a delegate bound to the method itself: a rename is a compile error, and the reference shows in a search', questions: nm.map((q) => q.id), section: '3: Invisible Relationships' });
    const wr = by('WRITE');
    for (const q of wr) out.push({ pattern: q.id.split('.').pop() + ' written by ' + new Set(q.refs.map((r) => r.split('#')[0])).size + ' graphs', oo: 'one owner: a private field behind a single method that changes it (and tells whoever must know)', questions: [q.id], section: '2: The Lack of Encapsulation' });
    // cohesion: the members of the Blueprint class that only the lock-on uses -> a component
    for (const c of A.classes.values()) {
      if (c.fields.size >= 5 && c.components.size) out.push({ pattern: c.name + ' carries ' + c.fields.size + ' fields, ' + c.components.size + ' components and ' + c.methods.length + ' methods that are all one behaviour', oo: 'one component any ' + (c.parent || 'owner') + ' can add (composition), named after the system: ' + c.name + ' keeps being a ' + (c.parent || 'what it is') + ', the behaviour moves out of its graph', questions: [], section: '2: The Hiding of the Hierarchy' });
    }
    const tm = by('TIMER');
    if (tm.length) out.push({ pattern: 'state polled by looping timers (' + tm.map((q) => q.id.split('.').pop()).join(', ') + ')', oo: 'ask when needed instead of polling: compute the value where it is used, and update on the owner\'s own tick', questions: tm.map((q) => q.id), section: '5: Data as Flowing Water' });
    return out;
  }

  /** the OO shape PROPOSED for what was read, generated - never written per sample: the class a cast tests for, with the members
   *  read through it, becomes an interface (the Blueprint interface already messaged on it, when there is one, extended); the Blueprint
   *  class's own fields and methods become one component named after the system's own title (the author's word for it) */
  function proposedShape(A, T, title) {
    const castTo = new Set();
    for (const G of T.graphs) for (const id of G.g.order) { const n = G.g.nodes.get(id); if (n.kw === 'type-test' && n.attrs.pat) castTo.add(NGL.textOf(n.attrs.pat).split(' ')[0]); }
    const shape = { interfaces: [], components: [] };
    for (const X of castTo) {
      const target = A.classes.get(X);
      const msg = [...A.interfaces.values()][0];
      shape.interfaces.push({ name: msg ? ident(msg.name) : 'I' + ident(X), implementer: X,
        members: (target ? [...target.fields.entries()].filter(([, f]) => f.external).map(([n, f]) => f.type + ' ' + ident(n) + ' { get; }') : []).concat(msg ? [...msg.methods.values()].map((s) => 'void ' + s) : []),
        why: 'the code casts to ' + X + ' to reach ' + (target ? [...target.fields.entries()].filter(([, f]) => f.external).map(([n]) => n).join(', ') : 'its members') + (msg ? ', and messages it through ' + msg.name : '') });
    }
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

  const api = { assemble: assemble, printClasses: printClasses, proposals: proposals, diagrams: diagrams, proposedShape: proposedShape };
  if (isNode) module.exports = api;
  else root.OO = api;
})(typeof self !== 'undefined' ? self : this);
