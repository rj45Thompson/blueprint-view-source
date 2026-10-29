// city_parts.js - what each thing the 3D city draws IS, what is written on it, and what it answers when a person points at it or
// clicks it. The first city could not be clicked everywhere, and its nodes looked blank. Measured 10-28 on the files the
// published page served: the 148 node boxes had nothing on them (a statement's line floated above its box and
// faded in only inside 34 units; the 49 expression nodes had no text at all), and a click answered on statements, entries and
// question marks alone - never on an expression node, the interface ring or its messages, a call, a pipe, a title or a class floor.
// The class of that defect is a thing a person can SEE and cannot ASK about, so this module is a list, not more labels:
//   parts(D)   every thing the data says the city draws: a node, a graph, a class, its engine parent, a call, an interface and each
//              statement sending it, a pipe, a member flow
//   keyOf()    one name per part, the same in node and in the page
//   faceOf()   what is written ON a node, the way Blueprint writes one: the title bar, then the line
//   nameOf()   what a hover says;  explain()  what a click shows, for each kind the node and graph details (view3d.js) do not draw
//   check()    the list held to the data: a node with nothing to write, an end that resolves nowhere, a kind with no answer
// The city (view3d.js) registers every part it draws under its key, and its audit holds what it drew to parts(D).
// Runs in node (scene_cli.js check) and in the page (window.CITY).
(function (root) {
  'use strict';

  /** the kinds of thing the city draws; each answers a hover (nameOf) and a click (explain, or view3d's node and graph details) */
  const KINDS = ['node', 'graph', 'class', 'parent', 'call', 'interface', 'message', 'wire', 'member'];
  /** what Blueprint calls a node of each kind, written on the node's title bar beside its title */
  const TAG = { event: 'event', branch: 'branch', 'for-loop': 'for each', call: 'call', 'pure-call': 'pure', set: 'set', 'set-local': 'local',
    operator: 'operator', 'get-at-index': 'get', 'make-array': 'make array', 'type-test': 'cast', return: 'return' };

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  const graphOf = (D, alias) => D.graphs.find((G) => G.alias === alias) || null;
  const classOf = (D, cls) => D.classes.find((c) => c.name === cls) || null;
  const ifaceOf = (D, name) => D.interfaces.find((I) => I.name === name) || null;
  /** a statement or expression by its ref (Alias#id); an entry ref (the alias alone) is the graph, not a node */
  function nodeAt(D, ref) {
    const k = ref.indexOf('#');
    const G = graphOf(D, k < 0 ? ref : ref.slice(0, k));
    return G && k >= 0 ? G.nodes.find((n) => n.id === ref.slice(k + 1)) || null : null;
  }
  const resolves = (D, ref) => (ref.indexOf('#') < 0 ? !!graphOf(D, ref) : !!nodeAt(D, ref));
  /** the classes the city lays out as districts: one per class owning a graph */
  const classesDrawn = (D) => [...new Set(D.graphs.map((G) => G.cls))];

  /** the statements an expression's value reaches, following data pipes until a statement takes it */
  function feeds(G, id) {
    const seen = new Set(), out = [];
    const walk = (x) => {
      for (const w of G.wires) {
        if (w.kind !== 'data' || w.from !== x || seen.has(w.to)) continue;
        seen.add(w.to);
        if (w.to[0] === 's') out.push(w.to); else walk(w.to);
      }
    };
    walk(id);
    return out;
  }
  /** the statements that send an interface's methods, each with the Blueprint message node it was written from (READ from units):
   *  one node reached on two paths is written twice, so statements can outnumber the interface's message nodes */
  function messagesOf(D, I) {
    const names = I.methods.map((m) => m.split('(')[0]);
    const out = [];
    for (const G of D.graphs) for (const n of G.nodes) {
      if (n.id[0] !== 's' || n.kw !== 'call' || !names.some((x) => new RegExp('\\b' + x.replace(/\W/g, '\\$&') + '\\(').test(n.text))) continue;
      out.push({ ref: G.alias + '#' + n.id, unit: n.units.find((u) => /\(Message,/.test(u)) || '' });
    }
    return out;
  }
  /** every member flow: a statement that writes a member, to each statement that names it */
  function flowsOf(D) {
    const out = [];
    for (const m of D.members) for (const w of m.writes) for (const r of m.reads) if (w !== r) out.push({ name: m.name, from: w, to: r });
    return out;
  }

  /** every thing the data says the city draws */
  function parts(D) {
    const out = [];
    for (const G of D.graphs) {
      out.push({ kind: 'graph', alias: G.alias });
      for (const n of G.nodes) out.push({ kind: 'node', alias: G.alias, id: n.id });
      G.wires.forEach((w, i) => out.push({ kind: 'wire', alias: G.alias, i: i }));
    }
    for (const cls of classesDrawn(D)) {
      out.push({ kind: 'class', cls: cls });
      const c = classOf(D, cls);
      if (c && c.parent) out.push({ kind: 'parent', cls: cls });
    }
    D.calls.forEach((c, i) => { if (c.to) out.push({ kind: 'call', i: i }); });
    for (const I of D.interfaces) {
      out.push({ kind: 'interface', name: I.name });
      for (const m of messagesOf(D, I)) out.push({ kind: 'message', name: I.name, ref: m.ref });
    }
    for (const f of flowsOf(D)) out.push({ kind: 'member', name: f.name, from: f.from, to: f.to });
    return out;
  }

  /** one name per part; an unknown kind is refused, never given a made-up key */
  function keyOf(w) {
    switch (w && w.kind) {
      case 'node': return 'node|' + w.alias + '#' + w.id;
      case 'graph': return 'graph|' + w.alias;
      case 'class': case 'parent': return w.kind + '|' + w.cls;
      case 'call': return 'call|' + w.i;
      case 'interface': return 'interface|' + w.name;
      case 'message': return 'message|' + w.name + '|' + w.ref;
      case 'wire': return 'wire|' + w.alias + '|' + w.i;
      case 'member': return 'member|' + w.name + '|' + w.from + '>' + w.to;
    }
    throw new Error('city_parts: no key for a part of kind ' + (w && w.kind));
  }

  /** what is written ON a node, the way Blueprint writes one: its title and kind on the title bar, then its line - a statement's
   *  pseudo-code; an expression's value (when it says more than its title) and the statement that takes it */
  function faceOf(G, n) {
    const statement = n.id[0] === 's';
    const lines = [];
    if (statement) lines.push(n.text);
    else {
      if (n.text && n.text !== n.title) lines.push(n.text);
      const to = feeds(G, n.id);
      if (to.length) lines.push('-> ' + to.map((id) => id + ' ' + ((G.nodes.find((x) => x.id === id) || {}).title || '')).join(', '));
    }
    return { title: String(n.title || n.text || ''), tag: (TAG[n.kw] || n.kw || '') + (n.t ? ' ' + n.t : ''), lines: lines, statement: statement };
  }
  /** the graph's entry node: the event or the function itself, named as its island's title names it (not the qualified
   *  FrankBP.SetLockOnTarget the converter keys it by, which left the name itself too small to read on the box) */
  function entryFace(G) {
    return { title: String(G.title || G.alias), tag: G.kind + (G.rate ? ', ' + G.rate.hz + ' times a second' : ''), lines: [], statement: true };
  }
  const typeOf = (G, id) => { const n = G.nodes.find((x) => x.id === id); return n && n.t ? n.t : ''; };

  /** what a hover says: one line naming the part */
  function nameOf(D, w) {
    switch (w.kind) {
      case 'node': {
        const G = graphOf(D, w.alias), n = G && G.nodes.find((x) => x.id === w.id);
        if (!n) break;
        const f = faceOf(G, n);
        return w.alias + '#' + w.id + '  ' + f.title + '  (' + f.tag + ')' + (f.lines.length ? '  ' + f.lines[0] : '');
      }
      case 'graph': {
        const G = graphOf(D, w.alias);
        if (!G) break;
        return (G.title || G.alias) + '  (' + G.kind + ' in ' + G.cls + ', ' + G.nodes.length + ' nodes' + (G.rate ? ', runs ' + G.rate.hz + ' times a second' : '') + ')';
      }
      case 'class': {
        const c = classOf(D, w.cls);
        return 'class ' + w.cls + (c ? (c.parent ? ' : ' + c.parent : '') + '  (' + c.fields.length + ' fields, ' + c.methods.length + ' methods)' : '  (no class was assembled for it)');
      }
      case 'parent': {
        const c = classOf(D, w.cls);
        if (!c || !c.parent) break;
        return c.parent + ' (engine): the parent of ' + w.cls + ', read from what it uses on itself';
      }
      case 'call': {
        const c = D.calls[w.i];
        if (!c) break;
        return c.from + (c.how === 'by name' ? ' names "' + c.name + '" (' + c.method + ')' : ' calls') + ' -> ' + c.to;
      }
      case 'interface': {
        const I = ifaceOf(D, w.name);
        if (!I) break;
        return 'interface ' + I.name + '  (' + I.callers.length + ' message nodes, written as ' + messagesOf(D, I).length + ' statements)';
      }
      case 'message': return w.ref + ' sends ' + w.name;
      case 'wire': {
        const G = graphOf(D, w.alias), x = G && G.wires[w.i];
        if (!x) break;
        return x.kind + ' pipe in ' + w.alias + ': ' + x.from + ' -> ' + x.to + (x.pin ? ' (' + x.pin + ')' : '') + (x.kind === 'data' && typeOf(G, x.from) ? ', a ' + typeOf(G, x.from) : '');
      }
      case 'member': return 'member ' + w.name + ': written at ' + w.from + ', named at ' + w.to;
    }
    throw new Error('city_parts: nothing to name for ' + JSON.stringify(w));
  }

  const button = (key, label) => '<button class="item" data-key="' + esc(key) + '">' + esc(label) + '</button>';
  const nodeLink = (D, ref) => { const n = nodeAt(D, ref); return button(ref.indexOf('#') < 0 ? 'graph|' + ref : 'node|' + ref, ref + (n ? '  ' + n.title : '')); };
  const graphLink = (D, alias) => { const G = graphOf(D, alias); return button('graph|' + alias, (G && G.title) || alias); };
  const kv = (rows) => '<div class="kv">' + rows.map(([k, v]) => '<span>' + esc(k) + '</span><span>' + v + '</span>').join('') + '</div>';
  const h3 = (t) => '<h3>' + esc(t) + '</h3>';

  /** what a click shows, as the details panel's HTML; null for a node or a graph, whose details view3d.js draws with its tabs */
  function explain(D, w) {
    switch (w.kind) {
      case 'node': case 'graph': return null;
      case 'class': {
        const c = classOf(D, w.cls);
        const graphs = D.graphs.filter((G) => G.cls === w.cls);
        if (!c) return h3('Class ' + w.cls) + '<div class="chain">No class was assembled for these graphs (oo.js found no owner):</div>' + graphs.map((G) => graphLink(D, G.alias)).join('');
        return h3('Class ' + c.name + (c.parent ? ' : ' + c.parent : '')) + kv([
          ['parent', esc(c.parent ? c.parent + ' - ' + c.parentWhy : c.parentWhy || 'not read')],
          ['methods', c.methods.map((m) => graphLink(D, m.alias)).join('') || '-'],
          ['fields', c.fields.map((f) => esc(f.type + ' ' + f.name)).join('<br>') || '-'],
          ['components', c.components.map((m) => esc(m.type + ' ' + m.name)).join('<br>') || '-'],
        ]);
      }
      case 'parent': {
        const c = classOf(D, w.cls);
        return h3(c.parent + ' (engine)') + '<div class="chain">The parent of ' + esc(w.cls) + ' is read, not drawn by hand: ' + esc(w.cls) +
          ' uses these on itself, and the engine declares them on ' + esc(c.parent) + ' or above.</div>' +
          kv((c.uses || []).map((u) => [u.name, esc((u.declared ? u.declared.cls + ' at ' + u.declared.at : 'declared where: not read') + ' - used at ' + (u.where || []).join(', '))]));
      }
      case 'call': {
        const c = D.calls[w.i], G = graphOf(D, c.to);
        const timer = G && G.rate && G.rate.from === c.from;
        return h3(c.how === 'by name' ? 'A call by name' : 'A call') + kv([
          ['from', nodeLink(D, c.from)],
          ['to', graphLink(D, c.to)],
          ['how', c.how === 'by name' ? esc(c.method + ' with the name "' + c.name + '": no reference an editor can find, only the text') : 'a direct call'],
        ].concat(timer ? [['rate', esc('this timer runs it ' + G.rate.hz + ' times a second (every ' + G.rate.every + ' s)')]] : []));
      }
      case 'interface': {
        const I = ifaceOf(D, w.name), ms = messagesOf(D, I);
        const byNode = new Map();
        for (const m of ms) (byNode.get(m.unit) || byNode.set(m.unit, []).get(m.unit)).push(m.ref);
        return h3('Interface ' + I.name) + kv([
          ['methods', esc(I.methods.join('; '))],
          ['sent by', esc((I.senders || []).join(', ') || '-')],
          ['message nodes', esc(I.callers.length + ' in the paste (' + I.callers.join(', ') + ')')],
          ['statements', esc(ms.length + (ms.length !== I.callers.length ? ': a node reached on two paths is written once per path' : ''))],
          ['implemented by', 'not in the pastes'],
        ]) + [...byNode].map(([unit, refs]) => '<div class="chain">' + esc(unit || 'no message node read') + '</div>' + refs.map((r) => nodeLink(D, r)).join('')).join('');
      }
      case 'message': {
        const n = nodeAt(D, w.ref);
        return h3('A message to ' + w.name) + kv([
          ['sent at', nodeLink(D, w.ref)],
          ['Blueprint', esc(n.units.filter((u) => /\(Message,/.test(u)).join(', ') || 'no message node read')],
          ['the line', esc(n.text)],
          ['interface', button('interface|' + w.name, w.name)],
        ]);
      }
      case 'wire': {
        const G = graphOf(D, w.alias), x = G.wires[w.i];
        const on = x.kind === 'exec' ? D.paths.filter((p) => p.graph === w.alias && (x.from === 'entry' ? p.stmts[0] === x.to : p.stmts.some((s, k) => s === x.from && p.stmts[k + 1] === x.to))) : [];
        return h3((x.kind === 'exec' ? 'An exec pipe' : 'A data pipe') + ' in ' + (G.title || G.alias)) + kv([
          ['from', x.from === 'entry' ? graphLink(D, w.alias) + ' <span style="color:var(--dim)">(the entry)</span>' : nodeLink(D, w.alias + '#' + x.from)],
          ['to', nodeLink(D, w.alias + '#' + x.to)],
        ].concat(x.kind === 'exec' ? [['leaves by', esc(x.pin || '-')], ['on paths', on.map((p) => esc(p.ref + ' (' + (!p.means ? 'not covered' : Array.isArray(p.means) ? p.means.join(', ') : 'cannot happen: ' + p.means.excluded) + ')')).join('<br>') || 'none of the listed paths']]
          : [['carries', esc(typeOf(G, x.from) || 'a value whose type was not read')]]));
      }
      case 'member': {
        const m = D.members.find((x) => x.name === w.name);
        return h3('Member ' + w.name) + kv([
          ['this flow', nodeLink(D, w.from) + ' -> ' + nodeLink(D, w.to)],
          ['written at', m.writes.map((r) => nodeLink(D, r)).join('')],
          ['named at', m.reads.map((r) => nodeLink(D, r)).join('') || '-'],
        ]);
      }
    }
    throw new Error('city_parts: nothing to explain for ' + JSON.stringify(w));
  }

  /** the list held to the data -> [{key, why}]: a node with nothing to write on it, a part whose end resolves nowhere, a key two parts
   *  share, a part no hover or click can answer, an interface whose statements do not come from its own message nodes */
  function check(D) {
    const bad = [];
    const all = parts(D);
    const seen = new Set();
    for (const p of all) {
      const key = keyOf(p);
      if (seen.has(key)) bad.push({ key: key, why: 'two parts share this key' });
      seen.add(key);
      if (p.kind === 'node') {
        const G = graphOf(D, p.alias), n = G.nodes.find((x) => x.id === p.id);
        if (!faceOf(G, n).title.trim()) bad.push({ key: key, why: 'blank: nothing to write on the node' });
      }
      if (p.kind === 'wire') {
        const G = graphOf(D, p.alias), x = G.wires[p.i];
        const has = (id) => G.nodes.some((n) => n.id === id);
        if (!(x.from === 'entry' || has(x.from)) || !has(x.to)) bad.push({ key: key, why: 'a pipe whose end is no node: ' + x.from + ' -> ' + x.to });
      }
      if (p.kind === 'call') {
        const c = D.calls[p.i];
        if (!resolves(D, c.from) || !graphOf(D, c.to)) bad.push({ key: key, why: 'a call whose end is no node or graph: ' + c.from + ' -> ' + c.to });
      }
      if (p.kind === 'member' && (!resolves(D, p.from) || !resolves(D, p.to))) bad.push({ key: key, why: 'a member flow whose end is no node: ' + p.from + ' -> ' + p.to });
      if (KINDS.indexOf(p.kind) < 0) { bad.push({ key: key, why: 'a kind the city does not know' }); continue; }
      try {
        if (!String(nameOf(D, p)).trim()) bad.push({ key: key, why: 'a hover with nothing to say' });
        const html = explain(D, p);
        if (html !== null && !String(html).trim()) bad.push({ key: key, why: 'a click with nothing to show' });
      } catch (e) { bad.push({ key: key, why: 'no answer: ' + e.message }); }
    }
    for (const I of D.interfaces) {
      const units = new Set(messagesOf(D, I).map((m) => m.unit));
      if (units.size !== I.callers.length) bad.push({ key: 'interface|' + I.name, why: I.callers.length + ' message nodes in the paste, but its statements come from ' + units.size });
    }
    return { parts: all.length, byKind: KINDS.map((k) => [k, all.filter((p) => p.kind === k).length]), bad: bad };
  }

  /** each fault check() exists to refuse, planted on a copy of real data: each must be caught, by its own reason */
  function selftest(D) {
    const copy = () => JSON.parse(JSON.stringify(D));
    const out = [];
    const real = check(D);
    out.push(['the data as written', real.bad.length === 0, real.bad.length + ' problem(s)']);
    const plant = (what, edit, want) => {
      const X = copy();
      edit(X);
      const r = check(X);
      const hit = r.bad.some((b) => b.why.indexOf(want) >= 0);
      out.push(['plant: ' + what, hit, hit ? 'refused: ' + want : 'NOT refused - ' + r.bad.length + ' problem(s)']);
    };
    plant('a node with no title and no text', (X) => { const n = X.graphs[0].nodes[0]; n.title = ''; n.text = ''; }, 'blank');
    plant('a pipe to a node that is not there', (X) => { X.graphs[0].wires[0].to = 's999'; }, 'a pipe whose end is no node');
    plant('a call to a graph that is not there', (X) => { X.calls[0].to = 'NoSuchGraph'; }, 'a call whose end is no node or graph');
    plant('a member read at a node that is not there', (X) => { X.members.find((m) => m.writes.length).reads.push('NoSuchGraph#s1'); }, 'a member flow whose end is no node');
    plant('an interface message node the statements do not come from', (X) => { if (X.interfaces[0]) X.interfaces[0].callers.push('planted.t3d:1'); }, 'message nodes in the paste');
    let unknown = false;
    try { keyOf({ kind: 'billboard' }); } catch (e) { unknown = /no key/.test(e.message); }
    out.push(['plant: a part of a kind the city does not know', unknown, unknown ? 'refused: no key' : 'NOT refused']);
    return { ok: out.every((r) => r[1]), rows: out };
  }

  const API = { KINDS: KINDS, parts: parts, keyOf: keyOf, faceOf: faceOf, entryFace: entryFace, nameOf: nameOf, explain: explain, feeds: feeds,
    messagesOf: messagesOf, check: check, selftest: selftest, esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.CITY = API;
})(this);
