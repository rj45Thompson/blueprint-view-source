#!/usr/bin/env python3
"""logic_map.py - LogicMap: every piece of code joined to the use case step it realises and the requirement that step carries.

The rule: every line of code and every piece of Blueprint logic links to the graph node of the use case step it realises, and the
steps describe the requirements as a linear, hierarchical chain. At each step a brainstorm of questions checks that the requirements
close the loop: as with code coverage, every path a user or the system can take through the code is handled by a requirement, or
dealt with by one (excluded, with the reason).

INPUTS
  the model (a usecase_model.py folder): each step and extension may carry `code: [cite ...]`, where a cite is
    `Alias`           a graph: its entry and the statements directly in its body
    `Alias#sN`        one statement (a decision's own test, not its outcomes)
    `Alias#sN:label`  one outcome of a decision: the edge and the statements directly in that body (then, else, loop, skip, a case)
  the trace (view/trace_cli.js build): graphs, statements, Blueprint units, decisions, outcomes, paths, questions
  exclusions (optional YAML, `exclusions: [{ref, why}]`): an outcome that cannot happen, with the reason - "dealt with", not ignored

OUTPUTS (the model folder's generated.yaml - never edit by hand - holds the closed spaces the EXISTING gap checker gates):
  one CODE space per Blueprint text: its keys are read from the text by the checker itself (every `Begin Object ... Name=`), its
    cells are the requirements of the steps whose cites reach that node - a node no step reaches has NO cell, and U7 fails on it
  S-OUT: every outcome of every decision; S-PATH: every path, covered only when each outcome on it is covered (an excluded outcome
    excludes the path, with its reason)
  TRACE.md beside the model: the chain, top down (epic -> use case -> step -> code) and bottom up (Blueprint node -> requirement);
    and, at every step, the brainstorm: each question its code raises, with the requirement that answers it (the question space
    S-Q is authored in the model: an unanswered question is a U7 hole there)
  <trace>/cites.json: statement -> the step that cites it (what the suggester is scored against)

    py -X utf8 tools/logic_map.py build <model dir> <trace dir> [--exclusions F] [--trace-md F]
    py -X utf8 tools/logic_map.py selftest

Exit 1 when a cite resolves to nothing, an outcome is both cited and excluded, or anything is left uncovered (the counts say what).
"""
import hashlib
import io
import json
import os
import re
import sys
import tempfile

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import toolkit_home  # noqa: E402  the toolkit's home, in its own tree or a release
sys.path.insert(0, toolkit_home.tool("autobot"))
import usecase_model as ucm  # noqa: E402  the one loader's Assertion and Term: an effect is parsed once, the same everywhere

UNIT_PATTERN = r'(?m)^Begin Object Class=\S+ Name="([^"]+)"'


def load_model(folder):
    """{usecases: [...], requirements: {...}, spaces: [...]} from every YAML file of the folder but generated.yaml"""
    out = {"usecases": [], "requirements": {}, "spaces": [], "questions": [], "terms": []}
    for f in sorted(os.listdir(folder)):
        if not f.endswith(".yaml") or f == "generated.yaml":
            continue
        d = yaml.safe_load(io.open(os.path.join(folder, f), encoding="utf-8")) or {}
        out["usecases"] += d.get("usecases") or []
        out["spaces"] += d.get("spaces") or []
        out["questions"] += d.get("questions") or []
        out["terms"] += d.get("terms") or []
        for r in d.get("requirements") or []:
            out["requirements"][r["id"]] = r
    return out


