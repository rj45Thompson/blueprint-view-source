// unreal2d.js - a pasted Blueprint drawn the way Unreal's Blueprint editor draws it: the reference beside the city, so a reader can
// hold the new view against the picture they already know. What is drawn is READ, not laid out by us:
//   where           each node where its author put it (NodePosX / NodePosY), each comment box with its own size and colour
//   pins and wires  as the paste stores them; a wire names its node AND its pin, because a duplicated node keeps its pins' ids
//   titles          in the engine's formats - Event {FunctionName}, Cast To {TargetName}, Branch, Sequence (BlueprintGraph/Private/
//                   K2Node_*.cpp), SET (GraphEditor/Private/KismetNodes/SGraphNodeK2Var.cpp:125) - with a function's DisplayName or
//                   CompactNodeTitle from its header (view/bp_titles.js, tools/bp_titletable.py), else FName::NameToDisplayString,
//                   ported below from Core/Private/UObject/UnrealNames.cpp
//   colours         the editor's defaults (GraphEditor/Private/GraphEditorSettings.cpp:40-100; the cast's K2Node_DynamicCast.cpp),
//                   linear values shown as sRGB, the way Slate shows them
// OURS, and the page says so: each box's size (Slate measures its text; this counts characters), the wires' curves, the grid.
//   model(text, titles)   a paste's text -> {nodes, wires, comments, box, notes}   (in node: it reads the paste with bp.js)
//   svg(model, opts)      -> an SVG string; opts.highlight: a Set of node names to light, opts.maxWidth for the page
//   displayString(s, b)   the engine's rule for turning a name into the words a person reads
// Runs in node (scene_cli.js embeds each paste's model in the city's data, showcase.py its SVG) and in the page (window.UE2D).
(function (root) {
  'use strict';
  const BP = typeof module !== 'undefined' && module.exports ? require('./bp.js') : root.BP;

  // ------------------------------------------------------------------------------------------------ the engine's rule for a name
  // FName::NameToDisplayString (Core/Private/UObject/UnrealNames.cpp): a space before an upper case letter or a digit that starts a
  // run, an underscore read as a space, a run of capitals and digits kept together ("Draw Scale 3D"), the leading b of a bool
  // dropped, the first letter upper case, and these words lower case after a space. The engine's exemption list starts empty.
  const ARTICLES = ['In', 'As', 'To', 'Or', 'At', 'On', 'If', 'Be', 'By', 'The', 'For', 'And', 'With', 'When', 'From'];
  const isLower = (c) => c >= 'a' && c <= 'z', isUpper = (c) => c >= 'A' && c <= 'Z', isDigit = (c) => c >= '0' && c <= '9';
  function displayString(name, isBool) {
    const s = String(name);
    let out = '', inRun = false, wasSpace = false, wasParen = false, wasNumber = false, wasMinus = false;
    for (let i = 0; i < s.length; i++) {
      let ch = s[i];
      const lower = isLower(ch), upper = isUpper(ch), digit = isDigit(ch);
      if (i === 0 && isBool && ch === 'b' && s.length > 1 && isUpper(s[1])) continue;
      if ((upper || (digit && !wasMinus)) && !inRun && !wasParen && !wasNumber) {
        if (!wasSpace && out.length) { out += ' '; wasSpace = true; }
        inRun = true;
      }
      if (lower) inRun = false;
      if (ch === '_') { ch = ' '; inRun = true; }
      if (!out.length) ch = ch.toUpperCase();
      else if (!digit && (wasSpace || wasParen)) {
        const article = ARTICLES.some((a) => s.length - i > a.length && !isLower(s[i + a.length]) && s.startsWith(a, i));
        ch = article ? ch.toLowerCase() : ch.toUpperCase();
      }
      wasSpace = ch === ' ';
      wasParen = ch === '(';
      wasMinus = ch === '-';
      wasNumber = digit || (wasNumber && (wasMinus || ch === '.'));
      out += ch;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ the editor's colours
  // GraphEditorSettings.cpp:40-63 (pins) and :91-97 (titles), linear; K2Node_DynamicCast.cpp GetNodeTitleColor (0, 0.55, 0.62)
  const PIN = { default: [0.75, 0.6, 0.4], exec: [1, 1, 1], bool: [0.3, 0, 0], byte: [0, 0.16, 0.13127], class: [0.1, 0, 0.5],
    int: [0.013575, 0.77, 0.429609], int64: [0.413575, 0.77, 0.429609], float: [0.357667, 1, 0.06], double: [0.039216, 0.666667, 0],
    real: [0.039216, 0.666667, 0], name: [0.607717, 0.224984, 1], delegate: [1, 0.04, 0.04], object: [0, 0.4, 0.91],
    softobject: [0.3, 1, 1], softclass: [1, 0.3, 1], interface: [0.8784, 1, 0.4], string: [1, 0, 0.660537], text: [0.8, 0.2, 0.4],
    struct: [0, 0.1, 0.6], wildcard: [0.22, 0.1958, 0.1958], Vector: [1, 0.591255, 0.016512], Rotator: [0.353393, 0.454175, 1],
    Transform: [1, 0.172585, 0] };
  const TITLE = { event: [1, 0, 0], call: [0.190525, 0.583898, 1], pure: [0.4, 0.85, 0.35], terminator: [0.6, 0, 1],
    branch: [1, 1, 1], cast: [0, 0.55, 0.62] };
  function srgb(l, a) {
    const c = (x) => Math.round(255 * Math.max(0, Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)));
    return a === undefined ? 'rgb(' + c(l[0]) + ',' + c(l[1]) + ',' + c(l[2]) + ')' : 'rgba(' + c(l[0]) + ',' + c(l[1]) + ',' + c(l[2]) + ',' + a + ')';
  }
  const pinLin = (p) => (p.cat === 'struct' ? PIN[p.subObj] || PIN.struct : PIN[p.cat] || PIN.default);

  // ------------------------------------------------------------------------------------------------ a paste -> its model
  const num = (v) => (v === undefined || v === '' ? 0 : Number(v));
  const unq = (v) => String(v || '').replace(/^"|"$/g, '');
  const INPUT_EVENTS = { K2Node_InputAxisEvent: 1, K2Node_InputAction: 1, K2Node_InputKey: 1, K2Node_InputAxisKeyEvent: 1, K2Node_InputTouch: 1 };
  /** a function's titles from its header: by its class and name, else by its name where one class alone declares it */
  function lookup(titles, cls, fn) {
    if (!titles || !fn) return null;
    if (cls && titles[cls + '.' + fn]) return titles[cls + '.' + fn];
    const keys = Object.keys(titles).filter((k) => k.endsWith('.' + fn));
    return keys.length === 1 ? titles[keys[0]] : null;
  }
  /** what the editor writes on a node: its title, the line under it, its colour, and whether it is drawn compact */
  function face(o, titles, notes) {
    const c = o.cls, p = o.props;
    const ref = (k) => (p[k] ? BP.parseStruct(p[k]) : null);
    const fr = ref('FunctionReference'), er = ref('EventReference'), vr = ref('VariableReference');
    const execs = o.pins.some((q) => q.cat === 'exec');
    if (BP.EVENTS[c] || INPUT_EVENTS[c]) {
      if (c === 'K2Node_CustomEvent') return { title: unq(p.CustomFunctionName), sub: 'Custom Event', color: TITLE.event };
      const t = BP.eventTitle(o);
      if (t) return { title: t, color: TITLE.event };
      const name = er ? unq(er.MemberName) : c.replace('K2Node_', '');
      const m = lookup(titles, er && er.MemberParent ? BP.shortName(er.MemberParent) : '', name);
      if (!m) notes.add('event ' + name + ': no DisplayName read; titled by NameToDisplayString');
      return { title: 'Event ' + (m && m.display ? m.display : displayString(name)), color: TITLE.event };
    }
    if (fr) {
      const fn = unq(fr.MemberName);
      const m = lookup(titles, fr.MemberParent ? BP.shortName(fr.MemberParent) : '', fn);
      if (m && m.compact && !execs) return { title: m.compact, compact: true, color: TITLE.pure };
      if (!m) notes.add(fn + ': not in the engine headers read (a Blueprint function, or one this engine version lacks); titled by NameToDisplayString');
      return { title: m && m.display ? m.display : displayString(fn), color: execs ? TITLE.call : TITLE.pure };
    }
    if (vr) {
      const name = unq(vr.MemberName);
      const vp = o.pins.find((q) => q.name === name) || o.pins.find((q) => q.cat !== 'exec' && q.name !== 'self');
      const col = vp ? pinLin(vp) : PIN.default;
      if (c === 'K2Node_VariableGet') return { title: displayString(name, vp && vp.cat === 'bool'), pill: true, color: col };
      return { title: 'SET', color: col };
    }
    if (c === 'K2Node_DynamicCast') return { title: 'Cast To ' + (p.TargetType ? BP.shortName(p.TargetType) : '?'), color: TITLE.cast };
    if (c === 'K2Node_IfThenElse') return { title: 'Branch', color: TITLE.branch };
    if (c === 'K2Node_ExecutionSequence') return { title: 'Sequence', color: TITLE.branch };
    if (c === 'K2Node_Knot') return { title: '', knot: true, color: PIN.default };
    if (c === 'K2Node_FunctionEntry' || c === 'K2Node_FunctionResult') return { title: c === 'K2Node_FunctionResult' ? 'Return Node' : displayString(o.name), color: TITLE.terminator };
    if (c === 'K2Node_MacroInstance') {
      const mg = /:(\w+)['"]*\)?$/.exec(String(p.MacroGraphReference || ''));
      return { title: mg ? displayString(mg[1]) : 'Macro', color: TITLE.branch };
    }
    notes.add(c + ': no title rule here; titled by its class');
    return { title: displayString(c.replace('K2Node_', '')), color: execs ? TITLE.call : TITLE.pure };
  }

  // sizes: OURS (Slate measures text; this counts characters at the editor's font sizes), said so on the page
  const CW = 6.2, TITLE_H = 30, SUB_H = 14, ROW = 24, PAD = 12;
  const tw = (s, px) => String(s).length * CW * (px || 12) / 12;
  function pinLabel(n, q, f) {
    if (q.cat === 'exec' && (q.name === 'execute' || q.name === 'then')) return '';
    if (f.pill) return '';
    if (n.cls === 'K2Node_VariableSet' && q.dir === 'out') return '';
    if (f.compact) return '';
    return q.friendly || displayString(q.name, q.cat === 'bool');
  }
  function defaultText(q) {
    if (q.dir !== 'in' || q.linked.length || q.cat === 'exec' || q.cat === 'object' || q.cat === 'class' || q.cat === 'interface') return '';
    const v = q.def !== undefined && q.def !== '' ? q.def : '';
    if (q.cat === 'bool') return v.toLowerCase() === 'true' ? '[x]' : '[ ]';
    return v.replace(/(-?\d+\.\d*?)0+(?=\D|$)/g, '$1').replace(/\.(?=\D|$)/g, '.0').replace(/,/g, ' ');
  }

  function model(text, titles) {
    if (!BP) throw new Error('unreal2d: model() reads the paste with bp.js, which is not loaded');
    const doc = BP.parseText(text);
    const notes = new Set();
    const nodes = [], comments = [];
    for (const o of doc.objects) {
      if (o.outer) continue;
      const x = num(o.props.NodePosX), y = num(o.props.NodePosY);
      if (o.cls === 'EdGraphNode_Comment') {
        if (o.props.NodeWidth === undefined || o.props.NodeHeight === undefined) notes.add('a comment whose size the paste does not hold: its title alone is drawn');
        const cc = o.props.CommentColor ? BP.parseStruct(o.props.CommentColor) : null;
        comments.push({ x: x, y: y, w: num(o.props.NodeWidth), h: num(o.props.NodeHeight), text: BP.displayText(o.props.NodeComment) || '',
          color: cc ? [Number(cc.R), Number(cc.G), Number(cc.B)] : null });
        continue;
      }
      if (!/^K2Node_/.test(o.cls)) continue;
      const f = face(o, titles, notes);
      // an event's OutputDelegate is drawn as a square in its title bar, not as a row (as the editor draws it)
      const delegate = o.pins.find((q) => !q.hidden && q.cat === 'delegate' && q.name === 'OutputDelegate' && q.dir === 'out');
      const shown = o.pins.filter((q) => !q.hidden && q !== delegate);
      const ins = shown.filter((q) => q.dir === 'in'), outs = shown.filter((q) => q.dir === 'out');
      const lab = (q) => pinLabel(o, q, f);
      let w, h;
      if (f.knot) { w = 16; h = 16; }
      else if (f.pill) { w = Math.max(70, tw(f.title) + 46); h = 30; }
      else if (f.compact) { w = Math.max(84, 44 + tw(f.title, 26)); h = Math.max(ins.length, outs.length, 1) * ROW + 16; }
      else {
        const left = Math.max(0, ...ins.map((q) => tw(lab(q)) + (defaultText(q) ? tw(defaultText(q), 11) + 14 : 0)));
        const right = Math.max(0, ...outs.map((q) => tw(lab(q))));
        w = Math.max(120, tw(f.title, 13) + 2 * PAD + 22, tw(f.sub || '', 11) + 2 * PAD, left + right + 2 * PAD + 44);
        h = TITLE_H + (f.sub ? SUB_H : 0) + Math.max(ins.length, outs.length, 1) * ROW + 8;
      }
      const top = f.knot || f.pill || f.compact ? (f.pill ? 15 : 8) : TITLE_H + (f.sub ? SUB_H : 0);
      const pins = [];
      ins.forEach((q, k) => pins.push({ id: q.id, name: q.name, dir: 'in', exec: q.cat === 'exec', color: srgb(pinLin(q)), label: lab(q), def: defaultText(q),
        linked: q.linked.length > 0, x: f.knot ? 8 : 0, y: f.knot ? 8 : f.pill ? h / 2 : top + (k + 0.5) * ROW }));
      outs.forEach((q, k) => pins.push({ id: q.id, name: q.name, dir: 'out', exec: q.cat === 'exec', color: srgb(pinLin(q)), label: lab(q), def: '',
        linked: q.linked.length > 0, links: q.linked.map((l) => [l.node, l.pin]), x: f.knot ? 8 : w, y: f.knot ? 8 : f.pill ? h / 2 : top + (k + 0.5) * ROW }));
      nodes.push({ name: o.name, cls: o.cls, x: x, y: y, w: Math.round(w), h: Math.round(h), title: f.title, sub: f.sub || '', compact: !!f.compact,
        pill: !!f.pill, knot: !!f.knot, color: srgb(f.color), pins: pins, delegate: delegate ? srgb(PIN.delegate) : '' });
    }
    // the wires: from each output pin to the input it names - by node name and pin id together (a duplicated node keeps pin ids)
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const wires = [];
    for (const n of nodes) for (const p of n.pins) for (const [tn, tp] of p.links || []) {
      const t = byName.get(tn), q = t && t.pins.find((x) => x.id === tp && x.dir === 'in');
      if (!q) { notes.add('a wire from ' + n.name + ' to ' + tn + ' lands on no shown pin (a hidden one, or a node outside the paste)'); continue; }
      wires.push({ from: n.name, to: t.name, exec: p.exec, color: p.color, a: [n.x + p.x, n.y + p.y], b: [t.x + q.x, t.y + q.y] });
    }
    for (const p of [].concat(...nodes.map((n) => n.pins))) delete p.links;
    const xs = nodes.map((n) => n.x).concat(comments.map((c) => c.x)), ys = nodes.map((n) => n.y).concat(comments.map((c) => c.y));
    const xe = nodes.map((n) => n.x + n.w).concat(comments.map((c) => c.x + c.w)), ye = nodes.map((n) => n.y + n.h).concat(comments.map((c) => c.y + c.h));
    const box = nodes.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xe), Math.max(...ye)] : [0, 0, 0, 0];
    return { nodes: nodes, wires: wires, comments: comments, box: box, notes: [...notes] };
  }

  // ------------------------------------------------------------------------------------------------ the model -> SVG
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  const execPin = (x, y, filled, col) => '<path d="M' + (x - 5) + ' ' + (y - 6) + ' h5 l6 6 l-6 6 h-5 z" fill="' + (filled ? col : 'none') + '" stroke="' + col + '" stroke-width="1.5"/>';
  const dataPin = (x, y, filled, col) => '<circle cx="' + x + '" cy="' + y + '" r="5" fill="' + (filled ? col : '#111') + '" stroke="' + col + '" stroke-width="1.6"/>';
  function svg(m, opts) {
    const o = opts || {};
    const hi = o.highlight || new Set();
    const M = 60;
    const [x0, y0, x1, y1] = m.box;
    const W = x1 - x0 + 2 * M, H = y1 - y0 + 2 * M;
    const out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + (x0 - M) + ' ' + (y0 - M) + ' ' + W + ' ' + H + '" width="' + W + '" height="' + H + '"' +
      (o.maxWidth ? ' style="max-width:' + o.maxWidth + ';height:auto"' : '') + ' font-family="Roboto, \'Segoe UI\', Arial, sans-serif" role="img">'];
    out.push('<defs><pattern id="g16" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0H0V16" fill="none" stroke="#2c2c2c" stroke-width="1"/></pattern>' +
      '<pattern id="g128" width="128" height="128" patternUnits="userSpaceOnUse"><rect width="128" height="128" fill="url(#g16)"/><path d="M128 0H0V128" fill="none" stroke="#171717" stroke-width="2"/></pattern>' +
      m.nodes.filter((n) => !n.pill && !n.compact && !n.knot).map((n) => '<linearGradient id="t_' + esc(n.name) + '" x1="0" x2="1"><stop offset="0" stop-color="' + n.color + '" stop-opacity="0.85"/><stop offset="1" stop-color="' + n.color + '" stop-opacity="0.08"/></linearGradient>').join('') + '</defs>');
    out.push('<rect x="' + (x0 - M) + '" y="' + (y0 - M) + '" width="' + W + '" height="' + H + '" fill="#262626"/><rect x="' + (x0 - M) + '" y="' + (y0 - M) + '" width="' + W + '" height="' + H + '" fill="url(#g128)"/>');
    for (const c of m.comments) {
      const col = c.color ? srgb(c.color, 0.25) : 'rgba(255,255,255,0.12)';
      if (c.w && c.h) out.push('<rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" rx="4" fill="' + col + '" stroke="rgba(255,255,255,0.2)"/>');
      out.push('<text x="' + (c.x + 10) + '" y="' + (c.y + 22) + '" fill="#e8e8e8" font-size="17">' + esc(c.text) + '</text>');
    }
    for (const w of m.wires) {
      const dx = Math.max(40, Math.abs(w.b[0] - w.a[0]) * 0.5);
      out.push('<path d="M' + w.a[0] + ' ' + w.a[1] + ' C' + (w.a[0] + dx) + ' ' + w.a[1] + ' ' + (w.b[0] - dx) + ' ' + w.b[1] + ' ' + w.b[0] + ' ' + w.b[1] +
        '" fill="none" stroke="' + w.color + '" stroke-width="' + (w.exec ? 3 : 2) + '" opacity="0.9"/>');
    }
    for (const n of m.nodes) {
      const sel = hi.has(n.name);
      out.push('<g transform="translate(' + n.x + ' ' + n.y + ')" data-node="' + esc(n.name) + '">');
      if (n.knot) out.push('<circle cx="8" cy="8" r="6" fill="#d9d9d9" stroke="' + (sel ? '#ffb000' : '#000') + '" stroke-width="' + (sel ? 3 : 1) + '"/>');
      else if (n.pill) {
        out.push('<rect width="' + n.w + '" height="' + n.h + '" rx="15" fill="rgba(18,18,18,0.92)" stroke="' + (sel ? '#ffb000' : n.color) + '" stroke-width="' + (sel ? 3 : 1.5) + '"/>');
        out.push('<text x="14" y="' + (n.h / 2 + 4.5) + '" fill="#f2f2f2" font-size="12.5" font-weight="600">' + esc(n.title) + '</text>');
      } else {
        out.push('<rect width="' + n.w + '" height="' + n.h + '" rx="7" fill="rgba(14,14,14,0.9)" stroke="' + (sel ? '#ffb000' : '#000') + '" stroke-width="' + (sel ? 3 : 1.2) + '"/>');
        if (n.compact) out.push('<text x="' + n.w / 2 + '" y="' + (n.h / 2 + 9) + '" fill="#9a9a9a" font-size="26" font-weight="700" text-anchor="middle">' + esc(n.title) + '</text>');
        else {
          out.push('<path d="M0 7 a7 7 0 0 1 7 -7 h' + (n.w - 14) + ' a7 7 0 0 1 7 7 v' + (TITLE_H + (n.sub ? SUB_H : 0) - 7) + ' h-' + n.w + ' z" fill="url(#t_' + esc(n.name) + ')"/>');
          out.push('<text x="' + PAD + '" y="20" fill="#ffffff" font-size="13" font-weight="700">' + esc(n.title) + '</text>');
          if (n.delegate) out.push('<rect x="' + (n.w - 18) + '" y="9" width="9" height="9" fill="none" stroke="' + n.delegate + '" stroke-width="1.6"/>');
          if (n.sub) out.push('<text x="' + PAD + '" y="' + (TITLE_H + 6) + '" fill="#bdbdbd" font-size="11" font-style="italic">' + esc(n.sub) + '</text>');
        }
      }
      for (const p of n.pins) {
        if (n.knot) continue;
        out.push(p.exec ? execPin(p.x + (p.dir === 'in' ? 12 : -12), p.y, p.linked, p.color) : dataPin(p.x + (p.dir === 'in' ? 12 : -12), p.y, p.linked, p.color));
        if (p.label) out.push('<text x="' + (p.dir === 'in' ? p.x + 24 : p.x - 24) + '" y="' + (p.y + 4) + '" fill="#d9d9d9" font-size="12"' + (p.dir === 'out' ? ' text-anchor="end"' : '') + '>' + esc(p.label) + '</text>');
        if (p.def) {
          const dxv = p.x + 24 + tw(p.label) + (p.label ? 8 : 0);
          out.push('<rect x="' + dxv + '" y="' + (p.y - 9) + '" width="' + (tw(p.def, 11) + 10) + '" height="18" rx="3" fill="#0b0b0b" stroke="#3c3c3c"/><text x="' + (dxv + 5) + '" y="' + (p.y + 4) + '" fill="#cfcfcf" font-size="11">' + esc(p.def) + '</text>');
        }
      }
      out.push('</g>');
    }
    out.push('</svg>');
    return out.join('');
  }

  /** each rule held to a case the engine's own source states, and a wire held to its node as well as its pin */
  function selftest() {
    const rows = [];
    const eq = (what, got, want) => rows.push([what, got === want, JSON.stringify(got) + (got === want ? '' : ' (wanted ' + JSON.stringify(want) + ')')]);
    eq('a run of capitals and digits kept together (the engine\'s own example)', displayString('DrawScale3D'), 'Draw Scale 3D');
    eq('a bool\'s leading b dropped', displayString('bHidden', true), 'Hidden');
    eq('articles lower case after a space', displayString('RandomUnitVectorInConeInDegrees'), 'Random Unit Vector in Cone in Degrees');
    eq('an underscore read as a space', displayString('Velocity_X'), 'Velocity X');
    eq('a word that merely starts like an article keeps its capital', displayString('InstanceIndex'), 'Instance Index');
    eq('a number kept whole (the engine\'s own example: "-1.2", never "- 1. 2")', displayString('-1.2'), '-1.2');
    eq('sRGB: linear 1 is 255, the toe 0.0031308 is 12.92 times (10)', srgb([1, 0, 0.0031308]), 'rgb(255,0,10)');
    return { ok: rows.every((r) => r[1]), rows: rows };
  }

  const API = { model: model, svg: svg, displayString: displayString, srgb: srgb, selftest: selftest };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.UE2D = API;
})(this);
