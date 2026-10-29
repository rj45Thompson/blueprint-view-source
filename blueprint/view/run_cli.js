#!/usr/bin/env node
// run_cli.js - a set's game played headless on its converted graphs (view/run.js under view/games/<set>.js), for the tests.
//
//   node view/run_cli.js play <set dir> <game> <seconds> [--seed N] [--plant <name>]
//     plays <seconds> at 60 frames a second with the computer at every control and prints one JSON line: the frames, what the
//     engine counted, every graph's runs and every statement that ran with its count, and the statements that never ran - counted
//     against the set's trace (<set dir>/trace/trace.json), so a statement here is one the model and the city count too. Exit 1 on
//     an error in the converted code - a name it reads that nothing defines, a function the runtime lacks - with the error.
//     Pong also measures, after every paddle hit, whether the ball came back (its X velocity turned).
//   --plant noflip      Pong: the paddle's turn taken out of a copy of its graph (Multiply_FloatFloat(Velocity.X, -1) -> 1): the
//                       ball must go through the paddle - proof the engine never turns the ball itself
//   --plant noshipkill  Asteroids: the enemy ship's own K2_DestroyActor taken out of a copy of its hit graph: a shot ship must
//                       live on - proof the engine never kills a ship itself
'use strict';
const fs = require('fs');
const path = require('path');
const NGL = require('./pl.js');

function readText(f) { const b = fs.readFileSync(f); return b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le').slice(1) : b.toString('utf8'); }

const PLANTS = {
  noflip: { file: 'BP_Ball.ngl', from: 'method=Multiply_FloatFloat args=[Velocity.X -1]', to: 'method=Multiply_FloatFloat args=[Velocity.X 1]' },
  // the ship's own destroy is the call with no `on=` (OtherActor's is the shot's): it becomes a call that changes nothing
  noshipkill: { file: 'BP_EnemyShip_Collision.ngl', from: /(call) method=K2_DestroyActor args=\[\] params=\[\]/, to: '$1 method=K2_GetActorLocation args=[] params=[]' },
};

function graphsOf(setDir, plant) {
  const out = [];
  const p = plant ? PLANTS[plant] : null;
  if (plant && !p) throw new Error('no plant named ' + plant);
  let planted = false;
  for (const f of fs.readdirSync(path.join(setDir, 'graphs')).filter((x) => x.endsWith('.ngl')).sort()) {
    let text = readText(path.join(setDir, 'graphs', f));
    if (p && f === p.file) { const before = text; text = text.replace(p.from, p.to); planted = text !== before; }
    out.push(...NGL.parse(text, f));
  }
  if (p && !planted) throw new Error('plant ' + plant + ': what it changes was not found in ' + p.file);
  return out;
}

function play(setDir, gameName, seconds, seed, plant) {
  const game = require('./games/' + gameName + '.js');
  const graphs = graphsOf(setDir, plant);
  const ran = new Map();
  const onNode = (g, id) => { const k = g + '#' + id; ran.set(k, (ran.get(k) || 0) + 1); };
  let pendingTurn = null;
  const back = { checked: 0, came: 0 };
  const G = game.create({ graphs: graphs, seed: seed, onNode: onNode,
    onEvent: (kind) => { if (kind === 'BP_Paddle') pendingTurn = Math.sign(G.ball.vars.Velocity.X); } });
  const frames = Math.round(seconds * 60);
  for (let f = 0; f < frames; f++) {
    const before = pendingTurn;
    const input = new Set();
    input.pressed = new Set();
    G.step(1 / 60, input);
    // Pong: a paddle hit is measured on the frame after it - the ball's X velocity must have turned against the paddle's side
    if (gameName === 'pong' && before !== null && pendingTurn === before) {
      back.checked++;
      const vx = Math.sign(G.ball.vars.Velocity.X);
      if (vx !== 0 && vx === -Math.sign(G.ball.pos.X)) back.came++;
      pendingTurn = null;
    }
  }
  // the trace's statements (a switch section's break and a latent node's output block are rows of the graph, not statements), by
  // the aliases the model cites
  const trace = JSON.parse(readText(path.join(setDir, 'trace', 'trace.json')));
  const aliasOf = new Map(trace.graphs.map((G) => [G.name, G.alias]));
  const ranAt = new Set([...ran.keys()].map((k) => { const i = k.lastIndexOf('#'); return aliasOf.get(k.slice(0, i)) + k.slice(i); }));
  const statements = [];
  for (const G of trace.graphs) for (const s of G.statements) statements.push(G.alias + '#' + s.id);
  const never = statements.filter((k) => !ranAt.has(k));
  const runs = {};
  for (const [k, n] of ran) if (k.endsWith('#entry')) runs[k.slice(0, -'#entry'.length)] = n;
  return { set: path.basename(setDir), game: gameName, seconds: seconds, frames: frames, seed: seed, plant: plant || null,
    hits: G.state.hits || null, goals: G.state.goals || null, serves: G.state.serves || null, count: G.state.count || null,
    came_back: gameName === 'pong' ? back : null, runs: runs, statements: statements.length, ran: statements.length - never.length, never: never,
    nodes: Object.fromEntries([...ran.entries()].filter(([k]) => !k.endsWith('#entry'))) };
}

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
if (argv[0] === 'play' && argv[3]) {
  try {
    console.log(JSON.stringify(play(argv[1], argv[2], parseFloat(argv[3]), parseInt(flag('--seed', '7'), 10), flag('--plant', null))));
    process.exit(0);
  } catch (e) { console.error('run: ' + e.stack); process.exit(1); }
}
console.error('usage: node view/run_cli.js play <set dir> <game> <seconds> [--seed N] [--plant noflip|noshipkill]');
process.exit(2);
