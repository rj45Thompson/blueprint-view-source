// view.js - the Blueprint view's page: find a graph, open it, read it in the form you pick (PLAN.md phase 3).
//
// Every projection is printed from the stored graph by pl.js (window.NGL), the same code the round-trip gate runs: the Blueprint
// style from NGL.layout, the blocks from the node tree, pseudo-code from NGL.printPseudo, C# from NGL.printCs, C++ from
// NGL.printCpp. Nothing here reads C#. The data is data/<project>.js, written by `node view/pl_cli.js bundle graphs view/data`.
(function () {
  'use strict';
  const NGL = window.NGL;
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const tt = NGL.termText;

  const state = { projects: [], index: [], byFile: new Map(), parsed: new Map(), vocab: {}, current: null, form: 'blueprint', history: [], selected: null, calls: null,
    callers: null, sourceOf: {} };
  const store = { get(k, d) { try { const v = localStorage.getItem('bpv.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('bpv.' + k, JSON.stringify(v)); } catch (e) { /* a private window: the page works without it */ } } };

  // ---------------------------------------------------------------- data

  function loadBundles(done) {
    const manifest = window.NGL_MANIFEST || [];
    // a page written with its graphs inside it (the Unity package's window writes one file): nothing left to load
    if (!manifest.length && (window.NGL_BUNDLES || []).length) { done(); return; }
    if (!manifest.length) { $('#status').textContent = 'No graphs bundled: run  node view/pl_cli.js bundle graphs view/data'; return; }
    let left = manifest.length;
    for (const m of manifest) {
      const s = document.createElement('script');
      s.src = 'data/' + m.script + '?v=' + (window.BPV_STAMP || '');
      s.onload = () => { if (--left === 0) done(); };
      s.onerror = () => { $('#status').textContent = 'Could not load data/' + m.script; };
      document.head.appendChild(s);
    }
  }

  function buildIndex() {
    for (const b of window.NGL_BUNDLES) {
      state.projects.push(b.project);
      state.sourceOf[b.project] = b.source || '';
      Object.assign(state.vocab, NGL.parseVocabulary(b.vocabulary));
      for (const file in b.files) indexFile(b.project, file, b.files[file], b.ext || '.cs');
    }
  }

  /** one .ngl file into the index; `ext` names its source (.cs for the C# reader's graphs, .t3d for converted Blueprint text) */
  function indexFile(project, file, text, ext) {
    const key = project + '/' + file;
    state.byFile.set(key, text);
    // one pass over the lines: a graph's size is ALL its statements (its s-lines), not only the top-level ones in body=[...]
    let cur = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('graph ')) {
        const m = /^graph (\S+|~"(?:[^"\\]|\\.)*") (.*)$/.exec(line);
        const name = m[1][0] === '~' ? JSON.parse(m[1].slice(1)) : m[1];
        const at = /\bat=(\d+):(\d+)/.exec(m[2]);
        cur = { name: name, file: key, project: project, src: file.replace(/\.ngl$/, ext), line: at ? +at[1] : 0, at: at ? at[1] + ':' + at[2] : '',
          kind: (/\bkind=(\S+)/.exec(m[2]) || [])[1] || '', size: 0, lower: name.toLowerCase() };
        state.index.push(cur);
      } else if (cur && /^\s+s\d+ /.test(line)) cur.size++;
    }
  }

  function graphsOf(file) {
    if (!state.parsed.has(file)) state.parsed.set(file, NGL.parse(state.byFile.get(file), file));
    return state.parsed.get(file);
  }

  /** by name AND place: one Blueprint node with several exec outputs starts several methods on the same line */
  function find(entry) {
    const gs = graphsOf(entry.file);
    return gs.find((g) => tt(g.attrs.at) === entry.at && g.name === entry.name) || null;
  }

  /** a call's `def` (File.cs:LINE in its project) -> the index entry of the graph declared there */
  function entryForDef(project, def) {
    const i = def.lastIndexOf(':');
    const file = def.slice(0, i).replace(/^\.\.\/([^/]+)\//, (m, p) => { project = p; return ''; }), line = +def.slice(i + 1);
    return state.index.find((e) => e.project === project && e.src === file && e.line === line) || null;
  }

  // ---------------------------------------------------------------- opening a graph

  function open(entry, push) {
    if (!entry) return;
    // the history keeps the selection too, so Back returns to the node as well as the graph (NV-4; round 1: it was dropped)
    if (push !== false && state.current) state.history.push({ entry: state.current.entry, selected: state.selected });
    const g = find(entry);
    if (!g) { $('#status').textContent = 'Graph not found: ' + entry.name; return; }
    state.current = { entry: entry, g: g, find: NGL.fileFinder(graphsOf(entry.file)) };
    state.selected = null;
    store.set('last', entry.project + '|' + entry.src + '|' + entry.at + '|' + entry.name);
    $('#back').disabled = state.history.length === 0;
    renderHeader();
    render();
    inspect(null);
    highlightResult();
  }

  function renderHeader() {
    const { entry, g } = state.current;
    $('#gname').textContent = entry.name;
    $('#gplace').textContent = entry.project + '/' + entry.src + ':' + entry.line;
    const params = NGL.listOf(g.attrs.params).map(tt).join(', ');
    $('#gsig').textContent = (NGL.listOf(g.attrs.mods).map(tt).join(' ') + ' ' + entry.kind + ' (' + params + ')' + (g.attrs.returns ? ' → ' + tt(g.attrs.returns) : '')).trim();
    $('#gdoc').textContent = g.attrs.doc ? NGL.textOf(g.attrs.doc) : '';
    $('#gdoc').hidden = !g.attrs.doc;
    const n = g.order.filter((id) => id[0] === 's').length;
    $('#gstats').textContent = n + ' statement' + (n === 1 ? '' : 's') + ', ' + g.order.filter((id) => id[0] === 'e').length + ' data nodes';
    // what it was read from (round 1 T-Q-A2-9: the page named no commit)
    $('#gsource').textContent = state.sourceOf[entry.project] ? 'read from ' + state.sourceOf[entry.project] : '';
    // who calls it, by METHOD (round 1 T-Q-A2-1: the page named only calling classes, in the Map)
    const box = $('#gcallers');
    box.innerHTML = '';
    const callers = (callersIndex().get(entry) || []).slice().sort((a, b) => (a.name < b.name ? -1 : 1));
    box.appendChild(el('span', '', callers.length ? 'called by ' + callers.length + ':' : 'called by no method in these graphs'));
    for (const c of callers.slice(0, 12)) {
      const btn = el('button', 'link', c.name);
      btn.addEventListener('click', () => open(c));
      box.appendChild(btn);
    }
    if (callers.length > 12) box.appendChild(el('span', '', '+' + (callers.length - 12) + ' more'));
  }

  /** each graph's calling graphs, from every call node's `def` (the links gate's click-throughs), resolved once */
  function callersIndex() {
    if (state.callers) return state.callers;
    const map = new Map();
    for (const [file, text] of state.byFile) {
      const project = file.split('/')[0];
      let from = null;
      for (const line of text.split('\n')) {
        if (line.startsWith('graph ')) {
          const m = /^graph (\S+|~"(?:[^"\\]|\\.)*") .*?\bat=(\d+:\d+)/.exec(line);
          const name = m ? (m[1][0] === '~' ? JSON.parse(m[1].slice(1)) : m[1]) : null;
          from = name && state.index.find((e) => e.file === file && e.name === name && e.at === m[2]);
          continue;
        }
        const d = / def=(\S+)/.exec(line);
        if (!d || !from) continue;
        const to = entryForDef(project, d[1]);
        if (!to) continue;
        if (!map.has(to)) map.set(to, []);
        if (!map.get(to).includes(from)) map.get(to).push(from);
      }
    }
    state.callers = map;
    return map;
  }

  function render() {
    const host = $('#canvas');
    host.innerHTML = '';
    host.className = 'canvas form-' + state.form;
    for (const b of document.querySelectorAll('[data-form]')) b.setAttribute('aria-pressed', String(b.dataset.form === state.form));
    if (!state.current) return;
    const fn = { blueprint: renderBlueprint, blocks: renderBlocks, pseudo: renderPseudo, cs: renderCs, cpp: renderCpp }[state.form];
    fn(host, state.current.g);
  }

  // ---------------------------------------------------------------- the Blueprint style

  const CATEGORY = {
    flow: ['branch', 'for-loop', 'for-each-loop', 'for-each-with-deconstruction', 'while-loop', 'do-while-loop', 'switch', 'switch-on-patterns', 'return',
      'expression-body', 'break', 'section-break', 'continue', 'try-catch-finally', 'using', 'lock', 'yield', 'goto-label', 'checked-unchecked-block', 'unsafe-fixed'],
    call: ['call', 'call-if-valid', 'await'],
    pure: ['pure-call', 'if-valid'],
    set: ['set-local', 'using-declaration', 'ref-local', 'set', 'set-with-math', 'set-if-null', 'deconstructing-set', 'increment', 'increment-inside-an-expression', 'assignment-inside-an-expression'],
    math: ['operator', 'select', 'coalesce', 'get-at-index', 'range', 'index-from-the-end'],
    make: ['construct', 'make-array', 'tuple', 'format', 'with'],
    cast: ['cast', 'type-test', 'compare', 'pattern-match'],
    lambda: ['lambda', 'local-function'],
    fail: ['throw'],
  };
  const catOf = {};
  for (const c in CATEGORY) for (const k of CATEGORY[c]) catOf[k] = c;
  const TYPE_CLASS = (t) => {
    if (!t) return 'ty-any';
    if (t === 'bool') return 'ty-bool';
    if (/^(int|long|short|byte|uint|ulong|ushort|sbyte)\??$/.test(t)) return 'ty-int';
    if (/^(float|double|decimal)\??$/.test(t)) return 'ty-float';
    if (t === 'string') return 'ty-string';
    if (/^(List|IList|IReadOnlyList|IEnumerable|Dictionary|HashSet|IReadOnlyCollection|ICollection)<|\[\]$/.test(t)) return 'ty-array';
    if (t === 'void') return 'ty-any';
    return 'ty-object';
  };
  const tierOf = (kw) => ((state.vocab[kw] || [])[0] || {}).tier || (/^(block|section|catch|arm|empty|section-break)$/.test(kw) ? 'structure' : '');

  function renderBlueprint(host, g) {
    const L = NGL.layout(g);
    const wrap = el('div', 'bp');
    const svg = sv('svg', { class: 'bp-svg', role: 'img', 'aria-label': 'Blueprint-style graph of ' + state.current.entry.name });
    const defs = sv('defs', {});
    const pat = sv('pattern', { id: 'grid', width: 16, height: 16, patternUnits: 'userSpaceOnUse' });
    pat.appendChild(sv('path', { d: 'M16 0H0V16', class: 'bp-grid' }));
    defs.appendChild(pat);
    svg.appendChild(defs);
    const world = sv('g', {});
    const PADW = 60;
    world.appendChild(sv('rect', { x: -PADW, y: -PADW, width: L.w + 2 * PADW + 400, height: L.h + 2 * PADW + 200, fill: 'url(#grid)', class: 'bp-bg' }));
    const wiresG = sv('g', { class: 'bp-wires' });
    const nodesG = sv('g', { class: 'bp-nodes' });
    world.appendChild(wiresG);
    world.appendChild(nodesG);
    svg.appendChild(world);
    wrap.appendChild(svg);
    host.appendChild(wrap);

    const R = NGL.ROW, T = NGL.TITLE, PAD = NGL.PAD;
    const pinY = new Map();     // `${id}|in|${k}` / `${id}|out|${k}` / `${id}|exec|${name}` -> {x, y}
    for (const [id, b] of L.boxes) {
      const node = g.nodes.get(id);
      const cat = catOf[b.kw] || 'other';
      const tier = tierOf(b.kw);
      const gN = sv('g', { class: 'bp-node cat-' + cat + (tier === 'Extended' ? ' tier-x' : tier === 'Island' ? ' tier-i' : ''), transform: 'translate(' + b.x + ',' + b.y + ')', 'data-id': id, tabindex: 0 });
      gN.appendChild(sv('rect', { class: 'bp-body', width: b.w, height: b.h, rx: 6 }));
      gN.appendChild(sv('rect', { class: 'bp-title', width: b.w, height: T, rx: 6 }));
      gN.appendChild(sv('rect', { class: 'bp-title', y: T - 8, width: b.w, height: 8 }));
      const title = sv('text', { x: PAD + (b.exec ? 0 : 0), y: 16, class: 'bp-title-text' });
      title.textContent = b.title;
      gN.appendChild(title);
      let y0 = T;
      if (b.sub) { const s = sv('text', { x: PAD, y: T + 12, class: 'bp-sub' }); s.textContent = b.sub; gN.appendChild(s); y0 += R - 4; }
      let row = 0;
      if (b.exec) {
        gN.appendChild(sv('path', { class: 'bp-exec-pin', d: 'M2 ' + (y0 + 5) + 'l7 5l-7 5z' }));
        gN.appendChild(sv('path', { class: 'bp-exec-pin', d: 'M' + (b.w - 9) + ' ' + (y0 + 5) + 'l7 5l-7 5z' }));
        pinY.set(id + '|execin', { x: b.x, y: b.y + y0 + 10 });
        pinY.set(id + '|exec|then', { x: b.x + b.w, y: b.y + y0 + 10 });
        row = 1;
      }
      b.ins.forEach((p, k) => {
        const y = y0 + (row + k) * R + 12;
        const cls = TYPE_CLASS(p.v.ref ? tt(g.nodes.get(p.v.ref).attrs.t) : '');
        gN.appendChild(sv('circle', { cx: 6, cy: y - 4, r: 4, class: 'bp-pin ' + cls + (p.v.ref ? ' wired' : '') }));
        const lab = sv('text', { x: 16, y: y, class: 'bp-pin-label' });
        lab.textContent = p.name;
        gN.appendChild(lab);
        if (!p.v.ref) {
          const val = tt(p.v) || '';
          const v = sv('text', { x: 16 + (p.name.length + 2) * NGL.CH, y: y, class: 'bp-pin-value' });
          v.textContent = val.length > 46 ? val.slice(0, 45) + '…' : val;
          const tip = sv('title', {}); tip.textContent = val; v.appendChild(tip);
          gN.appendChild(v);
        }
        pinY.set(id + '|in|' + k, { x: b.x + 6, y: b.y + y - 4 });
      });
      b.outs.forEach((o, k) => {
        const y = y0 + (row + k) * R + 12;
        gN.appendChild(sv('circle', { cx: b.w - 6, cy: y - 4, r: 4, class: 'bp-pin ' + TYPE_CLASS(o.type) }));
        if (o.name) { const lab = sv('text', { x: b.w - 16, y: y, class: 'bp-pin-label end' }); lab.textContent = o.name; gN.appendChild(lab); }
        pinY.set(id + '|out|' + k, { x: b.x + b.w - 6, y: b.y + y - 4 });
        if (o.name) pinY.set(id + '|outname|' + o.name, { x: b.x + b.w - 6, y: b.y + y - 4 });
      });
      const after = row + Math.max(b.ins.length, b.outs.length);
      b.bodies.forEach((body, k) => {
        const y = y0 + (after + k) * R + 12;
        gN.appendChild(sv('path', { class: 'bp-exec-pin', d: 'M' + (b.w - 9) + ' ' + (y - 9) + 'l7 5l-7 5z' }));
        const lab = sv('text', { x: b.w - 14, y: y, class: 'bp-pin-label end exec' }); lab.textContent = body.name; gN.appendChild(lab);
        pinY.set(id + '|exec|' + body.name, { x: b.x + b.w, y: b.y + y - 4 });
      });
      const def = node.attrs.def;
      if (def) { gN.classList.add('has-def'); const tip = sv('title', {}); tip.textContent = 'Open ' + b.title + ' (' + tt(def) + ')'; gN.appendChild(tip); }
      gN.addEventListener('click', (ev) => { ev.stopPropagation(); select(id); });
      gN.addEventListener('dblclick', (ev) => { ev.stopPropagation(); if (def) open(entryForDef(state.current.entry.project, tt(def))); });
      gN.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { if (def) open(entryForDef(state.current.entry.project, tt(def))); else select(id); } });
      nodesG.appendChild(gN);
    }
    // Get chips: a far read, drawn beside the reader as Blueprint draws a local variable, never as a long wire
    const chipsAt = new Map();
    for (const c of L.chips) { if (!chipsAt.has(c.at)) chipsAt.set(c.at, new Set()); chipsAt.get(c.at).add(c.name + '|' + c.made + '|' + c.span); }
    for (const [at, set] of chipsAt) {
      const b = L.boxes.get(at);
      if (!b) continue;
      let k = 0;
      for (const key of set) {
        const [name, made, span] = key.split('|');
        const w = (name.length + 5) * NGL.CH;
        const x = b.x - w - 14, y = b.y + 4 + k * 22;
        const chip = sv('g', { class: 'bp-chip', transform: 'translate(' + x + ',' + y + ')', tabindex: 0 });
        chip.appendChild(sv('rect', { width: w, height: 18, rx: 9 }));
        const t = sv('text', { x: 9, y: 13 }); t.textContent = 'get ' + name; chip.appendChild(t);
        const tip = sv('title', {}); tip.textContent = name + ' was made ' + span + ' statements earlier' + (made === 'p' ? ' (a parameter)' : ' (' + made + '): click to go there'); chip.appendChild(tip);
        chip.addEventListener('click', (ev) => { ev.stopPropagation(); if (made !== 'p') select(made, true); });
        nodesG.appendChild(chip);
        k++;
      }
    }
    const curve = (a, b, cls) => {
      const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
      wiresG.appendChild(sv('path', { class: cls, d: 'M' + a.x + ' ' + a.y + 'C' + (a.x + dx) + ' ' + a.y + ' ' + (b.x - dx) + ' ' + b.y + ' ' + b.x + ' ' + b.y }));
    };
    for (const w of L.wires) {
      if (w.kind === 'exec') {
        const a = pinY.get(w.from + '|exec|' + w.fromPin), b = pinY.get(w.to + '|execin');
        if (a && b) curve(a, b, 'bp-wire exec');
      } else if (w.kind === 'data') {
        const consumer = L.boxes.get(w.to);
        const k = consumer ? consumer.ins.findIndex((p) => (p.v.ref === w.from) || (p.v.term && NGL.refsIn(p.v.term).includes(w.from))) : -1;
        const a = pinY.get(w.from + '|out|0'), b = k >= 0 ? pinY.get(w.to + '|in|' + k) : null;
        if (a && b) curve(a, b, 'bp-wire data ' + TYPE_CLASS(tt(g.nodes.get(w.from).attrs.t)));
      } else if (w.kind === 'read') {
        const reader = L.boxes.get(w.to);
        const k = reader ? reader.ins.findIndex((p) => !p.v.ref && new RegExp('(^|[^\\w.])' + w.name + '\\b').test(tt(p.v) || '')) : -1;
        const a = pinY.get(w.from + '|outname|' + w.name) || pinY.get(w.from + '|out|0');
        const b = k >= 0 ? pinY.get(w.to + '|in|' + k) : (reader ? { x: reader.x, y: reader.y + 12 } : null);
        if (a && b) curve(a, b, 'bp-wire read');
      }
    }
    panZoom(wrap, svg, world, L);
  }

  function panZoom(wrap, svg, world, L) {
    const view = { x: 20, y: 20, k: 1 };
    const READABLE = 0.85;     // a graph opens at a size its pins can be read at, at its entry; Fit shows the whole of it
    const fitK = () => { const r = wrap.getBoundingClientRect(); return Math.max(0.02, Math.min(1, (r.width - 40) / Math.max(1, L.w + 200), (r.height - 40) / Math.max(1, L.h + 80))); };
    const fit = () => { view.k = fitK(); view.x = 80 * view.k + 10; view.y = 20; apply(); };
    const start = () => { view.k = Math.max(fitK(), READABLE); view.x = 80 * view.k + 10; view.y = 20; apply(); };
    const apply = () => world.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
    state.fit = fit;
    state.zoom = (k) => { view.k = k; apply(); };
    state.panTo = (x, y) => { const r = wrap.getBoundingClientRect(); view.x = r.width / 2 - x * view.k; view.y = r.height / 3 - y * view.k; apply(); };
    // a press becomes a pan only once it moves: capturing the pointer on every press sent the second click of a double-click
    // to the canvas, so a call node never opened its callee (measured 2026-10-28 with a real double-click)
    let drag = null;
    wrap.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, id: e.pointerId, moving: false }; });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moving) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
        drag.moving = true;
        wrap.setPointerCapture(drag.id);
        wrap.classList.add('dragging');
      }
      view.x = drag.vx + e.clientX - drag.x; view.y = drag.vy + e.clientY - drag.y; apply();
    });
    wrap.addEventListener('pointerup', () => { drag = null; wrap.classList.remove('dragging'); });
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k2 = Math.max(0.08, Math.min(2.5, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      view.x = mx - (mx - view.x) * (k2 / view.k); view.y = my - (my - view.y) * (k2 / view.k); view.k = k2;
      apply();
    }, { passive: false });
    requestAnimationFrame(start);
  }

  // ---------------------------------------------------------------- blocks: top to bottom, nested, operands inline

  function renderBlocks(host, g) {
    const root = el('div', 'blocks');
    const pill = (v) => {
      if (!v || v.none) return el('span', 'pill empty', '—');
      if (v.ref) {
        const n = g.nodes.get(v.ref);
        const b = NGL.bpNode(g, n);
        const p = el('span', 'pill cat-' + (catOf[n.kw] || 'other'));
        p.dataset.id = n.id;
        p.appendChild(el('span', 'pill-title', b.title));
        for (const i of b.ins) { p.appendChild(el('span', 'pill-sep', i.name.length <= 2 ? '' : i.name)); p.appendChild(pill(i.v)); }
        p.addEventListener('click', (e) => { e.stopPropagation(); select(n.id); });
        return p;
      }
      const t = tt(v) || '';
      if (t.indexOf('#') >= 0) {
        const p = el('span', 'pill term');
        let last = 0;
        for (const m of t.matchAll(/#([sekf]\d+)/g)) { p.appendChild(document.createTextNode(t.slice(last, m.index))); p.appendChild(pill({ ref: m[1] })); last = m.index + m[0].length; }
        p.appendChild(document.createTextNode(t.slice(last)));
        return p;
      }
      return el('span', 'pill term', t);
    };
    const stmts = (ids, parent) => { for (const r of ids) parent.appendChild(block(g.nodes.get(typeof r === 'string' ? r : NGL.idOf(r)))); };
    const block = (n) => {
      const b = NGL.bpNode(g, n);
      if (n.kw === 'block') { const d = el('div', 'stack'); stmts(NGL.listOf(n.attrs.body), d); return d; }
      if (n.kw === 'empty' || n.kw === 'section-break') return el('div', 'block quiet', n.kw === 'empty' ? ';' : 'end of case');
      const d = el('div', 'block cat-' + (catOf[n.kw] || 'other'));
      d.dataset.id = n.id;
      const head = el('div', 'block-head');
      head.appendChild(el('span', 'block-title', b.title + (b.sub ? ' · ' + b.sub : '')));
      for (const i of b.ins) { head.appendChild(el('span', 'pill-sep', i.name)); head.appendChild(pill(i.v)); }
      d.appendChild(head);
      if (n.attrs.note) d.appendChild(el('div', 'block-note', NGL.textOf(n.attrs.note)));
      for (const body of b.bodies) {
        const arm = el('div', 'arm');
        arm.appendChild(el('div', 'arm-label', body.name));
        const inner = el('div', 'stack');
        stmts(body.ids, inner);
        arm.appendChild(inner);
        d.appendChild(arm);
      }
      d.addEventListener('click', (e) => { e.stopPropagation(); select(n.id); });
      return d;
    };
    const ids = g.attrs.arrow ? [g.attrs.arrow] : NGL.listOf(g.attrs.body);
    stmts(ids, root);
    host.appendChild(root);
  }

  // ---------------------------------------------------------------- text projections

  function renderPseudo(host, g) {
    const pre = el('div', 'code pseudo');
    for (const line of NGL.printPseudo(g, state.current.find)) {
      const row = el('div', 'line');
      row.style.paddingLeft = (line.depth * 2) + 'ch';
      row.textContent = line.text;
      row.dataset.id = line.id;
      row.addEventListener('click', () => select(line.id));
      pre.appendChild(row);
    }
    host.appendChild(pre);
  }

  const CS_KEYWORDS = /\b(var|new|return|if|else|for|foreach|in|while|do|switch|case|default|break|continue|throw|try|catch|finally|using|lock|yield|await|async|static|null|true|false|this|base|is|as|out|ref|nameof|typeof|int|float|bool|string|void|double|long|auto|nullptr|static_cast|const|delegate|when|not|and|or)\b/g;
  function code(text, cls, banner) {
    const box = el('div', 'code ' + cls);
    if (banner) box.appendChild(el('div', 'banner', banner));
    const pre = el('pre');
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    pre.innerHTML = text.split('\n').map((l) => {
      const parts = l.split(/("(?:[^"\\]|\\.)*"|\/\*.*?\*\/|\/\/.*$)/);
      return parts.map((p, i) => i % 2 ? '<span class="' + (p[0] === '"' ? 'str' : 'cmt') + '">' + esc(p) + '</span>' :
        esc(p).replace(CS_KEYWORDS, '<span class="kw">$1</span>').replace(/\b(\d[\d_.]*[fFdDmMuUlL]?)\b/g, '<span class="num">$1</span>')).join('');
    }).join('\n');
    box.appendChild(pre);
    return box;
  }
  /** the declaration line a reader expects above a body, from the graph's own header (its params are name:type) */
  function declaration(g, cpp) {
    const name = state.current.entry.name.split(/[.>]/).pop();
    const decl = (p, out) => { const s = tt(p); const i = s.indexOf(':'); return out ? (cpp ? s.slice(i + 1) + '& ' + s.slice(0, i) : 'out ' + s.slice(i + 1) + ' ' + s.slice(0, i)) : s.slice(i + 1) + ' ' + s.slice(0, i); };
    // a converted Blueprint function's outputs are out parameters (its `outs`; bp.js, KismetCompiler.cpp:1686-1695): C++ references
    const params = NGL.listOf(g.attrs.params).map((p) => decl(p, false)).concat(NGL.listOf(g.attrs.outs).map((p) => decl(p, true))).join(', ');
    const ret = g.attrs.returns ? tt(g.attrs.returns) : '';
    const mods = NGL.listOf(g.attrs.mods).map(tt).filter((m) => !cpp || m === 'static' || m === 'virtual').join(' ');
    return ((mods ? mods + ' ' : '') + (ret ? ret + ' ' : '') + name + '(' + params + ')').replace(/\bstring\b/g, cpp ? 'std::string' : 'string');
  }
  const asDeclaration = (g, body) => (g.attrs.arrow ? ' => ' + body + ';' : '\n' + body);
  // what the gates measured about the C# of each kind of graph: the C# reader's graphs round-trip to their source; a converted
  // Blueprint has no C# source, so the claim is only that it parses (U2ue.CodeGraph syntax), never that it compiles
  const CS_BANNER = {
    '.cs': 'C#, printed from the graph. The round-trip gate holds the body to the source: the same syntax tree, for all 4,201 graphs.',
    '.t3d': 'C#, converted from Unreal Blueprint text (view/bp.js). Every converted method parses as C# (the syntax gate); no name is resolved and nothing is compiled.',
  };
  function renderCs(host, g) {
    const ext = /\.t3d$/.test(state.current.entry.src) ? '.t3d' : '.cs';
    host.appendChild(code(declaration(g, false) + asDeclaration(g, NGL.printCs(g, state.current.find)), 'cs', CS_BANNER[ext]));
  }
  function renderCpp(host, g) {
    const counter = { nodes: 0, untranslated: 0 };
    const text = NGL.printCpp(g, state.current.find, counter);
    host.appendChild(code(declaration(g, true) + asDeclaration(g, text), 'cpp', 'A C++ reading form, printed from the same graph. Not compiled. ' + counter.untranslated + ' of ' + counter.nodes +
      ' nodes have no C++ spelling here and are shown as C# after a /* C#: */ marker.'));
  }

  // ---------------------------------------------------------------- selection and the inspector

  function select(id, pan) {
    state.selected = id;
    for (const e of document.querySelectorAll('.is-selected')) e.classList.remove('is-selected');
    for (const e of document.querySelectorAll('[data-id="' + id + '"]')) e.classList.add('is-selected');
    if (pan && state.form === 'blueprint' && state.panTo) {
      const L = NGL.layout(state.current.g);
      const b = L.boxes.get(id);
      if (b) state.panTo(b.x + b.w / 2, b.y);
    }
    inspect(id);
  }

  function inspect(id) {
    const box = $('#inspector');
    box.innerHTML = '';
    if (!id || !state.current) { box.appendChild(el('p', 'hint', 'Select a node to see what it is, where it came from, and the Blueprint node it compares to. Double-click a call to open the method it calls.')); return; }
    const g = state.current.g;
    const n = g.nodes.get(id);
    if (!n) return;
    const b = NGL.bpNode(g, n);
    box.appendChild(el('h3', '', b.title));
    const voc = state.vocab[n.kw] || [];
    const dl = el('dl');
    const row = (k, v) => { if (v === undefined || v === null || v === '') return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); };
    row('node', n.id + ' · ' + n.kw);
    if (voc[0]) { row('family', voc.map((x) => x.family).join(' / ')); row('tier', voc[0].tier); row('in Blueprint', voc.map((x) => x.counterpart).filter(Boolean).join(' / ') || 'no counterpart'); }
    row('type', tt(n.attrs.t));
    row('source line', state.current.entry.src + ':' + (n.attrs.at ? tt(n.attrs.at) : '?'));
    row('calls', n.attrs.def ? tt(n.attrs.def) : '');
    if (n.attrs.binds) row('calls', tt(n.attrs.binds) + ' - ' + ({ interface: 'an interface member: no graph of its own, the object decides which implementation runs',
      abstract: 'an abstract member: each subclass has its own', delegate: 'a delegate: whatever function was handed in runs' }[tt(n.attrs.bindskind)] || tt(n.attrs.bindskind)));
    row('dispatch', tt(n.attrs.dispatch));
    row('reads', NGL.listOf(n.attrs.reads).map(tt).join(', '));
    box.appendChild(dl);
    if (n.attrs.note) box.appendChild(el('blockquote', '', NGL.textOf(n.attrs.note)));
    if (n.attrs.def) { const go = el('button', 'btn', 'Open ' + b.title); go.addEventListener('click', () => open(entryForDef(state.current.entry.project, tt(n.attrs.def)))); box.appendChild(go); }
    const raw = el('details');
    raw.appendChild(el('summary', '', 'the stored line'));
    const attrs = Object.entries(n.attrs).filter(([k]) => k !== 'note').map(([k, v]) => k + '=' + (v.list ? '[' + v.list.map((x) => x.ref ? '#' + x.ref : x.none ? '-' : tt(x)).join(' ') + ']' : v.ref ? '#' + v.ref : tt(v))).join(' ');
    raw.appendChild(el('code', '', n.id + ' ' + n.kw + ' ' + attrs));
    box.appendChild(raw);
  }

  // ---------------------------------------------------------------- finding: search, the class view, the map

  function showResults(q) {
    const list = $('#results');
    list.innerHTML = '';
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (words.length ? state.index.filter((e) => words.every((w) => e.lower.includes(w))) : state.index.filter((e) => e.size >= 40))
      .sort((a, b) => (words.length ? a.name.length - b.name.length : b.size - a.size)).slice(0, 200);
    $('#count').textContent = words.length ? hits.length + (hits.length === 200 ? '+' : '') + ' found' : 'the largest graphs';
    for (const e of hits) {
      const li = el('li');
      const btn = el('button', 'result');
      btn.appendChild(el('span', 'r-name', e.name));
      // its kind too (NV-1; round 1: a result carried name, place and size, not what it is)
      btn.appendChild(el('span', 'r-where', (e.kind ? e.kind + ' · ' : '') + e.src + ':' + e.line + ' · ' + e.size + ' st.'));
      btn.addEventListener('click', () => open(e));
      btn.dataset.key = e.file + '|' + e.at + '|' + e.name;
      li.appendChild(btn);
      list.appendChild(li);
    }
    highlightResult();
  }
  function highlightResult() {
    if (!state.current) return;
    const key = state.current.entry.file + '|' + state.current.entry.at + '|' + state.current.entry.name;
    for (const b of document.querySelectorAll('.result')) b.classList.toggle('is-current', b.dataset.key === key);
  }

  /** who calls whom, by class: every call node's `def`, resolved once over every graph (the map, IR-5's recommendation) */
  function callIndex() {
    if (state.calls) return state.calls;
    const byClass = new Map();
    const cls = (name) => name.split(/[.>]/)[0];
    const ensure = (c) => { if (!byClass.has(c)) byClass.set(c, { name: c, methods: [], out: new Map(), in: new Map() }); return byClass.get(c); };
    for (const e of state.index) ensure(cls(e.name)).methods.push(e);
    for (const e of state.index) {
      const text = state.byFile.get(e.file);
      if (!text) continue;
    }
    for (const [file, text] of state.byFile) {
      const project = file.split('/')[0];
      let graphName = null;
      for (const line of text.split('\n')) {
        if (line.startsWith('graph ')) { graphName = line.split(' ')[1]; continue; }
        const m = / def=(\S+)/.exec(line);
        if (!m || !graphName) continue;
        const target = entryForDef(project, m[1]);
        if (!target) continue;
        const from = cls(graphName), to = cls(target.name);
        if (from === to) continue;
        const a = ensure(from), b = ensure(to);
        a.out.set(to, (a.out.get(to) || 0) + 1);
        b.in.set(from, (b.in.get(from) || 0) + 1);
      }
    }
    state.calls = byClass;
    return byClass;
  }

  function showMap() {
    const box = $('#mapbox');
    box.innerHTML = '';
    const idx = callIndex();
    const classes = [...idx.values()].sort((a, b) => b.methods.length - a.methods.length);
    const current = state.current ? state.current.entry.name.split(/[.>]/)[0] : classes[0].name;
    const c = idx.get(current) || classes[0];
    box.appendChild(el('h3', '', c.name));
    box.appendChild(el('p', 'hint', c.methods.length + ' graphs · calls ' + c.out.size + ' classes · called by ' + c.in.size));
    const lists = el('div', 'map-lists');
    const side = (label, m) => {
      const col = el('div', 'map-col');
      col.appendChild(el('h4', '', label));
      const ul = el('ul');
      for (const [name, n] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
        const li = el('li');
        const btn = el('button', 'link', name + ' · ' + n);
        btn.addEventListener('click', () => { const first = idx.get(name).methods.slice().sort((x, y) => y.size - x.size)[0]; open(first); showMap(); });
        li.appendChild(btn);
        ul.appendChild(li);
      }
      col.appendChild(ul);
      return col;
    };
    lists.appendChild(side('called by', c.in));
    lists.appendChild(side('calls', c.out));
    box.appendChild(lists);
    box.appendChild(el('h4', '', 'its graphs'));
    const ul = el('ul', 'methods');
    for (const e of c.methods.slice().sort((a, b) => a.line - b.line)) {
      const li = el('li');
      const btn = el('button', 'link', e.name.slice(c.name.length + 1) + ' · ' + e.size);
      btn.addEventListener('click', () => open(e));
      li.appendChild(btn);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    // the main parts, ranked (round 1 T-Q-A3-2: nothing in the page ranked classes, so "which is the biggest" had no answer)
    box.appendChild(el('h4', '', 'every class, most graphs first'));
    const rank = el('ul', 'map-rank');
    for (const k of classes.slice(0, 25)) {
      const li = el('li');
      const btn = el('button', 'link', k.name + ' · ' + k.methods.length + ' graphs · calls ' + k.out.size);
      btn.addEventListener('click', () => { open(k.methods.slice().sort((x, y) => y.size - x.size)[0]); showMap(); });
      li.appendChild(btn);
      rank.appendChild(li);
    }
    box.appendChild(rank);
    if (classes.length > 25) box.appendChild(el('p', 'hint', '+' + (classes.length - 25) + ' more classes'));
  }

  // ---------------------------------------------------------------- Blueprint text into graphs (view/bp.js, REQ-BPV-27)

  /** text copied in Unreal's Blueprint editor, or an exported .t3d, converted by the same bp.js the corpus gate runs and opened here
   *  like any graph, in every form. A text the reader cannot read is refused with the line it stopped at; nothing half-converted is
   *  shown. A second paste replaces the first. Returns the report (or null), for window.BPV.convert */
  function convertPasted() {
    const out = $('#bpout');
    out.innerHTML = '';
    const text = $('#bptext').value;
    if (!text.trim()) { out.appendChild(el('p', 'hint', 'Nothing to convert: paste Blueprint nodes first.')); return null; }
    let r, gs;
    try { r = window.BP.convert(text, 'Pasted'); } catch (e) { out.appendChild(el('p', 'err', 'Not converted: ' + e.message)); return null; }
    try { gs = NGL.parse(r.ngl, 'Pasted/Pasted.ngl'); } catch (e) { out.appendChild(el('p', 'err', 'Converted, but the graph text does not read back: ' + e.message)); return null; }
    const rep = r.report;
    if (!gs.length) { out.appendChild(el('p', 'err', 'No method found: the text holds ' + rep.nodes + ' node(s) and none starts a chain (an event, a function entry).')); return rep; }
    state.index = state.index.filter((e) => e.project !== 'Pasted');
    if (!state.projects.includes('Pasted')) state.projects.push('Pasted');
    state.parsed.set('Pasted/Pasted.ngl', gs);
    indexFile('Pasted', 'Pasted.ngl', r.ngl, '.t3d');
    state.calls = null;
    state.callers = null;
    state.sourceOf.Pasted = 'text pasted into From Blueprint, converted by view/bp.js';
    const islands = Object.entries(rep.islands).map(([c, n]) => c.replace('K2Node_', '') + ' ' + n);
    out.appendChild(el('p', 'what', rep.methods + ' method' + (rep.methods === 1 ? '' : 's') + ' from ' + rep.nodes + ' node' + (rep.nodes === 1 ? '' : 's') +
      (islands.length ? '; kept as marked islands: ' + islands.join(', ') : '; every node has a code form') +
      (rep.unreached ? '; ' + rep.unreached + ' dead (no entry leads to them)' : '') + (rep.empty ? '; ' + rep.empty + ' event(s) with nothing wired after them' : '') + '.'));
    const ul = el('ul');
    for (const e of state.index.filter((x) => x.project === 'Pasted')) {
      const li = el('li');
      const btn = el('button', 'result');
      btn.appendChild(el('span', 'r-name', e.name));
      btn.appendChild(el('span', 'r-where', e.size + ' st.'));
      btn.dataset.key = e.file + '|' + e.at + '|' + e.name;
      btn.addEventListener('click', () => open(e));
      li.appendChild(btn);
      ul.appendChild(li);
    }
    out.appendChild(ul);
    for (const n of rep.notes.slice(0, 8)) out.appendChild(el('p', 'hint', n));
    open(state.index.find((x) => x.project === 'Pasted'));
    $('#status').textContent = state.index.length + ' graphs in ' + state.projects.join(' + ');
    return rep;
  }

  // ---------------------------------------------------------------- wiring the page

  function start() {
    buildIndex();
    $('#status').textContent = state.index.length + ' graphs in ' + state.projects.join(' + ');
    showResults('');
    $('#q').addEventListener('input', (e) => showResults(e.target.value));
    for (const b of document.querySelectorAll('[data-form]')) b.addEventListener('click', () => { state.form = b.dataset.form; store.set('form', state.form); render(); if (state.selected) select(state.selected); });
    for (const t of document.querySelectorAll('[data-panel]')) t.addEventListener('click', () => {
      for (const x of document.querySelectorAll('[data-panel]')) x.setAttribute('aria-selected', String(x === t));
      $('#find').hidden = t.dataset.panel !== 'find';
      $('#map').hidden = t.dataset.panel !== 'map';
      $('#convert').hidden = t.dataset.panel !== 'convert';
      if (t.dataset.panel === 'map') showMap();
    });
    $('#back').addEventListener('click', () => { const h = state.history.pop(); if (h) { open(h.entry, false); if (h.selected) select(h.selected, true); } });
    $('#fit').addEventListener('click', () => { if (state.fit) state.fit(); });
    $('#bpgo').addEventListener('click', convertPasted);
    state.form = store.get('form', 'blueprint');
    const last = String(store.get('last', '')).split('|');
    const hash = decodeURIComponent(location.hash.slice(1));
    const pick = (hash && state.index.find((e) => e.name === hash)) ||
      state.index.find((e) => e.project === last[0] && e.src === last[1] && e.at === last[2] && (last.length < 4 || e.name === last[3])) ||
      state.index[0];
    open(pick, false);
    // a link pasted into the address bar of an open page changes only its hash, which reloads nothing (measured in round 1:
    // the page stayed on the graph it had); the page follows its own link format whenever it changes
    window.addEventListener('hashchange', () => {
      const name = decodeURIComponent(location.hash.slice(1));
      const e = name && state.index.find((x) => x.name === name);
      if (e && (!state.current || state.current.entry !== e)) open(e);
    });
    window.BPV = { state: state, open: open, select: select, find: (name) => state.index.find((e) => e.name === name), setForm: (f) => { state.form = f; render(); },
      convert: (text) => { $('#bptext').value = text; return convertPasted(); } };
  }

  loadBundles(start);
})();
