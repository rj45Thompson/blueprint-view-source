// run.js - the converted code RUN, so a game plays on its own converted Blueprint and a person can watch it run. The NGL graphs the
// converter wrote from a Blueprint paste (view/bp.js -> <set>/graphs/*.ngl) are executed statement by statement on actors an
// engine supplies, and every node is announced as it runs, so a page can light it. The game a page plays (view/games/*.js) is the
// ENGINE: its actors, their places and sizes, the tick, the overlaps, the input. The LOGIC is the Blueprint's own, as converted -
// nothing of it is typed again here. A node kind, a function or a name this runtime does not know THROWS with its graph and node:
// a value is never made up to keep a game going (CLAUDE.md iron law 2).
// Runs in the page (window.BPRUN, after pl.js) and in node (require('./run.js')) - tools/test_real.py plays the games headless.
(function (root) {
  'use strict';
  const NGL = root.NGL || (typeof require === 'function' ? require('./pl.js') : null);

  // ---------------------------------------------------------------- values
  /** Vector - the engine's FVector: X, Y, Z (doubles since UE 5.0) */
  class Vector {
    constructor(X, Y, Z) { this.X = +X || 0; this.Y = +Y || 0; this.Z = +Z || 0; }
    toString() { return '(' + [this.X, this.Y, this.Z].map((v) => +v.toFixed(2)).join(', ') + ')'; }
  }
  /** Rotator - FRotator, degrees */
  class Rotator {
    constructor(Pitch, Yaw, Roll) { this.Pitch = +Pitch || 0; this.Yaw = +Yaw || 0; this.Roll = +Roll || 0; }
    toString() { return '(P ' + +this.Pitch.toFixed(1) + ', Y ' + +this.Yaw.toFixed(1) + ', R ' + +this.Roll.toFixed(1) + ')'; }
  }
  /** Transform - FTransform: a location, a rotation, a scale */
  class Transform {
    constructor(Location, Rotation, Scale) { this.Location = Location || new Vector(0, 0, 0); this.Rotation = Rotation || new Rotator(0, 0, 0); this.Scale = Scale || new Vector(1, 1, 1); }
  }
  /** LinearColor - FLinearColor */
  class LinearColor { constructor(R, G, B, A) { this.R = +R || 0; this.G = +G || 0; this.B = +B || 0; this.A = A === undefined ? 1 : +A; } }
  const isVec = (v) => v instanceof Vector;
  const vec = (x, y, z) => new Vector(x, y, z);
  const size = (v) => Math.hypot(v.X, v.Y, v.Z);
  /** FRotator::RotateVector: V times its rotation matrix, a row vector on the left (UnrealMath.cpp:571; UnrealMathSSE.h:2275
   *  "VecP*MatrixM"), the matrix's rows READ from RotationTranslationMatrix.h:72-84 */
  function rotateVector(r, v) {
    const d = Math.PI / 180, SP = Math.sin(r.Pitch * d), CP = Math.cos(r.Pitch * d), SY = Math.sin(r.Yaw * d), CY = Math.cos(r.Yaw * d), SR = Math.sin(r.Roll * d), CR = Math.cos(r.Roll * d);
    const M0 = [CP * CY, CP * SY, SP], M1 = [SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP], M2 = [-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP];
    return vec(v.X * M0[0] + v.Y * M1[0] + v.Z * M2[0], v.X * M0[1] + v.Y * M1[1] + v.Z * M2[1], v.X * M0[2] + v.Y * M1[2] + v.Z * M2[2]);
  }
  /** FVector::RotateAngleAxisRad (Vector.h:1341, READ): Rodrigues about a unit axis */
  function rotateAngleAxis(v, deg, a) {
    const r = deg * Math.PI / 180, S = Math.sin(r), C = Math.cos(r), OMC = 1 - C;
    const XX = a.X * a.X, YY = a.Y * a.Y, ZZ = a.Z * a.Z, XY = a.X * a.Y, YZ = a.Y * a.Z, ZX = a.Z * a.X, XS = a.X * S, YS = a.Y * S, ZS = a.Z * S;
    return vec((OMC * XX + C) * v.X + (OMC * XY - ZS) * v.Y + (OMC * ZX + YS) * v.Z,
      (OMC * XY + ZS) * v.X + (OMC * YY + C) * v.Y + (OMC * YZ - XS) * v.Z,
      (OMC * ZX - YS) * v.X + (OMC * YZ + XS) * v.Y + (OMC * ZZ + C) * v.Z);
  }
  /** FVector::GetSafeNormal: zero when the size is under the tolerance (1e-8 squared, the engine's default) */
  function safeNormal(v) { const s2 = v.X * v.X + v.Y * v.Y + v.Z * v.Z; if (s2 < 1e-8) return vec(0, 0, 0); const k = 1 / Math.sqrt(s2); return vec(v.X * k, v.Y * k, v.Z * k); }

  /** UE's FMath::VRandCone (UnrealMath.cpp:2859, READ): an even spread over the cone; FRand comes from the world's own generator */
  function vRandCone(dir, halfRad, rand) {
    if (!(halfRad > 0)) return safeNormal(dir);
    const theta = 2 * Math.PI * rand(), phi = Math.acos(2 * rand() - 1) % halfRad;
    // FRotationMatrix(Dir.Rotation()) axes X and Y, roll 0 (RotationTranslationMatrix.h:72-79)
    const yaw = Math.atan2(dir.Y, dir.X), pitch = Math.atan2(dir.Z, Math.hypot(dir.X, dir.Y));
    const CP = Math.cos(pitch), SP = Math.sin(pitch), CY = Math.cos(yaw), SY = Math.sin(yaw);
    const dirZ = vec(CP * CY, CP * SY, SP), dirY = vec(-SY, CY, 0);
    let r = rotateAngleAxis(dir, phi * 180 / Math.PI, dirY);
    r = rotateAngleAxis(r, theta * 180 / Math.PI, dirZ);
    return safeNormal(r);
  }

  /** the operators the converted code prints, with the engine's meaning for vectors (FVector * double scales, FVector * FVector is
   *  per component - Multiply_VectorVector) */
  function binary(op, a, b, where) {
    const both = isVec(a) && isVec(b);
    const pick = (f) => (both ? vec(f(a.X, b.X), f(a.Y, b.Y), f(a.Z, b.Z)) : isVec(a) && typeof b === 'number' ? vec(f(a.X, b), f(a.Y, b), f(a.Z, b))
      : typeof a === 'number' && isVec(b) ? vec(f(a, b.X), f(a, b.Y), f(a, b.Z)) : null);
    switch (op) {
      case '*': case '+': case '-': case '/': case '%': {
        const f = { '*': (x, y) => x * y, '+': (x, y) => x + y, '-': (x, y) => x - y, '/': (x, y) => x / y, '%': (x, y) => x % y }[op];
        if (typeof a === 'number' && typeof b === 'number') return f(a, b);
        if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return String(a) + String(b);
        const v = pick(f);
        if (v) return v;
        break;
      }
      case '<': if (typeof a === 'number' && typeof b === 'number') return a < b; break;
      case '>': if (typeof a === 'number' && typeof b === 'number') return a > b; break;
      case '<=': if (typeof a === 'number' && typeof b === 'number') return a <= b; break;
      case '>=': if (typeof a === 'number' && typeof b === 'number') return a >= b; break;
      case '==': return both ? a.X === b.X && a.Y === b.Y && a.Z === b.Z : a === b;
      case '!=': return both ? !(a.X === b.X && a.Y === b.Y && a.Z === b.Z) : a !== b;
      case '&&': if (typeof a === 'boolean' && typeof b === 'boolean') return a && b; break;
      case '||': if (typeof a === 'boolean' && typeof b === 'boolean') return a || b; break;
      default: break;
    }
    throw new Error(where + ': no meaning here for ' + show(a) + ' ' + op + ' ' + show(b));
  }
  function show(v) { return v === null ? 'null' : v === undefined ? 'nothing' : isVec(v) ? 'Vector' + v : typeof v === 'object' ? (v.cls || v.kind || 'object') : typeof v + ' ' + v; }

  // ---------------------------------------------------------------- the library the converted code calls
  /** KismetMathLibrary, as the engine defines each function (KismetMathLibrary.h/.inl): only those the sets call; any other throws */
  function mathLibrary(rand) {
    const num = (x, name) => { if (typeof x !== 'number') throw new Error('KismetMathLibrary.' + name + ': ' + show(x) + ' is not a number'); return x; };
    const v = (x, name) => { if (!isVec(x)) throw new Error('KismetMathLibrary.' + name + ': ' + show(x) + ' is not a Vector'); return x; };
    return {
      Multiply_FloatFloat: (A, B) => num(A, 'Multiply_FloatFloat') * num(B, 'Multiply_FloatFloat'),
      Multiply_DoubleDouble: (A, B) => num(A, 'Multiply_DoubleDouble') * num(B, 'Multiply_DoubleDouble'),
      Divide_DoubleDouble: (A, B) => num(A, 'Divide_DoubleDouble') / num(B, 'Divide_DoubleDouble'),
      Add_DoubleDouble: (A, B) => num(A, 'Add_DoubleDouble') + num(B, 'Add_DoubleDouble'),
      Subtract_DoubleDouble: (A, B) => num(A, 'Subtract_DoubleDouble') - num(B, 'Subtract_DoubleDouble'),
      Add_IntInt: (A, B) => (num(A, 'Add_IntInt') + num(B, 'Add_IntInt')) | 0,
      Less_DoubleDouble: (A, B) => num(A, 'Less_DoubleDouble') < num(B, 'Less_DoubleDouble'),
      Greater_DoubleDouble: (A, B) => num(A, 'Greater_DoubleDouble') > num(B, 'Greater_DoubleDouble'),
      Less_IntInt: (A, B) => num(A, 'Less_IntInt') < num(B, 'Less_IntInt'),
      Greater_IntInt: (A, B) => num(A, 'Greater_IntInt') > num(B, 'Greater_IntInt'),
      FClamp: (Value, Min, Max) => Math.min(Math.max(num(Value, 'FClamp'), Min), Max),
      Abs: (A) => Math.abs(num(A, 'Abs')),
      VSize: (A) => size(v(A, 'VSize')),
      Normal: (A, Tolerance) => { const t = Tolerance === undefined ? 1e-4 : Tolerance; const s2 = A.X * A.X + A.Y * A.Y + A.Z * A.Z; if (s2 < t) return vec(0, 0, 0); const k = 1 / Math.sqrt(s2); return vec(A.X * k, A.Y * k, A.Z * k); },
      Vector_Distance: (a, b) => size(binary('-', v(a, 'Vector_Distance'), v(b, 'Vector_Distance'), 'Vector_Distance')),
      Add_VectorVector: (A, B) => binary('+', v(A, 'Add_VectorVector'), v(B, 'Add_VectorVector'), 'Add_VectorVector'),
      Subtract_VectorVector: (A, B) => binary('-', v(A, 'Subtract_VectorVector'), v(B, 'Subtract_VectorVector'), 'Subtract_VectorVector'),
      Multiply_VectorVector: (A, B) => binary('*', v(A, 'Multiply_VectorVector'), v(B, 'Multiply_VectorVector'), 'Multiply_VectorVector'),
      Multiply_VectorFloat: (A, B) => binary('*', v(A, 'Multiply_VectorFloat'), num(B, 'Multiply_VectorFloat'), 'Multiply_VectorFloat'),
      Conv_DoubleToVector: (InDouble) => { num(InDouble, 'Conv_DoubleToVector'); return vec(InDouble, InDouble, InDouble); },
      MakeVector: (X, Y, Z) => vec(X, Y, Z),
      RandomUnitVectorInConeInDegrees: (ConeDir, ConeHalfAngleInDegrees) => vRandCone(v(ConeDir, 'RandomUnitVectorInConeInDegrees'), num(ConeHalfAngleInDegrees, 'RandomUnitVectorInConeInDegrees') * Math.PI / 180, rand),
      RandomUnitVectorInConeInRadians: (ConeDir, ConeHalfAngleInRadians) => vRandCone(v(ConeDir, 'RandomUnitVectorInConeInRadians'), num(ConeHalfAngleInRadians, 'RandomUnitVectorInConeInRadians'), rand),
      RandomFloatInRange: (Min, Max) => Min + (Max - Min) * rand(),
      // FMath::RandRange(int): Min + RandHelper(Max - Min + 1)
      RandomIntegerInRange: (Min, Max) => Min + Math.floor(rand() * (Max - Min + 1)),
      // UKismetMathLibrary::RandomPointInBoundingBox: Origin + (FRand*2-1) * HalfSize per axis (KismetMathLibrary.inl)
      RandomPointInBoundingBox: (Center, HalfSize) => vec(Center.X + (rand() * 2 - 1) * HalfSize.X, Center.Y + (rand() * 2 - 1) * HalfSize.Y, Center.Z + (rand() * 2 - 1) * HalfSize.Z),
      // KismetMathLibrary.inl, each READ: :1549 B.RotateVector(A); :1963 (To - From).GetSafeNormal(); :3757; :14 FMath::RandBool;
      // :1699 A + V * (B - A); :1447 FTransform(InTranslation); :872 FTransform(Rotation, Translation, Scale)
      GreaterGreater_VectorRotator: (A, B) => rotateVector(B, v(A, 'GreaterGreater_VectorRotator')),
      GetDirectionUnitVector: (From, To) => safeNormal(binary('-', v(To, 'GetDirectionUnitVector'), v(From, 'GetDirectionUnitVector'), 'GetDirectionUnitVector')),
      SelectFloat: (A, B, bSelectA) => (bSelectA ? A : B),
      RandomBool: () => rand() < 0.5,
      VLerp: (A, B, V) => binary('+', A, binary('*', num(V, 'VLerp'), binary('-', B, A, 'VLerp'), 'VLerp'), 'VLerp'),
      Conv_VectorToTransform: (InTranslation) => new Transform(v(InTranslation, 'Conv_VectorToTransform')),
      MakeTransform: (Translation, Rotation, Scale) => new Transform(Translation, Rotation, Scale),
      Subtract_IntInt: (A, B) => (num(A, 'Subtract_IntInt') - num(B, 'Subtract_IntInt')) | 0,
    };
  }
  /** KismetTextLibrary.Conv_DoubleToText: the number as FText::AsNumber writes it with the options given (grouping, fraction digits) */
  function textLibrary() {
    return {
      Conv_DoubleToText: (Value, RoundingMode, bAlwaysSign, bUseGrouping, MinimumIntegralDigits, MaximumIntegralDigits, MinimumFractionalDigits, MaximumFractionalDigits) =>
        (bAlwaysSign && Value >= 0 ? '+' : '') + Value.toLocaleString('en-US', { useGrouping: !!bUseGrouping, minimumFractionDigits: MinimumFractionalDigits || 0, maximumFractionDigits: MaximumFractionalDigits === undefined ? 3 : MaximumFractionalDigits }),
    };
  }

  // ---------------------------------------------------------------- a fragment of C# the converter left as text (~"...")
  /** the converter writes what has no node of its own as a C# fragment: `new Vector { X = 0, Y = -1, Z = 0 }`, an initializer
   *  `{ X = #e3, Y = Velocity.Y, Z = Velocity.Z }`, a pattern `BP_Paddle AsBP_Paddle_1`. A small reader for that grammar: literals,
   *  names, member paths, #references, calls, new-with-initializer, unary and binary operators. Anything else throws. */
  function tokenize(s, where) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      let m;
      if ((m = /^(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)[fFdDmM]?/.exec(s.slice(i)))) { out.push({ k: 'num', v: parseFloat(m[1]) }); i += m[0].length; continue; }
      if ((m = /^#([sekf]\d+)/.exec(s.slice(i)))) { out.push({ k: 'ref', v: m[1] }); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i)))) { out.push({ k: 'id', v: m[0] }); i += m[0].length; continue; }
      if (c === '"') { let j = i + 1; while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; j++; } out.push({ k: 'str', v: JSON.parse(s.slice(i, j + 1)) }); i = j + 1; continue; }
      if ((m = /^(==|!=|<=|>=|&&|\|\||[-+*\/%<>!=.,(){}\[\]?:])/.exec(s.slice(i)))) { out.push({ k: 'p', v: m[0] }); i += m[0].length; continue; }
      throw new Error(where + ': cannot read "' + s + '" at ' + i);
    }
    return out;
  }
  function parseFragment(s, where) {
    const t = tokenize(s, where);
    let i = 0;
    const peek = (v) => t[i] && t[i].k === 'p' && t[i].v === v;
    const eat = (v) => { if (!peek(v)) throw new Error(where + ': expected "' + v + '" in "' + s + '"'); i++; };
    const LEVELS = [['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    function expr() { return level(0); }
    function level(n) {
      if (n === LEVELS.length) return unary();
      let a = level(n + 1);
      while (t[i] && t[i].k === 'p' && LEVELS[n].includes(t[i].v)) { const op = t[i++].v; a = { op: op, a: a, b: level(n + 1) }; }
      if (n === 3 && t[i] && t[i].k === 'id' && t[i].v === 'is') { i++; const type = t[i++].v; const bind = t[i] && t[i].k === 'id' ? t[i++].v : null; a = { is: type, bind: bind, a: a }; }
      return a;
    }
    function unary() { if (peek('-') || peek('!') || peek('+')) { const op = t[i++].v; return { unary: op, a: unary() }; } return postfix(primary()); }
    function inits() {
      eat('{');
      const fields = [];
      while (!peek('}')) { const name = t[i++].v; eat('='); fields.push([name, expr()]); if (peek(',')) i++; }
      eat('}');
      return fields;
    }
    function primary() {
      const x = t[i++];
      if (!x) throw new Error(where + ': "' + s + '" ends early');
      if (x.k === 'num') return { lit: x.v };
      if (x.k === 'str') return { lit: x.v };
      if (x.k === 'ref') return { ref: x.v };
      if (x.k === 'p' && x.v === '(') { const e = expr(); eat(')'); return e; }
      if (x.k === 'p' && x.v === '{') { i--; return { init: inits() }; }
      if (x.k === 'id') {
        if (x.v === 'true' || x.v === 'false') return { lit: x.v === 'true' };
        if (x.v === 'null') return { lit: null };
        if (x.v === 'new') { const type = t[i++].v; if (peek('{')) return { neu: type, init: inits() }; eat('('); const args = []; while (!peek(')')) { args.push(expr()); if (peek(',')) i++; } eat(')'); return { neu: type, args: args, init: peek('{') ? inits() : [] }; }
        return { name: x.v };
      }
      throw new Error(where + ': unexpected "' + x.v + '" in "' + s + '"');
    }
    function postfix(e) {
      for (;;) {
        if (peek('.')) { i++; e = { member: t[i++].v, of: e }; continue; }
        if (peek('(')) { i++; const args = []; while (!peek(')')) { args.push(expr()); if (peek(',')) i++; } eat(')'); e = { call: e, args: args }; continue; }
        if (peek('[')) { i++; const ix = expr(); eat(']'); e = { index: ix, of: e }; continue; }
        return e;
      }
    }
    const e = expr();
    if (i !== t.length) throw new Error(where + ': left over after reading "' + s + '": ' + t.slice(i).map((x) => x.v).join(' '));
    return e;
  }
  /** a pattern of a type test: `Type Name` (the converter's cast output, bound to a name), or `Type` alone */
  function parsePattern(s) { const p = s.trim().split(/\s+/); return { type: p[0], bind: p[1] || null }; }

  // ---------------------------------------------------------------- the machine
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  /** machine - the converted graphs of one set, ready to run on an engine's actors.
   *  opts.graphs   NGL graphs (pl.js parse), named `<Blueprint>.<event or function>`
   *  opts.statics  { GameplayStatics: {...}, ... } the engine's static functions, merged over the runtime's own (KismetMathLibrary;
   *                KismetSystemLibrary's delays, timers and PrintString; KismetTextLibrary; GameplayStatics.GetObjectClass)
   *  opts.classes  the class names a graph may name as a value (SpawnActor(BP_Asteorid, ...), GetObjectClass(x) == BP_Character)
   *  opts.rand     the world's random generator (0..1), so a seeded world replays
   *  opts.onNode(graph, id, value) each statement as it runs and each expression with the value it gave; opts.onPrint(text) */
  function machine(opts) {
    const byName = new Map(opts.graphs.map((g) => [g.name, g]));
    const rand = opts.rand || Math.random;
    const onNode = opts.onNode || (() => {});
    const waiting = [];                      // a body waiting on a latent action: { at, it, self }
    const timers = [];                       // K2_SetTimerDelegate: { at, every, d }
    let now = 0;
    const counts = new Map();                // graph name -> times it ran
    const classes = new Map(), enums = new Map();
    // a class named as a value is one object per name, so == compares classes; an enum's member is its own name (never a number
    // made up for it): ESlateVisibility.Hidden is 'ESlateVisibility.Hidden'
    const classRef = (name) => classes.get(name) || classes.set(name, { __class: name, toString: () => name }).get(name);
    const enumOf = (name) => enums.get(name) || enums.set(name, { __enum: name }).get(name);
    const system = {
      // a latent action: an await on it waits its seconds (KismetSystemLibrary::Delay); DelayUntilNextTick waits for the next frame
      Delay: (Duration) => ({ latent: Duration }),
      DelayUntilNextTick: () => ({ latent: 0 }),
      // FTimerManager::SetTimer by delegate: it calls first after Time (and InitialStartDelay), then every Time when looping
      K2_SetTimerDelegate: (Delegate, Time, bLooping, InitialStartDelay) => {
        if (!Delegate || !Delegate.__delegate) throw new Error('K2_SetTimerDelegate: ' + show(Delegate) + ' is no event it can call');
        const t = { at: now + Time + (InitialStartDelay || 0), every: bLooping ? Time : 0, d: Delegate };
        timers.push(t);
        return t;
      },
      PrintString: (InString) => { if (opts.onPrint) opts.onPrint(String(InString)); },
    };
    const statics = { KismetMathLibrary: mathLibrary(rand), KismetSystemLibrary: system, KismetTextLibrary: textLibrary(),
      GameplayStatics: { GetObjectClass: (Object) => (Object && Object.cls ? classRef(Object.cls) : null) } };
    for (const [k, lib] of Object.entries(opts.statics || {})) statics[k] = Object.assign({}, statics[k] || {}, lib);
    for (const [k, lib] of Object.entries(statics)) lib.__static = k;     // a call on one of these is a static call

    /** the events of a Blueprint, keyed the way an engine fires them: ReceiveTick, ReceiveBeginPlay, `InputAxis MovePaddle`,
     *  `InputAction Shoot`, `Overlap Sphere` (the component its title names: "On Component Begin Overlap (Sphere)" - since UE 5 the
     *  event's own name carries its Blueprint too, BndEvt__BP_Meteor_Sphere_...), or a custom event / function by its own name */
    function eventKey(g) {
      const local = g.name.slice(g.name.indexOf('.') + 1);
      const title = g.attrs.title ? NGL.textOf(g.attrs.title) : null;
      let m;
      if (title && (m = /^On Component (Begin Overlap|End Overlap|Hit) \((.+)\)$/.exec(title))) return { 'Begin Overlap': 'Overlap', 'End Overlap': 'EndOverlap', Hit: 'Hit' }[m[1]] + ' ' + m[2];
      if (/^BndEvt__/.test(local)) throw new Error(g.name + ': a bound event whose title names no component this runtime fires');
      if (title && /^Input(Axis|Action) /.test(title)) return title;
      return local;
    }
    const events = new Map();               // Blueprint -> Map(key -> graph)
    for (const g of opts.graphs) {
      const bp = g.name.slice(0, g.name.indexOf('.'));
      if (!events.has(bp)) events.set(bp, new Map());
      const key = eventKey(g);
      if (events.get(bp).has(key)) throw new Error(g.name + ': ' + bp + ' already has the event ' + key + ' (' + events.get(bp).get(key).name + ')');
      events.get(bp).set(key, g);
    }

    function fail(g, n, why) { throw new Error(g.name + (n ? '#' + n.id : '') + ': ' + why); }
    /** a frame: the graph, the actor it runs on, its locals and parameters, the outputs of the islands that fired its block */
    function frame(g, self, params, islands) { return { g: g, self: self, locals: Object.assign({}, params || {}), islands: islands || {}, result: undefined, returned: false, broken: false }; }

    function lookup(F, name, n) {
      if (has(F.locals, name)) return F.locals[name];
      const self = F.self;
      if (self) {
        if (self.vars && has(self.vars, name)) return self.vars[name];
        if (self.comps && has(self.comps, name)) return self.comps[name];
        if (name === 'self' || name === 'this') return self;
        if (events.get(self.cls) && events.get(self.cls).has(name)) return { __delegate: true, self: self, key: name };   // an event of its own, as a value
      }
      if (has(statics, name)) return statics[name];
      if (opts.classes && opts.classes.includes(name)) return classRef(name);
      if (/^E[A-Z]\w*$/.test(name)) return enumOf(name);
      fail(F.g, n, 'reads "' + name + '", which neither the graph, its actor (' + (self ? self.cls : 'none') + ') nor the engine defines');
    }
    function member(obj, name, F, n) {
      if (obj === null || obj === undefined) fail(F.g, n, 'reads .' + name + ' of ' + show(obj));
      if (obj.__enum) return obj.__enum + '.' + name;
      if (isVec(obj)) { if (name === 'X' || name === 'Y' || name === 'Z') return obj[name]; fail(F.g, n, 'a Vector has no ' + name); }
      if (obj.vars && has(obj.vars, name)) return obj.vars[name];
      if (obj.comps && has(obj.comps, name)) return obj.comps[name];
      if (name in obj) return obj[name];
      fail(F.g, n, show(obj) + ' has no member ' + name);
    }

    /** a term: a literal, a name, a member path, `#e4` or `#e7.Hp`, or the converter's read of an island's output */
    const ISLAND_OUT = /^default \/\* (\S+?)\.(.+?): an output of the island above, no code form \*\/$/;
    function term(F, txt, n) {
      if (txt === 'true') return true;
      if (txt === 'false') return false;
      if (txt === 'null') return null;
      if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?[fFdD]?$/.test(txt)) return parseFloat(txt);
      if (/^"/.test(txt)) return JSON.parse(txt);
      const io = ISLAND_OUT.exec(txt);
      if (io) {
        const o = F.islands[io[1]];
        if (!o || !has(o, io[2])) fail(F.g, n, 'reads ' + io[1] + '.' + io[2] + ', an output of an island the engine is not running for it here');
        return o[io[2]];
      }
      return evalTree(F, parseFragment(txt, F.g.name + (n ? '#' + n.id : '')), n);
    }
    /** a field's value: a reference (a wire from another node), a term, a ~"fragment" */
    function value(F, v, n) {
      if (v === undefined) fail(F.g, n, 'a field it needs is missing');
      if (v.ref) return evalNode(F, v.ref);
      if (v.none) return undefined;
      if (v.str !== undefined) return JSON.parse(v.str);
      return term(F, v.term, n);
    }

    function evalTree(F, e, n) {
      if ('lit' in e) return e.lit;
      if (e.ref) return evalNode(F, e.ref);
      if (e.name) return lookup(F, e.name, n);
      if (e.member) return member(evalTree(F, e.of, n), e.member, F, n);
      if (e.call) {
        const args = e.args.map((a) => evalTree(F, a, n));
        if (e.call.member) return invoke(F, n, evalTree(F, e.call.of, n), e.call.member, args);
        return invoke(F, n, F.self, e.call.name, args);
      }
      if (e.neu) return construct(F, n, e.neu, e.args ? e.args.map((a) => evalTree(F, a, n)) : [], e.init);
      if (e.init) fail(F.g, n, 'an initializer with no type to build');
      if (e.unary) { const a = evalTree(F, e.a, n); if (e.unary === '-') return isVec(a) ? vec(-a.X, -a.Y, -a.Z) : -a; if (e.unary === '!') return !a; return +a; }
      if (e.is) { const a = evalTree(F, e.a, n); const ok = isA(a, e.is); if (ok && e.bind) F.locals[e.bind] = a; return ok; }
      if (e.op) return binary(e.op, evalTree(F, e.a, n), evalTree(F, e.b, n), F.g.name + (n ? '#' + n.id : ''));
      if (e.index) { const o = evalTree(F, e.of, n); return o[evalTree(F, e.index, n)]; }
      fail(F.g, n, 'cannot evaluate ' + JSON.stringify(e));
    }
    const TYPES = { Vector: [Vector, ['X', 'Y', 'Z']], Rotator: [Rotator, ['Pitch', 'Yaw', 'Roll']], Transform: [Transform, ['Location', 'Rotation', 'Scale']],
      LinearColor: [LinearColor, ['R', 'G', 'B', 'A']] };
    function construct(F, n, type, args, init) {
      const T = TYPES[type];
      if (!T) fail(F.g, n, 'constructs a ' + type + ', a type this runtime does not build');
      const o = new T[0](...args);
      for (const [k, ex] of init || []) { if (!T[1].includes(k)) fail(F.g, n, 'a ' + type + ' has no ' + k); o[k] = evalTree(F, ex, n); }
      return o;
    }
    /** a type test: the actor's own class, or one its engine says it is (a parent) */
    function isA(a, type) { return !!a && typeof a === 'object' && (a.cls === type || (typeof a.isA === 'function' && a.isA(type))); }

    /** a call: a static library's function, an event or function of the Blueprint's own (another graph), or the engine's own on an
     *  actor, a component or a widget */
    function invoke(F, n, on, method, args) {
      if (on && on.__static) {
        const f = on[method];
        if (typeof f !== 'function') fail(F.g, n, on.__static + '.' + method + ' is not provided by this runtime or its engine');
        return f.apply(on, args);
      }
      if (on && typeof on === 'object' && on.cls) {
        const own = events.get(on.cls) && events.get(on.cls).get(method);
        if (own) return run(own, on, paramsOf(own, args));
      }
      if (on && typeof on[method] === 'function') return on[method].apply(on, args);
      fail(F.g, n, 'calls ' + method + ' on ' + show(on) + ', which defines no such function');
    }
    function paramsOf(g, args) {
      const p = {};
      NGL.listOf(g.attrs.params).map(NGL.termText).map((x) => x.split(':')[0]).forEach((name, i) => { p[name] = args[i]; });
      return p;
    }

    function evalNode(F, id) {
      const n = F.g.nodes.get(id);
      if (!n) fail(F.g, null, 'refers to ' + id + ', which it does not define');
      const a = n.attrs;
      let out;
      switch (n.kw) {
        case 'operator':
          if (a.b === undefined) {
            const x = value(F, a.a, n), op = a.op.term;
            out = op === '-' ? (isVec(x) ? vec(-x.X, -x.Y, -x.Z) : -x) : op === '!' ? !x : fail(F.g, n, 'unary ' + op);
          } else out = binary(a.op.term, value(F, a.a, n), value(F, a.b, n), F.g.name + '#' + id);
          break;
        case 'pure-call': out = callNode(F, n); break;
        case 'type-test': { const x = value(F, a.a, n); const p = parsePattern(NGL.termText(a.pat || a.to)); out = isA(x, p.type); if (out && p.bind) F.locals[p.bind] = x; break; }
        case 'construct': {
          const type = a.type ? NGL.termText(a.type) : null;
          const init = a.init ? parseFragment(NGL.termText(a.init), F.g.name + '#' + id) : null;
          out = construct(F, n, type, NGL.listOf(a.args).map((x) => value(F, x, n)), init ? init.init : []);
          break;
        }
        default: fail(F.g, n, 'an expression of kind "' + n.kw + '", which this runtime does not run');
      }
      onNode(F.g.name, id, out);
      return out;
    }
    function callNode(F, n) {
      const a = n.attrs;
      const method = NGL.termText(a.method);
      const mods = NGL.listOf(a.argmods).map((x) => (x.none ? '-' : NGL.termText(x)));
      const args = NGL.listOf(a.args).map((x, i) => (mods[i] === 'out' ? undefined : value(F, x, n)));
      const on = a.on ? (a.on.ref ? evalNode(F, a.on.ref) : term(F, NGL.termText(a.on), n)) : a.callee ? value(F, a.callee, n) : F.self;
      return invoke(F, n, on, method, args);
    }
    const ids = (v) => NGL.listOf(v).map(NGL.idOf);

    /** the statements of a body, in order, as a generator: a latent step (await) yields its seconds and the body resumes there, with
     *  every branch and switch around it, when the time has come */
    function* runList(F, list) {
      for (let k = 0; k < list.length; k++) {
        if (F.returned || F.broken) return;
        const n = F.g.nodes.get(list[k]);
        if (!n) fail(F.g, null, 'its body names ' + list[k] + ', which it does not define');
        const a = n.attrs;
        if (n.kw === 'block') continue;          // a block runs when its island fires it, never in its place in the list
        onNode(F.g.name, n.id, undefined);
        switch (n.kw) {
          case 'call': callNode(F, n); break;
          case 'set': {
            const v = value(F, a.value, n), op = a.op ? a.op.term : '=';
            assign(F, n, NGL.termText(a.target), op === '=' ? v : binary(op[0], term(F, NGL.termText(a.target), n), v, F.g.name + '#' + n.id));
            break;
          }
          case 'set-local': {
            const vars = NGL.listOf(a.vars).map(NGL.termText), vals = NGL.listOf(a.values);
            vars.forEach((name, i) => { F.locals[name] = vals[i] && !vals[i].none ? value(F, vals[i], n) : undefined; });
            break;
          }
          case 'branch': {
            const c = value(F, a.cond, n);
            if (typeof c !== 'boolean') fail(F.g, n, 'branches on ' + show(c) + ', not a bool');
            const body = c ? a.then : a.else;
            if (body) yield* runList(F, ids(body));
            break;
          }
          case 'switch': {
            // the first section whose `case` equals the value, else its `default`; a section-break ends the section
            const on = value(F, a.on, n);
            let hit = null, dflt = null;
            for (const s of ids(a.sections).map((x) => F.g.nodes.get(x))) {
              const labels = NGL.listOf(s.attrs.labels).map(NGL.termText);
              for (let i = 0; i < labels.length; i++) {
                if (labels[i] === 'default') dflt = dflt || s;
                else if (labels[i] === 'case') { if (!hit && binary('==', on, term(F, labels[i + 1], s), F.g.name + '#' + s.id)) hit = s; i++; }
                else fail(F.g, s, 'a section label "' + labels[i] + '" this runtime does not read');
              }
            }
            const s = hit || dflt;
            if (s) { yield* runList(F, ids(s.attrs.body)); F.broken = false; }
            break;
          }
          case 'section-break': F.broken = true; return;
          case 'return': F.result = a.value ? value(F, a.value, n) : undefined; F.returned = true; return;
          case 'await': {
            const w = value(F, a.a, n);
            if (!(w && typeof w === 'object' && w.latent >= 0)) fail(F.g, n, 'waits on ' + show(w) + ', which is no latent action');
            yield w.latent;
            break;
          }
          case 'island': {
            const text = NGL.termText(a.text);
            if (/^\/\* \S+ -> .+: runs when the node fires this output \*\/$/.test(text)) break;    // a block's own label
            // a node with no code form (a Timeline): its engine runs it, and fires the blocks after it here, each in a frame of its own
            const m = /^\/\* Blueprint (\S+) "([^"]+)"/.exec(text);
            if (!m || !F.self || typeof F.self.island !== 'function') fail(F.g, n, 'reaches a node with no code form (' + (m ? m[1] + ' ' + m[2] : text.slice(0, 80)) + '), which its engine does not run');
            const outs = {};
            for (let j = k + 1; j < list.length; j++) {
              const b = F.g.nodes.get(list[j]);
              if (!b || b.kw !== 'block') break;
              const body = ids(b.attrs.body);
              outs[NGL.termText(b.attrs.on)] = (values) => {
                onNode(F.g.name, b.id, undefined);
                const Fb = frame(F.g, F.self, F.locals, Object.assign({}, F.islands, { [m[2]]: values || {} }));
                drive(runList(Fb, body), Fb);
              };
            }
            F.self.island(m[1], m[2], outs);
            break;
          }
          default: fail(F.g, n, 'a statement of kind "' + n.kw + '", which this runtime does not run');
        }
      }
    }
    function assign(F, n, target, v) {
      const path = target.split('.');
      if (path.length === 1) {
        if (has(F.locals, target)) { F.locals[target] = v; return; }
        if (F.self && F.self.vars && has(F.self.vars, target)) { F.self.vars[target] = v; return; }
        fail(F.g, n, 'sets "' + target + '", a variable its actor (' + (F.self ? F.self.cls : 'none') + ') does not declare');
      }
      const obj = term(F, path.slice(0, -1).join('.'), n), key = path[path.length - 1];
      if (isVec(obj)) { obj[key] = v; return; }
      if (obj && obj.vars && has(obj.vars, key)) { obj.vars[key] = v; return; }
      fail(F.g, n, 'sets ' + target + ', which ' + show(obj) + ' does not declare');
    }

    /** a body runs until it ends or waits; a wait comes back here when its time has come - unless its actor is gone (the engine
     *  drops an object's latent actions when it is destroyed) */
    function drive(it, F) { const r = it.next(); if (!r.done) waiting.push({ at: now + r.value, it: it, self: F.self }); }
    /** run a graph on an actor with its parameters: its body, then its result */
    function run(g, self, params) {
      counts.set(g.name, (counts.get(g.name) || 0) + 1);
      onNode(g.name, 'entry', undefined);
      const F = frame(g, self, params);
      drive(runList(F, g.attrs.body ? ids(g.attrs.body) : g.attrs.arrow ? [NGL.termText(g.attrs.arrow)] : []), F);
      return F.result;
    }

    return {
      Vector: Vector, Rotator: Rotator, Transform: Transform, classRef: classRef,
      /** fire an actor's event by its key (see eventKey), as its own class or as `asClass` (a graph its engine says it holds under
       *  an earlier name); false when that Blueprint has no such event */
      fire(self, key, params, asClass) {
        const bp = events.get(asClass || self.cls), g = bp && bp.get(key);
        if (!g) return false;
        run(g, self, params);
        return true;
      },
      has(cls, key) { return !!(events.get(cls) && events.get(cls).get(key)); },
      events(cls) { return events.get(cls) ? [...events.get(cls).keys()] : []; },
      /** time passes: the waits whose time has come resume (a wait made while resuming waits for the next frame), then the timers */
      advance(dt) {
        now += dt;
        const due = waiting.filter((w) => w.at <= now);
        for (const w of due) { waiting.splice(waiting.indexOf(w), 1); if (!(w.self && w.self.destroyed)) drive(w.it, { self: w.self }); }
        for (const t of timers) {
          while (!t.dead && t.at <= now) {
            if (t.d.self.destroyed) { t.dead = true; break; }
            run(events.get(t.d.self.cls).get(t.d.key), t.d.self, {});
            if (t.every > 0) t.at += t.every; else t.dead = true;
          }
        }
        for (let k = timers.length - 1; k >= 0; k--) if (timers[k].dead) timers.splice(k, 1);
      },
      counts: counts,
      graph: (name) => byName.get(name),
      now: () => now,
    };
  }

  /** a seeded generator (mulberry32), so a world replays the same serves */
  function seeded(seed) {
    let a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  const api = { machine, seeded, Vector, Rotator, Transform, LinearColor, vec, size, vRandCone, rotateAngleAxis, rotateVector, parseFragment };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BPRUN = api;
})(typeof window !== 'undefined' ? window : globalThis);
