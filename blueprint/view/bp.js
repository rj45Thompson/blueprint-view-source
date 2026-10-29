// bp.js - Unreal Blueprint text in, the node graph language out (REQ-BPV-27, UC-BV34: a Blueprint converts to code, so its logic
// can be read, traced and tested as code). The Blueprint's graphs become .ngl graphs, which pl.js prints as C#, C++ and pseudo-code
// and the page draws like any other graph - one converter, every projection.
//
// The input is the text the engine writes: an object export (`UnrealEditor-Cmd -run=pythonscript` with the T3D exporter: a
// declaration pass, then a definition pass) or a clipboard copy of nodes. Its grammar is the engine's own, READ from
// EdGraphNode.cpp:751-761 (a node's pins, one `CustomProperties Pin (...)` line each) and EdGraphPin.cpp:1077-1230 (a pin's fields),
// with the pin names and categories of EdGraphSchema_K2.cpp:591-633. A line it cannot read is an error that names the line (BC-1);
// a node class it does not map is a marked island, counted, never dropped (BC-10).
(function (root) {
  'use strict';
  const OPS = (typeof module !== 'undefined' && module.exports) ? require('./bp_ops.js') : root.BP_OPS;
  const SELF = (typeof module !== 'undefined' && module.exports) ? require('./bp_self.js') : root.BP_SELF;

  // ---------------------------------------------------------------- reading the text

  /** a value at s[i]: a "string", a (struct or list), a NAME(args) call (NSLOCTEXT, INVTEXT, LOCGEN_...), or a bare token ending at
   *  a comma or a closing bracket at depth 0 -> {end, raw} (raw: the value's exact text) */
  function scanValue(s, i) {
    const start = i;
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } i++; continue; }
      if (c === '(') { depth++; i++; continue; }
      if (c === ')') { if (depth === 0) break; depth--; i++; continue; }
      if (c === ',' && depth === 0) break;
      i++;
    }
    return { end: i, raw: s.slice(start, i) };
  }

  /** "(A=1,B.C="x",D=(E=2))" -> {A: '1', 'B.C': '"x"', D: '(E=2)'} (values raw); a list "(a,b,)" -> {_list: ['a','b']} */
  function parseStruct(raw) {
    const s = raw.trim();
    if (s[0] !== '(' || s[s.length - 1] !== ')') throw new Error('not a parenthesized value: ' + s.slice(0, 80));
    const out = {};
    const list = [];
    let i = 1;
    const end = s.length - 1;
    while (i < end) {
      while (i < end && (s[i] === ' ' || s[i] === ',')) i++;
      if (i >= end) break;
      const eq = (() => { let j = i, depth = 0; while (j < end) { const c = s[j]; if (c === '"') return -1; if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 0) return -1; else if (c === '=' && depth === 0) return j; j++; } return -1; })();
      if (eq > i && /^[\w.()]+$/.test(s.slice(i, eq))) {
        const v = scanValue(s, eq + 1);
        out[s.slice(i, eq)] = v.raw;
        i = v.end;
      } else {
        const v = scanValue(s, i);
        if (v.raw.trim()) list.push(v.raw.trim());
        i = v.end;
      }
    }
    if (list.length) out._list = list;
    return out;
  }

  const unquote = (v) => {
    if (v === undefined || v === null) return v;
    v = v.trim();
    if (v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
    return v;
  };

  /** the words a reader sees for a localized value: NSLOCTEXT(ns, key, "text") -> text; INVTEXT("t") -> t; a format of INVTEXTs ->
   *  their texts joined - display only, never compared */
  function displayText(v) {
    if (!v) return '';
    const inv = [...v.matchAll(/INVTEXT\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1]);
    if (/^LOCGEN_FORMAT/.test(v) && inv.length) return inv.join(' ');
    const ns = /NSLOCTEXT\(\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(v);
    if (ns) return ns[1];
    if (inv.length) return inv[0];
    return unquote(v);
  }

  /** an object reference as the engine writes it, read the way the engine reads it: `Class'path'` - the class is what stands left
   *  of the first quote and the path is what stands between it and the closing one (PackageName.cpp:2808-2827,
   *  ParseExportTextPathImpl) - and a path that starts with a double quote is a quoted string whose quotes are not part of it:
   *  UE 5.0 writes `BlueprintGeneratedClass'"/Game/A/B.B_C"'` (measured on blueprintue.com pastes), and the engine reads the
   *  inside with FPropertyHelpers::ReadToken, which takes a token that starts with `"` as FParse::QuotedString (Property.cpp:656-664,
   *  called by PropertyBaseObject.cpp:373-386). A quoted path that does not close is refused, as the engine refuses it.
   *  -> {cls, path}; a text with no quote is a bare path */
  function objectPath(text) {
    const p = unquote(text);
    const i = p.indexOf("'");
    if (i < 0) return { cls: '', path: p };
    // a value that opens Class' must close with ' around one path: the engine's object import refuses anything else
    // (PropertyBaseObject.cpp:373-386 returns false when the token is not followed by the closing quote)
    if (i + 1 >= p.length - 1 || p[p.length - 1] !== "'") throw new Error('an object reference that does not close: ' + p.slice(0, 160));
    let path = p.slice(i + 1, -1);
    if (path[0] === '"') {
      if (path.length < 2 || path[path.length - 1] !== '"') throw new Error('an object path whose quoted string does not close: ' + p.slice(0, 160));
      path = unquote(path);
    }
    return { cls: p.slice(0, i), path: path };
  }

  /** "/Script/CoreUObject.Class'/Script/Engine.Character'" or "/Script/Engine.EdGraph'EventGraph'" (or UE 5.0's
   *  "Class'"/Script/Engine.Character"'") -> the object's short name */
  function shortName(path) {
    if (!path) return '';
    const tail = objectPath(path).path.split(/[.:/]/).pop();
    return tail.replace(/_C$/, '');
  }

  function parsePin(raw, where) {
    // a refusal names the line it is on (measured 2026-10-28 by bp_cli.js plant: a pin line cut short was refused without one)
    let f;
    try { f = parseStruct(raw); } catch (e) { throw new Error(where + ': ' + e.message); }
    if (!f.PinId) throw new Error(where + ': a pin with no PinId');
    const linked = f.LinkedTo ? (parseStruct(f.LinkedTo)._list || []).map((x) => { const [node, pin] = x.trim().split(/\s+/); return { node: node, pin: pin }; }) : [];
    const pin = {
      id: f.PinId, name: unquote(f.PinName || '""'), friendly: f.PinFriendlyName ? displayText(f.PinFriendlyName) : '',
      dir: unquote(f.Direction || '') === 'EGPD_Output' ? 'out' : 'in',
      cat: unquote(f['PinType.PinCategory'] || '""'), sub: unquote(f['PinType.PinSubCategory'] || '""'),
      subObj: f['PinType.PinSubCategoryObject'] && f['PinType.PinSubCategoryObject'] !== 'None' ? shortName(f['PinType.PinSubCategoryObject']) : '',
      subObjGenerated: /^BlueprintGeneratedClass'/.test(f['PinType.PinSubCategoryObject'] || ''),   // a Blueprint's own class, not a native one
      container: f['PinType.ContainerType'] || 'None', isRef: f['PinType.bIsReference'] === 'True', isConst: f['PinType.bIsConst'] === 'True',
      def: f.DefaultValue !== undefined ? unquote(f.DefaultValue) : undefined,
      autoDef: f.AutogeneratedDefaultValue !== undefined ? unquote(f.AutogeneratedDefaultValue) : undefined,
      defObj: f.DefaultObject !== undefined ? unquote(f.DefaultObject) : undefined,
      defText: f.DefaultTextValue !== undefined ? displayText(f.DefaultTextValue) : undefined,
      memberRef: f['PinType.PinSubCategoryMemberReference'],
      linked: linked, hidden: f.bHidden === 'True', orphaned: f.bOrphanedPin === 'True',
      parent: f.ParentPin ? f.ParentPin.trim().split(/\s+/) : null,
    };
    return pin;
  }

  /** the engine's text -> {objects: [{path, cls, name, props, pins, line, outer}]} - both passes of an object export merged by path,
   *  a clipboard copy's top-level nodes as they come. Every non-blank line is read or the whole read fails, naming it. */
  function parseText(text) {
    const lines = text.split(/\r?\n/);
    const byPath = new Map();
    const order = [];
    const stack = [];
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n].trim();
      const where = 'line ' + (n + 1);
      if (!line) continue;
      if (line.startsWith('Begin Object')) {
        const cls = /\bClass=(\S+)/.exec(line);
        const name = /\bName="([^"]*)"/.exec(line) || /\bName=(\S+)/.exec(line);
        if (!name) throw new Error(where + ': Begin Object with no Name: ' + line.slice(0, 120));
        const outer = stack.length ? stack[stack.length - 1] : null;
        const path = (outer ? outer.path + '.' : '') + name[1];
        let o = byPath.get(path);
        if (!o) {
          o = { path: path, name: name[1], cls: '', props: {}, arrays: {}, pins: [], line: n + 1, outer: outer ? outer.path : null };
          byPath.set(path, o);
          order.push(o);
        }
        if (cls) o.cls = cls[1].split('.').pop();
        if (!cls && o.line < n + 1 && Object.keys(o.props).length === 0 && o.pins.length === 0) o.line = n + 1;   // the definition pass holds the content
        stack.push(o);
        continue;
      }
      if (line === 'End Object') {
        if (!stack.length) throw new Error(where + ': End Object with no Begin Object');
        stack.pop();
        continue;
      }
      if (!stack.length) {
        if (/^Begin Map|^End Map|^Begin Level|^End Level/.test(line)) continue;
        throw new Error(where + ': text outside any object: ' + line.slice(0, 120));
      }
      const o = stack[stack.length - 1];
      if (line.startsWith('CustomProperties Pin ')) {
        let pin;
        try { pin = parsePin(line.slice('CustomProperties Pin '.length), where); } catch (e) { throw new Error(/^line \d+/.test(e.message) ? e.message : where + ': ' + e.message); }
        // a pin id is unique only WITHIN its node: a duplicated node keeps its pins' GUIDs (measured 2026-10-28, a UE 4.18 Pong
        // paste: 32 of 94 ids on two nodes each), which is why a wire names its node too - so a pin knows the node it is on
        o.pins.push(Object.assign(pin, { line: n + 1, node: o.name }));
        continue;
      }
      if (line.startsWith('CustomProperties ')) { o.props['CustomProperties.' + line.split(/\s+/)[1]] = line; continue; }
      // a property name may hold a space (a widget's `Scale Output=5.000000`, measured in TP_VehicleAdvBP's UI_Touch_Vehicle)
      const kv = /^([\w. ]+?)(?:\((\d+)\))?=(.*)$/.exec(line);
      if (!kv) throw new Error(where + ': a line that is neither a property nor a pin: ' + line.slice(0, 120));
      if (kv[2] !== undefined) (o.arrays[kv[1]] = o.arrays[kv[1]] || [])[+kv[2]] = kv[3];
      else o.props[kv[1]] = kv[3];
    }
    if (stack.length) throw new Error('the text ends inside ' + stack[stack.length - 1].path);
    return { objects: order, byPath: byPath, lines: lines.length };
  }

  // ---------------------------------------------------------------- from a graph's nodes to the graph language

  const NODE_PREFIX = 'K2Node_';
  const execPins = (n, dir) => n.pins.filter((p) => p.cat === 'exec' && p.dir === dir && !p.orphaned);
  const dataPins = (n, dir) => n.pins.filter((p) => p.cat !== 'exec' && p.dir === dir && !p.orphaned);
  const isPure = (n) => execPins(n, 'in').length === 0 && execPins(n, 'out').length === 0;
  // a split struct pin: the engine hides the parent and shows one pin per member, each naming its parent (ParentPin=)
  const subPins = (n, p) => n.pins.filter((q) => q.parent && q.parent[1] === p.id);
  // the pins that carry a value in or out: shown pins, and the hidden parents of split pins (never a member pin itself) - measured
  // 2026-10-28 on BP_ThirdPersonCharacter: an input event's split ActionValue read as "not run", GetRightVector lost its rotator
  const argPins = (n, dir) => dataPins(n, dir).filter((p) => !p.parent && (!p.hidden || subPins(n, p).length));
  // a pin that carries a value somewhere: wired itself, or through one of its split members
  const used = (n, p) => p.linked.length > 0 || subPins(n, p).some((q) => q.linked.length > 0);
  // the calls a pure node can be: a function, or an operator node whose function is not drawn as an operator
  const PURE_CALLS = { K2Node_CallFunction: 1, K2Node_PromotableOperator: 1, K2Node_CommutativeAssociativeBinaryOperator: 1, K2Node_CallArrayFunction: 1 };
  const ident = (s) => {
    const t = String(s || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return /^[0-9]/.test(t) ? '_' + t : (t || '_');
  };
  const json = (s) => JSON.stringify(String(s));

  /** a pin's type as a C#-ish name, for pins and declared locals (display; the model's types are the engine's) */
  function typeOf(p) {
    let t = p.subObj || ({ bool: 'bool', int: 'int', int64: 'long', byte: 'byte', real: p.sub === 'float' ? 'float' : 'double',
      float: 'float', double: 'double', string: 'string', name: 'Name', text: 'Text', object: 'Object', class: 'Class', struct: 'Struct',
      enum: 'Enum', delegate: 'Delegate', wildcard: 'var' })[p.cat] || p.cat;
    if (p.container === 'Array') t = 'List<' + t + '>';
    else if (p.container === 'Set') t = 'Set<' + t + '>';
    else if (p.container === 'Map') t = 'Map<' + t + '>';
    return t;
  }

  // the engine's own text forms for three structs' pin defaults, READ from the compiler that turns them into constants
  // (KismetCompilerVMBackend.cpp:881-923): a Vector is "X,Y,Z" with spaces ignored (DefaultValueHelper.cpp:444-486), a Rotator the
  // same three numbers as FRotator(InPitch, InYaw, InRoll) (DefaultValueHelper.cpp:585, Rotator.h:103), a Transform
  // "translation|rotation|scale" (Transform.cpp:60-92), built as FTransform(Rotation, Translation, Scale3D) (TransformNonVectorized.h:198)
  function three(s) {
    const xs = String(s).replace(/\s+/g, '').split(',');
    return xs.length === 3 && xs.every((x) => x !== '' && isFinite(Number(x))) ? xs.map((x) => String(Number(x))) : null;
  }
  function structText(type, v) {
    const vec = (s) => { const x = three(s); return x && 'new Vector { X = ' + x[0] + ', Y = ' + x[1] + ', Z = ' + x[2] + ' }'; };
    const rot = (s) => { const x = three(s); return x && 'new Rotator { Pitch = ' + x[0] + ', Yaw = ' + x[1] + ', Roll = ' + x[2] + ' }'; };
    if (type === 'Vector') return vec(v);
    if (type === 'Rotator') return rot(v);
    if (type === 'Transform') {
      const parts = String(v).split('|');
      if (parts.length === 3 && vec(parts[0]) && rot(parts[1]) && vec(parts[2])) return 'new Transform(' + rot(parts[1]) + ', ' + vec(parts[0]) + ', ' + vec(parts[2]) + ')';
    }
    return null;
  }

  /** an unwired input's value: its DefaultValue, or the schema's autogenerated one, or its object/text, else C#'s `default` - the
   *  type's zero value, which is what an unset Blueprint pin holds (never a made-up number). A struct default in a text form the
   *  converter does not read is printed as a marked term holding the text, and noted - never guessed into a value */
  function defaultTerm(p, notes) {
    if (p.defObj && p.defObj !== 'None') return shortName(p.defObj);
    // an object, class or interface pin's literal is its DefaultObject or none: the compiler never reads its DefaultValue text
    // (KismetCompiledFunctionContext.h:203; KismetCompilerVMBackend.cpp:1083-1110, where a "self" pin is the object itself) -
    // measured: SpawnActor's Instigator holds DefaultValue="None", which printed as the string "None"
    if (p.cat === 'object' || p.cat === 'class' || p.cat === 'interface') return p.sub === 'self' ? 'this' : 'null';
    if (p.cat === 'text' && p.defText !== undefined) return json(p.defText);
    const v = p.def !== undefined && p.def !== '' ? p.def : p.autoDef;
    if (v === undefined || v === '') {
      if (p.cat === 'string' || p.cat === 'name') return '""';
      // the zero value, written out where C# has a plain literal for it (`if (default)` read worse than `if (false)`)
      if (p.cat === 'bool') return 'false';
      if (p.container === 'None' && (p.cat === 'int' || p.cat === 'int64' || p.cat === 'real')) return p.cat === 'real' && p.sub === 'float' ? '0f' : '0';
      return 'default';
    }
    // a delegate's literal is the function it names, or none for "(null).None" (KismetCompilerVMBackend.cpp:1060-1071)
    if (p.cat === 'delegate') return v === '(null).None' ? 'null' : ident(v);
    if (p.cat === 'bool') return v.toLowerCase() === 'true' ? 'true' : 'false';
    if (p.cat === 'string' || p.cat === 'name' || p.cat === 'text') return json(v);
    if (p.cat === 'real' || p.cat === 'float' || p.cat === 'double' || p.cat === 'int' || p.cat === 'int64') {
      const x = Number(v);
      if (!isFinite(x)) return json(v);
      const t = String(x);
      return p.cat === 'real' && p.sub === 'float' ? t + 'f' : t;
    }
    if ((p.cat === 'byte' || p.cat === 'enum') && p.subObj && /^[A-Za-z_]\w*$/.test(v)) return p.subObj + '.' + v;
    if (p.cat === 'struct' && v[0] === '(') {
      const f = parseStruct(v);
      const parts = Object.keys(f).filter((k) => k !== '_list').map((k) => k + ' = ' + (isFinite(Number(f[k])) ? String(Number(f[k]))
        : f[k] === 'True' || f[k] === 'False' ? f[k].toLowerCase() : f[k]));
      // raw text: term() wraps it once (measured: wrapped here too, it printed as ~"new ModifyContextOptions {...}")
      return 'new ' + (p.subObj || 'Struct') + ' { ' + parts.join(', ') + ' }';
    }
    if (p.cat === 'struct') {
      const s = structText(p.subObj, v);
      if (s) return s;
      if (notes) notes.push('a ' + (p.subObj || 'struct') + ' default "' + v + '" in a text form the converter does not read');
      return 'default /* ' + (p.subObj || 'struct') + ' default ' + json(v).replace(/\*\//g, '* /') + ', a text form the converter does not read */';
    }
    return json(v);
  }

  /** the event nodes (K2Node_Event and the classes built on it) */
  const EVENTS = { K2Node_Event: 1, K2Node_CustomEvent: 1, K2Node_ComponentBoundEvent: 1, K2Node_ActorBoundEvent: 1 };

  /** the method an event node starts, named as the engine names its function: an override's EventReference member, otherwise
   *  the node's CustomFunctionName (K2Node_Event.cpp:339, GetFunctionName: `bOverrideFunction ? EventReference.GetMemberName()
   *  : CustomFunctionName`). A component's bound event is named once, when the node is made, after the Blueprint, the component
   *  and the node (K2Node_ComponentBoundEvent.cpp:108) - renaming either later does not rename the function */
  function eventName(n) {
    if (n.props.bOverrideFunction !== 'True' && n.props.CustomFunctionName) return unquote(n.props.CustomFunctionName);
    const member = parseStruct(n.props.EventReference || '()').MemberName;
    if (!member) throw new Error('line ' + n.line + ': event ' + n.name + ' names no function (no CustomFunctionName, no EventReference member)');
    return unquote(member);
  }

  /** the words the editor shows on an event node, where they differ from its function's name: a component's bound event is titled
   *  "{DelegatePropertyName} ({ComponentPropertyName})" (K2Node_ComponentBoundEvent.cpp:84-96). The delegate's display name is the
   *  engine property's own (GetTargetDelegateDisplayName, :218-222), which a reader of the text alone cannot load: UE 5.0 caches it
   *  in the node (DelegatePropertyDisplayName, a field 5.7 no longer has) and it is used when present; otherwise the title shows the
   *  delegate's NAME, which is what the engine itself shows when it cannot find the property (:221). '' for any other event */
  function eventTitle(n) {
    if (n.cls === 'K2Node_ComponentBoundEvent' && n.props.ComponentPropertyName) {
      const dn = n.props.DelegatePropertyDisplayName ? displayText(n.props.DelegatePropertyDisplayName) : unquote(n.props.DelegatePropertyName || '""');
      return dn + ' (' + unquote(n.props.ComponentPropertyName) + ')';
    }
    // an input event as the editor titles it, READ from the engine (BlueprintGraph/Private/K2Node_InputAxisEvent.cpp:88 "InputAxis
    // {InputAxisName}", K2Node_InputAction.cpp:90 "InputAction {InputActionName}"); the Pong paddle's was cited by its node's
    // name, K2Node_InputAxisEvent_0, where the editor says InputAxis MovePaddle
    if (n.cls === 'K2Node_InputAxisEvent' && n.props.InputAxisName) return 'InputAxis ' + unquote(n.props.InputAxisName);
    if (n.cls === 'K2Node_InputAction' && n.props.InputActionName) return 'InputAction ' + unquote(n.props.InputActionName);
    return '';
  }

  /** the Blueprint a clipboard copy came from, where the copy says so: a custom or bound event's delegate pin refers to the event's
   *  function on the Blueprint's own class (K2Node_Event.cpp:307-319, UpdateDelegatePin: not an override -> the skeleton class's
   *  FindFunctionByName(CustomFunctionName)). An override's pin names the parent's function instead, so it is not read. -> the
   *  class's short name, '' when no event says (a pasted function body never does), refused when two events disagree */
  function pasteOwner(nodes) {
    const seen = new Map();
    for (const n of nodes) {
      if (!EVENTS[n.cls] || n.props.bOverrideFunction === 'True') continue;
      const d = n.pins.find((p) => p.name === 'OutputDelegate' && p.cat === 'delegate');
      if (!d || !d.memberRef) continue;
      const parent = parseStruct(d.memberRef).MemberParent;
      if (!parent) continue;
      let cls;
      try { cls = shortName(parent); } catch (e) { throw new Error('line ' + n.line + ' (' + n.name + '): ' + e.message); }
      seen.set(cls, n.name);
    }
    // a member variable read or written on self names the Blueprint too: the engine types its self pin with the Blueprint's
    // generated class (BlueprintGeneratedClass'/Game/PongDemo/Blueprints/BP_Paddle.BP_Paddle_C'). Measured 10-28 on the Pong
    // paddle, a copy whose only events are an override (Tick) and an input axis, so no event named its owner and it read 'Pasted'
    for (const n of nodes) {
      if (n.cls !== 'K2Node_VariableGet' && n.cls !== 'K2Node_VariableSet') continue;
      const ref = n.props.VariableReference ? parseStruct(n.props.VariableReference) : {};
      const self = n.pins.find((p) => p.name === 'self');
      if (ref.bSelfContext !== 'True' || !self || !self.subObjGenerated || !self.subObj) continue;
      if (!seen.has(self.subObj)) seen.set(self.subObj, n.name);
    }
    if (seen.size > 1) throw new Error('a clipboard copy whose events and self-context members name two Blueprints: ' + [...seen].map(([c, n]) => c + ' (' + n + ')').join(', '));
    return seen.size ? [...seen.keys()][0] : '';
  }

  function Converter(graphObj, nodes, report, source) {
    this.g = graphObj;
    this.nodes = nodes;                      // name -> node
    this.report = report;
    this.source = source;
  }

  /** one method: the chain of statements from one entry pin, in the graph language */
  Converter.prototype.method = function (entry, pin, name) {
    this.lines = [];
    this.s = 0; this.e = 0;
    this.locals = new Map();     // `${node}|${pinId}` -> local name, once that node has run on this path
    this.used = new Set();
    this.visits = new Map();
    this.entry = entry;
    // per step (one impure node): the calls written in front of it, and the pure calls it has evaluated (see hoistCall)
    this.hoist = []; this.hoistLines = []; this.pureCache = new Map(); this.step = { uses: new Map(), reads: new Set() }; this.depth = 1;
    this.loopElems = new Map();  // a ForEach's Array Element pin -> {arr, index}: read again as Array[index] at every use (loop())
    this.inPin = null;           // the exec input the chain entered the current node by (DoOnce's Reset is a second way in)
    const params = argPins(entry, 'out').filter((p) => p.cat !== 'delegate');
    for (const p of params) this.locals.set(entry.name + '|' + p.id, ident(p.friendly || p.name));
    const body = this.chain(pin, 1, []);
    // a bare return as the method's last step says nothing
    const last = body.length ? this.lines.findIndex((l) => l.startsWith('  ' + body[body.length - 1] + ' return at=')) : -1;
    if (last >= 0) { this.lines.splice(last, 1); body.pop(); }
    // a function's outputs are out parameters, and only one named ReturnValue is its return value - the engine's own rule
    // (KismetCompiler.cpp:1686-1695); a call to it (call() below) writes the same out arguments
    const result = entry.cls === 'K2Node_FunctionEntry' ? [...this.nodes.values()].find((o) => o.cls === 'K2Node_FunctionResult') : null;
    const outs = result ? argPins(result, 'in').filter((p) => p.name !== 'ReturnValue') : [];
    const ret = result ? argPins(result, 'in').find((p) => p.name === 'ReturnValue') : null;
    const sig = (p) => ident(p.friendly || p.name) + ':' + typeOf(p).replace(/\s/g, '');
    const title = eventTitle(entry);
    const head = 'graph ' + (/^[\w.>]+$/.test(name) ? name : '~' + json(name)) + ' kind=' + (entry.cls === 'K2Node_FunctionEntry' ? 'function' : 'event') +
      ' at=' + entry.line + ':1' + (title ? ' title=' + json(title) : '') + (params.length ? ' params=[' + params.map(sig).join(' ') + ']' : '') + (outs.length ? ' outs=[' + outs.map(sig).join(' ') + ']' : '') +
      ' returns=' + (ret ? typeOf(ret).replace(/\s/g, '') : 'void') + ' body=[' + body.join(' ') + ']';
    return head + '\n' + this.lines.join('\n') + '\nend\n';
  };

  /** the node a pin is on, by the name it was read under - never by its id, which two duplicated nodes can share */
  Converter.prototype.ownerOf = function (p) {
    return (p.node && this.nodes.get(p.node)) || null;
  };

  Converter.prototype.follow = function (pin) {
    if (!pin || !pin.linked.length) return null;
    const l = pin.linked[0];
    const n = this.nodes.get(l.node);
    if (!n) throw new Error('a wire to ' + l.node + ', which this graph does not hold');
    return { node: n, pin: n.pins.find((p) => p.id === l.pin) };
  };

  /** the statements reached from an exec pin, at indent depth `d`; `path` holds the nodes on the way (a cycle is not followed) */
  Converter.prototype.chain = function (pin, d, path) {
    const ids = [];
    let next = this.follow(pin);
    while (next) {
      let n = next.node;
      while (n.cls === 'K2Node_Knot') { const out = execPins(n, 'out')[0]; next = this.follow(out); if (!next) return ids; n = next.node; }
      // a DoOnce entered by its Reset fires nothing (the engine's macro: Reset opens the gate and stops - doOnce() below), so reaching
      // it again that way is no loop: siljaZ's Dying and Lives re-arms its DoOnce at the end of the flashing it guards
      const reset = next.pin && next.pin.name === 'Reset' && n.cls === 'K2Node_MacroInstance' && this.g.kind === 'UbergraphPages' &&
        n.props.MacroGraphReference && shortName(parseStruct(n.props.MacroGraphReference).MacroGraph) === 'DoOnce';
      if (path.includes(n.name) && !reset) { ids.push(this.island(n, d, 'loops back to an earlier step; the wire is not followed again', true)); this.report.cycles++; break; }
      const seen = (this.visits.get(n.name) || 0) + 1;
      this.visits.set(n.name, seen);
      if (seen > 1) this.report.shared++;
      if (seen > 8) { ids.push(this.island(n, d, 'reached by more than 8 paths; written 8 times', true)); break; }
      // one step: the calls hoisted while its values are built go in front of it, at its own depth (hoistCall)
      const saved = [this.hoist, this.hoistLines, this.pureCache, this.step, this.depth];
      this.hoist = []; this.hoistLines = []; this.pureCache = new Map(); this.step = this.stepReads(n); this.depth = d;
      const start = this.lines.length;
      this.inPin = next.pin;
      // a refusal while a node is read names the node's line, wherever in the node it came from
      let r;
      try { r = this.statement(n, d, path.concat(n.name), seen > 1); } catch (e) { throw /^line \d+/.test(e.message) ? e : new Error('line ' + n.line + ' (' + n.name + '): ' + e.message); }
      if (this.hoistLines.length) this.lines.splice(start, 0, ...this.hoistLines);
      ids.push(...this.hoist, ...r.ids);
      [this.hoist, this.hoistLines, this.pureCache, this.step, this.depth] = saved;
      next = r.then ? this.follow(r.then) : null;
    }
    return ids;
  };

  /** what one step reads of the pure nodes, directly or through other pure nodes: how many wires reach each node (uses) and
   *  which of their output pins (reads; a split member also reads its parent) */
  Converter.prototype.stepReads = function (n) {
    const uses = new Map(), reads = new Set();
    const walk = (node) => {
      for (const p of dataPins(node, 'in')) {
        for (const l of p.linked) {
          let link = l;
          let src = this.nodes.get(link.node);
          while (src && src.cls === 'K2Node_Knot') {
            const ip = dataPins(src, 'in')[0];
            link = ip && ip.linked.length ? ip.linked[0] : null;
            src = link ? this.nodes.get(link.node) : null;
          }
          if (!src || !isPure(src)) continue;
          reads.add(src.name + '|' + link.pin);
          const sp = src.pins.find((q) => q.id === link.pin);
          if (sp && sp.parent) reads.add(src.name + '|' + sp.parent[1]);
          const k = (uses.get(src.name) || 0) + 1;
          uses.set(src.name, k);
          if (k === 1) walk(src);
        }
      }
    };
    walk(n);
    return { uses: uses, reads: reads };
  };

  /** a pure call written as its own statement in front of the step that reads it. The engine runs a pure node once for each step
   *  that needs it, just before that step: KismetCompiler.cpp:2798-2876 copies a pure node's code in front of every impure node
   *  that reads it, once per node (a set). So a call one step reads twice, or reads for an out parameter, which C# can only hand
   *  back through a variable, becomes `var r = F(..., out var o)` in front of that step - and again in front of the next step */
  Converter.prototype.hoistCall = function (n, sp) {
    const key = n.name + '|' + (sp ? sp.id : '');
    if (!this.pureCache.has(key)) {
      const lines = this.lines;
      this.lines = [];
      const id = this.call(n, this.depth, null, null, this.pureCache);
      this.hoistLines.push(...this.lines);
      this.lines = lines;
      this.hoist.push(id);
    }
    if (!this.pureCache.has(key)) throw new Error(n.name + ': pin ' + (sp ? sp.name : '?') + ' is read but its call gives it no variable');
    return this.term(this.pureCache.get(key));
  };

  Converter.prototype.line = function (d, id, kw, attrs, node, note) {
    this.lines.push('  '.repeat(d) + id + ' ' + kw + (attrs ? ' ' + attrs : '') + (note ? ' note=' + json(note) : '') + ' at=' + (node ? node.line : 0));
  };

  /** a marked island; `marker` for a wire's back-reference to a node already written (a cycle, a ninth path), which is not
   *  another node left without code and so is not counted (measured: each Timeline whose Finished wires back into it counted twice) */
  Converter.prototype.island = function (n, d, why, marker) {
    const id = 's' + ++this.s;
    if (!marker) this.report.islands[n.cls] = (this.report.islands[n.cls] || 0) + 1;
    const pins = n.pins.filter((p) => !p.hidden).map((p) => (p.dir === 'out' ? '->' : '') + (p.friendly || p.name)).join(', ');
    this.line(d, id, 'island', 'text=' + '~' + json('/* Blueprint ' + n.cls + ' "' + n.name + '": ' + why + ' (pins: ' + pins + ') */'), n);
    return id;
  };

  /** a node with no code form: a marked island, then the code after it. With one wired exec output the chain carries on after the
   *  island; with several, each becomes a block that names its output, so no code after an island is ever dropped (measured
   *  2026-10-28: a FlipFlop's B and a Timeline's Finished were followed from nowhere and counted as unreached) */
  Converter.prototype.islandOut = function (n, d, path, why) {
    const ids = [this.island(n, d, why)];
    // its data outputs have run, but have no code form: a read of one says so (it read "has not run on this path", which was false)
    for (const p of argPins(n, 'out')) this.locals.set(n.name + '|' + p.id, 'default /* ' + n.name + '.' + (p.friendly || p.name) + ': an output of the island above, no code form */');
    const outs = execPins(n, 'out').filter((p) => p.linked.length);
    if (outs.length <= 1) return { ids: ids, then: outs[0] || null };
    for (const o of outs) {
      const id = 's' + ++this.s;
      const at = this.lines.length;
      const label = 's' + ++this.s;
      this.lines.push('  '.repeat(d + 1) + label + ' island text=~' + json('/* ' + n.name + ' -> ' + (o.friendly || o.name) + ': runs when the node fires this output */') + ' at=' + n.line);
      const body = this.chain(o, d + 1, path);
      // `on=` names the output: the layout draws the block as a node with its own body (pl.js bpNode), not flattened into the chain
      this.lines.splice(at, 0, '  '.repeat(d) + id + ' block on=' + this.term(ident(o.friendly || o.name)) + ' body=[' + [label].concat(body).join(' ') + '] at=' + n.line);
      ids.push(id);
    }
    return { ids: ids, then: null };
  };

  /** one exec node -> {ids: its statement ids, then: the exec pin the chain continues from} */
  Converter.prototype.statement = function (n, d, path, shared) {
    const note = shared ? 'shared: this step is also reached by another path of the Blueprint' : null;
    const c = n.cls;
    const flow = (name) => n.pins.find((p) => p.cat === 'exec' && p.dir === 'out' && p.name === name);
    this.report.converted[c] = (this.report.converted[c] || 0) + 1;
    // every statement line is spliced in at `at`, taken BEFORE any of its values are built, so its value lines sit under it in the
    // file's indentation tree (the row a value is drawn beside); measured 2026-10-28: a branch's condition, taken after, sat
    // under the step before it - the row gate in bp_cli.js now fails on that
    if (c === 'K2Node_IfThenElse') {
      const id = 's' + ++this.s;
      const at = this.lines.length;
      const cond = this.value(n.pins.find((p) => p.name === 'Condition'), d + 1);
      const then = this.chain(flow('then'), d + 1, path);
      const els = this.chain(flow('else'), d + 1, path);
      this.lines.splice(at, 0, '  '.repeat(d) + id + ' branch cond=' + cond + ' then=[' + then.join(' ') + ']' + (els.length ? ' else=[' + els.join(' ') + ']' : '') + (note ? ' note=' + json(note) : '') + ' at=' + n.line);
      return { ids: [id], then: null };
    }
    if (c === 'K2Node_ExecutionSequence') {
      const outs = execPins(n, 'out').sort((a, b) => (+a.name.replace(/\D/g, '') || 0) - (+b.name.replace(/\D/g, '') || 0));
      const ids = [];
      for (const o of outs) ids.push(...this.chain(o, d, path));
      return { ids: ids, then: null };
    }
    if (c === 'K2Node_CallFunction' || c === 'K2Node_CallParentFunction' || c === 'K2Node_CallArrayFunction' || c === 'K2Node_Message'
        || c === 'K2Node_CallFunctionOnMember' || c === 'K2Node_CallDataTableFunction' || c === 'K2Node_CallMaterialParameterCollectionFunction') {
      return { ids: [this.call(n, d, note)], then: flow('then') || execPins(n, 'out')[0] };
    }
    if (c === 'K2Node_VariableSet') {
      const id = 's' + ++this.s;
      const ref = n.props.VariableReference ? parseStruct(n.props.VariableReference) : {};
      const name = unquote(ref.MemberName || '"?"');
      const input = dataPins(n, 'in').find((p) => p.name === name) || dataPins(n, 'in').find((p) => p.name !== 'self');
      const at = this.lines.length;
      const target = this.target(n, d, ref);
      const v = this.value(input, d + 1);
      this.lines.splice(at, 0, '  '.repeat(d) + id + ' set target=' + this.term((target ? target + '.' : '') + ident(name)) + ' op== value=' + v + (note ? ' note=' + json(note) : '') + ' at=' + n.line);
      const out = dataPins(n, 'out').find((p) => p.name === name || p.name === 'Output_Get');
      if (out) this.locals.set(n.name + '|' + out.id, (target ? target + '.' : '') + ident(name));
      return { ids: [id], then: flow('then') };
    }
    if (c === 'K2Node_FunctionResult') {
      // the function's outputs are out parameters and only one named ReturnValue is its return value (KismetCompiler.cpp:1686-1695):
      // each other output is assigned, then the method returns
      const ins = argPins(n, 'in');
      const ids = [];
      for (const p of ins.filter((q) => q.name !== 'ReturnValue')) {
        const sid = 's' + ++this.s;
        const sat = this.lines.length;
        const v = this.arg(n, p, d + 1);
        this.lines.splice(sat, 0, '  '.repeat(d) + sid + ' set target=' + this.term(ident(p.friendly || p.name)) + ' op== value=' + v + ' at=' + n.line);
        ids.push(sid);
      }
      const ret = ins.find((q) => q.name === 'ReturnValue');
      const id = 's' + ++this.s;
      const at = this.lines.length;
      const v = ret ? this.arg(n, ret, d + 1) : null;
      this.lines.splice(at, 0, '  '.repeat(d) + id + ' return' + (v ? ' value=' + v : '') + ' at=' + n.line);
      ids.push(id);
      return { ids: ids, then: null };
    }
    if (c === 'K2Node_MacroInstance') {
      const macro = n.props.MacroGraphReference ? shortName(parseStruct(n.props.MacroGraphReference).MacroGraph) : '';
      // the loops whose engine macro has been READ (StandardMacros.t3d, tools/export_engine_macros.py). The WithBreak variants are
      // not here: printed as the plain loop they dropped their Break input, so they stay islands until a sample exercises them
      const loops = { ForEachLoop: 1, ReverseForEachLoop: 1, ForLoop: 1, WhileLoop: 1 };
      if (loops[macro]) return this.loop(n, macro, d, path);
      // FlipFlop and DoOnce keep their state in event-graph locals, which the compiler keeps per object between events
      // (K2Node_TemporaryVariable.cpp:43, TS_ForcedShared in an event graph; KismetCompilerMisc.cpp:2958-2962, EventGraphLocals;
      // KismetCompiler.cpp:1646-1716, the persistent ubergraph frame or a transient property of the class): written as fields
      // named after the macro instance. In a function graph the same temporaries are locals that start fresh on every call
      if (macro === 'FlipFlop' && this.g.kind === 'UbergraphPages') return this.flipFlop(n, d, path);
      if (macro === 'DoOnce' && this.g.kind === 'UbergraphPages') return this.doOnce(n, d, path);
      if (macro === 'DecrementInt' || macro === 'IncrementInt') return this.stepInt(n, macro, d, path);
      // CompareFloat and CompareInt, READ from StandardMacros (runs/ue_samples/out_engine/StandardMacros.t3d:874-928 and :949-1003):
      // Less(Input, CompareWith) fires "<"; otherwise Greater(Input, CompareWith) fires ">"; otherwise "==". Both pure calls are
      // the macro's own nodes, evaluated where its branches read them, so a pin value is read once for each test
      if (macro === 'CompareFloat' || macro === 'CompareInt') {
        const id = 's' + ++this.s;
        const at = this.lines.length;
        const input = dataPins(n, 'in').find((p) => p.name === 'Input');
        const other = dataPins(n, 'in').find((p) => p.name === 'CompareWith');
        if (!input || !other) throw new Error('line ' + n.line + ': ' + macro + ' ' + n.name + ' has no Input or CompareWith pin');
        const a = this.value(input, d + 2);
        const b = this.value(other, d + 2);
        const e1 = 'e' + ++this.e;
        const less = this.chain(flow('<'), d + 1, path);
        const id2 = 's' + ++this.s;
        const at2 = this.lines.length;
        const e2 = 'e' + ++this.e;
        const greater = this.chain(flow('>'), d + 2, path);
        const equal = this.chain(flow('=='), d + 2, path);
        this.lines.splice(at2, 0, '  '.repeat(d + 1) + id2 + ' branch cond=#' + e2 + ' then=[' + greater.join(' ') + ']' + (equal.length ? ' else=[' + equal.join(' ') + ']' : '') + ' at=' + n.line,
          '  '.repeat(d + 2) + e2 + ' operator op=> a=' + a + ' b=' + b + ' t=bool at=' + n.line);
        this.lines.splice(at, 0, '  '.repeat(d) + id + ' branch cond=#' + e1 + ' then=[' + less.join(' ') + '] else=[' + id2 + '] at=' + n.line,
          '  '.repeat(d + 1) + e1 + ' operator op=< a=' + a + ' b=' + b + ' t=bool at=' + n.line);
        return { ids: [id], then: null };
      }
      if (macro === 'IsValid') {
        const id = 's' + ++this.s;
        const at = this.lines.length;
        const obj = this.value(dataPins(n, 'in')[0], d + 2);
        const e = 'e' + ++this.e;
        const then = this.chain(flow('Is Valid'), d + 1, path);
        const els = this.chain(flow('Is Not Valid'), d + 1, path);
        this.lines.splice(at, 0, '  '.repeat(d) + id + ' branch cond=#' + e + ' then=[' + then.join(' ') + ']' + (els.length ? ' else=[' + els.join(' ') + ']' : '') + ' at=' + n.line,
          '  '.repeat(d + 1) + e + ' pure-call method=IsValid args=[' + obj + '] t=bool at=' + n.line);
        return { ids: [id], then: null };
      }
      this.report.converted[c]--;
      return this.islandOut(n, d, path, 'the standard macro "' + macro + '"' + (this.g.kind === 'UbergraphPages' ? '' : ' in a function') + ' has no code form in the converter');
    }
    if (c === 'K2Node_DynamicCast' || c === 'K2Node_ClassDynamicCast') {
      const id = 's' + ++this.s;
      const to = n.props.TargetType ? shortName(n.props.TargetType) : 'Object';
      const at = this.lines.length;
      const obj = this.value(dataPins(n, 'in').find((p) => p.name === 'Object' || p.name === 'Class') || dataPins(n, 'in')[0], d + 2);
      const asPin = dataPins(n, 'out').find((p) => p.name.startsWith('As'));
      const local = ident('As' + to) + '_' + this.s;
      if (asPin) this.locals.set(n.name + '|' + asPin.id, local);
      const e = 'e' + ++this.e;
      const then = this.chain(flow('then'), d + 1, path);
      const els = this.chain(flow('CastFailed'), d + 1, path);
      this.lines.splice(at, 0, '  '.repeat(d) + id + ' branch cond=#' + e + ' then=[' + then.join(' ') + ']' + (els.length ? ' else=[' + els.join(' ') + ']' : '') + ' at=' + n.line,
        '  '.repeat(d + 1) + e + ' type-test a=' + obj + ' pat=' + '~' + json(to + ' ' + local) + ' t=bool at=' + n.line);
      return { ids: [id], then: null };
    }
    if (/^K2Node_Switch(Enum|Integer|Name|String)$/.test(c)) {
      const id = 's' + ++this.s;
      const at = this.lines.length;
      const on = this.value(dataPins(n, 'in').find((p) => p.name === 'Selection') || dataPins(n, 'in')[0], d + 1);
      const enumName = c === 'K2Node_SwitchEnum' && n.props.Enum ? shortName(n.props.Enum) : '';
      const secs = [];
      for (const o of execPins(n, 'out')) {
        const k = 'k' + ++this.s;
        const kat = this.lines.length;
        const body = this.chain(o, d + 2, path);
        const label = o.name === 'Default' ? 'default' : 'case ' + (c === 'K2Node_SwitchInteger' ? o.name : enumName ? enumName + '.' + ident(o.name) : json(o.name));
        // a section that ends in a return needs no break (one after it is unreachable)
        const last = body.length ? this.lines.slice(kat).find((l) => l.trim().startsWith(body[body.length - 1] + ' ')) : '';
        const ends = last && / (return|throw)\b/.test(last.trim().split(' ').slice(0, 2).join(' '));
        this.lines.splice(kat, 0, '  '.repeat(d + 1) + k + ' section labels=[' + label + '] body=[' + (ends ? body : body.concat([this.sectionBreak(d + 2, n)])).join(' ') + '] at=' + n.line);
        secs.push(k);
      }
      this.lines.splice(at, 0, '  '.repeat(d) + id + ' switch on=' + on + ' sections=[' + secs.join(' ') + '] at=' + n.line);
      return { ids: [id], then: null };
    }
    if (c === 'K2Node_VariableGet' && execPins(n, 'in').length) {
      // a validated get (CurrentVariation=ValidatedObject): exec out `then` "Is Valid", `else` "Is Not Valid"
      const id = 's' + ++this.s;
      const at = this.lines.length;
      const ref = n.props.VariableReference ? parseStruct(n.props.VariableReference) : {};
      const target = this.target(n, d, ref);
      const v = (target ? target + '.' : '') + ident(unquote(ref.MemberName || '"?"'));
      const out = dataPins(n, 'out')[0];
      if (out) this.locals.set(n.name + '|' + out.id, v);
      const e = 'e' + ++this.e;
      const then = this.chain(flow('then'), d + 1, path);
      const els = this.chain(flow('else'), d + 1, path);
      this.lines.splice(at, 0, '  '.repeat(d) + id + ' branch cond=#' + e + ' then=[' + then.join(' ') + ']' + (els.length ? ' else=[' + els.join(' ') + ']' : '') + ' at=' + n.line,
        '  '.repeat(d + 1) + e + ' pure-call method=IsValid args=[' + this.term(v) + '] t=bool at=' + n.line);
      return { ids: [id], then: null };
    }
    if (c === 'K2Node_AddComponent') {
      const cls = n.props.TemplateType ? shortName(n.props.TemplateType) : 'Component';
      return { ids: [this.call(n, d, note, 'AddComponent<' + cls + '>')], then: flow('then') };
    }
    if (c === 'K2Node_SetFieldsInStruct') {
      // one set per field it overrides, on the struct it is handed by reference
      const ref = n.pins.find((p) => p.name === 'StructRef');
      const at0 = this.lines.length;
      const target = ref ? this.inline(this.value(ref, d + 1)) : 'Struct';
      const ids = [];
      for (const p of argPins(n, 'in').filter((q) => q !== ref)) {
        const id = 's' + ++this.s;
        const at = ids.length ? this.lines.length : at0;
        const v = this.arg(n, p, d + 1);
        this.lines.splice(at, 0, '  '.repeat(d) + id + ' set target=' + this.term(target + '.' + ident(p.name)) + ' op== value=' + v + ' at=' + n.line);
        ids.push(id);
      }
      const out = dataPins(n, 'out').find((p) => p.name === 'StructOut');
      if (out) this.locals.set(n.name + '|' + out.id, target);
      return { ids: ids, then: flow('then') };
    }
    if (c === 'K2Node_AddDelegate' || c === 'K2Node_RemoveDelegate' || c === 'K2Node_ClearDelegate' || c === 'K2Node_AssignDelegate') {
      const id = 's' + ++this.s;
      const ref = n.props.DelegateReference ? parseStruct(n.props.DelegateReference) : {};
      const name = ident(unquote(ref.MemberName || '"Delegate"'));
      const at = this.lines.length;
      const target = this.target(n, d, ref);
      const ev = dataPins(n, 'in').find((p) => p.cat === 'delegate');
      const v = c === 'K2Node_ClearDelegate' ? 'null' : this.value(ev, d + 1);
      const op = { K2Node_AddDelegate: '+=', K2Node_RemoveDelegate: '-=', K2Node_ClearDelegate: '=', K2Node_AssignDelegate: '+=' }[c];
      this.lines.splice(at, 0, '  '.repeat(d) + id + ' set target=' + this.term((target ? target + '.' : '') + name) + ' op=' + op + ' value=' + v + ' at=' + n.line);
      return { ids: [id], then: flow('then') };
    }
    if (c === 'K2Node_CallDelegate') {
      const ref = n.props.DelegateReference ? parseStruct(n.props.DelegateReference) : {};
      return { ids: [this.call(n, d, note, ident(unquote(ref.MemberName || '"Delegate"')) + '.Broadcast')], then: flow('then') };
    }
    if (c === 'K2Node_SpawnActorFromClass' || c === 'K2Node_GenericCreateObject' || c === 'K2Node_AddComponentByClass' || c === 'K2Node_CreateWidget'
        || c === 'K2Node_GetSubsystem' || c === 'K2Node_ConstructObjectFromClass') {
      return { ids: [this.call(n, d, note, { K2Node_SpawnActorFromClass: 'SpawnActor', K2Node_GenericCreateObject: 'NewObject', K2Node_AddComponentByClass: 'AddComponentByClass',
        K2Node_CreateWidget: 'CreateWidget', K2Node_GetSubsystem: 'GetSubsystem', K2Node_ConstructObjectFromClass: 'NewObject' }[c])], then: flow('then') };
    }
    // latent and async nodes, timelines, and anything not in the table: a marked island, the chain carried on through its first exec out
    this.report.converted[c]--;
    if (this.report.converted[c] === 0) delete this.report.converted[c];
    const latent = /AsyncAction|Timeline|LoadAsset|AsyncTask|Delay/.test(c);
    return this.islandOut(n, d, path, latent ? 'latent: its outputs run later, as callbacks; no synchronous code form' : 'no code form in the converter');
  };

  /** FlipFlop, READ from the engine's macro (StandardMacros.t3d): IsA = !IsA, then A when IsA, else B */
  Converter.prototype.flipFlop = function (n, d, path) {
    const field = ident('FlipFlop_' + n.name.replace(/^K2Node_MacroInstance_/, '') + '_IsA');
    const flow = (name) => execPins(n, 'out').find((p) => p.name === name);
    const isA = argPins(n, 'out').find((p) => p.name === 'IsA');
    if (isA) this.locals.set(n.name + '|' + isA.id, field);
    const t = 's' + ++this.s, e = 'e' + ++this.e;
    this.lines.push('  '.repeat(d) + t + ' set target=' + field + ' op== value=#' + e + ' note=' + json("a field of the object: the event graph keeps the FlipFlop's IsA between events") + ' at=' + n.line,
      '  '.repeat(d + 1) + e + ' operator op=! a=' + field + ' t=bool at=' + n.line);
    const id = 's' + ++this.s;
    const at = this.lines.length;
    const then = this.chain(flow('A'), d + 1, path);
    const els = this.chain(flow('B'), d + 1, path);
    this.lines.splice(at, 0, '  '.repeat(d) + id + ' branch cond=' + field + ' then=[' + then.join(' ') + ']' + (els.length ? ' else=[' + els.join(' ') + ']' : '') + ' at=' + n.line);
    return { ids: [t, id], then: null };
  };

  /** DoOnce, READ from the engine's macro (StandardMacros.t3d): on its first run it marks itself started and, when Start Closed is
   *  set, closed; then, if not closed, it closes and fires Completed. Its Reset input opens it again (closed = false, started = true)
   *  and fires nothing. No template wires Reset; that path is the macro's graph, not a sample */
  Converter.prototype.doOnce = function (n, d, path) {
    const k = 'DoOnce_' + n.name.replace(/^K2Node_MacroInstance_/, '');
    const started = ident(k + '_Started'), closed = ident(k + '_Closed');
    const ind = (x) => '  '.repeat(x);
    const note = ' note=' + json("a field of the object: the event graph keeps the DoOnce's state between events");
    if (this.inPin && this.inPin.name === 'Reset') {
      const a = 's' + ++this.s, b = 's' + ++this.s;
      this.lines.push(ind(d) + a + ' set target=' + closed + ' op== value=false' + note + ' at=' + n.line,
        ind(d) + b + ' set target=' + started + ' op== value=true at=' + n.line);
      return { ids: [a, b], then: null };
    }
    // if (!started) { started = true; if (StartClosed) closed = true; }
    const s1 = 's' + ++this.s, e1 = 'e' + ++this.e, s2 = 's' + ++this.s, s3 = 's' + ++this.s, s4 = 's' + ++this.s;
    this.lines.push(ind(d) + s1 + ' branch cond=#' + e1 + ' then=[' + s2 + ' ' + s3 + ']' + note + ' at=' + n.line,
      ind(d + 1) + e1 + ' operator op=! a=' + started + ' t=bool at=' + n.line,
      ind(d + 1) + s2 + ' set target=' + started + ' op== value=true at=' + n.line);
    const at3 = this.lines.length;
    const sc = this.value(dataPins(n, 'in').find((p) => p.name === 'Start Closed'), d + 2);
    this.lines.splice(at3, 0, ind(d + 1) + s3 + ' branch cond=' + sc + ' then=[' + s4 + '] at=' + n.line);
    this.lines.push(ind(d + 2) + s4 + ' set target=' + closed + ' op== value=true at=' + n.line);
    // if (!closed) { closed = true; Completed }
    const s5 = 's' + ++this.s, e2 = 'e' + ++this.e, s6 = 's' + ++this.s;
    const at5 = this.lines.length;
    this.lines.push(ind(d + 1) + e2 + ' operator op=! a=' + closed + ' t=bool at=' + n.line,
      ind(d + 1) + s6 + ' set target=' + closed + ' op== value=true at=' + n.line);
    const done = this.chain(execPins(n, 'out').find((p) => p.name === 'Completed'), d + 1, path);
    this.lines.splice(at5, 0, ind(d) + s5 + ' branch cond=#' + e2 + ' then=[' + [s6].concat(done).join(' ') + '] at=' + n.line);
    return { ids: [s1, s5], then: null };
  };

  /** DecrementInt and IncrementInt, READ from the engine's macros (runs/ue_samples/out_engine/StandardMacros.t3d: DecrementInt :340-347
   *  is Subtract_IntInt with B = 1, :2221-2230; IncrementInt :320-327 Add_IntInt), each handing its result to ManipulateIntInternal
   *  (:418), whose VariableSetRef writes it back to what Value is wired to: that variable goes down (up) by one, and Result is its new
   *  value. A Value wired to anything but a variable has nothing to write back to, and is refused with its line */
  Converter.prototype.stepInt = function (n, macro, d, path) {
    const value = dataPins(n, 'in').find((p) => p.name === 'Value');
    const at = this.lines.length;
    const target = value ? this.inline(this.value(value, d + 1)) : null;
    if (!target || !/^[A-Za-z_][\w.]*$/.test(target)) throw new Error('line ' + n.line + ': ' + macro + ' ' + n.name + ' writes back through Value, which is wired to ' + (target || 'nothing') + ', no variable');
    this.lines.length = at;                    // a variable is a term: nothing of it stays on its own line
    const id = 's' + ++this.s;
    this.lines.push('  '.repeat(d) + id + ' set target=' + this.term(target) + ' op=' + (macro === 'DecrementInt' ? '-=' : '+=') + ' value=1 at=' + n.line);
    const result = dataPins(n, 'out').find((p) => p.name === 'Result');
    if (result) this.locals.set(n.name + '|' + result.id, target);
    return { ids: [id], then: execPins(n, 'out')[0] || null };
  };

  Converter.prototype.sectionBreak = function (d, n) {
    const id = 's' + ++this.s;
    this.lines.push('  '.repeat(d) + id + ' section-break at=' + n.line);
    return id;
  };

  Converter.prototype.loop = function (n, macro, d, path) {
    const id = 's' + ++this.s;
    const at = this.lines.length;
    const ins = dataPins(n, 'in');
    const outs = dataPins(n, 'out');
    const flow = (name) => n.pins.find((p) => p.cat === 'exec' && p.dir === 'out' && p.name === name);
    let head;
    if (macro === 'ForEachLoop' || macro === 'ReverseForEachLoop') {
      // READ from the engine's macros (StandardMacros.t3d): ForEachLoop counts i from 0 while i < Length(Array), re-reading the array
      // at every check, and an element is GetArrayItem(Array, i) on the live array; ReverseForEachLoop counts from Length - 1 down
      // while i >= 0. So: an index loop, and every read of Array Element is Array[i] again (sourceValue), never a copy - a
      // `foreach` copy differs when the body changes the array or the array comes from a call
      const arrPin = ins.find((p) => p.name === 'Array') || ins[0];
      const i = ident('index_' + this.s);
      const el = outs.find((p) => p.name === 'Array Element' || p.name === 'ArrayElement');
      const ix = outs.find((p) => p.name === 'Array Index' || p.name === 'ArrayIndex');
      if (ix) this.locals.set(n.name + '|' + ix.id, i);
      if (el) this.loopElems.set(n.name + '|' + el.id, { arr: arrPin, index: i, node: n });
      const count = this.term(this.inline(this.value(arrPin, d + 1)) + '.Count');
      const e = 'e' + ++this.e;
      if (macro === 'ForEachLoop') {
        this.lines.push('  '.repeat(d + 1) + e + ' operator op=< a=' + i + ' b=' + count + ' t=bool at=' + n.line);
        head = 'for-loop decl=int vars=[' + i + '] values=[0] cond=#' + e + ' step=[' + i + '++]';
      } else {
        const e0 = 'e' + ++this.e;
        this.lines.push('  '.repeat(d + 1) + e0 + ' operator op=- a=' + count + ' b=1 t=int at=' + n.line,
          '  '.repeat(d + 1) + e + ' operator op=>= a=' + i + ' b=0 t=bool at=' + n.line);
        head = 'for-loop decl=int vars=[' + i + '] values=[#' + e0 + '] cond=#' + e + ' step=[' + i + '--]';
      }
    } else if (/ForLoop/.test(macro)) {
      const i = ident('i_' + this.s);
      const ix = outs.find((p) => p.name === 'Index');
      if (ix) this.locals.set(n.name + '|' + ix.id, i);
      const first = this.value(ins.find((p) => p.name === 'FirstIndex'), d + 1);
      const last = this.value(ins.find((p) => p.name === 'LastIndex'), d + 1);
      const e = 'e' + ++this.e;
      this.lines.push('  '.repeat(d + 1) + e + ' operator op=<= a=' + i + ' b=' + last + ' t=bool at=' + n.line);
      head = 'for-loop decl=int vars=[' + i + '] values=[' + first + '] cond=#' + e + ' step=[' + i + '++]';
    } else {
      const cond = this.value(ins.find((p) => p.name === 'Condition'), d + 1);
      head = 'while-loop cond=' + cond;
    }
    const body = this.chain(flow('LoopBody') || flow('Loop Body'), d + 1, path);
    this.lines.splice(at, 0, '  '.repeat(d) + id + ' ' + head + ' body=[' + body.join(' ') + '] at=' + n.line);
    const ids = [id];
    ids.push(...this.chain(flow('Completed'), d, path));
    return { ids: ids, then: null };
  };

  /** a member's owner: a wired self/target pin, else implicit (this); a static library function names its class */
  Converter.prototype.target = function (n, d, ref) {
    const self = n.pins.find((p) => p.name === 'self' && p.dir === 'in');
    if (self && self.linked.length) return this.value(self, d + 1);
    if (ref && ref.MemberParent && !(ref.bSelfContext === 'True')) {
      const cls = shortName(ref.MemberParent);
      if (/Library$|Statics$|^Kismet/.test(cls)) return cls;
    }
    return null;
  };

  /** an exec call: `call` (or `set-local` of its result when a later step reads it), with its parameters from its pins */
  Converter.prototype.call = function (n, d, note, methodOverride, store) {
    const keep = store || this.locals;       // where its results are found later: the path's locals, or one step's (hoistCall)
    // an output is kept when something reads it: anywhere later on the path, or - for a call hoisted in front of one step - by that step
    const wanted = store ? (p) => this.step.reads.has(n.name + '|' + p.id) : (p) => used(n, p);
    const id = 's' + ++this.s;
    const ref = n.props.FunctionReference ? parseStruct(n.props.FunctionReference) : {};
    const method = methodOverride || ident(unquote(ref.MemberName || '"' + n.cls.replace(NODE_PREFIX, '') + '"'));
    const at = this.lines.length;
    const target = this.target(n, d, ref);
    const ins = argPins(n, 'in').filter((p) => p.name !== 'self');
    const outs = argPins(n, 'out');
    const args = [], mods = [], names = [];
    for (const p of ins) {
      args.push(this.arg(n, p, d + 1));
      // a const reference is passed as a value (C# `ref` would demand a variable); only a mutable reference is `ref`
      mods.push(p.isRef && !p.isConst ? 'ref' : '-');
      names.push(ident(p.friendly || p.name));
    }
    const outArgs = outs.filter((p) => p.name !== 'ReturnValue' && p.cat !== 'exec');
    for (const p of outArgs) {
      // an out parameter nothing reads is discarded (`out _`); C# still needs the argument
      if (!wanted(p)) { args.push('_'); mods.push('out'); names.push(ident(p.friendly || p.name)); continue; }
      const local = ident(method + '_' + (p.friendly || p.name)) + '_' + this.s;
      keep.set(n.name + '|' + p.id, local);
      args.push('~' + json('var ' + local));
      mods.push('out');
      names.push(ident(p.friendly || p.name));
    }
    const ret = outs.find((p) => p.name === 'ReturnValue');
    const call = (target ? 'on=' + this.term(target) + ' ' : '') + 'method=' + method + ' args=[' + args.join(' ') + ']' +
      (mods.some((m) => m !== '-') ? ' argmods=[' + mods.join(' ') + ']' : '') + ' params=[' + names.join(' ') + ']';
    // a latent function - its signature takes an FLatentActionInfo (KismetSystemLibrary.h:666, Delay; the editor's own test is the
    // Latent metadata, K2Node_CallFunction.cpp:1411): the steps after it run when it finishes, later, which C# says with `await`
    const latent = n.pins.some((p) => p.cat === 'struct' && p.subObj === 'LatentActionInfo');
    const ind = '  '.repeat(d);
    const nt = note ? ' note=' + json(note) : '';
    if (ret && wanted(ret)) {
      const local = ident(method + '_result') + '_' + this.s;
      keep.set(n.name + '|' + ret.id, local);
      const t = ' t=' + typeOf(ret).replace(/\s/g, '');
      const e = 'e' + ++this.e;
      if (latent) {
        const w = 'e' + ++this.e;
        this.lines.splice(at, 0, ind + id + ' set-local decl=var vars=[' + local + '] values=[#' + w + ']' + t + nt + ' at=' + n.line,
          ind + '  ' + w + ' await a=#' + e + t + ' at=' + n.line, ind + '    ' + e + ' pure-call ' + call + t + ' at=' + n.line);
      } else {
        this.lines.splice(at, 0, ind + id + ' set-local decl=var vars=[' + local + '] values=[#' + e + ']' + t + nt + ' at=' + n.line,
          ind + '  ' + e + ' pure-call ' + call + t + ' at=' + n.line);
      }
    } else if (latent) {
      const e = 'e' + ++this.e;
      this.lines.splice(at, 0, ind + id + ' await a=#' + e + nt + ' at=' + n.line, ind + '  ' + e + ' pure-call ' + call + ' at=' + n.line);
    } else {
      this.lines.splice(at, 0, ind + id + ' call ' + call + nt + ' at=' + n.line);
    }
    return id;
  };

  Converter.prototype.term = function (t) {
    return /^[^\s"\[\]~][^\s"]*$/.test(t) && !/[\[\]]/.test(t) ? t : '~' + json(t);
  };

  /** an input pin's value as an argument: a split struct input is built from its member pins (InRot_Yaw is the Yaw of InRot) */
  Converter.prototype.arg = function (n, p, d) {
    // an unwired object pin the function names DefaultToSelf, with no default object of its own, is compiled as self
    // (CallFunctionHandler.cpp:747-757); which pin that is lives in the C++ metadata, READ into bp_self.js by tools/bp_selftable.py
    if (!p.linked.length && !p.defObj && (p.cat === 'object' || p.cat === 'interface') && n.props.FunctionReference) {
      const fr = parseStruct(n.props.FunctionReference);
      const key = (fr.MemberParent ? shortName(fr.MemberParent) : '') + '.' + unquote(fr.MemberName || '""');
      if (SELF[key] && SELF[key].param === p.name) return 'this';
    }
    const subs = subPins(n, p);
    if (!subs.length) return this.value(p, d);
    const e = 'e' + ++this.e;
    const at = this.lines.length;
    const parts = subs.map((q) => ident(q.name.slice(p.name.length + 1)) + ' = ' + this.inline(this.value(q, d + 1)));
    this.lines.splice(at, 0, '  '.repeat(d) + e + ' construct type=' + this.term(typeOf(p)) + ' init=~' + json('{ ' + parts.join(', ') + ' }') +
      ' t=' + typeOf(p).replace(/\s/g, '') + ' at=' + n.line);
    return '#' + e;
  };

  /** a value as text inside raw text: a reference stays #eN (the printer substitutes it), a term its own text */
  Converter.prototype.inline = function (v) {
    return v[0] === '~' ? JSON.parse(v.slice(1)) : v;
  };

  /** the value an input pin receives: a wire's source (a pure node's expression, an earlier node's stored result, an entry's
   *  parameter) or the pin's own default */
  Converter.prototype.value = function (p, d) {
    if (!p) return 'default';
    if (p.cat === 'exec') throw new Error('an exec pin asked for a value');
    if (!p.linked.length) {
      // a split struct input is built from its member pins wherever it is read, not only as a call's argument (arg()): measured
      // 2026-10-28 on a UE 4.18 Pong paste, a SET of Velocity whose split X and Y were wired from Random Unit Vector In Cone printed
      // the hidden parent's default, Velocity = (0, 0, 0) - a plausible constant where a wired value belonged (DEBUG D39)
      const n = p.dir === 'in' ? this.ownerOf(p) : null;
      if (n && subPins(n, p).length) return this.arg(n, p, d);
      return this.term(defaultTerm(p, this.report.notes));
    }
    const src = this.follow(p);
    let n = src.node, sp = src.pin;
    while (n.cls === 'K2Node_Knot') { const ip = dataPins(n, 'in')[0]; if (!ip || !ip.linked.length) return 'default'; const s2 = this.follow(ip); n = s2.node; sp = s2.pin; }
    if (sp && sp.parent) {
      // a split struct pin: a member of its parent pin's value (Axis_X is Axis.X)
      const parent = n.pins.find((q) => q.id === sp.parent[1]) || n.pins.find((q) => sp.name.startsWith(q.name + '_') && !q.parent);
      if (parent) {
        const pv = this.sourceValue(n, parent, d);
        const member = ident(sp.name.slice(parent.name.length + 1));
        return /^#e\d+$/.test(pv) ? this.term(pv + '.' + member) : this.term(pv.replace(/^~"|"$/g, '') + '.' + member);
      }
    }
    return this.sourceValue(n, sp, d);
  };

  /** the value of output pin `sp` on node `n` */
  Converter.prototype.sourceValue = function (n, sp, d) {
    const key = n.name + '|' + (sp ? sp.id : '');
    if (this.loopElems.has(key)) {
      // a ForEach element: the live array's item at the loop's index, read again here (loop())
      const le = this.loopElems.get(key);
      const e = 'e' + ++this.e;
      const at = this.lines.length;
      const a = this.value(le.arr, d + 1);
      this.lines.splice(at, 0, '  '.repeat(d) + e + ' get-at-index on=' + a + ' index=[' + le.index + '] at=' + le.node.line);
      return '#' + e;
    }
    if (this.locals.has(key)) return this.term(this.locals.get(key));
    if (this.pureCache.has(key)) return this.term(this.pureCache.get(key));
    // an event's delegate pin (the red square on its title) is the event itself: handed to a bind, it is the method's name
    if (sp && sp.cat === 'delegate' && sp.dir === 'out' && (n.cls === 'K2Node_CustomEvent' || n.cls === 'K2Node_Event')) return this.term(ident(eventName(n)));
    if (!isPure(n)) {
      this.report.notes.push(n.name + ' (' + n.cls + '): its output is read before that node runs on this path');
      return this.term('default /* ' + n.name + '.' + (sp ? sp.name : '?') + ' has not run on this path */');
    }
    return this.pure(n, sp, d);
  };

  /** a pure node's expression, as a data node line; returns its reference (or a term) */
  Converter.prototype.pure = function (n, sp, d) {
    const c = n.cls;
    const ind = '  '.repeat(d);
    const t = sp ? ' t=' + typeOf(sp).replace(/\s/g, '') : '';
    const inPins = argPins(n, 'in');
    this.report.converted[c] = (this.report.converted[c] || 0) + 1;
    const emit = (body) => { const e = 'e' + ++this.e; const at = this.lines.length; const b = body(); this.lines.splice(at, 0, ind + e + ' ' + b + t + ' at=' + n.line); return '#' + e; };
    if (c === 'K2Node_VariableGet') {
      const ref = n.props.VariableReference ? parseStruct(n.props.VariableReference) : {};
      const target = this.target(n, d, ref);
      return this.term((target ? target + '.' : '') + ident(unquote(ref.MemberName || '"?"')));
    }
    if (c === 'K2Node_Self') return 'this';
    if (c === 'K2Node_EnumLiteral') { const p = inPins[0]; return this.term(defaultTerm(p)); }
    if (c === 'K2Node_Literal') return this.term(shortName(n.props.ObjectRef || '"?"'));
    if (PURE_CALLS[c]) {
      const ref = n.props.FunctionReference ? parseStruct(n.props.FunctionReference) : {};
      const fn = unquote(ref.MemberName || '"?"');
      const op = OPS[fn];
      const args = inPins.filter((p) => p.name !== 'self');
      const asOp = op && ((op.arity === 1 && args.length === 1) || (op.arity === 2 && args.length >= 2));
      // a call with out parameters, or one this step reads more than once, is written in front of the step (hoistCall)
      if (!asOp && (argPins(n, 'out').some((p) => p.name !== 'ReturnValue') || (this.step.uses.get(n.name) || 0) > 1)) return this.hoistCall(n, sp);
      if (op && op.arity === 1 && args.length === 1) return emit(() => 'operator op=' + op.op + ' a=' + this.arg(n, args[0], d + 1));
      if (op && op.arity === 2 && args.length >= 2) {
        // a commutative node may carry more than two inputs: A op B op C ...
        return emit(() => {
          let acc = 'operator op=' + op.op + ' a=' + this.arg(n, args[0], d + 1) + ' b=' + this.arg(n, args[1], d + 1);
          for (let k = 2; k < args.length; k++) {
            const e2 = 'e' + ++this.e;
            this.lines.push(ind + '  ' + e2 + ' ' + acc + t + ' at=' + n.line);
            acc = 'operator op=' + op.op + ' a=#' + e2 + ' b=' + this.arg(n, args[k], d + 1);
          }
          return acc;
        });
      }
      return emit(() => {
        const target = this.target(n, d, ref);
        const vals = args.map((p) => this.arg(n, p, d + 1));
        return 'pure-call ' + (target ? 'on=' + this.term(target) + ' ' : '') + 'method=' + ident(fn) + ' args=[' + vals.join(' ') + '] params=[' + args.map((p) => ident(p.friendly || p.name)).join(' ') + ']';
      });
    }
    if (c === 'K2Node_Select') {
      const opts = inPins.filter((p) => /^Option/.test(p.name));
      const idx = inPins.find((p) => p.name === 'Index');
      if (opts.length === 2 && idx && idx.cat === 'bool') return emit(() => 'select cond=' + this.value(idx, d + 1) + ' then=' + this.value(opts[1], d + 1) + ' else=' + this.value(opts[0], d + 1));
      return emit(() => 'pure-call method=Select args=[' + [idx].concat(opts).map((p) => this.value(p, d + 1)).join(' ') + ']');
    }
    if (c === 'K2Node_DynamicCast' || c === 'K2Node_ClassDynamicCast') {
      const to = n.props.TargetType ? shortName(n.props.TargetType) : 'Object';
      return emit(() => 'cast form=as a=' + this.value(inPins[0], d + 1) + ' to=' + this.term(to));
    }
    if (c === 'K2Node_MakeStruct') {
      const type = n.props.StructType ? shortName(n.props.StructType) : 'Struct';
      return emit(() => {
        const parts = inPins.map((p) => ident(p.friendly || p.name) + ' = ' + this.value(p, d + 1));
        return 'construct type=' + this.term(type) + ' init=' + '~' + json('{ ' + parts.join(', ') + ' }');
      });
    }
    if (c === 'K2Node_BreakStruct' || c === 'K2Node_StructMemberGet') {
      const v = this.value(inPins[0], d + 1);
      return this.term((v[0] === '#' ? v : v.replace(/^~"|"$/g, '')) + '.' + ident(sp ? (sp.friendly || sp.name) : '?'));
    }
    if (c === 'K2Node_MakeArray') return emit(() => 'make-array form=' + this.term('new[]') + ' elems=[' + inPins.map((p) => this.value(p, d + 1)).join(' ') + ']');
    if (c === 'K2Node_GetArrayItem') return emit(() => 'get-at-index on=' + this.value(inPins[0], d + 1) + ' index=[' + this.value(inPins[1], d + 1) + ']');
    // the editor's variant is a subclass that expands to UEditorSubsystemBlueprintLibrary::GetEditorSubsystem (K2Node_GetSubsystem.h:114,
    // K2Node_GetSubsystem.cpp:703); both name their class in CustomClass
    if (c === 'K2Node_GetSubsystem' || c === 'K2Node_GetEditorSubsystem') {
      const cls = n.props.CustomClass ? shortName(n.props.CustomClass) : 'Subsystem';
      return emit(() => 'pure-call method=' + this.term((c === 'K2Node_GetEditorSubsystem' ? 'GetEditorSubsystem<' : 'GetSubsystem<') + cls + '>') + ' args=[]');
    }
    if (c === 'K2Node_CastByteToEnum') {
      const en = n.props.Enum ? shortName(n.props.Enum) : 'Enum';
      return emit(() => 'cast form=cast to=' + this.term(en) + ' a=' + this.value(inPins[0], d + 1));
    }
    if (c === 'K2Node_CreateDelegate') return this.term(ident(unquote(n.props.SelectedFunctionName || '"Function"')));
    if (c === 'K2Node_EnumEquality' || c === 'K2Node_EnumInequality') return emit(() => 'operator op=' + (c === 'K2Node_EnumEquality' ? '==' : '!=') + ' a=' + this.value(inPins[0], d + 1) + ' b=' + this.value(inPins[1], d + 1));
    if (c === 'K2Node_FormatText') return emit(() => 'pure-call method=FormatText args=[' + inPins.map((p) => this.value(p, d + 1)).join(' ') + ']');
    if (c === 'K2Node_MathExpression') return emit(() => 'pure-call method=' + this.term('/* math expression */ Eval') + ' args=[' + json(unquote(n.props.Expression || '""')) + ' ' + inPins.map((p) => this.value(p, d + 1)).join(' ') + ']');
    // any other pure node: a marked island term, counted (BC-10)
    this.report.converted[c]--;
    if (this.report.converted[c] === 0) delete this.report.converted[c];
    this.report.islands[c] = (this.report.islands[c] || 0) + 1;
    return this.term('default /* Blueprint ' + c + ' "' + n.name + '": no code form */');
  };

  /** the node classes that stand only in an event graph (BlueprintGraph/Classes: each `: public UK2Node_Event`, and the two below) */
  const EVENT_GRAPH_ONLY = /^K2Node_(Event|ActorBoundEvent|ComponentBoundEvent|CustomEvent|GeneratedBoundEvent|InputActionEvent|InputAxisEvent|InputAxisKeyEvent|InputKeyEvent|InputTouchEvent|InputAction|InputKey)$/;

  /** the graphs a Blueprint lists as its own (UbergraphPages, FunctionGraphs, MacroGraphs) - read from it, never guessed from names.
   *  Text with no Blueprint object (a clipboard copy) is one graph of its top-level nodes. */
  function userGraphs(doc, declared) {
    const bp = doc.objects.find((o) => o.cls === 'Blueprint' || o.cls === 'AnimBlueprint' || o.cls === 'WidgetBlueprint' || /Blueprint$/.test(o.cls) && !o.outer);
    if (!bp) {
      // an exported graph on its own (Begin Object Class=/Script/Engine.EdGraph): its nodes are one graph
      const graphs = doc.objects.filter((o) => !o.outer && o.cls === 'EdGraph');
      if (graphs.length) return graphs.map((g) => ({ name: g.name, kind: 'EdGraph', blueprint: g.name, cls: g.cls, code: true, nodes: doc.objects.filter((o) => o.outer === g.path) }));
      // a clipboard copy: top-level nodes
      const nodes = doc.objects.filter((o) => !o.outer && (o.cls.startsWith(NODE_PREFIX) || o.cls === 'EdGraphNode_Comment'));
      // the Blueprint is named when the copy's own events name it (pasteOwner); a pasted function body names none, so it stays
      // 'Pasted' - the owner is then a fact the copy does not hold, never a guess
      const owner = pasteOwner(nodes);
      // the kind of graph the copy came from, READ from its nodes: an event (each subclass of K2Node_Event), an input action or an
      // input key stands only in an event graph (K2Node_Event.cpp:523-532, IsCompatibleWithGraph: GT_Ubergraph; K2Node_InputAction.cpp:
      // 114-129; K2Node_InputKey.cpp:206-219), a function's entry only in a function. A copy with neither keeps no kind. Until 10-28
      // every copy kept none, so a DoOnce in a pasted event graph was refused as "in a function" (siljaZ's Dying and Lives)
      const kind = nodes.some((o) => EVENT_GRAPH_ONLY.test(o.cls)) ? 'UbergraphPages' : nodes.some((o) => o.cls === 'K2Node_FunctionEntry') ? 'FunctionGraphs' : undefined;
      // a copy that names no owner takes the one its set's manifest declares, with the manifest's reason (bp_cli reads SOURCES.json);
      // a declared owner the copy contradicts is refused
      if (declared && declared.owner && owner && declared.owner !== owner) throw new Error('the manifest declares the owner ' + declared.owner + ', the copy\'s own events name ' + owner);
      return nodes.length ? [{ name: 'Pasted', kind: kind, blueprint: owner || (declared && declared.owner) || 'Pasted', owner: owner, cls: 'EdGraph', code: true, nodes: nodes }] : [];
    }
    const out = [];
    for (const key of ['UbergraphPages', 'FunctionGraphs', 'MacroGraphs']) {
      for (const ref of bp.arrays[key] || []) {
        if (!ref) continue;
        const gname = objectPath(ref).path.split(/[.:]/).pop();
        // a graph is any *Graph object: an EdGraph holds Blueprint code; an AnimationGraph or a ControlRigGraph holds another
        // language's nodes (measured: the templates' ABP_* and CtrlRig_* list them), counted and never converted as if they were code
        const g = doc.objects.find((o) => o.outer === bp.path && o.name === gname && /Graph$/.test(o.cls));
        if (!g) throw new Error(bp.name + ' lists ' + key + ' ' + gname + ', which the text does not hold');
        out.push({ name: gname, kind: key, blueprint: bp.name, cls: g.cls, code: g.cls === 'EdGraph', nodes: doc.objects.filter((o) => o.outer === g.path) });
      }
    }
    return out;
  }

  /** text -> {ngl: the graph-language file, report} for every user graph's entry points */
  /** declared: {owner, why} from the set's manifest, for a clipboard copy whose own events name no Blueprint */
  function convert(text, label, declared) {
    const doc = parseText(text);
    const report = { blueprint: label || '', graphs: 0, methods: 0, nodes: 0, comments: 0, unreached: 0, empty: 0, cycles: 0, shared: 0,
      converted: {}, islands: {}, notCode: {}, notes: [], lines: doc.lines };
    let ngl = '# ' + (label || 'Blueprint') + ' - converted from Unreal Blueprint text by view/bp.js (REQ-BPV-27). Generated: never edit by hand.\n';
    const graphs = userGraphs(doc, declared);
    if (declared && declared.owner && graphs.some((g) => !g.owner && g.blueprint === declared.owner)) {
      if (!declared.why) throw new Error('the manifest declares the owner ' + declared.owner + ' with no reason');
      ngl += '# its owner ' + declared.owner + ' is the manifest\'s, not the copy\'s: ' + declared.why + '\n';
    }
    for (const g of graphs) {
      if (!g.code) {
        report.notCode[g.cls] = (report.notCode[g.cls] || 0) + g.nodes.length;
        continue;
      }
      report.graphs++;
      const nodes = new Map(g.nodes.map((o) => [o.name, o]));
      const k2 = g.nodes.filter((o) => o.cls !== 'EdGraphNode_Comment');
      report.nodes += k2.length;
      report.comments += g.nodes.length - k2.length;
      const conv = new Converter(g, nodes, report, label);
      const reached = new Set();
      // entry points: a node with no exec input and a wired exec output (an event, an input event, a function's entry), and every
      // function's entry - a function with nothing wired after its entry is still a method of the class, with an empty body
      const entries = k2.filter((n) => execPins(n, 'in').length === 0 && (execPins(n, 'out').some((p) => p.linked.length) || n.cls === 'K2Node_FunctionEntry'));
      for (const entry of entries) {
        report.converted[entry.cls] = (report.converted[entry.cls] || 0) + 1;
        const outs = execPins(entry, 'out').filter((p) => p.linked.length);
        for (const pin of outs.length ? outs : [null]) {
          let name;
          // a function's graph carries the function's name; a clipboard copy of its body has no graph, but its entry node keeps the
          // signature it implements (K2Node_FunctionTerminator.h:30-32, FunctionReference)
          if (entry.cls === 'K2Node_FunctionEntry') name = g.name !== 'Pasted' ? g.name : unquote(parseStruct(entry.props.FunctionReference || '()').MemberName || '"Pasted"');
          else if (EVENTS[entry.cls]) name = eventName(entry);
          else if (entry.props.InputAction) name = shortName(entry.props.InputAction) + (outs.length > 1 || pin.name !== 'then' ? '_' + pin.name : '');
          else name = entry.name + (pin.name !== 'then' ? '_' + pin.name : '');
          const graphName = ident(g.blueprint) + '.' + ident(name);
          ngl += conv.method(entry, pin, graphName);
          report.methods++;
          for (const v of conv.visits.keys()) reached.add(v);
        }
        reached.add(entry.name);
      }
      // a node no entry reaches is dead in the Blueprint too (the compiler prunes it, KismetCompiler.cpp:2036); counted apart from
      // an event with nothing wired after it, which is empty rather than dead. A pure node is reached through what reads it
      for (const n of k2) {
        if (reached.has(n.name) || isPure(n) || n.cls === 'K2Node_Knot' || entries.includes(n)) continue;
        if (execPins(n, 'in').length === 0) report.empty++;
        else report.unreached++;
      }
    }
    return { ngl: ngl, report: report, doc: doc };
  }

  const api = { parseText: parseText, parseStruct: parseStruct, convert: convert, userGraphs: userGraphs, displayText: displayText,
    typeOf: typeOf, shortName: shortName, objectPath: objectPath, eventTitle: eventTitle, EVENTS: EVENTS, EVENT_GRAPH_ONLY: EVENT_GRAPH_ONLY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BP = api;
})(typeof self !== 'undefined' ? self : this);