class Trace(object):
    """the trace.json of view/trace_cli.js, indexed"""

    def __init__(self, folder):
        self.folder = folder
        t = json.load(io.open(os.path.join(folder, "trace.json"), encoding="utf-8"))
        self.t = t
        self.graphs = {g["alias"]: g for g in t["graphs"]}
        self.stmt = {}
        for g in t["graphs"]:
            for s in g["statements"]:
                self.stmt["%s#%s" % (g["alias"], s["id"])] = dict(s, graph=g["alias"])
        self.outcomes = {}
        for d in t["decisions"]:
            for o in d["outcomes"]:
                self.outcomes[o["ref"]] = dict(o, decision=d["ref"], graph=d["graph"])
        self.paths = t["paths"]
        self.units = t["units"]
        self.questions = t["questions"]

    def top(self, alias):
        g = self.graphs[alias]
        return ["%s#%s" % (alias, s["id"]) for s in g["statements"] if s["under"] is None]

    def resolve(self, cite):
        """cite -> (kind, statements it covers, outcome ref or None); raises on a cite that names nothing"""
        if "#" not in cite:
            if cite not in self.graphs:
                raise KeyError("no graph %r (graphs: %s)" % (cite, ", ".join(sorted(self.graphs))))
            return "graph", self.top(cite), None
        if re.search(r"#s\d+:", cite):
            if cite not in self.outcomes:
                raise KeyError("no outcome %r" % cite)
            o = self.outcomes[cite]
            # a body can hold rows that are no statement (a switch section's break, a latent node's output block): only statements
            return "outcome", ["%s#%s" % (o["graph"], b) for b in o["body"] if "%s#%s" % (o["graph"], b) in self.stmt], cite
        if cite not in self.stmt:
            raise KeyError("no statement %r" % cite)
        return "statement", [cite], None


