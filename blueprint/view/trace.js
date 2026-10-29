// trace.js - from a line of code to the requirement it serves, and everything the code can do that no requirement says yet.
//
// The rule: every line of code and every piece of Blueprint logic links to the use case step it realises, and the steps form a
// linear, hierarchical chain down to the requirements. At each step a brainstorm of questions checks that the requirements close the
// loop: as with code coverage, every path a user or the system can take through the code is handled by a requirement, or excluded
// with the reason.
// PLAN.md "The trace" draws these classes; tools/logic_map.py joins them to the use case model and writes the closed spaces the
// existing gap checker (autobot/usecase_model.py) gates.
//
//   SourceUnit     a piece of code as its author wrote it - a Blueprint node (name, class, line) - and the graph nodes it became;
//                  a node the converter wrote inline (a variable read) belongs to the statement that reads it, as the engine
//                  compiles a pure node in front of each statement that reads it (KismetCompiler.cpp:2798-2876)
//   Decision       a statement that chooses: branch, loop, switch; its Outcomes are the ways it can go (then/else, loop/skip, case)
//   CodePath       one way through a graph from its entry to an exit: the outcomes it takes, in order (a loop body once)
//   QuestionRules  the brainstorm a statement raises, each rule reading the graph (never a guess): the side a branch ignores, the
//                  == boundary, a member written by several graphs, a call by name, a literal, an array add, an unguarded read of
//                  something that can be None, a looping timer, a debug draw, a caller and callee that disagree, an event called
//                  as a function, a rule written twice, a flag whose test can only go one way
//   Suggester      message passing over the graph (a graph network with fixed weights): proposes the step an uncited statement
//                  belongs to, from its neighbours. It never writes a cite - a suggestion is not a fact (CLAUDE.md IRON LAW 1)
//
// A cite (in the model) is `Alias#sN` (a statement), `Alias#sN:then` (an outcome: the decision's edge and the statements directly
// in that body), or `Alias` (the graph: its entry and the statements directly in its body). Alias = a bound event's title without
// spaces, else the method name. Runs in node (require) and in the page (window.TRACE).
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const NGL = isNode ? require('./pl.js') : root.NGL;
  const BP = isNode ? require('./bp.js') : root.BP;

  const MAX_PATHS = 20000;            // per graph; past it the enumeration is refused, never cut short silently
  const DECIDE = { branch: 1, switch: 1, 'for-loop': 1, 'for-each-loop': 1, 'while-loop': 1, 'do-loop': 1 };
  const LOOPS = { 'for-loop': 1, 'for-each-loop': 1, 'while-loop': 1, 'do-loop': 1 };
  const ids = (v) => NGL.listOf(v).map(NGL.idOf).filter((x) => x && /^[sk]\d+$/.test(x));

  /** a cite's short name for a graph: a bound event by its title without spaces, else its method name */
  function alias(g) {
    const t = g.attrs.title ? NGL.textOf(g.attrs.title) : '';
    return t ? t.replace(/\s+/g, '') : g.name.split('.').pop();
  }

  // ------------------------------------------------------------------------------------------------ the graphs and their text

  /** {file: ngl text} (+ {file: paste text}) -> the trace set: graphs, statements with their text, units, decisions, paths */
  function build(nglFiles, pasteFiles) {
    const graphs = [];
    const byAlias = new Map();
    // a cite name is the short name while it is the set's only one; two Blueprints' events of one name (a ball's and a paddle's
    // ReceiveTick, measured 10-28 on the Pong set) are each named with their Blueprint, as a bound event names its component:
    // ReceiveTick(BP_Ball). Two that still share a name - two "Pasted" copies whose owner neither copy holds - are refused.
    const parsed = [];
    for (const [file, text] of Object.entries(nglFiles)) for (const g of NGL.parse(text, file)) parsed.push([file, g]);
    const count = new Map();
    for (const [, g] of parsed) count.set(alias(g), (count.get(alias(g)) || 0) + 1);
    for (const [file, g] of parsed) {
      const short = alias(g);
      const a = count.get(short) > 1 ? short + '(' + g.name.split('.')[0] + ')' : short;
      if (byAlias.has(a)) throw new Error('two graphs share the cite name ' + a + ': ' + byAlias.get(a).name + ' and ' + g.name);
      const lines = NGL.printPseudo(g);
      const text1 = new Map();
      for (const l of lines) if (l.id && !text1.has(l.id)) text1.set(l.id, l.text);
      const G = { file: file, name: g.name, alias: a, kind: NGL.termText(g.attrs.kind), title: g.attrs.title ? NGL.textOf(g.attrs.title) : '',
        at: NGL.termText(g.attrs.at), g: g, text: text1, pseudo: lines };
      graphs.push(G);
      byAlias.set(a, G);
    }
    const T = { graphs: graphs, byAlias: byAlias, units: [], decisions: [], outcomes: [], paths: [] };
    for (const G of graphs) {
      for (const d of decisionsOf(G)) { T.decisions.push(d); T.outcomes.push(...d.outcomes); }
      T.paths.push(...pathsOf(G));
    }
    T.vars = [];
    if (pasteFiles) for (const [file, text] of Object.entries(pasteFiles)) { T.units.push(...unitsOf(T, file, text)); T.vars.push(...varsOf(file, text)); }
    // a self member belongs to the Blueprint whose graphs name it. Where two Blueprints of the set each have a member of one name
    // as their own, each is named with its Blueprint - BP_Ball.Velocity, BP_Paddle.Velocity: a duplicated Blueprint keeps its
    // variables' names AND guids (the Pong paddle was made from the ball, measured 10-28), so neither tells the two apart. A name
    // only one Blueprint holds stays bare, which keeps every member and question id of a set without such a twin as it was.
    T.selfOwners = new Map();
    for (const v of T.vars) if (v.self && v.owner !== 'self') (T.selfOwners.get(v.name) || T.selfOwners.set(v.name, new Set()).get(v.name)).add(v.owner);
    T.shared = (name) => (T.selfOwners.get(name) || new Set()).size > 1;
    T.memberKey = (G, name) => (!/[.[]/.test(name) && T.shared(name) ? G.name.split('.')[0] + '.' + name : name);
    T.members = membersOf(T);
    T.calls = callsOf(T);
    return T;
  }

  /** the statement and expression ids under one statement (itself, its expressions; not the bodies it chooses between) */
  function ownNodes(G, sid) {
    const g = G.g;
    const out = [sid];
    const kids = new Set();
    const s = g.nodes.get(sid);
    for (const k of ['then', 'else', 'body', 'sections']) for (const id of ids(s.attrs[k])) kids.add(id);
    for (const id of g.order) {
      const n = g.nodes.get(id);
      if (id === sid || id[0] !== 'e') continue;
      if (NGL.rowOf(g, n) === sid) out.push(id);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ decisions and outcomes

  /** every choosing statement and its outcomes: {ref: 'A#s4', kind, outcomes: [{ref: 'A#s4:then', body: [ids], label}]} */
  function decisionsOf(G) {
    const g = G.g;
    const out = [];
    for (const id of g.order) {
      const n = g.nodes.get(id);
      if (id[0] !== 's' || !DECIDE[n.kw]) continue;
      const ref = G.alias + '#' + id;
      const d = { ref: ref, graph: G.alias, id: id, kw: n.kw, text: G.text.get(id) || n.kw, outcomes: [] };
      if (n.kw === 'branch') {
        d.outcomes.push({ ref: ref + ':then', decision: ref, label: 'then', body: ids(n.attrs.then) });
        d.outcomes.push({ ref: ref + ':else', decision: ref, label: 'else', body: ids(n.attrs.else) });
      } else if (LOOPS[n.kw]) {
        // a loop decides at its test: the body runs (at least once) or it never does
        d.outcomes.push({ ref: ref + ':loop', decision: ref, label: 'loop', body: ids(n.attrs.body) });
        if (n.kw !== 'do-loop') d.outcomes.push({ ref: ref + ':skip', decision: ref, label: 'skip', body: [] });
      } else if (n.kw === 'switch') {
        for (const k of ids(n.attrs.sections)) {
          const sec = g.nodes.get(k);
          const label = NGL.listOf(sec.attrs.labels).map(NGL.termText).join('|');
          d.outcomes.push({ ref: ref + ':' + k, decision: ref, label: label, body: ids(sec.attrs.body) });
        }
      }
      for (const o of d.outcomes) o.graph = G.alias;
      out.push(d);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ paths

  /** every way from the graph's entry to an exit: {ref: 'A#P3', outs: [outcome refs in order], stmts: [ids], exit} - a loop's body
   *  is taken once (the paths inside it are its own); refused past MAX_PATHS rather than cut short */
  function pathsOf(G) {
    const g = G.g;
    const body = ids(g.attrs.body);
    let count = 0;
    function cat(a, b) { return { outs: a.outs.concat(b.outs), stmts: a.stmts.concat(b.stmts), exit: b.exit }; }
    // all ways through list[k..]: each {outs, stmts, exit: 'end' | 'return' | 'break'}
    function walk(list, k) {
      if (k >= list.length) return [{ outs: [], stmts: [], exit: 'end' }];
      const id = list[k];
      const n = g.nodes.get(id);
      const ref = G.alias + '#' + id;
      if (n.kw === 'return' || n.kw === 'throw') return [{ outs: [], stmts: [id], exit: 'return' }];
      if (n.kw === 'break') return [{ outs: [], stmts: [id], exit: 'break' }];
      let heads;
      if (n.kw === 'branch') {
        heads = [];
        for (const side of ['then', 'else']) for (const p of walk(ids(n.attrs[side]), 0)) heads.push({ outs: [ref + ':' + side].concat(p.outs), stmts: [id].concat(p.stmts), exit: p.exit });
      } else if (LOOPS[n.kw]) {
        heads = [];
        for (const p of walk(ids(n.attrs.body), 0)) heads.push({ outs: [ref + ':loop'].concat(p.outs), stmts: [id].concat(p.stmts), exit: p.exit === 'break' ? 'end' : p.exit });
        if (n.kw !== 'do-loop') heads.push({ outs: [ref + ':skip'], stmts: [id], exit: 'end' });
      } else if (n.kw === 'switch') {
        heads = [];
        for (const k2 of ids(n.attrs.sections)) {
          for (const p of walk(ids(g.nodes.get(k2).attrs.body), 0)) heads.push({ outs: [ref + ':' + k2].concat(p.outs), stmts: [id].concat(p.stmts), exit: p.exit === 'break' ? 'end' : p.exit });
        }
      } else {
        heads = [{ outs: [], stmts: [id], exit: 'end' }];
      }
      const out = [];
      for (const h of heads) {
        if (h.exit !== 'end') { out.push(h); continue; }
        for (const rest of walk(list, k + 1)) {
          out.push(cat(h, rest));
          if (++count > MAX_PATHS) throw new Error(G.alias + ': more than ' + MAX_PATHS + ' paths - enumerate this graph by outcome instead');
        }
      }
      return out;
    }
    return walk(body, 0).map((p, i) => ({ ref: G.alias + '#P' + (i + 1), graph: G.alias, outs: p.outs, stmts: p.stmts, exit: p.exit === 'break' ? 'end' : p.exit }));
  }

  // ------------------------------------------------------------------------------------------------ source units (Blueprint nodes)

  /** the Blueprint nodes of one paste and the graph nodes each became: by its line (`at`), or - written inline - through the node
   *  that reads it (its output wires, knots followed), the engine's own rule for a pure node */
  function unitsOf(T, file, text) {
    const doc = BP.parseText(text);
    const nodes = doc.objects.filter((o) => !o.outer);
    const byName = new Map(nodes.map((o) => [o.name, o]));
    const graphs = T.graphs.filter((G) => G.file.replace(/\.ngl$/, '') === file.replace(/\.t3d$/, ''));
    const atMap = new Map();          // line -> [refs]
    for (const G of graphs) {
      for (const id of G.g.order) {
        const n = G.g.nodes.get(id);
        const at = NGL.atLine(n);
        if (at === null) continue;
        const row = id[0] === 's' ? id : NGL.rowOf(G.g, n);
        if (!row) continue;
        const ref = G.alias + '#' + row;
        if (!atMap.has(at)) atMap.set(at, new Set());
        atMap.get(at).add(ref);
      }
      // a graph's entry node (an event, a function entry) is its header line
      const hat = parseInt(String(G.at || '').split(':')[0], 10);
      if (hat) { if (!atMap.has(hat)) atMap.set(hat, new Set()); atMap.get(hat).add(G.alias); }
    }
    const units = nodes.map((o) => ({ file: file, name: o.name, cls: o.cls, line: o.line, refs: [...(atMap.get(o.line) || [])].sort(), via: [] }));
    const byUnit = new Map(units.map((u) => [u.name, u]));
    // inline nodes: follow output wires to readers until one became graph nodes (bounded by the node count)
    for (const u of units) {
      if (u.refs.length) continue;
      const o = byName.get(u.name);
      const seen = new Set([u.name]);
      let frontier = [o];
      const found = new Set();
      while (frontier.length) {
        const next = [];
        for (const x of frontier) {
          for (const p of x.pins) {
            if (p.dir !== 'out') continue;
            for (const l of p.linked) {
              if (seen.has(l.node)) continue;
              seen.add(l.node);
              const r = byUnit.get(l.node);
              if (!r) continue;
              if (r.refs.length) { for (const ref of r.refs) found.add(ref); u.via.push(l.node); }
              else if (byName.get(l.node)) next.push(byName.get(l.node));
            }
          }
        }
        frontier = next;
      }
      u.refs = [...found].sort();
      u.inline = true;
    }
    // a function's bare return node at its end is no statement (bp.js drops a bare return as the method's last step: it says
    // nothing) - it is the graph's exit, so it belongs to the graph; with two function graphs in one text that is ambiguous: refused
    for (const u of units) {
      if (u.refs.length || u.cls !== 'K2Node_FunctionResult') continue;
      const fns = graphs.filter((G) => G.kind === 'function');
      if (fns.length !== 1) throw new Error(file + ': ' + u.name + ' is a bare return, and ' + fns.length + ' function graphs could own it');
      u.refs = [fns[0].alias];
      u.exit = true;
    }
    return units;
  }

  /** every Blueprint variable the text reads or writes, by its MemberGuid - the engine's identity for a member, kept across renames
   *  (two names with two guids are two variables). A get whose value feeds a by-reference input (an array function's TargetArray)
   *  writes it. -> [{name, guid, owner, write, node, file, line}] */
  function varsOf(file, text) {
    const objs = BP.parseText(text).objects.filter((o) => !o.outer);
    const byName = new Map(objs.map((o) => [o.name, o]));
    const out = [];
    for (const o of objs) {
      if (o.cls !== 'K2Node_VariableGet' && o.cls !== 'K2Node_VariableSet') continue;
      const r = BP.parseStruct(o.props.VariableReference || '()');
      if (!r.MemberGuid) continue;                 // native (C++) members carry no guid: not the Blueprint's own variables
      const name = String(r.MemberName || '').replace(/^"|"$/g, '');
      let write = o.cls === 'K2Node_VariableSet';
      if (!write) {
        for (const p of o.pins) {
          if (p.dir !== 'out') continue;
          for (const l of p.linked) { const t = byName.get(l.node); const tp = t && t.pins.find((q) => q.id === l.pin); if (tp && tp.isRef) write = true; }
        }
      }
      // a self-context variable's Blueprint is its self pin's generated class, where the paste types it (UE 4.18 and 5.0 both do)
      const selfPin = !r.MemberParent ? o.pins.find((p) => p.name === 'self') : null;
      const selfClass = selfPin && selfPin.subObjGenerated ? selfPin.subObj : '';
      out.push({ name: name, guid: r.MemberGuid, owner: r.MemberParent ? BP.shortName(r.MemberParent) : selfClass || 'self', self: !r.MemberParent,
        write: write, node: o.name, file: file, line: o.line });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ members and calls (the context)

  /** member writes and reads across the set: name -> {writes: [refs], reads: [refs], nulls: [refs], valid: [refs]} */
  function membersOf(T) {
    const M = new Map();
    const get = (name) => { if (!M.has(name)) M.set(name, { writes: [], reads: [], nulls: [], valid: [] }); return M.get(name); };
    for (const G of T.graphs) {
      const g = G.g;
      const locals = new Set();
      for (const p of NGL.listOf(g.attrs.params)) locals.add(String(NGL.termText(p)).split(':')[0]);
      for (const p of NGL.listOf(g.attrs.outs)) locals.add(String(NGL.termText(p)).split(':')[0]);
      for (const id of g.order) {
        const n = g.nodes.get(id);
        if (n.kw === 'set-local' || /-loop$/.test(n.kw)) for (const v of NGL.listOf(n.attrs.vars)) locals.add(NGL.termText(v));
        const pat = n.kw === 'type-test' && n.attrs.pat ? NGL.textOf(n.attrs.pat) : '';
        if (pat) locals.add(pat.split(' ').pop());
      }
      for (const id of g.order) {
        const n = g.nodes.get(id);
        const row = id[0] === 's' ? id : NGL.rowOf(g, n);
        const ref = G.alias + '#' + row;
        if (n.kw === 'set' || n.kw === 'set-with-math') {
          const t = NGL.termText(n.attrs.target) || '';
          const root0 = t.split(/[.[]/)[0];
          if (t && !locals.has(root0)) {
            get(T.memberKey(G, t)).writes.push(ref);
            if (NGL.termText(n.attrs.value) === 'null') get(T.memberKey(G, t)).nulls.push(ref);
          }
        }
        if (n.kw === 'pure-call' && NGL.termText(n.attrs.method) === 'IsValid') for (const a of NGL.listOf(n.attrs.args)) { const t = NGL.termText(a); if (t) get(T.memberKey(G, t)).valid.push(ref); }
      }
    }
    return M;
  }

  /** calls between the graphs of the set: by name in code, or by a function NAME in a string (a timer) */
  function callsOf(T) {
    const out = [];
    for (const G of T.graphs) {
      const g = G.g;
      for (const id of g.order) {
        const n = g.nodes.get(id);
        if (n.kw !== 'call' && n.kw !== 'pure-call') continue;
        const row = id[0] === 's' ? id : NGL.rowOf(g, n);
        const m = NGL.termText(n.attrs.method);
        const callee = T.byAlias.get(m);
        if (callee && !n.attrs.on) out.push({ from: G.alias + '#' + row, to: callee.alias, how: 'call' });
        const params = NGL.listOf(n.attrs.params).map(NGL.termText);
        const args = NGL.listOf(n.attrs.args);
        params.forEach((p, i) => {
          if (!/^(FunctionName|FunctionNameToCall|EventName)$/.test(p) || !args[i]) return;
          const lit = NGL.textOf(args[i]);
          const name = typeof lit === 'string' ? lit.replace(/^"|"$/g, '') : '';
          if (!name) return;
          out.push({ from: G.alias + '#' + row, to: T.byAlias.has(name) ? name : null, name: name, how: 'by name', method: m });
        });
      }
    }
    return out;
  }

  /** the statements that pause or clear a delegate timer bound to `event` (KismetSystemLibrary K2_PauseTimerDelegate,
   *  K2_ClearTimerDelegate: each takes the same delegate the timer was set with) */
  function delegateStops(T, event) {
    const out = [];
    for (const G of T.graphs) {
      for (const id of G.g.order) {
        const n = G.g.nodes.get(id);
        if ((n.kw !== 'call' && n.kw !== 'pure-call') || !/^K2_(Pause|Clear)TimerDelegate$/.test(NGL.termText(n.attrs.method) || '')) continue;
        if (NGL.listOf(n.attrs.args).some((a) => NGL.termText(a) === event)) out.push(G.alias + '#' + (id[0] === 's' ? id : NGL.rowOf(G.g, n)));
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ the brainstorm (QuestionRules)

  const RULES = {
    ELSE: 'the side of a choice the code ignores',
    EQ: 'the == boundary of a comparison',
    WRITE: 'a member several graphs write',
    NAME: 'a call made by a function NAME in a string',
    LITERAL: 'a number written into the code',
    ADD: 'an add that may hold the same thing twice',
    INDEX: 'a read by index that may be out of range',
    NONE: 'a read of something that can be None, unguarded',
    TIMER: 'a looping timer: what stops it',
    DEBUG: 'debug drawing in the code',
    SIG: 'a caller and the called function disagree',
    EVENTCALL: 'an event called as if it were a function',
    DUP: 'the same statements written twice',
    CONST: 'a test that can only go one way',
    UNWRITTEN: 'a variable read that nothing in the set writes (with its near-namesake, if one is written)',
  };

  /** every question the set raises: {id, rule, refs: [statement refs it is raised at], text}. Ids are stable for unchanged code:
   *  the rule and the first statement (or member) it is about */
  function questions(T) {
    const Q = new Map();
    const add = (rule, key, refs, text) => {
      const id = 'Q-' + rule + '.' + key;
      if (Q.has(id)) { for (const r of refs) if (!Q.get(id).refs.includes(r)) Q.get(id).refs.push(r); return; }
      Q.set(id, { id: id, rule: rule, refs: refs.slice(), text: text });
    };
    const lit = (v) => { const t = NGL.termText(v); return t && /^-?\d+(\.\d+)?f?$/.test(t) ? t.replace(/f$/, '') : null; };
    const opText = (G, eid) => G.text.get(eid) || '';
    for (const G of T.graphs) {
      const g = G.g;
      const enclosedBy = (id) => { const out = []; let n = g.nodes.get(id); while (n && n.under) { const p = g.nodes.get(n.under); out.push({ p: p, from: n.id }); n = p; } return out; };
      const sideOf = (parent, childId) => (ids(parent.attrs.then).includes(childId) ? 'then' : ids(parent.attrs.else).includes(childId) ? 'else' : 'other');
      // the expression feeding a branch's cond
      const condNode = (n) => { const c = n.attrs.cond; return c && c.ref ? g.nodes.get(c.ref) : null; };
      for (const id of g.order) {
        const n = g.nodes.get(id);
        if (id[0] !== 's') continue;
        const ref = G.alias + '#' + id;
        const say = G.text.get(id) || n.kw;
        if (n.kw === 'branch') {
          const c = condNode(n);
          const thenB = ids(n.attrs.then), elseB = ids(n.attrs.else);
          // CONST: a test that is a literal (a macro's input left at its default is written so: DoOnce's Start Closed) can only go one way
          const literal = n.attrs.cond && !n.attrs.cond.ref && /^(true|false)$/.test(NGL.termText(n.attrs.cond) || '') ? NGL.termText(n.attrs.cond) : null;
          if (literal) {
            const dead = literal === 'true' ? elseB : thenB;
            add('CONST', ref, [ref], 'The test here is the literal ' + literal + ', so only its ' + (literal === 'true' ? 'then' : 'else') + ' side can ever run' + (dead.length ? ' (' + dead.length + ' statement(s) never will)' : '') + '. A default nobody set, or meant?');
          }
          // ELSE: a choice whose other side does nothing (a literal test is asked as CONST above, not here)
          if (!literal && !elseB.length && thenB.length) add('ELSE', ref, [ref], 'When "' + say.replace(/^if |\s+then$/g, '') + '" is false, nothing happens here. Intended, and what should the person see?');
          if (!literal && !thenB.length && elseB.length) add('ELSE', ref, [ref], 'When "' + say.replace(/^if |\s+then$/g, '') + '" is true, nothing happens here. Intended?');
          if (!literal && !thenB.length && !elseB.length) add('ELSE', ref, [ref], 'This choice does nothing either way ("' + say + '"). Why is it here?');
          // EQ: a < or > whose equality falls to a side that was not written for it
          if (c && c.kw === 'operator' && /^[<>]$/.test(NGL.termText(c.attrs.op))) {
            const a = NGL.termText(c.attrs.a), b = NGL.termText(c.attrs.b);
            const inner = elseB.length === 1 ? g.nodes.get(elseB[0]) : null;
            const ic = inner && inner.kw === 'branch' ? condNode(inner) : null;
            const nested = ic && ic.kw === 'operator' && NGL.termText(ic.attrs.a) === a && NGL.termText(ic.attrs.b) === b;
            if (nested) {
              const eq = ids(inner.attrs.else);
              add('EQ', ref, [ref], 'When ' + a + ' equals ' + b + ', ' + (eq.length ? 'it does what the ' + (eq.length) + ' statement(s) of the == side say' : 'nothing happens') + '. Is equal meant to count as ' + (eq.length ? 'that' : 'neither') + '?');
            }
          }
          // CONST: a test of a member flag that every path reaching it set to the same value
          if (n.attrs.cond && !n.attrs.cond.ref) {
            const flag = NGL.termText(n.attrs.cond);
            if (flag && /^\w+$/.test(flag)) {
              const vals = new Set(), unset = [];
              for (const p of T.paths.filter((x) => x.graph === G.alias && x.stmts.includes(id))) {
                const k = p.stmts.indexOf(id);
                let v = null;
                for (let j = k - 1; j >= 0; j--) { const s = g.nodes.get(p.stmts[j]); if (s.kw === 'set' && NGL.termText(s.attrs.target) === flag) { v = NGL.termText(s.attrs.value); break; } }
                if (v === null) unset.push(p.ref); else vals.add(v);
              }
              if (vals.size === 1 && /^(true|false)$/.test([...vals][0])) add('CONST', ref, [ref], 'On every path that sets ' + flag + ' before this test it is ' + [...vals][0] + ', so the test only depends on the paths that do not set it (' + unset.length + ' here, holding what another event left). What is ' + flag + ' meant to record?');
            }
          }
        }
        // the statement's own expressions
        const own = ownNodes(G, id).map((x) => g.nodes.get(x));
        // LITERAL
        const lits = [];
        for (const x of own) for (const k of ['value', 'b', 'a', 'args', 'index']) for (const v of NGL.listOf(x.attrs[k])) { const l = lit(v); if (l !== null && !/^(0|1|-1|0\.0|1\.0)$/.test(l)) lits.push(l); }
        if (lits.length) add('LITERAL', ref, [ref], 'The number(s) ' + [...new Set(lits)].join(', ') + ' are written into "' + say + '". Where do they come from, and who may change them?');
        for (const x of own) {
          const m = NGL.termText(x.attrs.method);
          if (m === 'Array_Add') add('ADD', ref, [ref], '"' + say + '" adds without checking: can the same actor be in the array twice (two overlapping parts), and what then?');
          if ((x.kw === 'get-at-index' || m === 'Array_Get') && !enclosedBy(x.id).some((e) => LOOPS[e.p.kw])) add('INDEX', ref, [ref], '"' + say + '" reads by index outside a loop over the array: what if the index is out of range?');
          if (/^(K2_SetTimer|SetTimerByFunctionName|K2_SetTimerDelegate)$/.test(m || '')) {
            const params = NGL.listOf(x.attrs.params).map(NGL.termText), args = NGL.listOf(x.attrs.args);
            const looping = NGL.termText(args[params.indexOf('bLooping')]) === 'true';
            // the timer's function: a NAME in a string, or (K2_SetTimerDelegate) the event bound as its delegate - an event name as a value
            const byName = params.includes('FunctionName');
            const fname = byName ? (NGL.textOf(args[params.indexOf('FunctionName')]) || '').replace(/^"|"$/g, '') : NGL.termText(args[params.indexOf('Event')]) || '';
            if (looping) {
              const stops = byName ? T.calls.filter((c) => c.how === 'by name' && c.name === fname && /Pause|Clear/.test(c.method || '')).map((c) => c.from)
                : delegateStops(T, fname);
              add('TIMER', fname, [ref], '"' + fname + '" runs every ' + NGL.termText(args[params.indexOf('Time')]) + ' s once started here, until it is paused' + (stops.length ? ' (at ' + stops.join(', ') + ')' : ' - and nothing in the set pauses it') + '. Does every way the behaviour ends stop it?');
            }
          }
          const params = NGL.listOf(x.attrs.params).map(NGL.termText), args = NGL.listOf(x.attrs.args);
          params.forEach((p, i) => {
            if (/^(FunctionName|FunctionNameToCall|EventName)$/.test(p) && args[i]) {
              const name = (NGL.textOf(args[i]) || '').replace(/^"|"$/g, '');
              if (name) add('NAME', name, [ref], '"' + name + '" is called by its NAME in a string (' + m + '): nothing checks the name, so a rename breaks it silently' + (T.byAlias.has(name) ? '' : ', and no graph in this set defines it') + '. Should it be a direct call or a delegate?');
            }
          });
          for (const v of NGL.listOf(x.attrs.args)) { const t = NGL.termText(v) || ''; if (/^EDrawDebugTrace\.(ForDuration|ForOneFrame|Persistent)$/.test(t)) add('DEBUG', ref, [ref], '"' + say + '" draws debug lines (' + t + '): every call, in every build. Should it ship?'); }
          // SIG: a call to a graph of the set whose out arguments differ from the callee's outs
          if ((x.kw === 'call' || x.kw === 'pure-call') && !x.attrs.on && T.byAlias.has(m)) {
            const callee = T.byAlias.get(m);
            if (callee.kind === 'event') add('EVENTCALL', m, [ref], m + ' is a custom EVENT called here as if it were a function: it cannot return a value or run in order with a return, and anything can fire it. Should it be a function?');
            const outsCallee = NGL.listOf(callee.g.attrs.outs).length;
            const mods = NGL.listOf(x.attrs.argmods).map(NGL.termText);
            const outsCaller = mods.filter((t) => t === 'out').length;
            if (outsCaller !== outsCallee) add('SIG', m, [ref], 'This call passes ' + outsCaller + ' output(s) to ' + m + ', which declares ' + outsCallee + ': the two copies disagree (a stale node in one of them). Which is right?');
          }
        }
        // NONE: X.Y or a call on X, where X can be None (set to None or checked with IsValid somewhere) and no enclosing test guards it
        for (const x of own) {
          const reads = [];
          for (const k of ['a', 'b', 'value', 'cond', 'args']) for (const v of NGL.listOf(x.attrs[k])) { const t = NGL.termText(v); if (t && /^\w+\.\w+/.test(t)) reads.push(t.split('.')[0]); }
          const on = NGL.termText(x.attrs.on);
          if (on && /^\w+$/.test(on)) reads.push(on);
          for (const X of new Set(reads)) {
            const mm = T.members.get(T.memberKey(G, X));
            if (!mm || (!mm.nulls.length && !mm.valid.length)) continue;
            const guarded = enclosedBy(x.id).some(({ p, from }) => {
              if (p.kw !== 'branch' || sideOf(p, from) !== 'then') return false;
              const c = condNode(p);
              return c && c.kw === 'pure-call' && NGL.termText(c.attrs.method) === 'IsValid' && NGL.listOf(c.attrs.args).map(NGL.termText).includes(X);
            });
            if (!guarded) add('NONE', ref + '.' + X, [ref], X + ' can be None (' + (mm.nulls.length ? 'set to None at ' + mm.nulls.join(', ') : 'checked with IsValid at ' + mm.valid.join(', ')) + '), and "' + say + '" reads it with no IsValid test around it. What should happen when it is None?');
          }
        }
      }
    }
    // WRITE: a member written by more than one graph
    for (const [name, mm] of T.members) {
      const graphsW = [...new Set(mm.writes.map((r) => r.split('#')[0]))];
      if (graphsW.length > 1 && !/\.b[A-Z]/.test(name)) add('WRITE', name, mm.writes, name + ' is written by ' + graphsW.length + ' graphs (' + graphsW.join(', ') + '). Which one decides its value, and what if they run in between each other?');
    }
    // UNWRITTEN: a Blueprint variable (by its guid) read in the set that nothing in the set writes. When a variable with nearly the
    // same name (letters and digits, case folded) IS written under ANOTHER guid, the two are named together: two variables, or one?
    // (measured on the Lock-On pastes: the search reads "Distance to Frank Var", the enemy's timer writes "DistanceToFrankVar")
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    // (a variable two Blueprints of the set each hold as their own is one per Blueprint, whatever its guid: see T.shared)
    const byGuid = new Map();
    for (const v of T.vars || []) {
      const k = v.self && T.shared(v.name) ? v.guid + '@' + v.owner : v.guid;
      if (!byGuid.has(k)) byGuid.set(k, { name: v.self && T.shared(v.name) ? v.owner + '.' + v.name : v.name, owner: v.owner, reads: [], writes: [] });
      (v.write ? byGuid.get(k).writes : byGuid.get(k).reads).push(v);
    }
    const unitRefs = (v) => (T.units.find((u) => u.file === v.file && u.name === v.node) || { refs: [] }).refs.filter((r) => r.includes('#'));
    for (const [guid, m] of byGuid) {
      if (m.writes.length || !m.reads.length) continue;
      const twin = [...byGuid.entries()].find(([g, x]) => g !== guid && x.writes.length && norm(x.name) === norm(m.name));
      const refs = [...new Set(m.reads.flatMap(unitRefs))].sort();
      if (!refs.length) continue;
      add('UNWRITTEN', m.name.replace(/\s+/g, '_'), refs, '"' + m.name + '" (variable ' + guid.slice(0, 8) + ') is read at ' + refs.join(', ') + ' and nothing in these graphs writes it' +
        (twin ? ', while "' + twin[1].name + '" - another variable (MemberGuid ' + twin[0].slice(0, 8) + ') with nearly the same name - is written at ' +
          [...new Set(twin[1].writes.flatMap(unitRefs))].join(', ') + '. Two variables, or one?' : '. Who sets it: the Blueprint\'s defaults, or code that was not pasted?'));
    }
    // DUP: the same run of statements (3+) in two bodies
    const runs = new Map();
    for (const G of T.graphs) for (const o of T.outcomes.filter((x) => x.graph === G.alias)) {
      if (o.body.length < 3) continue;
      const key = o.body.map((id) => G.text.get(id)).join('\n');
      if (!runs.has(key)) runs.set(key, []);
      runs.get(key).push(o.ref);
    }
    for (const [key, refs] of runs) if (refs.length > 1) add('DUP', refs[0], refs, 'These ' + key.split('\n').length + ' statements are written twice (' + refs.join(', ') + '). One rule or two?');
    return [...Q.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // ------------------------------------------------------------------------------------------------ the suggester (message passing)

  /** the graph the suggester passes messages over: statements, joined by the body order, the decision that holds them, a member one
   *  writes and another reads, and a call to a graph's entry. -> {nodes: [ref], edges: Map(ref -> [[ref, kind]])} */
  function neighbourhood(T) {
    const E = new Map();
    const link = (a, b, k) => { if (!a || !b || a === b) return; if (!E.has(a)) E.set(a, []); if (!E.has(b)) E.set(b, []); E.get(a).push([b, k]); E.get(b).push([a, k]); };
    for (const G of T.graphs) {
      const g = G.g;
      const R = (id) => G.alias + '#' + id;
      const seq = (list) => { for (let i = 1; i < list.length; i++) link(R(list[i - 1]), R(list[i]), 'next'); };
      seq(ids(g.attrs.body));
      if (ids(g.attrs.body).length) link(G.alias, R(ids(g.attrs.body)[0]), 'next');
      for (const id of g.order) {
        const n = g.nodes.get(id);
        if (id[0] !== 's') continue;
        for (const k of ['then', 'else', 'body']) { const l = ids(n.attrs[k]); seq(l); if (l.length) link(R(id), R(l[0]), 'holds'); }
        for (const k2 of ids(n.attrs.sections)) { const l = ids(g.nodes.get(k2).attrs.body); seq(l); if (l.length) link(R(id), R(l[0]), 'holds'); }
      }
    }
    for (const [, mm] of T.members) for (const w of mm.writes) for (const w2 of mm.writes) if (w < w2) link(w, w2, 'data');
    for (const c of T.calls) if (c.to) link(c.from, c.to, 'call');
    return E;
  }

  /** labels: Map(ref -> label). -> Map(ref -> {label, score, votes}) for every unlabelled node with a labelled node within `hops`;
   *  each hop passes every node's label distribution to its neighbours, weighted by the edge's kind, damped by the hop */
  function suggest(T, labels, opts) {
    const o = Object.assign({ hops: 3, weights: { next: 1, holds: 0.8, data: 0.5, call: 0.6 }, damp: 0.6 }, opts || {});
    const E = neighbourhood(T);
    let dist = new Map();
    for (const [ref, lab] of labels) dist.set(ref, new Map([[lab, 1]]));
    const out = new Map();
    for (let h = 0; h < o.hops; h++) {
      const next = new Map();
      for (const [ref, d] of dist) {
        for (const [nb, kind] of E.get(ref) || []) {
          if (labels.has(nb)) continue;
          if (!next.has(nb)) next.set(nb, new Map());
          const m = next.get(nb);
          for (const [lab, s] of d) m.set(lab, (m.get(lab) || 0) + s * o.weights[kind] * Math.pow(o.damp, h));
        }
      }
      for (const [ref, m] of next) {
        if (!dist.has(ref)) dist.set(ref, new Map());
        const d = dist.get(ref);
        for (const [lab, s] of m) d.set(lab, (d.get(lab) || 0) + s);
      }
    }
    for (const [ref, d] of dist) {
      if (labels.has(ref)) continue;
      let best = null, bs = -1, tot = 0;
      for (const [lab, s] of d) { tot += s; if (s > bs) { bs = s; best = lab; } }
      if (best !== null) out.set(ref, { label: best, score: tot ? bs / tot : 0 });
    }
    return out;
  }

  const api = { build: build, alias: alias, questions: questions, suggest: suggest, neighbourhood: neighbourhood, RULES: RULES, MAX_PATHS: MAX_PATHS, ownNodes: ownNodes };
  if (isNode) module.exports = api;
  else root.TRACE = api;
})(typeof self !== 'undefined' ? self : this);
