# NGL - the node graph language

The design goal: a pseudo-language of its own that the node graph interprets, agnostic to every language it is shown in, the
visual Blueprint language included. This is that language. Every method of the sandbox's code is stored in it, one `.ngl` file
per source file (`graphs/<project>/`), written by `U2ue.CodeGraph graph` and read back by `view/pl.js`.

**One stored graph, many projections** (REQ-BPV-23, REQ-BPV-26). Nothing a reader sees is printed from the C# again: the Blueprint
style, the blocks, pseudo-code, C# and the C++ reading form are all printed by `pl.js` from these lines. The language is trusted only
while it round-trips: every graph, read back from disk, prints C# whose syntax tree equals its method's (4,201 of 4,201 on one
game's code, `tools/graphs.py build`; 5,018 of 5,018 on a Unity project read from Unity's own command line).

## A file

The reader's own `GraphBuilder.LineOf` (`n.GetLocation().GetLineSpan().StartLinePosition.Line + 1`), as the reader writes it when it
reads itself:

```
# U2ue.CodeGraph/CodeGraphReader.cs - the node graph language (view/NGL.md) ...      a comment line
graph GraphBuilder.LineOf kind=method at=727:5 mods=[static] params=[n:SyntaxNode] returns=int arrow=s1
  s1 expression-body value=#e1 at=727:37
    e1 operator op=+ a=#e2.StartLinePosition.Line b=1 t=int at=727:40
      e2 pure-call on=#e3 method=GetLineSpan args=[] dispatch=virtual t=FileLinePositionSpan at=727:40
        e3 pure-call on=n method=GetLocation args=[] dispatch=instance t=Location reads=[n@p] at=727:40
end
```

- A graph starts with `graph <name>` and ends with `end`. Its name is the census's: `Type.Member`, or `Parent>Local` for a local
  function, which is a graph of its own.
- Between them, **one node per line**: `<id> <keyword> key=value ...`. Indentation is for the reader only: a node is written under
  the node that created it, so the file reads in source order. The parser ignores it except to know which statement a node sits in.

## Values

- `#e4` a reference to another node of the same graph (a wire).
- `[a b c]` a list. Inside a list `-` means "none" (a declarator with no initializer).
- `"..."` a quoted token: a string literal as the author wrote it, or, for `note=` and `doc=`, free text.
- `~"..."` any text that is not one token (it has a space, a quote, a bracket at the start), as a JSON string.
- anything else is a **term**, one token: a name, a member path, a literal, a type. A term may contain references (`#e7.Hp`).

Terms are leaves spelled as the author wrote them: `n.SyntaxTree.FilePath`, `1.25f`, `0x10`, `Tier.Island`. That
spelling is shared by C-family languages; a projection to another language re-spells only what it must (the C++ form turns `null`
into `nullptr`, `var` into `auto`).

## Ids

- `s1, s2, ...` statements, the exec chain. **Their numbers are the census's statement ordinals**, the order the census counts
  statements in, so "a value read 6 or more statements after it was made" (a long wire) is computed from the ids alone.
- `e1, e2, ...` expressions that are nodes: data nodes, pure, feeding a pin.
- `f1, ...` a local function's declaring statement (the census gives it no ordinal).
- `k1, ...` structure, not nodes: a nested `{ }` block, a switch section, a catch clause, a switch-expression arm, an empty `;`.

## The graph's header

