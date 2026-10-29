// pl.js - the node graph language (NGL) read back and projected: the one reader the page and the round-trip gate share
// (quarantine/blueprint_view/PLAN.md phases 2-3; the grammar is NGL.md beside this file).
//
// The graph files are written by U2ue.CodeGraph from C#. Everything a reader sees is printed from them HERE, never from the C#:
// C# text (printCs, which the round-trip gate compares with the source), pseudo-code (printPseudo), a C++ reading form
// (printCpp), the blocks style and the Blueprint style (view.js, laid out by layout()). One graph, many projections
// (REQ-BPV-23, REQ-BPV-26). Runs in the browser (window.NGL) and in node (require('./pl.js')).
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- reading

  const REF = /^#([sekf]\d+)$/;
  const REF_IN_TEXT = /#([sekf]\d+)/g;

  /** One line's fields after the id and keyword: {key: value}. A value is {ref}, {list}, {term}, {str} (a quoted token, raw) or
   *  {none}. A malformed line throws with its text: a graph file that cannot be read is an error, never a skipped line. */
  function readFields(line, i, lineNo) {
    const out = {};
    const n = line.length;
    function fail(why) { throw new Error('NGL line ' + lineNo + ': ' + why + ' in: ' + line.slice(0, 160)); }
    function ws() { while (i < n && (line[i] === ' ' || line[i] === '\t')) i++; }
    function quoted() {             // a "..." token with backslash escapes, returned raw (quotes included)
      const start = i++;
      while (i < n && line[i] !== '"') { if (line[i] === '\\') i++; i++; }
      if (i >= n) fail('unterminated string');
      i++;
      return line.slice(start, i);
    }
    function value(inList) {
      const c = line[i];
      if (c === '[') {
        i++;
        const items = [];
        for (;;) {
          ws();
          if (i >= n) fail('unterminated list');
          if (line[i] === ']') { i++; return { list: items }; }
          items.push(value(true));
        }
      }
      if (c === '~' && line[i + 1] === '"') { i++; return { term: JSON.parse(quoted()) }; }
      if (c === '"') return { str: quoted() };
      const start = i;
      let depth = 0;
      while (i < n) {
        const ch = line[i];
        if (ch === ' ' || ch === '\t') break;
        if (ch === '[') depth++;
        else if (ch === ']') { if (depth === 0) break; depth--; }
        i++;
      }
      const v = line.slice(start, i);
      if (v === '') fail('empty value');
      if (v === '-' && inList) return { none: true };
      const m = REF.exec(v);
      return m ? { ref: m[1] } : { term: v };
    }
    for (;;) {
      ws();
      if (i >= n) return out;
      const eq = line.indexOf('=', i);
      const key = eq < 0 ? '' : line.slice(i, eq);
      if (!/^[a-z]+$/.test(key)) fail('expected key=value at column ' + i);
      i = eq + 1;
      out[key] = value(false);
    }
  }

  function firstToken(line, i) {
    let j = i;
    while (j < line.length && line[j] !== ' ') j++;
    return [line.slice(i, j), j];
  }

  /** A .ngl file -> [{name, file, attrs, nodes: Map, order}] in file order. */
  function parse(text, file) {
    const graphs = [];
    let g = null;
    const stack = [];
    const lines = text.split('\n');
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k].replace(/\r$/, '');
      if (line === '' || line[0] === '#') continue;
      if (line.startsWith('graph ')) {
        if (g) throw new Error('NGL line ' + (k + 1) + ': graph inside graph ' + g.name);
        const rest = line.slice(6);
        let name, i;
        if (rest[0] === '~') {
          const end = rest.indexOf('"', 2);
          let j = 2;
          while (j < rest.length && rest[j] !== '"') { if (rest[j] === '\\') j++; j++; }
          name = JSON.parse(rest.slice(1, j + 1));
          i = 6 + j + 1;
        } else { [name, i] = firstToken(line, 6); }
        g = { name: name, file: file, attrs: readFields(line, i, k + 1), nodes: new Map(), order: [] };
        stack.length = 0;
        continue;
      }
      if (line === 'end') {
        if (!g) throw new Error('NGL line ' + (k + 1) + ': end outside a graph');
        graphs.push(g);
        g = null;
        continue;
      }
      if (line.startsWith('word ')) continue;   // VOCABULARY.ngl
      if (!g) throw new Error('NGL line ' + (k + 1) + ': node outside a graph: ' + line.slice(0, 80));
      let indent = 0;
      while (line[indent] === ' ') indent++;
      const [id, a] = firstToken(line, indent);
      const [kw, b] = firstToken(line, a + 1);
      if (!/^[sekf]\d+$/.test(id)) throw new Error('NGL line ' + (k + 1) + ': bad node id ' + id);
      if (g.nodes.has(id)) throw new Error('NGL line ' + (k + 1) + ': node ' + id + ' defined twice in ' + g.name);
      const node = { id: id, kw: kw, attrs: readFields(line, b, k + 1), indent: indent, under: null, graph: g };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      node.under = stack.length ? stack[stack.length - 1].id : null;
      stack.push(node);
      g.nodes.set(id, node);
      g.order.push(id);
    }
    if (g) throw new Error('NGL: graph ' + g.name + ' has no end');
    return graphs;
  }

  /** vocabulary lines: keyword -> [{tier, family, counterpart}] */
  function parseVocabulary(text) {
    const voc = {};
    for (const line of text.split('\n')) {
      if (!line.startsWith('word ')) continue;
      const [kw, i] = firstToken(line, 5);
      const parts = JSON.parse(line.slice(i + 1)).split('|');
      (voc[kw] = voc[kw] || []).push({ tier: parts[0], family: parts[1], counterpart: parts[2] });
    }
    return voc;
  }

  // ---------------------------------------------------------------- helpers over a graph

  const attr = (node, key) => node.attrs[key];
  const has = (node, key) => node.attrs[key] !== undefined;
  const termText = (v) => (v && v.term !== undefined ? v.term : v && v.str !== undefined ? v.str : null);
  const textOf = (v) => (v === undefined ? null : v.str !== undefined ? JSON.parse(v.str) : v.term !== undefined ? v.term : null);
  const listOf = (v) => (v === undefined ? [] : v.list ? v.list : [v]);
  const idOf = (v) => (v.ref ? v.ref : termText(v));
  const atLine = (node) => (node.attrs.at ? parseInt(node.attrs.at.term, 10) : null);

  function nodeOf(g, id) {
    const n = g.nodes.get(id);
    if (!n) throw new Error('graph ' + g.name + ' refers to ' + id + ', which it does not define');
    return n;
  }

  /** the statement a node belongs to (its row): the nearest s-node at or above it in the file's indentation tree */
  function rowOf(g, node) {
    for (let n = node; n; n = n.under ? g.nodes.get(n.under) : null) if (n.id[0] === 's') return n.id;
    return 'p';
  }

  /** every local or parameter read: {name, made: the declaring node's id or 'p', madeRow, reader: node id, row}. A row is the
   *  statement a node sits in, which is the census's ordinal: a wire spans row - madeRow statements. */
  function readsOf(g) {
    const out = [];
    for (const id of g.order) {
      const node = g.nodes.get(id);
      for (const r of listOf(node.attrs.reads)) {
        const t = termText(r);
        const at = t.lastIndexOf('@');
        const made = t.slice(at + 1);
        out.push({ name: t.slice(0, at), made: made, madeRow: made === 'p' ? 'p' : rowOf(g, nodeOf(g, made)), reader: id, row: rowOf(g, node) });
      }
    }
    return out;
  }

  const ordinal = (id) => (id === 'p' ? 0 : parseInt(id.slice(1), 10));

  // ---------------------------------------------------------------- C#

  // precedence, highest binds tightest (C# spec order): primary 16, unary 15, range 14, switch/with 13, multiplicative 12,
  // additive 11, shift 10, relational and type testing 9, equality 8, & 7, ^ 6, | 5, && 4, || 3, ?? 2, ?: 1, assignment/lambda 0
  const BINARY = {
    '*': 12, '/': 12, '%': 12, '+': 11, '-': 11, '<<': 10, '>>': 10, '>>>': 10, '<': 9, '>': 9, '<=': 9, '>=': 9,
    '==': 8, '!=': 8, '&': 7, '^': 6, '|': 5, '&&': 4, '||': 3, '??': 2,
  };

  function csPrecedence(node) {
    switch (node.kw) {
      case 'operator':
        if (has(node, 'post')) return 16;
        return has(node, 'b') ? BINARY[termText(node.attrs.op)] : 15;
      case 'coalesce': return 2;
      case 'select': return has(node, 'arms') ? 13 : 1;
      case 'cast': return termText(node.attrs.form) === 'as' ? 9 : 15;
      case 'type-test': case 'compare': case 'pattern-match': return 9;
      case 'increment': case 'increment-inside-an-expression': return has(node, 'post') ? 16 : 15;
      case 'lambda': case 'set': case 'set-with-math': case 'set-if-null': case 'deconstructing-set':
      case 'assignment-inside-an-expression': return 0;
      case 'throw': return 16;   // only ever where C# allows it (?? right, ?: branches, =>), and `(throw e)` is not C#
      case 'await': case 'index-from-the-end': case 'pointer': return 15;
      case 'ref-expression': return has(node, 'text') ? 16 : 15;
      case 'range': return 14;
      case 'with': case 'switch-expression-on-patterns': return 13;
      case 'query-pipeline': return 0;
      default: return 16;
    }
  }

  function CsPrinter(g, findGraph) {
    this.g = g;
    this.findGraph = findGraph;
  }

  CsPrinter.prototype.value = function (v, min) {
    if (v === undefined || v.none) return '';
    if (v.ref) {
      const node = nodeOf(this.g, v.ref);
      const s = this.expr(node);
      return csPrecedence(node) < min ? '(' + s + ')' : s;
    }
    return this.text(termText(v));
  };

  /** a term or spelled syntax with node references: each reference becomes its node's C#, unparenthesized - the text kept the
   *  source's own parentheses around anything that needed them */
  CsPrinter.prototype.text = function (t) {
    if (t === null || t === undefined) return '';
    return t.indexOf('#') < 0 ? t : t.replace(REF_IN_TEXT, (m, id) => this.expr(nodeOf(this.g, id)));
  };

  CsPrinter.prototype.args = function (node, key, open, close) {
    const values = listOf(node.attrs[key]);
    const names = listOf(node.attrs[key === 'args' ? 'argnames' : key + 'names']);
    const mods = listOf(node.attrs[key === 'args' ? 'argmods' : key + 'mods']);
    return open + values.map((v, i) => {
      const name = names[i] && !names[i].none ? termText(names[i]) + ': ' : '';
      const mod = mods[i] && !mods[i].none ? termText(mods[i]) + ' ' : '';
      return name + mod + this.value(v, 0);
    }).join(', ') + close;
  };

  CsPrinter.prototype.expr = function (node) {
    const a = node.attrs;
    const v = (k, min) => this.value(a[k], min);
    switch (node.kw) {
      case 'call': case 'pure-call': {
        let head;
        if (a.callee) head = v('callee', 16);
        else if (a.on && termText(a.on) === '?') head = '.' + termText(a.method);
        else if (a.on) head = v('on', 16) + '.' + termText(a.method);
        else head = termText(a.method);
        return head + this.args(node, 'args', '(', ')');
      }
      case 'construct':
        return 'new' + (a.implicit ? '' : ' ' + this.text(termText(a.type))) + (a.args ? this.args(node, 'args', '(', ')') : '') +
          (a.init ? ' ' + this.text(termText(a.init)) : '');
      case 'make-array':
        if (a.text) return this.text(termText(a.text));
        return this.text(termText(a.form)) + (a.elems ? ' { ' + listOf(a.elems).map((x) => this.value(x, 0)).join(', ') + (a.comma ? ',' : '') + ' }' : '');
      case 'get-at-index': return v('on', 16) + this.args(node, 'index', '[', ']');
      case 'operator': {
        const op = termText(a.op);
        if (a.post) return v('a', 16) + op;
        if (!a.b) {
          const operand = v('a', 15);
          return op + ((op === '-' || op === '+') && operand[0] === op ? ' ' : '') + operand;
        }
        const p = BINARY[op];
        return v('a', p) + ' ' + op + ' ' + v('b', p + 1);
      }
      case 'coalesce': return v('a', 3) + ' ?? ' + v('b', 2);
      case 'select':
        if (a.arms) {
          const arms = listOf(a.arms).map((r) => {
            const arm = nodeOf(this.g, idOf(r));
            return this.value(arm.attrs.pat, 0) + (arm.attrs.when ? ' when ' + this.value(arm.attrs.when, 0) : '') + ' => ' +
              this.value(arm.attrs.value, 0);
          });
          return v('on', 14) + ' switch { ' + arms.join(', ') + (a.comma ? ',' : '') + ' }';
        }
        return v('cond', 2) + ' ? ' + v('then', 0) + ' : ' + v('else', 0);
      case 'switch-expression-on-patterns': {
        const arms = listOf(a.arms).map((r) => {
          const arm = nodeOf(this.g, idOf(r));
          return this.value(arm.attrs.pat, 0) + (arm.attrs.when ? ' when ' + this.value(arm.attrs.when, 0) : '') + ' => ' +
            this.value(arm.attrs.value, 0);
        });
        return v('on', 14) + ' switch { ' + arms.join(', ') + (a.comma ? ',' : '') + ' }';
      }
      case 'cast': {
        if (termText(a.form) === 'as') return v('a', 9) + ' as ' + this.text(termText(a.to));
        // (T)-x reads as a subtraction unless T is a keyword type: an operand that is not primary is always grouped
        const operand = a.a.ref ? nodeOf(this.g, a.a.ref) : null;
        const inner = operand && csPrecedence(operand) < 16 ? '(' + this.expr(operand) + ')' : v('a', 16);
        return '(' + this.text(termText(a.to)) + ')' + inner;
      }
      case 'type-test': case 'compare': case 'pattern-match':
        if (a.form && termText(a.form) === 'is') return v('a', 9) + ' is ' + this.text(termText(a.to));
        return v('a', 9) + ' is ' + this.value(a.pat, 0);
      case 'increment': case 'increment-inside-an-expression':
        return a.post ? v('a', 16) + termText(a.op) : termText(a.op) + v('a', 15);
      case 'if-valid': case 'call-if-valid': return v('on', 16) + '?' + v('then', 16);
      case 'format': return this.text(termText(a.text));
      case 'tuple': {
        const names = listOf(a.names);
        return '(' + listOf(a.elems).map((x, i) => (names[i] && !names[i].none ? termText(names[i]) + ': ' : '') + this.value(x, 0)).join(', ') + ')';
      }
      case 'lambda': {
        const mods = listOf(a.mods).map(termText).join(' ');
        let head = (mods ? mods + ' ' : '');
        if (a.delegate) head += 'delegate' + (a.params ? ' ' + this.text(termText(a.params)) : '');
        else head += (a.ret ? this.text(termText(a.ret)) + ' ' : '') + this.text(termText(a.params)) + ' =>';
        if (a.body) return head + ' ' + this.block(listOf(a.body), '');
        if (a.do) return head + ' ' + this.expr(nodeOf(this.g, idOf(a.do)));
        return head + ' ' + v('value', 0);
      }
      case 'set': case 'set-with-math': case 'set-if-null': case 'deconstructing-set': case 'assignment-inside-an-expression':
        return v('target', 15) + ' ' + termText(a.op) + ' ' + v('value', 0);
      case 'await': return 'await ' + v('a', 15);
      case 'throw': return 'throw ' + v('value', 0);
      case 'with': return v('a', 14) + ' with ' + this.text(termText(a.init));
      case 'range': return v('a', 15) + '..' + v('b', 15);
      case 'index-from-the-end': return '^' + v('a', 15);
      case 'checked-unchecked': return termText(a.kw) + '(' + v('a', 0) + ')';
      case 'ref-expression':
        if (a.text) return this.text(termText(a.text));
        return 'ref ' + v('a', 15);
      case 'expression-body': return v('value', 0);
      default:
        if (a.text) return this.text(termText(a.text));
        throw new Error('C# printer: no expression form for ' + node.kw + ' (' + node.id + ' in ' + this.g.name + ')');
    }
  };

  CsPrinter.prototype.block = function (ids, ind) {
    if (ids.length === 0) return '{ }';
    return '{\n' + ids.map((r) => this.stmt(nodeOf(this.g, idOf(r)), ind + '    ')).join('') + ind + '}';
  };

  /** a body value: a list is a braced block, a single id an embedded statement */
  CsPrinter.prototype.body = function (v, ind) {
    if (v.list) return ' ' + this.block(v.list, ind);
    const id = idOf(v);
    return '\n' + this.stmt(nodeOf(this.g, id), ind + '    ').replace(/\n$/, '');
  };

  CsPrinter.prototype.declaration = function (node) {
    const a = node.attrs;
    const values = listOf(a.values);
    return this.text(termText(a.decl)) + ' ' + listOf(a.vars).map((x, i) => termText(x) + (values[i] && !values[i].none ? ' = ' + this.value(values[i], 0) : '')).join(', ');
  };

  CsPrinter.prototype.stmt = function (node, ind) {
    const a = node.attrs;
    const v = (k) => this.value(a[k], 0);
    const mods = listOf(a.mods).map(termText);
    const line = (s) => ind + s + '\n';
    const tail = (s) => (s[0] === '\n' ? s + '\n' : s + '\n');
    switch (node.kw) {
      case 'block': return line(this.block(listOf(a.body), ind));
      case 'empty': return line(';');
      case 'set-local': case 'using-declaration': case 'ref-local':
        return line((mods.length ? mods.join(' ') + ' ' : '') + this.declaration(node) + ';');
      case 'branch': {
        let s = ind + 'if (' + v('cond') + ')' + this.body(a.then, ind);
        if (a.else) {
          const e = a.else;
          const single = !e.list && nodeOf(this.g, idOf(e)).kw === 'branch';
          s += (a.then.list ? ' ' : '\n' + ind) + 'else' + (single ? ' ' + this.stmt(nodeOf(this.g, idOf(e)), ind).trimStart().replace(/\n$/, '') : this.body(e, ind));
        }
        return s + '\n';
      }
      case 'switch': case 'switch-on-patterns': {
        let s = ind + 'switch (' + v('on') + ')\n' + ind + '{\n';
        for (const r of listOf(a.sections)) {
          const sec = nodeOf(this.g, idOf(r));
          const labels = listOf(sec.attrs.labels);
          for (let i = 0; i < labels.length; i++) {
            const kind = termText(labels[i]);
            if (kind === 'default') s += ind + '    default:\n';
            else if (kind === 'case') s += ind + '    case ' + this.value(labels[++i], 0) + ':\n';
            else if (kind === 'pattern') {
              let lab = ind + '    case ' + this.text(termText(labels[++i]));
              if (labels[i + 1] && termText(labels[i + 1]) === 'when') { i += 2; lab += ' when ' + this.value(labels[i], 0); }
              s += lab + ':\n';
            } else throw new Error('C# printer: switch label ' + kind + ' in ' + this.g.name);
          }
          for (const st of listOf(sec.attrs.body)) s += this.stmt(nodeOf(this.g, idOf(st)), ind + '        ');
        }
        return s + ind + '}\n';
      }
      case 'for-loop': {
        const init = a.decl ? this.declaration(node) : listOf(a.init).map((x) => this.value(x, 0)).join(', ');
        const step = listOf(a.step).map((x) => this.value(x, 0)).join(', ');
        return tail(ind + 'for (' + init + '; ' + v('cond') + '; ' + step + ')' + this.body(a.body, ind));
      }
      case 'for-each-loop':
        return tail(ind + (mods.includes('await') ? 'await ' : '') + 'foreach (' + this.text(termText(a.decl)) + ' ' + termText(a.var) + ' in ' + v('in') + ')' + this.body(a.body, ind));
      case 'for-each-with-deconstruction':
        return tail(ind + (mods.includes('await') ? 'await ' : '') + 'foreach (' + this.text(termText(a.var)) + ' in ' + v('in') + ')' + this.body(a.body, ind));
      case 'while-loop': return tail(ind + 'while (' + v('cond') + ')' + this.body(a.body, ind));
      case 'do-while-loop': {
        const b = this.body(a.body, ind);
        return ind + 'do' + b + (a.body.list ? ' ' : '\n' + ind) + 'while (' + v('cond') + ');\n';
      }
      case 'return': return line('return' + (a.value ? ' ' + v('value') : '') + ';');
      case 'break': case 'section-break': return line('break;');
      case 'continue': return line('continue;');
      case 'throw': return line('throw' + (a.value ? ' ' + v('value') : '') + ';');
      case 'try-catch-finally': {
        let s = ind + 'try ' + this.block(listOf(a.body), ind);
        for (const r of listOf(a.catches)) {
          const c = nodeOf(this.g, idOf(r));
          s += '\n' + ind + 'catch';
          if (c.attrs.decl) s += ' (' + this.text(termText(c.attrs.decl)) + (c.attrs.var ? ' ' + termText(c.attrs.var) : '') + ')';
          if (c.attrs.when) s += ' when (' + this.value(c.attrs.when, 0) + ')';
          s += ' ' + this.block(listOf(c.attrs.body), ind);
        }
        if (a.finally) s += '\n' + ind + 'finally ' + this.block(listOf(a.finally), ind);
        return s + '\n';
      }
      case 'using':
        return tail(ind + (mods.includes('await') ? 'await ' : '') + 'using (' + (a.decl ? this.declaration(node) : v('res')) + ')' + this.body(a.body, ind));
      case 'lock': return tail(ind + 'lock (' + v('on') + ')' + this.body(a.body, ind));
      case 'yield': return line(termText(a.kind) === 'break' ? 'yield break;' : 'yield return ' + v('value') + ';');
      case 'goto-label':
        if (a.label) return ind + termText(a.label) + ':\n' + this.stmt(nodeOf(this.g, idOf(a.stmt)), ind);
        return line(this.text(termText(a.text)) + ';');
      case 'checked-unchecked-block': return line(termText(a.kw) + ' ' + this.block(listOf(a.body), ind));
      case 'unsafe-fixed':
        if (termText(a.kw) === 'fixed') return tail(ind + 'fixed (' + this.declaration(node) + ')' + this.body(a.body, ind));
        return line('unsafe ' + this.block(listOf(a.body), ind));
      case 'local-function': {
        const child = this.findGraph(this.g, termText(a.graph));
        if (!child) throw new Error('C# printer: ' + this.g.name + ' declares a local function whose graph (' + termText(a.graph) + ') is not in the file');
        const cp = new CsPrinter(child, this.findGraph);
        return line(this.text(termText(a.sig)) + cp.graphBody(ind, true));
      }
      default:
        return line(this.expr(node) + ';');
    }
  };

  /** the body of the whole graph: ` { ... }` for a block body, ` => expr;` for an arrow (asDeclaration), or the bare body the
   *  round-trip gate compares (a block, or the arrow's expression) */
  CsPrinter.prototype.graphBody = function (ind, asDeclaration) {
    const a = this.g.attrs;
    if (a.arrow) {
      const s = this.expr(nodeOf(this.g, termText(a.arrow)));
      return asDeclaration ? ' => ' + s + ';' : s;
    }
    const b = this.block(listOf(a.body), ind);
    return asDeclaration ? '\n' + ind + b : b;
  };

  /** the graph's body as C#: what the round-trip gate compares with the source */
  function printCs(g, findGraph) {
    return new CsPrinter(g, findGraph || (() => null)).graphBody('', false);
  }

  /** one statement's own C# line (its head, without the blocks it holds) - what a view shows beside the node it selected */
  function printCsStatement(g, id, findGraph) {
    return new CsPrinter(g, findGraph || (() => null)).stmt(nodeOf(g, id), '').split('\n')[0].replace(/\s*\{\s*$/, '');
  }

  // ---------------------------------------------------------------- C++: a reading form, not a compiler

  /** The same graph in C++ spelling, for a reader who thinks in C++ (IR-14: C++ is the code language named beyond C#). It is NOT
   *  compiled and does not claim to be: the model's types are C#'s, and a construct C++ has no form for is printed as C# inside a
   *  marker, and counted (cppUntranslated), so the coverage of this projection is a measured number rather than an impression. */
  function CppPrinter(g, findGraph, counter) {
    CsPrinter.call(this, g, findGraph);
    this.counter = counter || { nodes: 0, untranslated: 0 };
  }
  CppPrinter.prototype = Object.create(CsPrinter.prototype);
  const CPP_TERM = [[/\bnull\b/g, 'nullptr'], [/\bstring\b/g, 'std::string'], [/\bvar\b/g, 'auto']];
  CppPrinter.prototype.text = function (t) {
    if (t === null || t === undefined) return '';
    let s = CsPrinter.prototype.text.call(this, t);
    if (s[0] !== '"' && s[0] !== '@' && s[0] !== '$') for (const [re, to] of CPP_TERM) s = s.replace(re, to);
    return s;
  };
  CppPrinter.prototype.mark = function (cs) { this.counter.untranslated++; return '/* C#: */ ' + cs; };
  /** a call's arguments in C++: a reference parameter takes the variable as it is (`ref x` and `out x` are `x`); an argument that
   *  declares its variable (`out var x`), discards it (`out _`) or is named (`name: x`) has no C++ form inside a call, so it stays C#,
   *  marked and counted. Measured 2026-10-28: the C# spelling `out auto x` was printed unmarked, which reads as C++ and is not */
  CppPrinter.prototype.args = function (node, key, open, close) {
    const values = listOf(node.attrs[key]);
    const names = listOf(node.attrs[key === 'args' ? 'argnames' : key + 'names']);
    const mods = listOf(node.attrs[key === 'args' ? 'argmods' : key + 'mods']);
    let marked = 0;
    const text = open + values.map((v, i) => {
      const name = names[i] && !names[i].none ? termText(names[i]) : '';
      const mod = mods[i] && !mods[i].none ? termText(mods[i]) : '';
      const val = this.value(v, 0);
      const declares = mod === 'out' && (val === '_' || /^(auto|var)\s/.test(val) || /\s/.test(val.trim()));
      if (!(name || declares || (mod && mod !== 'ref' && mod !== 'out'))) return val;
      // the marked part is the C# as it is (through this printer, `var` would be rewritten to `auto` inside the marker)
      marked++;
      return '/* C#: */ ' + (name ? name + ': ' : '') + (mod ? mod + ' ' : '') + new CsPrinter(this.g, this.findGraph).value(v, 0);
    }).join(', ') + close;
    // the count is of NODES: a call with any argument left as C# is one node not fully in C++ (measured 2026-10-28: counting each
    // argument gave "19 of 4 nodes" on a Blueprint function with 17 out arguments)
    if (marked) this.counter.untranslated++;
    return text;
  };
  CppPrinter.prototype.expr = function (node) {
    this.counter.nodes++;
    const a = node.attrs;
    const v = (k, min) => this.value(a[k], min);
    switch (node.kw) {
      case 'cast': return termText(a.form) === 'as' ? 'Cast<' + this.text(termText(a.to)) + '>(' + v('a', 0) + ')' : 'static_cast<' + this.text(termText(a.to)) + '>(' + v('a', 0) + ')';
      case 'type-test': case 'compare': case 'pattern-match':
        if (a.form && termText(a.form) === 'is') return '(Cast<' + this.text(termText(a.to)) + '>(' + v('a', 0) + ') != nullptr)';
        if (termText(a.pat) === 'null') return '(' + v('a', 8) + ' == nullptr)';
        return this.mark(CsPrinter.prototype.expr.call(this, node));
      case 'coalesce': return '(' + v('a', 3) + ' ? ' + v('a', 3) + ' : ' + v('b', 2) + ')';
      case 'lambda': {
        const params = this.text(termText(a.params)).replace(/^\(|\)$/g, '');
        const head = '[&](' + params.split(',').filter((x) => x.trim()).map((p) => (/\s/.test(p.trim()) ? p.trim() : 'auto ' + p.trim())).join(', ') + ')';
        if (a.body) return head + ' ' + this.block(listOf(a.body), '');
        if (a.do) return head + ' { ' + this.expr(nodeOf(this.g, idOf(a.do))) + '; }';
        return head + ' { return ' + v('value', 0) + '; }';
      }
      case 'construct':
        if (a.implicit || a.init) return this.mark(CsPrinter.prototype.expr.call(this, node));
        return this.text(termText(a.type)) + this.args(node, 'args', '(', ')');
      case 'if-valid': case 'call-if-valid': case 'format': case 'tuple': case 'with': case 'range': case 'index-from-the-end':
      case 'switch-expression-on-patterns':
        return this.mark(CsPrinter.prototype.expr.call(this, node));
      case 'select':
        if (a.arms) return this.mark(CsPrinter.prototype.expr.call(this, node));
        return CsPrinter.prototype.expr.call(this, node);
      default:
        if (a.text) return this.mark(CsPrinter.prototype.expr.call(this, node));
        return CsPrinter.prototype.expr.call(this, node);
    }
  };
  CppPrinter.prototype.stmt = function (node, ind) {
    const a = node.attrs;
    switch (node.kw) {
      case 'for-each-loop':
        this.counter.nodes++;
        return ind + 'for (' + this.text(termText(a.decl)) + ' ' + termText(a.var) + ' : ' + this.value(a.in, 0) + ')' + this.body(a.body, ind) + '\n';
      case 'try-catch-finally': case 'lock': case 'using': case 'yield': case 'for-each-with-deconstruction': case 'local-function':
      case 'switch-on-patterns': case 'unsafe-fixed': case 'checked-unchecked-block':
        this.counter.nodes++; this.counter.untranslated++;
        return ind + '/* C#: */\n' + CsPrinter.prototype.stmt.call(this, node, ind);
      case 'set-local': case 'using-declaration': case 'ref-local':
        this.counter.nodes++;
        return CsPrinter.prototype.stmt.call(this, node, ind);
      default:
        if (node.id[0] === 's' && !['branch', 'switch', 'for-loop', 'while-loop', 'do-while-loop', 'return', 'break', 'section-break', 'continue', 'throw', 'goto-label'].includes(node.kw)) return CsPrinter.prototype.stmt.call(this, node, ind);
        this.counter.nodes++;
        return CsPrinter.prototype.stmt.call(this, node, ind);
    }
  };
  function printCpp(g, findGraph, counter) {
    return new CppPrinter(g, findGraph || (() => null), counter).graphBody('', false);
  }

  // ---------------------------------------------------------------- pseudo-code: no language at all

  /** The graph as plain, language-free steps: `if ... then ... end if`, `for each x in xs`, `x ← value`, words for operators.
   *  A reader of no particular language reads this one; nothing here is C#, C++ or Blueprint. */
  const PSEUDO_OP = { '&&': 'and', '||': 'or', '!': 'not ', '==': '=', '!=': '≠', '<=': '≤', '>=': '≥', '*': '×', '/': '÷', '%': 'mod' };
  function PseudoPrinter(g, findGraph) { this.g = g; this.findGraph = findGraph; }
  PseudoPrinter.prototype.value = function (v) {
    if (v === undefined || v.none) return '';
    if (v.ref) { const n = nodeOf(this.g, v.ref); const s = this.expr(n); return csPrecedence(n) < 16 ? '(' + s + ')' : s; }
    return this.text(termText(v));
  };
  PseudoPrinter.prototype.text = function (t) {
    if (t === null || t === undefined) return '';
    const s = t.indexOf('#') < 0 ? t : t.replace(REF_IN_TEXT, (m, id) => this.expr(nodeOf(this.g, id)));
    return s.replace(/\bnull\b/g, 'nothing').replace(/\bthis\./g, '');
  };
  PseudoPrinter.prototype.args = function (node, key) {
    return '(' + listOf(node.attrs[key]).map((x) => this.value(x)).join(', ') + ')';
  };
  PseudoPrinter.prototype.expr = function (node) {
    const a = node.attrs;
    const v = (k) => this.value(a[k]);
    const t = (k) => termText(a[k]);
    switch (node.kw) {
      case 'call': case 'pure-call':
        return (a.callee ? v('callee') : (a.on && t('on') !== '?' ? v('on') + '.' : '') + t('method')) + this.args(node, 'args');
      case 'operator': {
        const op = PSEUDO_OP[t('op')] || t('op');
        if (a.post) return v('a') + t('op');
        if (!a.b) return op + v('a');
        return v('a') + ' ' + op + ' ' + v('b');
      }
      case 'coalesce': return v('a') + ' otherwise ' + v('b');
      case 'select':
        if (a.arms) return 'match ' + v('on') + ' { ' + listOf(a.arms).map((r) => { const arm = nodeOf(this.g, idOf(r)); return this.value(arm.attrs.pat) + ' → ' + this.value(arm.attrs.value); }).join('; ') + ' }';
        return 'if ' + v('cond') + ' then ' + v('then') + ' else ' + v('else');
      case 'cast': return v('a') + ' as ' + t('to');
      case 'type-test': case 'compare': case 'pattern-match': return v('a') + ' is ' + (a.to ? this.text(t('to')) : this.value(a.pat));
      case 'get-at-index': return v('on') + '[' + listOf(a.index).map((x) => this.value(x)).join(', ') + ']';
      case 'construct': return 'new ' + (a.implicit ? (t('t') || '') : this.text(t('type'))) + (a.args ? this.args(node, 'args') : '') + (a.init ? ' with ' + this.text(t('init')) : '');
      case 'make-array': return a.text ? this.text(t('text')) : 'list [' + listOf(a.elems).map((x) => this.value(x)).join(', ') + ']';
      case 'lambda': return 'function ' + this.text(t('params') || '()') + ' → ' + (a.value ? v('value') : a.do ? this.expr(nodeOf(this.g, idOf(a.do))) : '{ ' + listOf(a.body).length + ' steps }');
      case 'if-valid': case 'call-if-valid': return v('on') + '?' + v('then');
      case 'set': case 'set-with-math': case 'set-if-null': case 'deconstructing-set': case 'assignment-inside-an-expression': {
        const op = t('op');
        if (op === '=') return v('target') + ' ← ' + v('value');
        if (op === '??=') return v('target') + ' ← ' + v('target') + ' otherwise ' + v('value');
        return v('target') + ' ← ' + v('target') + ' ' + (PSEUDO_OP[op.slice(0, -1)] || op.slice(0, -1)) + ' ' + v('value');
      }
      case 'increment': case 'increment-inside-an-expression': return v('a') + ' ← ' + v('a') + (t('op') === '++' ? ' + 1' : ' − 1');
      case 'tuple': return '(' + listOf(a.elems).map((x) => this.value(x)).join(', ') + ')';
      case 'throw': return 'fail with ' + v('value');
      case 'await': return 'wait for ' + v('a');
      case 'expression-body': return v('value');
      default: return a.text ? this.text(t('text')) : CsPrinter.prototype.expr.call(new CsPrinter(this.g, this.findGraph), node);
    }
  };
  PseudoPrinter.prototype.lines = function (ids, depth, out) {
    for (const r of ids) this.stmt(nodeOf(this.g, idOf(r)), depth, out);
  };
  PseudoPrinter.prototype.body = function (v, depth, out) { this.lines(listOf(v), depth, out); };
  PseudoPrinter.prototype.stmt = function (node, depth, out) {
    const a = node.attrs;
    const v = (k) => this.value(a[k]);
    const t = (k) => termText(a[k]);
    const say = (s) => out.push({ depth: depth, text: s, id: node.id });
    switch (node.kw) {
      case 'set-local': case 'using-declaration': case 'ref-local': {
        const vals = listOf(a.values);
        listOf(a.vars).forEach((x, i) => say('let ' + termText(x) + (t('decl') !== 'var' ? ': ' + this.text(t('decl')) : '') + (vals[i] && !vals[i].none ? ' = ' + this.value(vals[i]) : '')));
        return;
      }
      case 'branch':
        say('if ' + v('cond') + ' then'); this.body(a.then, depth + 1, out);
        if (a.else) { say('else'); this.body(a.else, depth + 1, out); }
        say('end if'); return;
      case 'for-loop': {
        const init = a.decl ? listOf(a.vars).map((x, i) => termText(x) + ' = ' + this.value(listOf(a.values)[i])).join(', ') : listOf(a.init).map((x) => this.value(x)).join(', ');
        say('repeat from ' + init + ' while ' + v('cond') + ', each time ' + listOf(a.step).map((x) => this.value(x)).join(', '));
        this.body(a.body, depth + 1, out); say('end repeat'); return;
      }
      case 'for-each-loop': case 'for-each-with-deconstruction':
        say('for each ' + this.text(t('var')) + ' in ' + v('in')); this.body(a.body, depth + 1, out); say('end for'); return;
      case 'while-loop': say('while ' + v('cond')); this.body(a.body, depth + 1, out); say('end while'); return;
      case 'do-while-loop': say('repeat'); this.body(a.body, depth + 1, out); say('until not (' + v('cond') + ')'); return;
      case 'switch': case 'switch-on-patterns':
        say('match ' + v('on'));
        for (const r of listOf(a.sections)) {
          const sec = nodeOf(this.g, idOf(r));
          const labels = listOf(sec.attrs.labels);
          const names = [];
          for (let i = 0; i < labels.length; i++) {
            const k = termText(labels[i]);
            if (k === 'default') names.push('anything else');
            else if (k === 'case') names.push(this.value(labels[++i]));
            else if (k === 'pattern') names.push(this.text(termText(labels[++i])));
            else if (k === 'when') names[names.length - 1] += ' when ' + this.value(labels[++i]);
          }
          out.push({ depth: depth + 1, text: 'case ' + names.join(' or ') + ':', id: sec.id });
          this.body(sec.attrs.body, depth + 2, out);
        }
        say('end match'); return;
      case 'return': say(a.value ? 'return ' + v('value') : 'return'); return;
      case 'expression-body': say('return ' + v('value')); return;
      case 'break': say('stop the loop'); return;
      case 'section-break': return;
      case 'continue': say('go to the next turn of the loop'); return;
      case 'throw': say(a.value ? 'fail with ' + v('value') : 'fail again with the same error'); return;
      case 'try-catch-finally':
        say('try'); this.body(a.body, depth + 1, out);
        for (const r of listOf(a.catches)) { const c = nodeOf(this.g, idOf(r)); out.push({ depth: depth, text: 'if it fails' + (c.attrs.decl ? ' with ' + termText(c.attrs.decl) : '') + (c.attrs.var ? ' (' + termText(c.attrs.var) + ')' : ''), id: c.id }); this.body(c.attrs.body, depth + 1, out); }
        if (a.finally) { say('in every case'); this.body(a.finally, depth + 1, out); }
        say('end try'); return;
      case 'using': say('using ' + (a.res ? v('res') : listOf(a.vars).map(termText).join(', '))); this.body(a.body, depth + 1, out); say('end using'); return;
      case 'lock': say('holding ' + v('on')); this.body(a.body, depth + 1, out); say('end holding'); return;
      case 'yield': say(t('kind') === 'break' ? 'stop producing' : 'produce ' + v('value')); return;
      case 'local-function': say('function ' + this.text(t('sig')) + ' (its own graph)'); return;
      case 'goto-label': if (a.label) { say(t('label') + ':'); this.stmt(nodeOf(this.g, idOf(a.stmt)), depth, out); } else say(this.text(t('text'))); return;
      case 'block': this.body(a.body, depth, out); return;
      case 'empty': return;
      case 'checked-unchecked-block': case 'unsafe-fixed': say(t('kw')); this.body(a.body, depth + 1, out); say('end ' + t('kw')); return;
      default: say(this.expr(node));
    }
  };
  /** [{depth, text, id}] - one line per step, with the node each came from, so a view can link a line to its node */
  function printPseudo(g, findGraph) {
    const p = new PseudoPrinter(g, findGraph || (() => null));
    const out = [];
    if (g.attrs.arrow) p.stmt(nodeOf(g, termText(g.attrs.arrow)), 0, out);
    else p.lines(listOf(g.attrs.body), 0, out);
    return out;
  }

  /** findGraph for a whole file: a local function is looked up by its declaration's line:col */
  function fileFinder(graphs) {
    const byAt = new Map(graphs.map((x) => [termText(x.attrs.at), x]));
    return (g, at) => byAt.get(at) || null;
  }

  // ---------------------------------------------------------------- the Blueprint style: node boxes and the stable layout

  // Sizes are computed, never measured from the DOM, so node and the browser lay a graph out identically (the gate checks the
  // same numbers the page draws). The page draws in a monospace font at this advance.
  const CH = 7.2, TITLE = 24, ROW = 18, PAD = 10, GAP_X = 36, GAP_Y = 22, INDENT = 26, MAX_PIN = 46;
  const LONG = 6;    // the census's long wire: a value read 6 or more statements after it was made

  const STATEMENT_TITLES = {
    'branch': 'Branch', 'set-local': 'Local', 'using-declaration': 'Using local', 'ref-local': 'Ref local', 'set': 'Set',
    'set-with-math': 'Set', 'set-if-null': 'Set if null', 'deconstructing-set': 'Set (deconstruct)', 'increment': 'Increment',
    'return': 'Return', 'expression-body': 'Return', 'for-loop': 'For Loop', 'for-each-loop': 'For Each Loop',
    'for-each-with-deconstruction': 'For Each Loop', 'while-loop': 'While Loop', 'do-while-loop': 'Do While Loop',
    'switch': 'Switch', 'switch-on-patterns': 'Switch on Pattern', 'break': 'Break', 'section-break': 'End of Case',
    'continue': 'Continue', 'throw': 'Throw', 'try-catch-finally': 'Try', 'using': 'Using', 'lock': 'Lock', 'yield': 'Yield',
    'local-function': 'Local Function', 'goto-label': 'Label', 'checked-unchecked-block': 'Checked', 'unsafe-fixed': 'Unsafe',
    'call-if-valid': 'If Valid', 'await': 'Await', 'construct': 'Construct',
  };
  const OP_NAMES = { '&&': 'AND', '||': 'OR', '!': 'NOT', '==': '==', '!=': '!=', '??': 'If Null' };

  const short = (s) => (s.length > MAX_PIN ? s.slice(0, MAX_PIN - 1) + '…' : s);
  // a pattern is pattern text with references inside, or one whole node when the reader made its constant a node (a case
  // `(AreaShape)7 =>` is a cast): shown as its C# either way. Measured 2026-10-28 on a Unity project's 5,018 graphs
  const patText = (g, v) => (v && v.ref ? new CsPrinter(g, null).value(v, 0) : termText(v));
  const refsIn = (t) => { const out = []; let m; REF_IN_TEXT.lastIndex = 0; while ((m = REF_IN_TEXT.exec(t))) out.push(m[1]); return out; };

  /** what a node shows in the Blueprint style: title, the class or target under it, input pins (each a ref to wire from, or a
   *  term shown inline), output pins, and its exec outputs into bodies. Pure: the same node gives the same box. */
  function bpNode(g, node) {
    const a = node.attrs;
    const t = (k) => termText(a[k]);
    const ins = [];
    const pin = (name, v) => { if (v !== undefined && !v.none) ins.push({ name: name, v: v }); };
    let title = STATEMENT_TITLES[node.kw] || node.kw, sub = '';
    const outs = [];
    const bodies = [];
    const exec = node.id[0] === 's' || node.id[0] === 'f';
    switch (node.kw) {
      case 'call': case 'pure-call': {
        title = t('method') || 'Call';
        const on = a.on && t('on') !== '?' ? a.on : null;
        if (on && !on.ref && /^[A-Z][\w<>.,]*$/.test(termText(on))) sub = termText(on);   // a type: a static call
        else if (on) pin('Target', on);
        if (a.callee) pin('Function', a.callee);
        const params = listOf(a.params).map((p) => { const s = termText(p); return s.slice(0, s.indexOf(':')); });
        listOf(a.args).forEach((v, i) => pin(params[i] || 'arg ' + i, v));
        if (t('t') && t('t') !== 'void') outs.push({ name: 'Return Value', type: t('t') });
        break;
      }
      case 'operator': {
        const op = t('op');
        title = OP_NAMES[op] || op;
        pin('A', a.a); pin('B', a.b);
        outs.push({ name: '', type: t('t') });
        break;
      }
      case 'select':
        title = 'Select';
        if (a.arms) { pin('Value', a.on); for (const r of listOf(a.arms)) { const arm = nodeOf(g, idOf(r)); pin(short(patText(g, arm.attrs.pat) + ' =>'), arm.attrs.value); } }
        else { pin('Condition', a.cond); pin('True', a.then); pin('False', a.else); }
        outs.push({ name: '', type: t('t') });
        break;
      case 'coalesce': title = 'If Null'; pin('Value', a.a); pin('Else', a.b); outs.push({ name: '', type: t('t') }); break;
      case 'cast': title = (t('form') === 'as' ? 'As ' : 'Cast to ') + t('to'); pin('Object', a.a); outs.push({ name: '', type: t('t') }); break;
      case 'type-test': case 'compare': case 'pattern-match':
        title = 'Is ' + (t('to') || patText(g, a.pat)); pin('Object', a.a); outs.push({ name: '', type: 'bool' }); break;
      case 'get-at-index': title = 'Get'; pin('Target', a.on); listOf(a.index).forEach((v, i) => pin('Index' + (i ? ' ' + i : ''), v)); outs.push({ name: '', type: t('t') }); break;
      case 'construct': {
        title = 'Make ' + (a.implicit ? (t('t') || '') : t('type'));
        const params = listOf(a.params).map((p) => { const s = termText(p); return s.slice(0, s.indexOf(':')); });
        listOf(a.args).forEach((v, i) => pin(params[i] || 'arg ' + i, v));
        if (a.init) pin('Init', a.init);
        if (!exec) outs.push({ name: '', type: t('t') });
        break;
      }
      case 'make-array': title = 'Make Array'; if (a.text) pin('Items', a.text); else listOf(a.elems).forEach((v, i) => pin('[' + i + ']', v)); outs.push({ name: '', type: t('t') }); break;
      case 'format': title = 'Format Text'; pin('Text', a.text); outs.push({ name: '', type: 'string' }); break;
      case 'tuple': title = 'Make Tuple'; listOf(a.elems).forEach((v, i) => pin('Item' + (i + 1), v)); outs.push({ name: '', type: t('t') }); break;
      case 'lambda':
        title = 'Lambda ' + (t('params') || '');
        if (a.value) pin('Result', a.value);
        if (a.body) bodies.push({ name: 'Body', ids: listOf(a.body).map(idOf) });
        if (a.do) bodies.push({ name: 'Body', ids: [idOf(a.do)] });
        outs.push({ name: '', type: t('t') });
        break;
      case 'if-valid': case 'call-if-valid': title = 'If Valid'; pin('Target', a.on); pin('Then', a.then); if (!exec) outs.push({ name: '', type: t('t') }); break;
      case 'increment': case 'increment-inside-an-expression': title = t('op') === '++' ? 'Increment' : 'Decrement'; pin('Target', a.a); break;
      case 'set': case 'set-with-math': case 'set-if-null': case 'deconstructing-set': case 'assignment-inside-an-expression':
        title = 'Set' + (t('op') !== '=' ? ' ' + t('op') : ''); pin('Target', a.target); pin('Value', a.value);
        if (!exec) outs.push({ name: '', type: t('t') });
        break;
      case 'set-local': case 'using-declaration': case 'ref-local': case 'for-loop': case 'using': case 'unsafe-fixed': {
        const vals = listOf(a.values);
        listOf(a.vars).forEach((x, i) => { pin(termText(x), vals[i]); outs.push({ name: termText(x), type: t('t') || t('decl') }); });
        if (node.kw === 'for-loop') { listOf(a.init).forEach((v) => pin('Init', v)); pin('Condition', a.cond); listOf(a.step).forEach((v) => pin('Step', v)); bodies.push({ name: 'Loop Body', ids: listOf(a.body).map(idOf) }); }
        if (node.kw === 'using') { pin('Resource', a.res); bodies.push({ name: 'Body', ids: listOf(a.body).map(idOf) }); }
        if (node.kw === 'unsafe-fixed') bodies.push({ name: 'Body', ids: listOf(a.body).map(idOf) });
        break;
      }
      case 'branch':
        pin('Condition', a.cond);
        bodies.push({ name: 'True', ids: listOf(a.then).map(idOf) });
        if (a.else) bodies.push({ name: 'False', ids: listOf(a.else).map(idOf) });
        break;
      case 'for-each-loop': case 'for-each-with-deconstruction':
        pin('Array', a.in); outs.push({ name: t('var'), type: t('decl') });
        bodies.push({ name: 'Loop Body', ids: listOf(a.body).map(idOf) });
        break;
      case 'while-loop': case 'do-while-loop': pin('Condition', a.cond); bodies.push({ name: 'Loop Body', ids: listOf(a.body).map(idOf) }); break;
      case 'switch': case 'switch-on-patterns':
        pin('Selection', a.on);
        for (const r of listOf(a.sections)) {
          const sec = nodeOf(g, idOf(r));
          const labels = listOf(sec.attrs.labels).map(termText);
          let name = '';
          for (let i = 0; i < labels.length; i++) {
            if (labels[i] === 'default') name += (name ? ', ' : '') + 'Default';
            else if (labels[i] === 'case' || labels[i] === 'pattern') name += (name ? ', ' : '') + (labels[++i] || '');
            else if (labels[i] === 'when') i++;
          }
          bodies.push({ name: short(name), ids: listOf(sec.attrs.body).map(idOf) });
        }
        break;
      case 'try-catch-finally':
        bodies.push({ name: 'Try', ids: listOf(a.body).map(idOf) });
        for (const r of listOf(a.catches)) { const c = nodeOf(g, idOf(r)); bodies.push({ name: 'Catch ' + (termText(c.attrs.decl) || ''), ids: listOf(c.attrs.body).map(idOf) }); }
        if (a.finally) bodies.push({ name: 'Finally', ids: listOf(a.finally).map(idOf) });
        break;
      case 'lock': pin('Object', a.on); bodies.push({ name: 'Body', ids: listOf(a.body).map(idOf) }); break;
      case 'checked-unchecked-block': bodies.push({ name: 'Body', ids: listOf(a.body).map(idOf) }); break;
      // a block that runs ON one exec output of the step before it (the Blueprint converter: an island's Update, Finished, ...);
      // a plain `{ }` never reaches here, flat() draws its statements in the chain
      case 'block': title = 'On ' + t('on'); bodies.push({ name: 'Then', ids: listOf(a.body).map(idOf) }); break;
      case 'goto-label':
        if (a.label) { title = 'Label ' + t('label'); bodies.push({ name: '', ids: [idOf(a.stmt)] }); } else { title = 'Goto'; pin('To', a.text); }
        break;
      case 'local-function': title = 'Local Function'; sub = short(t('sig')); break;
      case 'return': case 'expression-body': case 'yield': pin('Value', a.value); break;
      case 'throw': pin('Error', a.value); if (!exec) outs.push({ name: '', type: t('t') }); break;
      case 'await': case 'index-from-the-end': case 'checked-unchecked': case 'ref-expression': case 'range': case 'with':
        title = { 'await': 'Await', 'index-from-the-end': 'From End', 'checked-unchecked': 'Checked', 'ref-expression': 'Ref', 'range': 'Range', 'with': 'With' }[node.kw];
        pin('A', a.a); pin('B', a.b); if (a.text) pin('Code', a.text); if (a.init) pin('Init', a.init);
        outs.push({ name: '', type: t('t') });
        break;
      default:
        if (a.text) pin('Code', a.text);
        outs.push({ name: '', type: t('t') });
    }
    // a row holds an input on the left and an output on the right, so its width is both, side by side (measured 2026-10-28:
    // sizing by the longer of the two drew `Target  x` over `Return Value` on a pure call)
    const labels = ins.map((p) => p.name + (p.v.ref ? '' : '  ' + short(termText(p.v) || '')));
    const first = exec ? 1 : 0;
    const rowWidth = (r) => (labels[r - first] ? labels[r - first].length + 3 : 0) + (outs[r - first] && outs[r - first].name ? outs[r - first].name.length + 3 : outs[r - first] ? 2 : 0);
    let widest = 0;
    for (let r = first; r < first + Math.max(ins.length, outs.length); r++) widest = Math.max(widest, rowWidth(r));
    const width = Math.max(title.length + 4, sub.length + 2, widest + 2, ...bodies.map((b) => b.name.length + 4), 8);
    // rows, as drawn: an exec node's first row is its exec in and its "then" out; the data pins follow (inputs left, outputs
    // right); the exec outs into bodies come last, on the right
    const rows = (exec ? 1 : 0) + Math.max(ins.length, outs.length) + bodies.length;
    return { id: node.id, kw: node.kw, title: title, sub: sub, ins: ins, outs: outs, bodies: bodies, exec: exec,
      w: Math.round(width * CH + 2 * PAD), h: TITLE + (sub ? ROW - 4 : 0) + Math.max(1, rows) * ROW + 6 };
  }

  /** The stable layout of a graph in the Blueprint style. Exec runs left to right along a spine; a statement's data nodes sit
   *  below it and to its left, deeper operands further left (data flows in from the left, as in Blueprint); every nested body
   *  (a branch's True, a loop's body, a lambda's body) is a chain of its own in a band below. A local read is drawn as a wire
   *  only when the value was made fewer than LONG statements earlier; further than that it is a Get chip beside the reader.
   *  A pure function of the graph: the same file always gives the same picture. */
  function layout(g) {
    const boxes = new Map();
    const wires = [];
    const chips = [];
    const rowCache = new Map();
    const row = (id) => { if (!rowCache.has(id)) rowCache.set(id, rowOf(g, nodeOf(g, id))); return rowCache.get(id); };
    // every node's consumer: who refers to it (a data node has exactly one)
    const consumer = new Map();
    for (const id of g.order) {
      const n = g.nodes.get(id);
      for (const v of Object.values(n.attrs)) {
        for (const x of v.list || [v]) {
          if (x.ref) consumer.set(x.ref, id);
          else if (x.term && x.term.indexOf('#') >= 0) for (const r of refsIn(x.term)) consumer.set(r, id);
        }
      }
    }
    // the data nodes a statement's cell holds: the e-nodes whose row is that statement, in file order
    const cellOf = new Map();
    for (const id of g.order) {
      if (id[0] !== 'e') continue;
      const r = row(id);
      if (!cellOf.has(r)) cellOf.set(r, []);
      cellOf.get(r).push(id);
    }
    // a cell: the statement at its top right, its operands as a tree growing LEFT of it, as Blueprint draws pure nodes feeding an
    // exec node - each operand to the left of the pin it feeds, its own operands further left, siblings stacked downward. The
    // tree starts one row below the exec pins, so the exec spine runs above it. Returns its size, the owners of nested bodies
    // (with their x in the cell), and a placer.
    const kids = new Map();
    for (const id of g.order) {
      if (id[0] !== 'e') continue;
      const c = consumer.get(id);
      if (!c) continue;
      if (!kids.has(c)) kids.set(c, []);
      kids.get(c).push(id);
    }
    function cell(sid) {
      const head = bpNode(g, nodeOf(g, sid));
      const placed = [];              // {id, box, x, y} relative to the cell's top-left, x measured from the RIGHT edge for now
      // lay a subtree out right-to-left: the node's right edge at `right`, its top at `top`; returns the subtree's height
      function tree(id, right, top) {
        const box = bpNode(g, nodeOf(g, id));
        placed.push({ id: id, box: box, right: right, top: top });
        let y = top, used = 0;
        for (const k of (kids.get(id) || []).filter((x) => row(x) === sid)) {
          const h = tree(k, right - box.w - GAP_X * 0.6, y);
          y += h + 10;
          used += h + 10;
        }
        return Math.max(box.h, used - 10);
      }
      let y = TITLE + ROW + 4, treeH = 0;
      for (const k of (kids.get(sid) || []).filter((x) => row(x) === sid)) {
        const h = tree(k, -GAP_X * 0.6, y);
        y += h + 10;
        treeH = y - 10;
      }
      // operands of a statement that does not wire them directly (rare): the cell's own e-nodes not yet placed, stacked below
      for (const id of cellOf.get(sid) || []) {
        if (placed.some((p) => p.id === id)) continue;
        const h = tree(id, -GAP_X * 0.6, y);
        y += h + 10;
        treeH = y - 10;
      }
      const leftMost = placed.reduce((m, p) => Math.min(m, p.right - p.box.w), 0);
      const headX = -leftMost;                       // the head's left edge, from the cell's left edge
      const w = headX + head.w;
      const h = Math.max(head.h, treeH);
      const data = placed.map((p) => ({ id: p.id, box: p.box, dx: headX + p.right - p.box.w, dy: p.top }));
      const owners = [{ id: sid, x: headX, box: head }].concat(data.map((x) => ({ id: x.id, x: x.dx, box: x.box })));
      return { w: w, h: h, owners: owners, place: (x0, y0) => {
        boxes.set(sid, Object.assign({ x: x0 + headX, y: y0 }, head));
        for (const x of data) boxes.set(x.id, Object.assign({ x: x0 + x.dx, y: y0 + x.dy }, x.box));
      } };
    }

    // A chain is measured first and placed after, so a nested body can be packed where it fits: as close under its own owner
    // as the bodies already placed allow (a skyline), never in a band below every earlier body (measured 2026-10-28: the band
    // rule put a lambda's body 25,904 px from its owner in one of the game's registration methods).
    // a nested `{ ... }` is structure, not a step: its statements join the chain it sits in (measured 2026-10-28: drawing the
    // block as one box left the 368 statements inside `case 1: { ... }` and bare blocks undrawn); an empty `;` draws nothing
    function flat(ids) {
      const out = [];
      for (const id of ids) {
        const n = nodeOf(g, id);
        // ...except a block that runs on an exec output (`on=`, the Blueprint converter's): flattened, the steps of a Timeline's
        // Finished would draw as if they followed its Update; it is a node whose body is its own chain (bpNode)
        if (n.kw === 'block' && !n.attrs.on) out.push(...flat(listOf(n.attrs.body).map(idOf)));
        else if (n.kw !== 'empty') out.push(id);
      }
      return out;
    }

    function chain(rawIds, entryFrom) {
      const ids = flat(rawIds);
      const cells = ids.map(cell);
      const cx = [];
      let x = 0, bandH = 0;
      for (const c of cells) { cx.push(x); x += c.w + GAP_X; bandH = Math.max(bandH, c.h); }
      let w = Math.max(0, x - GAP_X), h = bandH;
      const below = [];                     // packed bodies: {sub, x, y}
      cells.forEach((c, i) => {
        for (const o of c.owners) {
          for (const body of o.box.bodies) {
            if (!body.ids.length) continue;
            const sub = chain(body.ids, { id: o.id, pin: body.name });
            const bx = cx[i] + o.x + INDENT;
            let by = bandH + GAP_Y;
            for (const r of below) if (r.x < bx + sub.w && bx < r.x + r.sub.w) by = Math.max(by, r.y + r.sub.h + GAP_Y);
            below.push({ sub: sub, x: bx, y: by });
            w = Math.max(w, bx + sub.w);
            h = Math.max(h, by + sub.h);
          }
        }
      });
      return { w: w, h: h, place: (x0, y0) => {
        let prev = entryFrom;
        cells.forEach((c, i) => {
          c.place(x0 + cx[i], y0);
          if (prev) wires.push({ kind: 'exec', from: prev.id, fromPin: prev.pin, to: ids[i] });
          prev = { id: ids[i], pin: 'then' };
        });
        for (const r of below) r.sub.place(x0 + r.x, y0 + r.y);
      } };
    }

    let bodyIds;
    if (g.attrs.arrow) bodyIds = [termText(g.attrs.arrow)];
    else bodyIds = listOf(g.attrs.body).map(idOf);
    const size = chain(bodyIds, { id: 'entry', pin: 'then' });
    size.place(0, 0);

    // data wires: every reference from a data node to its consumer, in the same statement
    for (const [id, c] of consumer) if (boxes.has(id) && boxes.has(c)) wires.push({ kind: 'data', from: id, to: c, span: 0 });
    // local reads: a wire from the declaring node when near, a Get chip when far (the census's long wire, never drawn)
    let longReads = 0;
    const longValues = new Set();
    for (const r of readsOf(g)) {
      const span = ordinal(r.row) - ordinal(r.madeRow);
      if (span >= LONG) { chips.push({ at: r.reader, name: r.name, made: r.made, span: span }); longReads++; longValues.add(r.name + '@' + r.made); }
      else if (r.made !== 'p' && r.made !== r.reader && boxes.has(r.made)) wires.push({ kind: 'read', from: r.made, to: r.reader, name: r.name, span: span });
    }
    return { boxes: boxes, wires: wires, chips: chips, w: size.w, h: size.h, longReads: longReads, longValues: longValues.size };
  }

  /** the statement-row span of every drawn wire, the visual length of each, and how many reads became Get chips */
  function layoutStats(g, L) {
    let longDrawn = 0, maxLen = 0;
    for (const w of L.wires) {
      if (w.kind !== 'exec' && w.from !== 'entry') {
        const span = Math.abs(ordinal(rowOf(g, nodeOf(g, w.to))) - ordinal(w.kind === 'read' ? rowOf(g, nodeOf(g, w.from)) : rowOf(g, nodeOf(g, w.from))));
        if (span >= LONG) longDrawn++;
      }
      const A = L.boxes.get(w.from), B = L.boxes.get(w.to);
      if (A && B) maxLen = Math.max(maxLen, Math.hypot(B.x - (A.x + A.w), B.y - A.y));
    }
    return { longDrawn: longDrawn, maxLen: Math.round(maxLen), wires: L.wires.length, chips: L.chips.length, longValues: L.longValues };
  }

  const api = {
    parse: parse, parseVocabulary: parseVocabulary, printCs: printCs, printCpp: printCpp, printPseudo: printPseudo,
    fileFinder: fileFinder, bpNode: bpNode, layout: layout,
    layoutStats: layoutStats, LONG: LONG, CH: CH, TITLE: TITLE, ROW: ROW, PAD: PAD, idOf: idOf, refsIn: refsIn,
    readsOf: readsOf, rowOf: rowOf, ordinal: ordinal, termText: termText, textOf: textOf, listOf: listOf, atLine: atLine,
    nodeOf: nodeOf, csPrecedence: csPrecedence, printCsStatement: printCsStatement,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NGL = api;
})(typeof self !== 'undefined' ? self : this);
