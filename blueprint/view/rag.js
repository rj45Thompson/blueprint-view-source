// rag.js - the trace as a retrieval layer: a question about the code answered from the few pieces of the graph it touches, not from
// the files, so the graph already built does a second job and a model reads a fraction of the tokens the code would cost.
//
// Documents are the trace's own pieces - a statement (its pseudo-code line), a use case step (what it does, its requirements, its
// cites), a requirement (text and measure), a brainstorm question (and the requirements that answer it), a class member (its type,
// where it is read) - joined by the trace's edges: a step cites statements, carries requirements; a question is raised at
// statements and answered by requirements; a member is read or written by statements. retrieve() seeds on the names a question uses
// (graph aliases, members, ids weigh most; plain words least), follows the edges one hop, and writes the context in the chain's order
// (use case > step > code > requirement > question), under a budget. Runs in node (rag_cli.js) and in the page (window.RAG).
(function (root) {
  'use strict';

  const WORD = /[A-Za-z_][A-Za-z0-9_]*(?:#s\d+(?::\w+)?)?|[A-Z]+-[A-Z0-9-]+/g;
  const STOP = new Set('a an the is it its of to in on at and or not what when who how why does do did which where this that with be are was for from by as if then else after before there anything nothing'.split(' '));

  /** trace.json + classes.json + the model's chain (logic_map's chain.json) -> the index */
  function index(trace, classes, chain) {
    const docs = new Map();
    const edges = new Map();
    const add = (id, kind, text, order) => docs.set(id, { id: id, kind: kind, text: text, order: order, words: new Set(wordsOf(text)) });
    const link = (a, b) => { if (!docs.has(a) || !docs.has(b)) return; (edges.get(a) || edges.set(a, []).get(a)).push(b); (edges.get(b) || edges.set(b, []).get(b)).push(a); };
    let o = 0;
    for (const G of trace.graphs) {
      add(G.alias, 'graph', G.alias + ' (' + G.kind + (G.title ? ', ' + G.title : '') + ') = ' + G.name, o++);
      for (const s of G.statements) { add(G.alias + '#' + s.id, 'code', G.alias + '#' + s.id + '  ' + s.text, o++); link(G.alias, G.alias + '#' + s.id); }
    }
    for (const r of chain.requirements) add(r.id, 'requirement', r.id + ' ' + r.text + (r.measure ? ' [' + r.measure + ']' : ''), o++);
    for (const u of chain.usecases) {
      add(u.id, 'usecase', u.id + ' ' + u.name + ' (' + u.level + ')', o++);
      for (const st of u.legs) {
        add(st.label, 'step', st.label + ' ' + st.text + ' [' + st.reqs.join(', ') + ']', o++);
        link(u.id, st.label);
        for (const r of st.reqs) link(st.label, r);
        for (const s of st.statements) link(st.label, s);
      }
    }
    // the persona questions (the model's brainstorm, each inverted into its use case): the bridge from a person's words to the code
    for (const a of chain.asks || []) { add(a.id, 'ask', a.id + ' ' + a.text + ' -> ' + a.inverse, o++); link(a.id, a.inverse); }
    for (const q of trace.questions) {
      add(q.id, 'question', q.id + ' ' + q.text + (chain.answers[q.id] ? ' -> ' + [].concat(chain.answers[q.id]).join(', ') : ''), o++);
      for (const r of q.refs) link(q.id, r);
      for (const a of [].concat(chain.answers[q.id] || [])) link(q.id, a);
    }
    for (const c of (classes ? classes.classes : [])) {
      add(c.name, 'class', 'class ' + c.name + (c.parent ? ' : ' + c.parent + ' (' + c.parentWhy + ')' : ''), o++);
      for (const f of c.fields) {
        const id = c.name + '.' + f.name;
        add(id, 'member', f.type + ' ' + c.name + '.' + f.name, o++);
        link(c.name, id);
        const k = f.name.replace(/\s+/g, '_');
        for (const G of trace.graphs) for (const s of G.statements) if (s.text.indexOf(k) >= 0) link(id, G.alias + '#' + s.id);
      }
    }
    // how rare each word is across the documents (inverse document frequency): a word on every page says little
    const df = new Map();
    for (const d of docs.values()) for (const w of d.words) df.set(w, (df.get(w) || 0) + 1);
    const idf = new Map([...df].map(([w, n]) => [w, Math.log((docs.size + 1) / (n + 0.5))]));
    return { docs: docs, edges: edges, idf: idf };
  }

  /** a text's words for matching: each name whole, and - as code search does - its camelCase and underscore parts
   *  (EnemyElement -> enemyelement, enemy, element), so a person's word meets the identifier that holds it */
  function wordsOf(text) {
    const out = [];
    for (const w of text.match(WORD) || []) {
      out.push(w.toLowerCase());
      for (const part of w.replace(/#.*$/, '').split(/_|(?<=[a-z0-9])(?=[A-Z])/)) if (part.length > 1) out.push(part.toLowerCase());
    }
    return out;
  }
  const tokensOf = (s) => [...new Set(wordsOf(s))].filter((w) => !STOP.has(w) && w.length > 1);

  /** question -> {seeds, context, ids} under `budget` characters */
  function retrieve(I, question, budget) {
    budget = budget || 4000;
    const q = tokensOf(question);
    const scored = [];
    for (const d of I.docs.values()) {
      let s = 0;
      for (const w of q) {
        if (d.id.toLowerCase() === w) s += 8;                              // a name of the trace itself
        else if (d.words.has(w)) s += I.idf.get(w) || 0;                   // weighted by how rare the word is
      }
      if (s) scored.push([s, d]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].order - b[1].order);
    const seeds = scored.slice(0, 6).map((x) => x[1].id);
    // CHOSEN by relevance: the seeds, then their neighbours, then down the chain (a use case's steps, a step's code and
    // requirements) - each wave in the order it was reached; the budget stops the choosing, so what is cut is the least related
    const order = [];
    const seen = new Set();
    const score = new Map(scored.map(([s, d]) => [d.id, s]));
    const take = (id) => { if (!seen.has(id) && I.docs.has(id)) { seen.add(id); order.push(id); } };
    // within a wave, the pieces that match the question best come first
    const wave = (ids) => ids.filter((id) => !seen.has(id)).sort((a, b) => (score.get(b) || 0) - (score.get(a) || 0)).forEach(take);
    seeds.forEach(take);
    wave(seeds.flatMap((id) => I.edges.get(id) || []));
    wave([...order].filter((id) => I.docs.get(id).kind === 'usecase').flatMap((id) => (I.edges.get(id) || []).filter((n) => I.docs.get(n).kind === 'step')));
    wave([...order].filter((id) => I.docs.get(id).kind === 'step').flatMap((id) => (I.edges.get(id) || []).filter((n) => /^(code|requirement)$/.test(I.docs.get(n).kind))));
    const chosen = [];
    let used = 0;
    for (const id of order) {
      const d = I.docs.get(id);
      if (used + d.text.length + 1 > budget) continue;
      chosen.push(d);
      used += d.text.length + 1;
    }
    // PRINTED in the chain's order: use cases, steps, code, requirements, questions, classes and members
    const rank = { ask: 0, usecase: 0, step: 1, graph: 2, code: 3, requirement: 4, question: 5, class: 6, member: 7 };
    chosen.sort((a, b) => rank[a.kind] - rank[b.kind] || a.order - b.order);
    return { seeds: seeds, ids: chosen.map((d) => d.id), context: chosen.map((d) => d.text).join('\n') };
  }

  const api = { index: index, retrieve: retrieve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RAG = api;
})(typeof self !== 'undefined' ? self : this);