def sha(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


class EffectCheck(object):
    """Each requirement's EFFECT (usecase_model.Assertion) held to the trace: an assertion holds when a statement at its place
    sets, calls, branches on or reads its target as it says. Every verdict is PLANTED the other way, so a check that cannot change
    its answer is caught (usecase_kg.py loop, L8): a holding one must break when the statement it read is mutated in each thing the
    assertion claims (the target renamed, the value changed, an argument dropped); a failing one must hold once the statement it
    asks for is added - it can be satisfied, so the fix is expressible. The NAMES: every code-shaped word of a requirement's text,
    every term's binding and every assertion's target, looked up in the converted code and then the pasted text, so a requirement
    cannot name a thing the code does not have (L10)."""

    WORD = re.compile(r"[A-Za-z_]\w*")
    # code-shaped: an underscore inside, or a capital after a lower-case letter (LockedOn, NoFalse, Master_Enemy, K2_SetTimer)
    SHAPED = re.compile(r"`([A-Za-z_]\w*)`|\b([A-Za-z]\w*?(?:[a-z0-9][A-Z]|_[A-Za-z0-9])\w*)\b")
    BRANCHING = ("branch", "for-loop")

    def __init__(self, trace, paste_texts=()):
        self.T = trace
        self.kids = {}
        for ref, s in trace.stmt.items():
            if s.get("under"):
                self.kids.setdefault("%s#%s" % (s["graph"], s["under"]), []).append(ref)
        self.code = set(trace.graphs)
        for s in trace.stmt.values():
            self.code.update(self.WORD.findall(s["text"]))
        for g in trace.graphs:
            self.code.update(self.WORD.findall(g))
        self.paste = set()
        for t in paste_texts:
            self.paste.update(self.WORD.findall(t))

    def place(self, at):
        """the statements an assertion's place holds: every statement of a graph, one statement, or an outcome's body with all
        that is nested in it; KeyError on a place that names nothing"""
        if "#" not in str(at):
            if at not in self.T.graphs:
                raise KeyError("no graph %r" % at)
            return ["%s#%s" % (at, s["id"]) for s in self.T.graphs[at]["statements"]]
        kind, refs, _ = self.T.resolve(at)
        if kind != "outcome":
            return refs
        out, todo = [], list(refs)
        while todo:
            r = todo.pop(0)
            out.append(r)
            todo += self.kids.get(r, [])
        return out

    @staticmethod
    def norm(v):
        v = re.sub(r"(\d)f\b", r"\1", str(v).strip().lower())
        return {"none": "nothing", "null": "nothing"}.get(v, v)

    @staticmethod
    def sides(text):
        """(left, right) of an assignment - `X ← v` or `let X = v` - or None"""
        if "←" in text:
            left, right = text.split("←", 1)
        elif text.startswith("let ") and "=" in text:
            left, right = text[4:].split("=", 1)
        else:
            return None
        return left.strip(), right.strip()

    def matches(self, a, s):
        """does the trace statement `s` do what the assertion `a` says?"""
        text, word = s["text"], re.compile(r"(?<!\w)%s(?!\w)" % re.escape(a.target))
        if a.verb == "sets" and a.by is not None:     # a write through a call: F( ... X ... )
            m = re.search(r"(?<!\w)%s\((.*)\)" % re.escape(str(a.by)), text)
            return m is not None and word.search(m.group(1)) is not None and (a.to is None or str(a.to) in m.group(1))
        if a.verb == "sets":
            lr = self.sides(text)
            return bool(lr) and (lr[0] == a.target or lr[0].endswith("." + a.target)) and (
                a.to is None or self.norm(lr[1]) == self.norm(a.to))
        if a.verb == "calls":
            return re.search(r"(?<!\w)%s\(" % re.escape(a.target), text) is not None and all(x in text for x in a.args)
        if a.verb == "branches":
            return s["kw"] in self.BRANCHING and word.search(text) is not None
        if a.verb == "reads":
            lr = self.sides(text)
            return word.search(lr[1] if lr else text) is not None
        return False

    def mutants(self, a, s):
        """the matched statement changed in each thing the assertion claims - each one must stop matching"""
        t = s["text"]
        out = [("the target renamed", dict(s, text=re.sub(r"(?<!\w)%s(?!\w)" % re.escape(a.target), a.target + "Planted", t)))]
        if a.by is not None:
            out.append(("another call", dict(s, text=re.sub(r"(?<!\w)%s\(" % re.escape(str(a.by)), "PlantedCall(", t))))
        elif a.verb == "sets" and a.to is not None:
            out.append(("the value changed", dict(s, text="%s ← planted_value" % self.sides(t)[0])))
        for x in a.args:
            out.append(("argument %s dropped" % x, dict(s, text=t.replace(x, "planted"))))
        return out

    def wanted(self, a):
        """the statement the assertion asks for, in the trace's own form"""
        if a.by is not None:
            return {"kw": "call", "text": "%s(%s%s)" % (a.by, a.target, "" if a.to is None else ", %s" % a.to)}
        return {"sets": {"kw": "set", "text": "%s ← %s" % (a.target, "x" if a.to is None else a.to)},
                "calls": {"kw": "call", "text": "%s(%s)" % (a.target, ", ".join(a.args))},
                "branches": {"kw": "branch", "text": "if %s then" % a.target},
                "reads": {"kw": "call", "text": "Use(%s)" % a.target}}[a.verb]

    def verdict(self, a):
        """{holds, matched, fp, plant, why} - holds None when the assertion is malformed or its place names nothing"""
        if a.verb is None or not a.at:
            return {"holds": None, "why": "malformed: one verb and a place, U18"}
        try:
            refs = self.place(a.at)
        except KeyError as e:
            return {"holds": None, "why": "its place names nothing: %s" % e}
        hit = [r for r in refs if self.matches(a, self.T.stmt[r])]
        v = {"holds": bool(hit), "matched": hit, "read": len(refs),
             # the code this verdict rests on: what it matched, or everything at the place when nothing did
             "fp": sha("\n".join(self.T.stmt[r]["text"] for r in (hit or refs)))}
        if hit:
            still = ["%s (%s)" % (r, what) for r in hit for what, m in self.mutants(a, self.T.stmt[r]) if self.matches(a, m)]
            v["plant"] = "flips" if not still else "does not flip: " + "; ".join(still)
            v["why"] = "%s at %s" % (a.verb, ", ".join(hit))
        else:
            v["plant"] = "flips" if self.matches(a, self.wanted(a)) else "does not flip: the statement it asks for does not satisfy it"
            v["why"] = "no statement at %s %s %s%s (read %d)" % (a.at, a.verb, a.target, "" if a.to is None else " to %s" % a.to, len(refs))
        return v

    def names(self, texts):
        """every code-shaped name in the texts -> 'code' | 'paste' | None"""
        out = {}
        for t in texts:
            for m in self.SHAPED.finditer(t or ""):
                n = m.group(1) or m.group(2)
                out[n] = "code" if n in self.code else "paste" if n in self.paste else None
        return out

    def run(self, M, out_path):
        """every requirement's assertions and every name, written to verdicts.json for usecase_kg.py loop"""
        assertions, says = {}, {}
        for r in M["requirements"].values():
            req = ucm.Requirement(r)
            for a in req.effect:
                assertions[a.id] = dict(self.verdict(a), at=a.at, text=a.text())
            says[req.id] = sorted(self.names([req.text]))
        terms = [ucm.Term(t) for t in M["terms"]]
        named = self.names([r.get("text") for r in M["requirements"].values()])
        for t in terms:
            for b in t.binds:
                named[b] = "code" if b in self.code else "paste" if b in self.paste else None
        for a in [ucm.Requirement(r) for r in M["requirements"].values()]:
            for x in a.effect:
                for n in [x.target, x.by]:       # the call a write goes through is a code name as much as its target
                    if n:
                        named[str(n)] = "code" if n in self.code else "paste" if n in self.paste else None
        doc = {"format": "effect-verdicts/1", "trace": sha(json.dumps(self.T.t, sort_keys=True)), "assertions": assertions,
               "names": named, "says": says}
        io.open(out_path, "w", encoding="utf-8").write(json.dumps(doc, indent=1, sort_keys=True))
        return doc


def build(model_dir, trace_dir, exclusions_file=None, trace_md=None):
    M = load_model(model_dir)
    T = Trace(trace_dir)
    excl = {}
    if exclusions_file:
        for e in (yaml.safe_load(io.open(exclusions_file, encoding="utf-8")) or {}).get("exclusions") or []:
            excl[e["ref"]] = e["why"]
    bad = []
    covered_stmt = {}       # ref -> [(pathway, reqs)]
    covered_out = {}        # outcome ref -> [(pathway, reqs)]
    graph_cited = {}        # alias -> [(pathway, reqs)]
    pathway_code = []       # (uc, pathway label, text, reqs, cites)
    for uc in M["usecases"]:
        legs = [("%s.%d" % (uc["id"], i + 1), s.get("do", ""), s.get("reqs") or [], s.get("code") or []) for i, s in enumerate(uc.get("steps") or [])]
        legs += [("%s.%d%s" % (uc["id"], e.get("at"), chr(97 + i)), e.get("when", ""), e.get("reqs") or [], e.get("code") or [])
                 for i, e in enumerate(uc.get("ext") or [])]
        for label, text, reqs, cites in legs:
            pathway_code.append((uc["id"], label, text, reqs, cites))
            for c in cites:
                try:
                    kind, stmts, oref = T.resolve(c)
                except KeyError as e:
                    bad.append("%s cites %s: %s" % (label, c, e))
                    continue
                if kind == "graph":
                    graph_cited.setdefault(c, []).append((label, reqs))
                if oref:
                    if oref in excl:
                        bad.append("%s cites %s, which exclusions say cannot happen (%s)" % (label, oref, excl[oref]))
                    covered_out.setdefault(oref, []).append((label, reqs))
                for s in stmts:
                    covered_stmt.setdefault(s, []).append((label, reqs))
    for oref in excl:
        if oref not in T.outcomes:
            bad.append("exclusion %s names no outcome" % oref)

    def reqs_of(entries):
        out = []
        for _, rs in entries:
            for r in rs:
                if r not in out:
                    out.append(r)
        return out

    # Blueprint units: covered through any graph node they became (a graph's entry or exit through the graph's own cite)
    unit_spaces = {}
    unit_uncovered = []
    for u in T.units:
        entries = []
        for ref in u["refs"]:
            entries += covered_stmt.get(ref, []) if "#" in ref else graph_cited.get(ref, [])
        sp = unit_spaces.setdefault(u["file"], {})
        if entries:
            sp[u["name"]] = reqs_of(entries)
        elif u.get("why"):
            # a node that is no code, or that nothing in its copy runs (the trace says which, view/trace_cli.js): dealt with, by its reason
            sp[u["name"]] = {"excluded": u["why"]}
        else:
            unit_uncovered.append("%s:%s (%s, line %d)" % (u["file"], u["name"], u["cls"], u["line"]))
    # outcomes
    out_cells, out_uncovered = {}, []
    for oref in T.outcomes:
        if oref in excl:
            out_cells[oref] = {"excluded": excl[oref]}
        elif oref in covered_out:
            out_cells[oref] = reqs_of(covered_out[oref])
        else:
            out_uncovered.append(oref)
    # paths: every outcome on it covered (or the path excluded through an excluded outcome), and its graph cited
    path_cells, path_uncovered = {}, []
    for p in T.paths:
        ex = [o for o in p["outs"] if o in excl]
        if ex:
            path_cells[p["ref"]] = {"excluded": "takes %s, which cannot happen: %s" % (ex[0], excl[ex[0]])}
            continue
        miss = [o for o in p["outs"] if o not in covered_out]
        g_ok = p["graph"] in graph_cited or any(s in covered_stmt for s in T.top(p["graph"])[:1])
        if miss or not g_ok:
            path_uncovered.append("%s (%s)" % (p["ref"], ", ".join(miss) if miss else "its graph is cited by no step"))
            continue
        entries = graph_cited.get(p["graph"], [])
        for o in p["outs"]:
            entries = entries + covered_out[o]
        path_cells[p["ref"]] = reqs_of(entries)

    # the brainstorm at each step: the questions its code raises
    answers = {}
    for sp in M["spaces"]:
        if sp.get("id") == "S-Q":
            answers = sp.get("cells") or {}
    step_questions = {}
    unasked = []
    for q in T.questions:
        raised = False
        for uc, label, text, reqs, cites in pathway_code:
            # a question is raised at the step whose code it is about: a statement the step reaches, or an outcome it cites
            # (a rule written twice is about two outcomes, not one statement)
            reach = set()
            for c in cites:
                try:
                    reach.update(T.resolve(c)[1])
                    reach.add(c)
                except KeyError:
                    pass
            if reach.intersection(q["refs"]):
                step_questions.setdefault(label, []).append(q["id"])
                raised = True
        if not raised:
            unasked.append(q["id"])

    # write the generated spaces
    rel = lambda p: os.path.relpath(p, model_dir).replace("\\", "/")
    spaces = []
    paste_dir = os.path.dirname(os.path.abspath(model_dir))
    for f in sorted(unit_spaces):
        spaces.append({"id": "S-BP-" + re.sub(r"\W", "", os.path.splitext(f)[0]), "title": "every node of the Blueprint text " + f,
                       "basis": "code", "kind": "extract", "file": rel(os.path.join(paste_dir, f)), "pattern": UNIT_PATTERN,
                       "cells": unit_spaces[f]})
    spaces.append({"id": "S-OUT", "title": "every outcome of every decision in the converted graphs", "basis": "code", "kind": "extract",
                   "file": rel(os.path.join(trace_dir, "outcomes.txt")), "pattern": r"(?m)^outcome (\S+)$", "cells": out_cells})
    spaces.append({"id": "S-PATH", "title": "every path from a graph's entry to an exit", "basis": "code", "kind": "extract",
                   "file": rel(os.path.join(trace_dir, "paths.txt")), "pattern": r"(?m)^path (\S+) =", "cells": path_cells})
    head = ("# GENERATED by tools/logic_map.py from the steps' `code:` cites and the trace (%s) - never edit by hand.\n"
            "# Each cell is the requirements of the steps whose cites reach that key; a key no step reaches has no cell, and the gap\n"
            "# checker (autobot/usecase_model.py U7) names it.\n" % rel(trace_dir))
    io.open(os.path.join(model_dir, "generated.yaml"), "w", encoding="utf-8", newline="\n").write(
        head + yaml.safe_dump({"spaces": spaces}, sort_keys=False, allow_unicode=True, width=200))

    # cites.json for the suggester: each covered statement -> every step citing it
    cites_json = {ref: sorted({lab for lab, _ in entries}) for ref, entries in covered_stmt.items()}
    io.open(os.path.join(trace_dir, "cites.json"), "w", encoding="utf-8").write(json.dumps(cites_json, indent=1, sort_keys=True))

    # chain.json for the retrieval layer (view/rag.js) and the page: each use case's pathways with the statements they reach, every
    # requirement, and each question's answer - the chain the trace is joined by, as data
    legs_by_uc = {}
    for uc, label, text, reqs, cites in pathway_code:
        reach = []
        for c in cites:
            try:
                for s in T.resolve(c)[1]:
                    if s not in reach:
                        reach.append(s)
            except KeyError:
                pass
        legs_by_uc.setdefault(uc, []).append({"label": label, "text": text, "reqs": list(reqs), "cites": list(cites), "statements": reach})
    chain = {"usecases": [{"id": u["id"], "name": u.get("name", ""), "level": u.get("level", ""), "parent": u.get("parent"),
                           "legs": legs_by_uc.get(u["id"], [])} for u in M["usecases"]],
             "requirements": [{"id": r["id"], "kind": r.get("kind"), "text": r.get("text", ""), "measure": r.get("measure", ""), "why": r.get("why", "")}
                              for r in M["requirements"].values()],
             "answers": {k: v for k, v in answers.items()},
             # each path's requirements (or why it cannot happen), each outcome's: what a replay of that path means
             "paths": path_cells, "outcomes": out_cells,
             # the persona questions, each inverted into the use case that answers it: the model's own natural-language layer
             "asks": [{"id": q["id"], "text": q.get("text", ""), "inverse": q.get("inverse")} for q in M["questions"]]}
    io.open(os.path.join(trace_dir, "chain.json"), "w", encoding="utf-8").write(json.dumps(chain, indent=1))

    # the effects: every requirement's assertions held to the code, each planted the other way (usecase_kg.py loop reads this)
    pastes = [io.open(os.path.join(paste_dir, f), encoding="utf-8").read() for f in sorted(unit_spaces)]
    eff = EffectCheck(T, pastes).run(M, os.path.join(trace_dir, "verdicts.json"))

    n_units = len(T.units)
    n_out = len(T.outcomes)
    n_paths = len(T.paths)
    print("logic_map: %d use cases, %d pathways cite code" % (len(M["usecases"]), sum(1 for x in pathway_code if x[4])))
    print("  Blueprint nodes : %d of %d reached by a step%s" % (n_units - len(unit_uncovered), n_units, "" if not unit_uncovered else "; NOT: " + ", ".join(unit_uncovered[:12])))
    print("  outcomes        : %d of %d cited, %d excluded with a reason%s" % (len([o for o in out_cells if not isinstance(out_cells[o], dict)]), n_out,
                                                                        len(excl), "" if not out_uncovered else "; NOT: " + ", ".join(out_uncovered[:12])))
    print("  paths           : %d of %d covered, %d excluded (an outcome that cannot happen)%s" % (
        len([p for p in path_cells if not isinstance(path_cells[p], dict)]), n_paths, len([p for p in path_cells if isinstance(path_cells[p], dict)]),
        "" if not path_uncovered else "; NOT: " + ", ".join(path_uncovered[:8])))
    answered = [q["id"] for q in T.questions if q["id"] in answers]
    print("  brainstorm      : %d questions, raised at %d steps; %d answered in S-Q, %d not%s" % (
        len(T.questions), len(step_questions), len(answered), len(T.questions) - len(answered),
        "" if not unasked else "; raised at NO step: " + ", ".join(unasked)))
    av = list(eff["assertions"].values())
    print("  effects         : %d assertions - %d hold, %d fail, %d unread; %d planted the other way and flipped" % (
        len(av), sum(1 for v in av if v["holds"] is True), sum(1 for v in av if v["holds"] is False),
        sum(1 for v in av if v["holds"] is None), sum(1 for v in av if v.get("plant") == "flips")))
    lost = sorted(n for n, w in eff["names"].items() if w is None)
    print("  names           : %d code names in the requirements, terms and effects; %d unresolved%s" % (
        len(eff["names"]), len(lost), "" if not lost else ": " + ", ".join(lost[:12])))
    for b in bad:
        print("  BAD: " + b)
    if trace_md:
        write_trace_md(trace_md, M, T, pathway_code, step_questions, answers, covered_stmt, graph_cited)
    return 1 if (bad or unit_uncovered or out_uncovered or path_uncovered or unasked) else 0


def write_trace_md(path, M, T, pathway_code, step_questions, answers, covered_stmt, graph_cited):
    """the chain, readable: top down and bottom up"""
    reqs = M["requirements"]
    ucs = {u["id"]: u for u in M["usecases"]}
    kids = {}
    for u in M["usecases"]:
        if u.get("parent"):
            kids.setdefault(u["parent"]["uc"], []).append(u["id"])
    L = ["# The trace: every piece of the Blueprint, the step it realises, the requirement it serves",
         "", "Generated by `tools/logic_map.py` from the model and the trace. Top down: each use case, its steps in order, the code each",
         "step cites and the questions that code raises (each with its answer). Bottom up: each Blueprint node and the chain above it.", ""]

    def stmt_lines(cites):
        out = []
        for c in cites:
            kind, stmts, oref = T.resolve(c)
            if oref:
                out.append("    - `%s` (%s)" % (c, T.outcomes[oref]["label"]))
            elif kind == "graph":
                out.append("    - `%s` (%s)" % (c, T.graphs[c]["title"] or T.graphs[c]["name"]))
            for s in stmts:
                out.append("      - `%s` %s" % (s, T.stmt[s]["text"][:140].replace("|", "/")))
        return out

    def walk(uid, depth):
        u = ucs[uid]
        L.append("%s %s %s (%s)" % ("#" * min(2 + depth, 5), u["id"], u["name"], u["level"]))
        L.append("")
        for i, s in enumerate(u.get("steps") or []):
            label = "%s.%d" % (uid, i + 1)
            L.append("%d. %s  [%s]" % (i + 1, s.get("do", ""), ", ".join(s.get("reqs") or [])))
            L.extend(stmt_lines(s.get("code") or []))
            for q in step_questions.get(label, []):
                L.append("    - ask: %s -> %s" % (q, ", ".join(answers.get(q, ["UNANSWERED"])) if not isinstance(answers.get(q), dict) else "excluded: " + answers[q]["excluded"]))
        for i, e in enumerate(u.get("ext") or []):
            label = "%s.%d%s" % (uid, e.get("at"), chr(97 + i))
            L.append("- %s%s when %s: %s -> %s  [%s]" % (e.get("at"), chr(97 + i), e.get("when", ""), "; ".join(e.get("do") or []), e.get("out", ""), ", ".join(e.get("reqs") or [])))
            L.extend(stmt_lines(e.get("code") or []))
            for q in step_questions.get(label, []):
                L.append("    - ask: %s -> %s" % (q, ", ".join(answers.get(q, ["UNANSWERED"])) if not isinstance(answers.get(q), dict) else "excluded: " + answers[q]["excluded"]))
        L.append("")
        for k in kids.get(uid, []):
            walk(k, depth + 1)

    L.append("## Top down")
    L.append("")
    for u in M["usecases"]:
        if not u.get("parent"):
            walk(u["id"], 0)
    L.append("## Bottom up: each Blueprint node -> the steps -> the requirements")
    L.append("")
    for u in T.units:
        steps = []
        for ref in u["refs"]:
            steps += [lab for lab, _ in (covered_stmt.get(ref, []) if "#" in ref else graph_cited.get(ref, []))]
        steps = sorted(set(steps))
        rs = sorted({r for ref in u["refs"] for _, rr in (covered_stmt.get(ref, []) if "#" in ref else graph_cited.get(ref, [])) for r in rr})
        L.append("- `%s` %s (line %d) -> %s -> %s -> %s" % (u["name"], u["cls"].replace("K2Node_", ""), u["line"], ", ".join(u["refs"]) or "-",
                                                         ", ".join(steps) or "NO STEP", ", ".join(rs) or "-"))
    io.open(path, "w", encoding="utf-8", newline="\n").write("\n".join(L) + "\n")


def selftest():
    """a two-graph trace and a one-use-case model: full coverage passes; an uncited outcome, a dangling cite and an outcome both
    cited and excluded each fail"""
    tmp = tempfile.mkdtemp(prefix="logic_map_")
    tr = os.path.join(tmp, "trace")
    os.makedirs(tr)
    trace = {"graphs": [{"alias": "G", "name": "C.G", "title": "", "statements": [
        {"id": "s1", "depth": 0, "text": "if X then", "kw": "branch", "under": None}, {"id": "s2", "depth": 1, "text": "Y(X)", "kw": "call", "under": "s1"}]}],
        "decisions": [{"ref": "G#s1", "graph": "G", "outcomes": [{"ref": "G#s1:then", "label": "then", "body": ["s2"]}, {"ref": "G#s1:else", "label": "else", "body": []}]}],
        "paths": [{"ref": "G#P1", "graph": "G", "outs": ["G#s1:then"]}, {"ref": "G#P2", "graph": "G", "outs": ["G#s1:else"]}],
        "units": [{"file": "a.t3d", "name": "N1", "cls": "K2Node_IfThenElse", "line": 1, "refs": ["G#s1"]},
                  {"file": "a.t3d", "name": "N2", "cls": "K2Node_CallFunction", "line": 3, "refs": ["G#s2"]}],
        "questions": [{"id": "Q-ELSE.G#s1", "refs": ["G#s1"], "rule": "ELSE", "text": "?"}]}
    json.dump(trace, io.open(os.path.join(tr, "trace.json"), "w", encoding="utf-8"))
    io.open(os.path.join(tmp, "a.t3d"), "w", encoding="utf-8").write(
        'Begin Object Class=/Script/BlueprintGraph.K2Node_IfThenElse Name="N1"\nEnd Object\n'
        'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="N2"\nEnd Object\n')
    md = os.path.join(tmp, "model")
    os.makedirs(md)

    def model(steps, ext):
        uc = {"id": "UC-1", "name": "n", "level": "sea", "steps": steps, "ext": ext}
        io.open(os.path.join(md, "m.yaml"), "w", encoding="utf-8").write(yaml.safe_dump(
            {"usecases": [uc], "requirements": [{"id": "R-1"}], "spaces": [{"id": "S-Q", "cells": {"Q-ELSE.G#s1": ["R-1"]}}]}))
    cases = [
        ("everything cited", [{"do": "a", "reqs": ["R-1"], "code": ["G", "G#s1:then"]}], [{"at": 1, "when": "w", "reqs": ["R-1"], "code": ["G#s1:else"]}], None, 0),
        ("an outcome nobody cites", [{"do": "a", "reqs": ["R-1"], "code": ["G", "G#s1:then"]}], [], None, 1),
        ("a cite naming nothing", [{"do": "a", "reqs": ["R-1"], "code": ["G", "G#s1:then", "G#s9"]}], [{"at": 1, "when": "w", "reqs": ["R-1"], "code": ["G#s1:else"]}], None, 1),
        ("an outcome cited AND excluded", [{"do": "a", "reqs": ["R-1"], "code": ["G", "G#s1:then"]}], [{"at": 1, "when": "w", "reqs": ["R-1"], "code": ["G#s1:else"]}], "G#s1:else", 1),
    ]
    ok = True
    for what, steps, ext, ex, want in cases:
        model(steps, ext)
        exf = None
        if ex:
            exf = os.path.join(tmp, "ex.yaml")
            io.open(exf, "w", encoding="utf-8").write(yaml.safe_dump({"exclusions": [{"ref": ex, "why": "cannot"}]}))
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            got = build(md, tr, exf)
        print("selftest: %-34s -> exit %d %s" % (what, got, "PASS" if got == want else "FAIL (wanted %d)" % want))
        ok &= got == want
    # the effects: assertions that hold, fail, or name no place - and each verdict planted the other way
    ec = EffectCheck(Trace(tr), ['Begin Object Class=X Name="N1"'])
    for i, (d, holds) in enumerate([({"branches": "X", "at": "G#s1"}, True), ({"calls": "Y", "at": "G#s1:then"}, True),
                                    ({"calls": "Z", "at": "G"}, False), ({"sets": "X", "at": "G"}, False),
                                    ({"sets": "X", "by": "Y", "at": "G"}, True), ({"sets": "X", "by": "Q", "at": "G"}, False),
                                    ({"calls": "Y", "at": "G#s1:else"}, False), ({"calls": "Y", "at": "G#s9"}, None)]):
        v = ec.verdict(ucm.Assertion("R-1", i + 1, d))
        good = v["holds"] is holds and (holds is None or v["plant"] == "flips")
        print("selftest: effect %-26s -> holds %-5s plant %-6s %s" % (ucm.Assertion("R-1", 1, d).text()[:26], v["holds"],
                                                                         v.get("plant", "-")[:6], "PASS" if good else "FAIL"))
        ok &= good
    got = ec.names(["`X` and Master_Enemy, N1 and plain words"])
    good = got == {"X": "code", "Master_Enemy": None}
    print("selftest: names %r -> %s" % (got, "PASS" if good else "FAIL"))
    ok &= good
    print("selftest: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["selftest"]:
        sys.exit(selftest())
    if len(a) >= 3 and a[0] == "build":
        ex = a[a.index("--exclusions") + 1] if "--exclusions" in a else None
        tm = a[a.index("--trace-md") + 1] if "--trace-md" in a else None
        sys.exit(build(a[1], a[2], ex, tm))
    sys.exit(__doc__)
