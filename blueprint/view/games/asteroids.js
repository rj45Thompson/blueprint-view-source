// games/asteroids.js - the ENGINE under siljaZ's asteroid shooter (samples/online/asteroids): two levels, the actors, the tick, the
// overlaps, the Timeline, the widgets, the input and the picture. The 16 pastes are the game's LOGIC: the ship turning on its axis,
// the shot and its flight, the asteroids and the enemy ships spawned, aimed, moved, grown and hit, the score, the lives and the
// flashing, the title screen and the game over. They carry none of what is below: every number is AUTHORED in LEVEL and listed on
// the page as authored, and each place the engine stands in for a missing piece of the game says so. What the actors DO is the
// converted Blueprint, run by view/run.js - this file never scores, never kills a ship, never takes a life (tools/test_real.py plants
// a ship hit without its K2_DestroyActor and the ships live on).
(function (root) {
  'use strict';
  const RUN = root.BPRUN || require('../run.js');

  /** AUTHORED here, every one: the pastes carry none of it */
  const LEVEL = {
    field: 300,                                           // the screen's half size, units; the middle is where everything spawns
    ring: 238,                                            // BP_Character's Sprite stands this far from the middle, on its turning arm
    muzzle: 214,                                          // its ProjectileSpawn, a little nearer the middle
    rotationSpeed: 3.2,                                   // BP_Controller's RotationSpeed: degrees per frame of full axis
    flash: 0.11,                                          // BP_Character's FlashInterval, s
    asteroid: { speed: 95, r: 17 },                       // BP_Asteorid's Speed and its Sphere's radius at scale 1
    ship: { delayUntilShooting: 1.2, score: 150, r: 15 }, // BP_EnemyShip's DelayUntilShooting and HitEnemyShipScore; its HitboxEnemy
    bullet: { speed: 150, r: 5 },                         // BP_EnemyProjectile's Speed and Sphere
    shot: { timeline: 0.55, r: 6 },                       // BP_Projectile's Timeline: its length (a straight 0 to 1) and the shot's radius
    player: { r: 14 },                                    // where an asteroid or a bullet touches the player: the ship's Sprite
    waves: { ships: 5, every: 6.5, first: 2.5 },          // a wave of ships on one path; the 0.5 s between ships is the copied timer's own
    explosion: 0.7,                                       // BP_Explosion is spawned by the pastes and carried by none: a burst, s
    computer: { aim: 7, rate: 0.18, idle: 4 },            // the computer player: aims within 7 degrees, fires every 0.18 s, takes over after 4 s idle
  };
  /** the class names the graphs name as values (SpawnActor(BP_Asteorid, ...), GetObjectClass(OtherActor) == BP_Character) */
  const CLASSES = ['BP_Character', 'BP_Controller', 'BP_EnemyLogic', 'BP_Asteorid', 'BP_Meteor', 'BP_EnemyShip', 'BP_EnemyProjectile', 'BP_Projectile', 'BP_Explosion', 'BP_Score'];
  // four paths out of the middle (EnemyWaveSpawning names Spline1..Spline4 and the level held their shapes): spirals, authored
  const PATHS = [1, -1, 1, -1].map((turn, k) => {
    const pts = [];
    for (let i = 0; i <= 64; i++) { const u = i / 64, a = (k * 90 + 30) * Math.PI / 180 + turn * u * 3.4, r = 6 + u * 330; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
    return pts;
  });

  function create(opts) {
    const L = LEVEL, rand = RUN.seeded(opts.seed || 7), crand = RUN.seeded((opts.seed || 7) * 31 + 1);
    const vec = RUN.vec, R = (p, y, r) => new RUN.Rotator(p, y, r);
    const state = { t: 0, level: null, widget: null, view: null, fx: [], stars: [], timelines: [], waves: { next: L.waves.first, left: 0, gap: 0, path: 0 },
      count: { asteroids: 0, ships: 0, shots: 0, bullets: 0, shipsKilled: 0, asteroidsShot: 0, livesLost: 0, gameOvers: 0, starts: 0 }, idle: 0, cooldown: 0, prints: [] };
    for (let i = 0; i < 160; i++) state.stars.push([crand() * 2 - 1, crand() * 2 - 1, crand()]);
    let actors = [], pending = null, M = null;
    const world = (owner, off) => { const w = RUN.rotateVector(owner.rot, off); return vec(owner.pos.X + w.X, owner.pos.Y + w.Y, owner.pos.Z + w.Z); };
    const char = () => actors.find((a) => a.cls === 'BP_Character' && !a.destroyed);
    const ctrl = () => actors.find((a) => a.cls === 'BP_Controller' && !a.destroyed);

    /** an actor and the engine's side of it (Actor.h: K2_GetActorLocation and the rest; Pawn/Controller and widgets below) */
    function actor(cls, x, y, extra) {
      const a = Object.assign({ cls: cls, pos: vec(x, y, 0), rot: R(0, 0, 0), scale: 1, vars: {}, comps: {}, destroyed: false, born: state.t }, extra || {});
      a.K2_GetActorLocation = () => vec(a.pos.X, a.pos.Y, a.pos.Z);
      a.K2_SetActorLocation = (NewLocation) => { a.pos = vec(NewLocation.X, NewLocation.Y, NewLocation.Z); return true; };
      a.K2_SetActorLocationAndRotation = (NewLocation, NewRotation) => { a.pos = vec(NewLocation.X, NewLocation.Y, NewLocation.Z); a.rot = R(NewRotation.Pitch, NewRotation.Yaw, NewRotation.Roll); return true; };
      a.K2_GetActorRotation = () => R(a.rot.Pitch, a.rot.Yaw, a.rot.Roll);
      a.K2_SetActorRotation = (NewRotation) => { a.rot = R(NewRotation.Pitch, NewRotation.Yaw, NewRotation.Roll); return true; };
      a.SetActorScale3D = (s) => { a.scale = s.X; };
      a.K2_DestroyActor = () => { a.destroyed = true; };
      // the SpawnActor node: the world makes the class, places it, and its BeginPlay runs
      a.SpawnActor = (cls2, T) => spawn(cls2.__class, T);
      a.CreateWidget = (cls2) => widget(cls2.__class);
      actors.push(a);
      return a;
    }
    /** a scene component on an actor at an offset (a Sprite, ProjectileSpawn, a shot's RenderComponent that moves on its own) */
    function comp(owner, off, extra) {
      const c = Object.assign({ owner: owner, off: off, at: null, visible: true }, extra || {});
      c.K2_GetComponentLocation = () => c.at || world(owner, c.off);
      c.K2_GetComponentToWorld = () => new RUN.Transform(c.K2_GetComponentLocation(), owner.rot, vec(1, 1, 1));
      c.K2_SetWorldLocation = (NewLocation) => { c.at = vec(NewLocation.X, NewLocation.Y, NewLocation.Z); return true; };
      c.SetVisibility = (bNewVisibility) => { c.visible = !!bNewVisibility; };
      return c;
    }
    /** BP_Score, the score widget: the pastes create it, show it, hide its life icons and hand it the score's text, and carry none of
     *  it - here it shows the text it is handed and the icons it is told to (UpdateScore's body is the widget's own, not pasted) */
    function widget(cls) {
      const img = () => ({ visible: true, SetVisibility(v) { this.visible = !/Hidden|Collapsed/.test(String(v)); } });
      return { cls: cls, text: '0', shown: false, Life1: img(), Life2: img(), Life3: img(), AddToViewport() { this.shown = true; state.widget = this; }, UpdateScore(t) { this.text = String(t); } };
    }
    function spawn(cls, T) {
      const p = T && T.Location ? T.Location : vec(0, 0, 0), s = T && T.Scale ? T.Scale.X : 1;
      let a;
      if (cls === 'BP_Asteorid') {
        a = actor(cls, p.X, p.Y, { vars: { AimVector: vec(0, 0, 0), Speed: L.asteroid.speed }, shape: rock() });
        a.comps.Sphere = comp(a, vec(0, 0, 0));
        state.count.asteroids++;
        // BP_Asteorid is BP_Meteor renamed (its overlap event is still BndEvt__BP_Meteor_Sphere_...): its BeginPlay is the one pasted under
        // the old name, and its Tick and overlap the later pastes (SOURCES.json)
        M.fire(a, 'ReceiveBeginPlay', {}, 'BP_Meteor');
      } else if (cls === 'BP_EnemyShip') {
        a = actor(cls, p.X, p.Y, { scale: s, vars: { Speed: 0, Distance: 0, Spline: spline(PATHS[state.waves.path % PATHS.length]), DelayUntilShooting: L.ship.delayUntilShooting, HitEnemyShipScore: L.ship.score } });
        a.comps.HitboxEnemy = comp(a, vec(0, 0, 0));
        state.count.ships++;
        M.fire(a, 'ReceiveBeginPlay', {});
      } else if (cls === 'BP_EnemyProjectile') {
        a = actor(cls, p.X, p.Y, { vars: { Aim_Vector: vec(0, 0, 0), Speed: L.bullet.speed } });
        a.comps.Sphere = comp(a, vec(0, 0, 0));
        state.count.bullets++;
        M.fire(a, 'ReceiveBeginPlay', {});
      } else if (cls === 'BP_Projectile') {
        a = actor(cls, p.X, p.Y, {});
        a.comps.RenderComponent = comp(a, vec(0, 0, 0));
        // its Timeline: the island the converter could not write; the engine plays it and fires the paste's Update and Finished
        a.island = (kind, name, outs) => {
          if (kind !== 'K2Node_Timeline') throw new Error('BP_Projectile reaches ' + kind + ' ' + name + ', which this engine does not run');
          state.timelines.push({ a: a, t: 0, len: L.shot.timeline, outs: outs, name: name });
        };
        state.count.shots++;
        M.fire(a, 'ReceiveBeginPlay', {});
      } else if (cls === 'BP_Explosion') {
        a = actor(cls, p.X, p.Y, {});
        fx('boom', p.X, p.Y);
      } else throw new Error('SpawnActor(' + cls + '): a class this engine does not make');
      return a;
    }
    /** a path an enemy ship flies (USplineComponent's functions, on an authored polyline) */
    function spline(pts) {
      const lens = [0];
      for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const at = (d) => { d = Math.max(0, Math.min(d, lens[lens.length - 1])); let i = 1; while (i < lens.length - 1 && lens[i] < d) i++; const u = (d - lens[i - 1]) / (lens[i] - lens[i - 1] || 1); return [i, u]; };
      return {
        GetSplineLength: () => lens[lens.length - 1],
        GetLocationAtDistanceAlongSpline: (Distance) => { const [i, u] = at(Distance); return vec(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u, 0); },
        GetRotationAtDistanceAlongSpline: (Distance) => { const [i] = at(Distance); return R(0, Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) * 180 / Math.PI, 0); },
      };
    }
    function rock() { const n = 8 + Math.floor(crand() * 4), pts = []; for (let i = 0; i < n; i++) pts.push([i / n * Math.PI * 2, 0.72 + crand() * 0.38]); return { pts: pts, spin: (crand() * 2 - 1) * 1.4 }; }
    function fx(kind, x, y) { state.fx.push({ kind: kind, x: x, y: y, t: state.t, parts: Array.from({ length: kind === 'boom' ? 18 : 8 }, () => [crand() * Math.PI * 2, 30 + crand() * 90]) }); }

    /** a level opens: the world is emptied, its actors are made, and every BeginPlay runs (OpenLevelBySoftObjectPtr) */
    function load(name) {
      for (const a of actors) a.destroyed = true;
      actors = []; state.timelines = []; state.widget = null; state.view = null;
      M = RUN.machine({ graphs: opts.graphs, rand: rand, classes: CLASSES, onNode: opts.onNode, onPrint: (s) => state.prints.push(s),
        statics: { GameplayStatics: {
          GetPlayerCharacter: () => char() || null, GetPlayerController: () => ctrl() || null,
          OpenLevelBySoftObjectPtr: (Level) => { pending = String(Level).split('.').pop(); },
        } } });
      state.level = name;
      const c = actor('BP_Character', 0, 0, { vars: { Lives: 3, FlashInterval: L.flash, b_IsTitleScreen: false, DoOnce_0_Started: false, DoOnce_0_Closed: false } });
      c.comps.Sprite = comp(c, vec(L.ring, 0, 0));
      c.comps.ProjectileSpawn = comp(c, vec(L.muzzle, 0, 0));
      const pc = actor('BP_Controller', 0, 0, { vars: { Score: 0, ScoreWidget: null, RotationSpeed: L.rotationSpeed } });
      // the controller's yaw is the character's (a character using its controller's rotation, as the paste's turning reads it back)
      pc.SetControlRotation = (r) => { c.rot = R(r.Pitch, r.Yaw, r.Roll); };
      pc.SetViewTargetWithBlend = (target) => { state.view = target; };
      // DestroyUI is a BP_Controller function the pastes do not include: here it takes the score widget off the screen
      pc.DestroyUI = () => { state.widget = null; };
      if (name === 'TitleScreen') {
        const ls = actor('TitleScreen', 0, 0, { vars: { CameraActor_1: { cls: 'CameraActor', name: 'the title camera' } } });
        for (const a of [c, pc, ls]) M.fire(a, 'ReceiveBeginPlay', {});
      } else {
        const sp = actor('BP_EnemyLogic', 0, 0, {});
        for (const a of [c, pc, sp]) M.fire(a, 'ReceiveBeginPlay', {});
        state.waves = { next: state.t + L.waves.first, left: 0, gap: 0, path: 0 };
        state.count.starts++;
      }
    }
    load('TitleScreen');

    /** begin-overlaps between what the pastes listen on: an asteroid's Sphere, a ship's HitboxEnemy, a bullet's Sphere */
    const touching = new Set();
    function overlaps() {
      const c = char(), shots = actors.filter((a) => a.cls === 'BP_Projectile' && !a.destroyed);
      const pairs = [];
      const near = (p, q, r) => (p.X - q.X) ** 2 + (p.Y - q.Y) ** 2 < r * r;
      const ship = c && c.comps.Sprite.K2_GetComponentLocation();
      for (const a of actors) {
        if (a.destroyed) continue;
        if (a.cls === 'BP_Asteorid') {
          const r = L.asteroid.r * a.scale;
          if (c && c.comps.Sprite.visible && near(a.pos, ship, r + L.player.r)) pairs.push([a, 'Overlap Sphere', c]);
          for (const s of shots) if (near(a.pos, s.comps.RenderComponent.K2_GetComponentLocation(), r + L.shot.r)) pairs.push([a, 'Overlap Sphere', s]);
        } else if (a.cls === 'BP_EnemyShip') {
          for (const s of shots) if (near(a.pos, s.comps.RenderComponent.K2_GetComponentLocation(), L.ship.r * a.scale / 0.3 + L.shot.r)) pairs.push([a, 'Overlap HitboxEnemy', s]);
        } else if (a.cls === 'BP_EnemyProjectile') {
          if (c && c.comps.Sprite.visible && near(a.pos, ship, L.bullet.r + L.player.r)) pairs.push([a, 'Overlap Sphere', c]);
        }
      }
      const now = new Set();
      for (const [a, key, o] of pairs) {
        const id = actors.indexOf(a) + '|' + actors.indexOf(o);
        now.add(id);
        if (touching.has(id) || a.destroyed || o.destroyed) continue;
        M.fire(a, key, { OverlappedComponent: null, OtherActor: o, OtherComp: null, OtherBodyIndex: 0, bFromSweep: false, SweepResult: null });
        if (o.cls === 'BP_Projectile' && o.destroyed) { fx(a.destroyed ? 'kill' : 'hit', a.pos.X, a.pos.Y); if (a.cls === 'BP_Asteorid') state.count.asteroidsShot++; if (a.destroyed) state.count.shipsKilled++; }
      }
      touching.clear();
      for (const id of now) touching.add(id);
    }

    /** the computer at the controls when nobody is (ours): start from the title, turn toward the nearest thing coming, fire when lined up */
    function computer() {
      const c = char();
      if (!c) return { axis: 0, fire: false };
      if (c.vars.b_IsTitleScreen) return { axis: 0, fire: state.t % 3 < 0.02 };
      const yaw = ((c.rot.Yaw % 360) + 360) % 360;
      let best = null;
      for (const a of actors) {
        if (a.destroyed || !/BP_Asteorid|BP_EnemyShip/.test(a.cls)) continue;
        const ang = (Math.atan2(a.pos.Y, a.pos.X) * 180 / Math.PI + 360) % 360, d = Math.hypot(a.pos.X, a.pos.Y);
        let dy = ang - yaw; if (dy > 180) dy -= 360; if (dy < -180) dy += 360;
        const score = Math.abs(dy) + (a.cls === 'BP_EnemyShip' ? -25 : 0) - d * 0.05;
        if (!best || score < best.score) best = { dy: dy, score: score };
      }
      if (!best) return { axis: 0, fire: false };
      return { axis: Math.abs(best.dy) < 2 ? 0 : Math.max(-1, Math.min(1, best.dy / 15)), fire: Math.abs(best.dy) < L.computer.aim };
    }

    return {
      level: LEVEL, state: state, get machine() { return M; }, actors: () => actors.filter((a) => !a.destroyed),
      /** one frame as UE runs it: input (the axis every frame, the action when pressed), every actor's Tick, the Timelines, the
       *  overlaps, the latent steps and timers, then the waves, and a level opened this frame opens at its end */
      step(dt, input) {
        state.t += dt;
        const keys = input || new Set(), pressed = (input && input.pressed) || new Set();
        const mine = ['a', 'd', 'arrowleft', 'arrowright'].some((k) => keys.has(k)) || pressed.size || (input && input.touch);
        state.idle = mine ? 0 : state.idle + dt;
        const auto = state.idle > L.computer.idle ? computer() : null;
        let axis = ((keys.has('d') || keys.has('arrowright')) ? 1 : 0) - ((keys.has('a') || keys.has('arrowleft')) ? 1 : 0);
        // a key press fires once, at once; a held finger (and the computer) fire at the computer's rate
        const tap = pressed.has(' ') || pressed.has('enter');
        let held = false;
        if (input && input.touch) { const c = char(); if (c) { const ang = Math.atan2(input.touch.y, input.touch.x) * 180 / Math.PI; let dy = ang - c.rot.Yaw; dy = ((dy % 360) + 540) % 360 - 180; axis = Math.max(-1, Math.min(1, dy / 15)); held = !!input.touch.fire; } }
        if (auto) { axis = auto.axis; held = auto.fire; }
        state.cooldown -= dt;
        const pc = ctrl(), c = char();
        if (pc) M.fire(pc, 'InputAxis Move Right / Left', { AxisValue: axis });
        if (c && (tap || (held && state.cooldown <= 0))) { M.fire(c, 'InputAction Shoot', { Key: 'SpaceBar' }); state.cooldown = L.computer.rate; }
        for (const a of actors.slice()) if (!a.destroyed) M.fire(a, 'ReceiveTick', { DeltaSeconds: dt });
        for (const tl of state.timelines.slice()) {
          if (tl.a.destroyed) { state.timelines.splice(state.timelines.indexOf(tl), 1); continue; }
          tl.t = Math.min(tl.len, tl.t + dt);
          tl.outs.Update({ NewTrack_0: tl.t / tl.len });
          if (tl.t >= tl.len) { state.timelines.splice(state.timelines.indexOf(tl), 1); if (tl.outs.Finished) tl.outs.Finished({}); }
        }
        overlaps();
        M.advance(dt);
        // the waves: EnemyWaveSpawning and its macro hold them, and the converter does not inline a macro of the author's own - here a
        // wave is a few ships 0.5 s apart (the copied ship timer's own Time) on the next path, the ship itself the paste's CustomEvent_1
        if (state.level === 'Level1') {
          const sp = actors.find((a) => a.cls === 'BP_EnemyLogic' && !a.destroyed), W = state.waves;
          if (W.left === 0 && state.t >= W.next) { W.left = L.waves.ships; W.gap = 0; }
          if (W.left > 0 && (W.gap -= dt) <= 0 && sp) { M.fire(sp, 'CustomEvent_1', {}); W.left--; W.gap = 0.5; if (W.left === 0) { W.next = state.t + L.waves.every; W.path++; } }
        }
        // a thing far off the screen is gone (the pastes never destroy an asteroid or a bullet that misses)
        for (const a of actors) if (!a.destroyed && /BP_Asteorid|BP_EnemyProjectile/.test(a.cls) && Math.hypot(a.pos.X, a.pos.Y) > L.field * 1.6) a.destroyed = true;
        actors = actors.filter((a) => !a.destroyed || a.cls === 'BP_Explosion' && state.t - a.born < L.explosion);
        state.fx = state.fx.filter((f) => state.t - f.t < L.explosion);
        const lives = c ? c.vars.Lives : null;
        if (lives !== null && state.lastLives !== undefined && lives < state.lastLives) state.count.livesLost++;
        state.lastLives = lives;
        if (pending) { if (pending === 'TitleScreen') state.count.gameOvers++; const p = pending; pending = null; load(p); state.lastLives = undefined; }
      },
      draw(ctx, w, h) { draw(ctx, w, h, this); },
      who() { return state.idle > L.computer.idle ? 'the computer is playing - press a key to take over' : 'you are playing'; },
    };
  }

  // ---------------------------------------------------------------- the picture: a neon tube, the city's night
  function draw(ctx, w, h, G) {
    const S = G.state, L = LEVEL, sc = Math.min(w, h) / (2 * L.field) * 0.94, cx = w / 2, cy = h / 2 + 6;
    G.view = { sc: sc, cx: cx, cy: cy };
    const X = (x) => cx + x * sc, Y = (y) => cy + y * sc;
    const glow = (col, b) => { ctx.shadowColor = col; ctx.shadowBlur = b; };
    ctx.save();
    ctx.fillStyle = '#03050c'; ctx.fillRect(0, 0, w, h);
    // stars rushing out of the middle, and the tube's rings
    for (const [sx, sy, z] of S.stars) { const k = ((z + S.t * 0.12) % 1); const r = k * k; ctx.fillStyle = 'rgba(200,220,255,' + (0.15 + 0.6 * r) + ')'; ctx.fillRect(X(sx * L.field * r * 1.2), Y(sy * L.field * r * 1.2), 1 + r * 1.5, 1 + r * 1.5); }
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) { const k = ((i / 7 + S.t * 0.08) % 1), r = 8 + k * k * L.field * 1.3; ctx.strokeStyle = 'rgba(90,169,255,' + (0.03 + 0.1 * k) + ')'; ctx.beginPath(); ctx.arc(cx, cy, r * sc, 0, Math.PI * 2); ctx.stroke(); }
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2 + S.t * 0.05; ctx.strokeStyle = 'rgba(90,169,255,0.05)'; ctx.beginPath(); ctx.moveTo(X(Math.cos(a) * 10), Y(Math.sin(a) * 10)); ctx.lineTo(X(Math.cos(a) * L.field * 1.3), Y(Math.sin(a) * L.field * 1.3)); ctx.stroke(); }
    // the ring the ship turns on, and the middle everything comes out of
    ctx.strokeStyle = 'rgba(127,227,255,0.12)'; ctx.setLineDash([4, 8]); ctx.beginPath(); ctx.arc(cx, cy, L.ring * sc, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    glow('#b388ff', 24); ctx.fillStyle = 'rgba(179,136,255,0.55)'; ctx.beginPath(); ctx.arc(cx, cy, (5 + Math.sin(S.t * 3) * 1.5) * sc * 1.6, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    const label = (txt, x, y, col) => { ctx.shadowBlur = 0; ctx.fillStyle = col; ctx.font = '600 9px "JetBrains Mono", Consolas, monospace'; ctx.textAlign = 'center'; ctx.fillText(txt, x, y); };
    const labelled = new Set();
    for (const a of G.actors()) {
      const x = X(a.pos.X), y = Y(a.pos.Y);
      if (a.cls === 'BP_Asteorid') {
        const r = L.asteroid.r * a.scale * sc, sp = a.shape.spin * S.t;
        glow('#ffb347', 14); ctx.strokeStyle = '#ffcf87'; ctx.fillStyle = 'rgba(70,40,10,0.55)'; ctx.lineWidth = 1.6;
        ctx.beginPath(); a.shape.pts.forEach(([ang, k], i) => { const px = x + Math.cos(ang + sp) * r * k, py = y + Math.sin(ang + sp) * r * k; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.closePath(); ctx.fill(); ctx.stroke();
        if (!labelled.has(a.cls)) { labelled.add(a.cls); label('BP_Asteorid', x, y - r - 6, 'rgba(255,207,135,0.6)'); }
      } else if (a.cls === 'BP_EnemyShip') {
        const s = L.ship.r * a.scale / 0.3 * sc, yaw = a.rot.Yaw * Math.PI / 180;
        glow('#ff4dd2', 16); ctx.strokeStyle = '#ff8be4'; ctx.lineWidth = 1.8; ctx.fillStyle = 'rgba(80,10,60,0.6)';
        ctx.beginPath(); for (const [px, py] of [[1.1, 0], [-0.8, 0.8], [-0.4, 0], [-0.8, -0.8]]) ctx.lineTo(x + (px * Math.cos(yaw) - py * Math.sin(yaw)) * s, y + (px * Math.sin(yaw) + py * Math.cos(yaw)) * s); ctx.closePath(); ctx.fill(); ctx.stroke();
        if (!labelled.has(a.cls)) { labelled.add(a.cls); label('BP_EnemyShip', x, y - s - 6, 'rgba(255,139,228,0.6)'); }
      } else if (a.cls === 'BP_EnemyProjectile') {
        glow('#ff3b4e', 12); ctx.fillStyle = '#ff7a86'; ctx.beginPath(); ctx.arc(x, y, L.bullet.r * sc * 0.9, 0, Math.PI * 2); ctx.fill();
      } else if (a.cls === 'BP_Projectile') {
        const p = a.comps.RenderComponent.K2_GetComponentLocation(), px = X(p.X), py = Y(p.Y), d = Math.hypot(p.X, p.Y) || 1;
        glow('#7fe3ff', 14); ctx.strokeStyle = '#e6fbff'; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + p.X / d * 10 * sc, py + p.Y / d * 10 * sc); ctx.stroke();
      } else if (a.cls === 'BP_Character' && a.comps.Sprite.visible && !a.vars.b_IsTitleScreen) {
        const p = a.comps.Sprite.K2_GetComponentLocation(), px = X(p.X), py = Y(p.Y), ang = Math.atan2(-p.Y, -p.X), s = 15 * sc;
        glow('#21c7ff', 22); ctx.fillStyle = '#7fe3ff'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4;
        ctx.beginPath(); for (const [qx, qy] of [[1.2, 0], [-0.9, 0.85], [-0.45, 0], [-0.9, -0.85]]) ctx.lineTo(px + (qx * Math.cos(ang) - qy * Math.sin(ang)) * s, py + (qx * Math.sin(ang) + qy * Math.cos(ang)) * s); ctx.closePath(); ctx.fill(); ctx.stroke();
        label('BP_Character', px, py + s + 12, 'rgba(127,227,255,0.6)');
      }
    }
    // BP_Explosion: a burst (the pastes spawn it and none carries it)
    for (const f of S.fx) {
      const k = (S.t - f.t) / L.explosion, col = f.kind === 'hit' ? '255,207,135' : '255,120,200';
      glow('rgb(' + col + ')', 16);
      for (const [a, v] of f.parts) { ctx.fillStyle = 'rgba(' + col + ',' + (1 - k) + ')'; ctx.fillRect(X(f.x + Math.cos(a) * v * k), Y(f.y + Math.sin(a) * v * k), 2.5, 2.5); }
      ctx.strokeStyle = 'rgba(' + col + ',' + (0.8 - 0.8 * k) + ')'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(f.x), Y(f.y), (6 + 40 * k) * sc, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // the widget the pastes made: its score text and its three life icons, exactly as they were set
    const W = S.widget;
    if (W && W.shown) {
      ctx.textAlign = 'left'; ctx.fillStyle = '#e6ecf7'; ctx.font = '600 22px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.fillText(W.text, 14, 30);
      ctx.font = '9px "JetBrains Mono", Consolas, monospace'; ctx.fillStyle = 'rgba(147,164,191,0.85)'; ctx.fillText('BP_Score: UpdateScore, as the paste sets it', 14, 44);
      ['Life1', 'Life2', 'Life3'].forEach((k, i) => { if (!W[k].visible) return; const x = w - 22 - i * 22, y = 24; glow('#21c7ff', 10); ctx.fillStyle = '#7fe3ff'; ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 7, y + 7); ctx.lineTo(x, y + 3); ctx.lineTo(x - 7, y + 7); ctx.closePath(); ctx.fill(); });
      ctx.shadowBlur = 0;
    }
    if (S.level === 'TitleScreen') {
      ctx.textAlign = 'center'; glow('#ff4dd2', 18); ctx.fillStyle = '#ffffff'; ctx.font = '700 ' + Math.round(34 * Math.min(1.4, w / 520)) + 'px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.fillText('ASTEROID SHOOTER', cx, cy - 18); ctx.shadowBlur = 0;
      ctx.font = '12px "JetBrains Mono", Consolas, monospace'; ctx.fillStyle = 'rgba(230,236,247,' + (0.55 + 0.45 * Math.sin(S.t * 4)) + ')';
      ctx.fillText('press Space, or tap, to start', cx, cy + 12);
      ctx.fillStyle = 'rgba(147,164,191,0.85)'; ctx.font = '10px "JetBrains Mono", Consolas, monospace';
      ctx.fillText("siljaZ's Blueprints (UE 5.0, 2023), running as converted", cx, cy + 32);
    }
    ctx.restore();
  }

  /** every value above, as the page lists it under "this page's, authored" */
  const L = LEVEL;
  const authored = [
    'the screen: ' + 2 * L.field + ' units across, everything spawning in its middle (the pastes spawn at 0,0,0)',
    "BP_Character: its Sprite on an arm " + L.ring + ' from the middle, its ProjectileSpawn at ' + L.muzzle + '; it turns with its controller (the paste reads the yaw back from the character)',
    'BP_Controller: RotationSpeed ' + L.rotationSpeed + ' degrees a frame; DestroyUI, a function of its own the pastes do not include, takes the score widget away',
    'Lives starts at 3: the paste hides the three life icons at 2, 1 and 0 and ends the game at -1; FlashInterval ' + L.flash + ' s',
    'BP_Asteorid: Speed ' + L.asteroid.speed + ', Sphere ' + L.asteroid.r + ' at scale 1 (the paste grows it from 0.5 to 1.5 itself); removed when it leaves the screen - the paste never destroys one, and a shot that hits one scores and is spent',
    'BP_Asteorid is BP_Meteor renamed (its overlap event is still named BndEvt__BP_Meteor_Sphere_...): its BeginPlay is the one pasted under the old name',
    'BP_EnemyShip: DelayUntilShooting ' + L.ship.delayUntilShooting + ' s, HitEnemyShipScore ' + L.ship.score + '; its Spline is one of four spiral paths (the level held Spline1-4)',
    'waves: ' + L.waves.ships + ' ships 0.5 s apart (the copied timer\'s own Time) every ' + L.waves.every + ' s - EnemyWaveSpawning keeps its waves in a macro of the author\'s own, which the converter does not inline',
    'BP_EnemyProjectile: Speed ' + L.bullet.speed + '; BP_Projectile: its Timeline runs ' + L.shot.timeline + ' s, 0 to 1 (the curve is the Blueprint\'s, not the paste\'s)',
    'collision: an asteroid or a bullet touches the ship\'s Sprite (radius ' + L.player.r + '), a shot touches an asteroid or a ship\'s HitboxEnemy',
    'BP_Score (the widget) and BP_Explosion: spawned and set by the pastes, carried by none - here the score text and life icons it is told to show, and a burst',
    'input: A/D or the arrows give Move Right / Left, Space or a tap gives Shoot; the title screen is the level the paste opens',
    'the computer player when nobody plays for ' + L.computer.idle + ' s: it turns toward the nearest thing coming and fires within ' + L.computer.aim + ' degrees',
  ];
  /** a finger or a held mouse button, in the page's pixels: the ship turns toward it and fires while it is held */
  function touch(view, x, y) { return { x: (x - view.cx) / view.sc, y: (y - view.cy) / view.sc, fire: true }; }

  const api = { create: create, LEVEL: LEVEL, CLASSES: CLASSES, authored: authored, title: 'Asteroid Shooter', touch: touch,
    keyset: ['a', 'd', 'arrowleft', 'arrowright', ' ', 'enter'], pauseKey: 'p',
    keys: 'A / D or the arrows turn the ship around the middle, Space fires (and starts from the title). Drag on the screen to aim. P pauses. Left alone, the computer plays.' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.CITY_GAMES = root.CITY_GAMES || {}).asteroids = api;
})(typeof window !== 'undefined' ? window : globalThis);