`kind` (method, constructor, get, set, property, operator, local, ...), `at` (line:col, the graph's identity in its file), `mods`,
`params` (`name:type`), `returns`, `doc` (the XML summary), and either `body=[s1 s2 ...]` (a block) or `arrow=s1` (`=> expr`).

## Every node may carry

- `at` its source line; `t` its value's type (the pin colour in the Blueprint style);
- `reads=[name@made ...]` the locals and parameters it reads, each with the node that declared it (`@p` a parameter of the graph);
- `note` the comments written above it (and at the end of its line), kept for readers and never compared.

## Keywords

The keyword is the census family's name (`U2ue.CodeGraph/NodeFamilies.cs`), hyphenated: the graph files and the census count the
same families, 41,679 + 25,605 nodes, keyword by keyword. `VOCABULARY.ngl` lists each with its tier (Blueprint, Extended, Island)
and the Blueprint node a reader would compare it to.

Statements (the exec chain):
- `set-local` `decl` (the written type, `var` included) `vars=[...]` `values=[...]`, `mods` (const, using, await); also
  `using-declaration`, `ref-local`.
- `set`, `set-with-math`, `set-if-null`, `deconstructing-set` `target` `op` (=, +=, ??=, ...) `value`.
- `call` (a call whose result is not used) and `pure-call` (an expression): `on` the target (a type for a static call; `?` inside
  `?.`) or `callee` (any other expression), `method`, `args` (`argnames`, `argmods` when any), `params` the callee's pins,
  `dispatch` (static, instance, virtual, interface, extension, LINQ, delegate, local function, parent), and `def` - where the
  callee's graph is (`File.cs:LINE`) - or `binds` + `bindskind` when it has none (an interface or abstract member, a delegate).
- `branch` `cond` `then` `else`; a body is a list `[s4 s5]` (a braced block) or a single id (an embedded statement).
- `for-loop` (`decl vars values` or `init`) `cond` `step` `body`; `for-each-loop` `decl` `var` `in` `body`;
  `for-each-with-deconstruction`; `while-loop`, `do-while-loop` `cond` `body`.
- `switch` / `switch-on-patterns` `on` `sections=[k...]`; a `section` holds `labels=[case X default pattern P when C]` and `body`.
- `return` `value`; `break`; `continue`; `section-break` (a switch section's own break: an ordinal, not a node); `throw` `value`.
- `try-catch-finally` `body` `catches=[k...]` (each `catch` with `decl` `var` `when` `body`) `finally`.
- `using` `res` or a declaration, `body`; `lock` `on` `body`; `yield` `kind=return|break` `value`.
- `local-function` `sig` `graph` (the local function's own graph, by its `at`).
- `goto-label` (`label` + `stmt`, or `text`), `checked-unchecked-block`, `unsafe-fixed` - the census's islands.

Expressions (data nodes):
- `operator` `op` `a` `b` (unary: `a` only; `post=1` for `x++`), `coalesce` `a` `b`, `select` `cond` `then` `else` or `on`
  `arms=[k...]` (a switch expression), `cast` `form=cast|as` `to` `a`, `type-test` `a` and `to` or `pat`.
- `construct` `type` (or `implicit=1`) `args` `init`, `make-array` `form` `elems` (`comma=1` when the author left a trailing comma),
  `tuple` `elems` `names`, `format` `text` (an interpolated string), `get-at-index` `on` `index`.
- `lambda` `params` `mods` and `value` (an expression body), `do` (a void expression body, which is a statement) or `body`.
- `if-valid` (`a?.b`) and `call-if-valid` `on` `then`; `increment-inside-an-expression`, `assignment-inside-an-expression`,
  `await`, `throw` (an expression), `with`, `range`, `index-from-the-end`, `checked-unchecked`, `ref-expression`.
- `text` on anything with no structure another language could use (a query expression, an anonymous object): its own text,
  nodes inside it as references. Measured on the sandbox (2026-10-28): 159 interpolated strings (`format`, whose holes are
  references) and 2 `goto` statements carry `text`; no query expression or anonymous object occurs.

## Written from a Blueprint (view/bp.js)

The converter writes the same language from Unreal Blueprint text, with three additions the C# reader never needs:
- the header's `outs=[name:type ...]`: a Blueprint function's outputs other than ReturnValue, which the engine passes as out
  parameters (KismetCompiler.cpp:1686-1695); `kind=function` or `kind=event`, and `at` is the entry node's line in the .t3d;
- `block on=<output>`: the steps that run when a node with no code form (an `island`) fires that exec output; the Blueprint style
  draws it as an "On <output>" node with its own body, where a plain `{ }` is flattened into its chain;
- `await a=#e` as a statement: a latent function call, whose following steps run when it finishes.

A converted graph has no C# source, so it is not round-tripped: `U2ue.CodeGraph syntax --printed <dir>` parses every method as C#
(and fails on a planted error and on an empty folder), `bp_cli.js` holds every value under the statement that reads it, and the
layout gate runs on it as on the reader's graphs.

## What holds it to the code (all run by `py -X utf8 tools/graphs.py build`)

- **Round trip**: pl.js prints every graph's C#; `U2ue.CodeGraph roundtrip` compares it with the source as syntax trees, whitespace,
  comments and grouping parentheses ignored. `graphs.py --selftest` plants a deleted statement, a swapped operator and a dropped
  argument in a copy; each fails exactly its graph.
- **Census**: node counts per keyword equal the census's; the long wires recomputed from `reads` equal the census's, graph by graph.
- **Layout**: no drawn wire spans 6 or more statements (far reads are Get chips), every node is drawn, two layouts are identical.
- **Projections**: every graph prints as pseudo-code and as C++ without error; the C++ form's untranslated share is counted.
- **Links**: every `def` names a graph that exists; no `binds` does.
