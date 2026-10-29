// games/pong.js - the ENGINE under the Pong pastes (samples/online/pong): a court, the actors, the tick, the overlaps, the input and
// the picture. The pastes are the ball's and the paddle's LOGIC and nothing else: they name BP_Wall and BP_Goal and carry neither,
// set no Speed (IR-PG-2), keep no score (IR-PG-1) and say nothing of the court, the collision settings or which key moves a
// paddle. Every such number is AUTHORED below, in LEVEL, and the page lists LEVEL as authored. What the ball and the paddles DO -
// the serve, the turn off a paddle and off a wall, the reset at a goal, the move - is the converted Blueprint, run by view/run.js;
// this file never turns the ball (tools/test_real.py plants a paste without the paddle's flip and the ball goes through).
(function (root) {
  'use strict';
  const RUN = root.BPRUN || require('../run.js');

  /** AUTHORED here, every one: the pastes carry none of it */
  const LEVEL = {
    court: { x: 1000, y: 560 },                      // half sizes: X across (the paste serves toward -X), Y up and down the screen
    ball: { r: 18, speed: 950 },                     // BP_Ball's Sphere radius; its Speed (IR-PG-2)
    paddle: { x: 905, hx: 14, hy: 92, speed: 1150 }, // where BP_Paddle stands and how big; its Speed (IR-PG-2)
    wall: { thick: 40 },                             // BP_Wall, top and bottom
    goal: { x: 1075, thick: 70 },                    // BP_Goal, behind each paddle
    // collision: the ball's overlap event turns it, so the ball OVERLAPS everything; a paddle's sweep (bSweep is true in the paste)
    // stops at a wall. Keys: W and S move the left paddle, the arrows the right (MovePaddle's own mapping is not in the paste).
    // the computer player of an idle paddle: ours, and beatable (it aims off by up to `aim` for each ball that comes); the paste has
    // no opponent, and its paddle turn keeps the ball's angle, so a computer that aimed true would never miss
    computer: { react: 0.16, gain: 1 / 70, max: 0.58, aim: 140 },
  };

  function actor(cls, x, y, extra) { return Object.assign({ cls: cls, pos: RUN.vec(x, y, 0), vars: {}, comps: {} }, extra || {}); }

  /** create - a Pong world on the set's converted graphs. opts: graphs (pl.js parse of the .ngl files), seed, onNode(graph, id,
   *  value), onEvent(kind, detail) for the picture's flashes, plant (a test's change to the world, never the page's) */
  function create(opts) {
    const L = LEVEL, rand = RUN.seeded(opts.seed || 7);
    const box = (a) => ({ x0: a.pos.X - a.hx, x1: a.pos.X + a.hx, y0: a.pos.Y - a.hy, y1: a.pos.Y + a.hy });
    const ball = actor('BP_Ball', 0, 0, { vars: { Velocity: RUN.vec(0, 0, 0), Speed: L.ball.speed }, comps: { Sphere: { cls: 'SphereComponent', r: L.ball.r } } });
    const paddle = (side) => actor('BP_Paddle', side * L.paddle.x, 0, { side: side, hx: L.paddle.hx, hy: L.paddle.hy, vars: { Velocity: RUN.vec(0, 0, 0), Speed: L.paddle.speed } });
    const paddles = [paddle(-1), paddle(1)];
    const wallY = L.court.y + L.wall.thick / 2;
    const walls = [-1, 1].map((s) => actor('BP_Wall', 0, s * wallY, { side: s, hx: L.court.x + L.goal.thick, hy: L.wall.thick / 2 }));
    const goals = [-1, 1].map((s) => actor('BP_Goal', s * L.goal.x, 0, { side: s, hx: L.goal.thick / 2, hy: L.court.y }));
    const others = [...paddles, ...walls, ...goals];
    const state = { t: 0, goals: [0, 0], hits: { BP_Paddle: 0, BP_Wall: 0, BP_Goal: 0 }, trail: [], fx: [], errors: [], serves: 0, idle: [0, 0] };
    const event = (kind, detail) => { if (opts.onEvent) opts.onEvent(kind, detail); state.fx.push({ kind: kind, x: detail.x, y: detail.y, side: detail.side, t: state.t }); };
    const M = RUN.machine({ graphs: opts.graphs, rand: rand, onNode: opts.onNode });

    // the engine's side of the actors the Blueprint calls into (Actor.h: K2_AddActorWorldOffset, K2_SetActorLocation)
    const overlapping = new Set();
    function overlaps() {
      for (const a of others) {
        const b = box(a);
        const dx = Math.max(b.x0 - ball.pos.X, 0, ball.pos.X - b.x1), dy = Math.max(b.y0 - ball.pos.Y, 0, ball.pos.Y - b.y1);
        const now = dx * dx + dy * dy < L.ball.r * L.ball.r;
        if (now && !overlapping.has(a)) {
          overlapping.add(a);
          state.hits[a.cls]++;
          if (a.cls === 'BP_Goal') { state.goals[a.side < 0 ? 1 : 0]++; }
          event(a.cls, { x: ball.pos.X, y: ball.pos.Y, side: a.side });
          // UPrimitiveComponent::OnComponentBeginOverlap of the ball's Sphere: the Blueprint decides what it means
          M.fire(ball, 'Overlap Sphere', { OverlappedComponent: ball.comps.Sphere, OtherActor: a, OtherComp: a, OtherBodyIndex: 0, bFromSweep: false, SweepResult: null });
        } else if (!now) overlapping.delete(a);
      }
    }
    function move(a, d, sweep) {
      a.pos = RUN.vec(a.pos.X + d.X, a.pos.Y + d.Y, a.pos.Z + d.Z);
      if (a === ball) return overlaps();
      if (sweep) {           // a paddle's sweep stops where it would enter a wall (it blocks): a paddle never overlaps the ball's walls
        const lim = L.court.y - a.hy;
        if (a.pos.Y > lim) a.pos.Y = lim;
        if (a.pos.Y < -lim) a.pos.Y = -lim;
      }
    }
    for (const a of [ball, ...paddles]) {
      a.K2_AddActorWorldOffset = function (DeltaLocation, bSweep) { move(this, DeltaLocation, bSweep); };
      a.K2_SetActorLocation = function (NewLocation) {
        this.pos = RUN.vec(NewLocation.X, NewLocation.Y, NewLocation.Z);
        if (this === ball) { state.serves++; state.trail = []; overlaps(); }
        return true;
      };
      a.K2_GetActorLocation = function () { return RUN.vec(this.pos.X, this.pos.Y, this.pos.Z); };
    }
    if (opts.plant) opts.plant({ ball, paddles, walls, goals, M });

    // BeginPlay, every actor that has one (the ball serves)
    for (const a of [ball, ...paddles]) M.fire(a, 'ReceiveBeginPlay', {});
    state.serves++;

    /** the axis a paddle's input gives this frame: a player's keys, else the computer's (ours) */
    const lagged = [0, 0], aim = [0, 0], wasComing = [false, false], aimedAt = [-1, -1];
    const crand = RUN.seeded((opts.seed || 7) * 31 + 1);       // the computer's own dice: the Blueprint's (the serves) stay its own
    function axis(p, i, input) {
      const up = i === 0 ? input.has('w') : input.has('arrowup'), down = i === 0 ? input.has('s') : input.has('arrowdown');
      if (input.touch && input.touch[i] !== undefined) { state.idle[i] = 0; return Math.max(-1, Math.min(1, (p.pos.Y - input.touch[i]) / 40)); }
      if (up || down) { state.idle[i] = 0; return (up ? 1 : 0) - (down ? 1 : 0); }        // W / up: AxisValue 1, the paste's -Y: up the screen
      state.idle[i] += 1;
      // the computer: it reads the ball late, aims off a little for each ball, and only follows a ball coming its way
      const coming = Math.sign(ball.vars.Velocity.X) === Math.sign(p.side);
      // a fresh aim for each ball that comes: one turned its way, or a new serve (a serve after a goal comes the same way, and kept
      // the last aim - the computer missed five serves running at the start of seed 7)
      if (coming && (!wasComing[i] || aimedAt[i] !== state.serves)) { aim[i] = (crand() * 2 - 1) * L.computer.aim; aimedAt[i] = state.serves; }
      wasComing[i] = coming;
      const k = 1 - Math.exp(-1 / 60 / L.computer.react);
      lagged[i] += ((coming ? ball.pos.Y + aim[i] : 0) - lagged[i]) * k;
      return Math.max(-L.computer.max, Math.min(L.computer.max, (p.pos.Y - lagged[i]) * L.computer.gain));
    }

    return {
      level: LEVEL, ball: ball, paddles: paddles, walls: walls, goals: goals, state: state, machine: M,
      /** one frame: input as UE processes it (the axis events), then every actor's Tick, then the latent steps */
      step(dt, input) {
        state.t += dt;
        paddles.forEach((p, i) => { M.fire(p, 'InputAxis MovePaddle', { AxisValue: axis(p, i, input || new Set()) }); });
        for (const a of [ball, ...paddles]) M.fire(a, 'ReceiveTick', { DeltaSeconds: dt });
        M.advance(dt);
        state.trail.push([ball.pos.X, ball.pos.Y]);
        if (state.trail.length > 18) state.trail.shift();
        state.fx = state.fx.filter((f) => state.t - f.t < 0.6);
      },
      draw(ctx, w, h) { draw(ctx, w, h, this); },
      /** who is playing each paddle: 'you' while its keys were used in the last 4 s, else the computer */
      players() { return state.idle.map((n) => (n < 240 ? 'you' : 'computer')); },
      /** the panel's line: who plays each paddle */
      who() { return this.players().map((p, i) => (i ? 'right: ' : 'left: ') + p).join('  '); },
    };
  }

  /** a finger or a held mouse button on the court, in the page's pixels: the left half moves the left paddle, the right half the right */
  function touch(view, x, y, w) {
    const t = [];
    t[x < w / 2 ? 0 : 1] = (y - view.cy) / view.sc;
    return t;
  }

  // ---------------------------------------------------------------- the picture: neon on the city's night
  function draw(ctx, w, h, G) {
    const L = LEVEL, S = G.state;
    const margin = 26, sc = Math.min((w - 2 * margin) / (2 * (L.goal.x + L.goal.thick / 2)), (h - 2 * margin - 40) / (2 * (L.court.y + L.wall.thick)));
    const cx = w / 2, cy = h / 2 + 14;
    const X = (x) => cx + x * sc, Y = (y) => cy + y * sc;
    G.view = { sc: sc, cx: cx, cy: cy };          // where the court is on the canvas, so a finger can be read back as a paddle's place
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#050a14';
    ctx.fillRect(0, 0, w, h);
    // the floor's grid, faint
    ctx.strokeStyle = 'rgba(90,169,255,0.06)'; ctx.lineWidth = 1;
    for (let gx = -L.court.x; gx <= L.court.x; gx += 100) { ctx.beginPath(); ctx.moveTo(X(gx), Y(-L.court.y)); ctx.lineTo(X(gx), Y(L.court.y)); ctx.stroke(); }
    for (let gy = -L.court.y; gy <= L.court.y; gy += 100) { ctx.beginPath(); ctx.moveTo(X(-L.court.x), Y(gy)); ctx.lineTo(X(L.court.x), Y(gy)); ctx.stroke(); }
    const glow = (col, blur) => { ctx.shadowColor = col; ctx.shadowBlur = blur; };
    const label = (txt, x, y, col) => { ctx.shadowBlur = 0; ctx.fillStyle = col; ctx.font = '600 10px "JetBrains Mono", Consolas, monospace'; ctx.textAlign = 'center'; ctx.fillText(txt, x, y); };
    // goals: red zones, flaring when the ball enters one
    for (const g of G.goals) {
      const hot = S.fx.some((f) => f.kind === 'BP_Goal' && f.side === g.side);
      ctx.fillStyle = hot ? 'rgba(255,70,90,0.35)' : 'rgba(255,70,90,0.07)';
      ctx.fillRect(X(g.pos.X - g.hx), Y(-L.court.y), g.hx * 2 * sc, L.court.y * 2 * sc);
      label('BP_Goal', X(g.pos.X), Y(L.court.y) - 6, 'rgba(255,120,135,0.6)');
    }
    // walls
    glow('#5aa9ff', 14);
    ctx.fillStyle = '#9fd0ff';
    for (const wl of G.walls) ctx.fillRect(X(-L.court.x - L.goal.thick), Y(wl.pos.Y - wl.hy) + (wl.side < 0 ? wl.hy * 2 * sc - 3 : 0), (L.court.x + L.goal.thick) * 2 * sc, 3);
    label('BP_Wall', X(0), Y(-L.court.y) - 8, 'rgba(159,208,255,0.55)');
    // the centre line
    ctx.setLineDash([10, 12]); ctx.strokeStyle = 'rgba(159,208,255,0.18)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(0), Y(-L.court.y)); ctx.lineTo(X(0), Y(L.court.y)); ctx.stroke(); ctx.setLineDash([]);
    // paddles
    for (const p of G.paddles) {
      const hit = S.fx.some((f) => f.kind === 'BP_Paddle' && Math.sign(f.x) === p.side);
      glow(hit ? '#ffffff' : '#21c7ff', hit ? 30 : 18);
      ctx.fillStyle = hit ? '#ffffff' : '#7fe3ff';
      const r = Math.min(6, p.hx * sc);
      ctx.beginPath(); ctx.roundRect(X(p.pos.X - p.hx), Y(p.pos.Y - p.hy), p.hx * 2 * sc, p.hy * 2 * sc, r); ctx.fill();
      label('BP_Paddle', X(p.pos.X), Y(p.pos.Y - p.hy) - 8, 'rgba(127,227,255,0.6)');
    }
    // the ball's trail and the ball
    ctx.shadowBlur = 0;
    S.trail.forEach(([tx, ty], i) => { ctx.fillStyle = 'rgba(127,227,255,' + (0.03 + 0.25 * i / S.trail.length) + ')'; ctx.beginPath(); ctx.arc(X(tx), Y(ty), L.ball.r * sc * (0.4 + 0.6 * i / S.trail.length), 0, 2 * Math.PI); ctx.fill(); });
    glow('#9fe8ff', 26);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(X(G.ball.pos.X), Y(G.ball.pos.Y), L.ball.r * sc, 0, 2 * Math.PI); ctx.fill();
    label('BP_Ball', X(G.ball.pos.X), Y(G.ball.pos.Y) - L.ball.r * sc - 7, 'rgba(255,255,255,0.55)');
    // a ring where the ball turned
    for (const f of S.fx) {
      const k = (S.t - f.t) / 0.6;
      ctx.strokeStyle = f.kind === 'BP_Goal' ? 'rgba(255,90,110,' + (1 - k) + ')' : 'rgba(180,240,255,' + (1 - k) + ')';
      ctx.lineWidth = 2; glow(ctx.strokeStyle, 12);
      ctx.beginPath(); ctx.arc(X(f.x), Y(f.y), (10 + 60 * k) * sc * 2, 0, 2 * Math.PI); ctx.stroke();
    }
    // the goals seen, which the page counts (the paste keeps no score, IR-PG-1)
    ctx.shadowBlur = 0; ctx.textAlign = 'center'; ctx.fillStyle = '#e6ecf7';
    ctx.font = '600 26px "Barlow Condensed", "Arial Narrow", sans-serif';
    ctx.fillText(S.goals[0] + '   :   ' + S.goals[1], cx, 30);
    ctx.font = '10px "JetBrains Mono", Consolas, monospace'; ctx.fillStyle = 'rgba(147,164,191,0.85)';
    ctx.fillText('goals counted by this page - the paste keeps no score (IR-PG-1)', cx, 44);
    ctx.restore();
  }

  /** every value above, as the page lists it under "this page's, authored" */
  const L = LEVEL;
  const authored = [
    'the court: ' + 2 * L.court.x + ' by ' + 2 * L.court.y + ' units, the ball served from its middle',
    'BP_Ball: a Sphere of radius ' + L.ball.r + ', Speed ' + L.ball.speed + ' (the paste sets no Speed: the author\'s question IR-PG-2)',
    'BP_Paddle: at X ' + L.paddle.x + ' either side, ' + 2 * L.paddle.hx + ' by ' + 2 * L.paddle.hy + ', Speed ' + L.paddle.speed + ' (IR-PG-2)',
    'BP_Wall and BP_Goal: the paste names them and carries neither - here a wall top and bottom, a goal behind each paddle',
    'collision: the ball overlaps everything (its overlap event turns it); a paddle\'s sweep stops at a wall',
    'input: W and S give the left paddle\'s MovePaddle axis, the arrows the right\'s (the axis mapping is not in the paste)',
    'the computer player at a paddle left alone: it reads the ball ' + L.computer.react + ' s late and aims off by up to ' + L.computer.aim + ' units',
    'the score: counted here from the goals the engine sees (the paste keeps none: IR-PG-1)',
    'the serve always goes left (toward -X): that is the paste\'s own cone, and which end it should go is IR-PG-3',
  ];
  const api = { create: create, LEVEL: LEVEL, authored: authored, title: 'Pong', touch: touch,
    keyset: ['w', 's', 'arrowup', 'arrowdown'], pauseKey: ' ',
    keys: 'W / S moves the left paddle, the arrows the right, or drag on the court. A paddle left alone is played by the computer. Space pauses.' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.CITY_GAMES = root.CITY_GAMES || {}).pong = api;
})(typeof window !== 'undefined' ? window : globalThis);
