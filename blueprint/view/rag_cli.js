#!/usr/bin/env node
// rag_cli.js - the retrieval layer (rag.js) from the command line.
//
//   node view/rag_cli.js ask <trace dir> "<question>"            the context a model would be given for that question
//   node view/rag_cli.js batch <trace dir> <questions.json> <out.json> [budget chars]   [{id, q}] -> [{id, q, seeds, ids, context}]
//
// The trace dir holds trace.json (trace_cli.js build), classes.json (oo_cli.js assemble) and chain.json (tools/logic_map.py build).
'use strict';
const fs = require('fs');
const path = require('path');
const RAG = require('./rag.js');

function load(dir) {
  const j = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const f of ['trace.json', 'chain.json']) if (!fs.existsSync(path.join(dir, f))) throw new Error(dir + ' has no ' + f);
  return RAG.index(j('trace.json'), fs.existsSync(path.join(dir, 'classes.json')) ? j('classes.json') : null, j('chain.json'));
}

const [verb, a, b, c, budget] = process.argv.slice(2);
try {
  if (verb === 'ask' && a && b) { const r = RAG.retrieve(load(a), b); console.log(r.context); process.exit(0); }
  if (verb === 'batch' && a && b && c) {
    const I = load(a);
    const qs = JSON.parse(fs.readFileSync(b, 'utf8'));
    fs.writeFileSync(c, JSON.stringify(qs.map((x) => Object.assign({ id: x.id, q: x.q }, RAG.retrieve(I, x.q, budget ? Number(budget) : undefined))), null, 1));
    console.log('rag batch: %d questions -> %s', qs.length, c);
    process.exit(0);
  }
} catch (e) { console.error('rag: ' + e.message); process.exit(2); }
console.error('usage: node view/rag_cli.js ask <trace dir> "<question>" | batch <trace dir> <questions.json> <out.json>');
process.exit(2);
