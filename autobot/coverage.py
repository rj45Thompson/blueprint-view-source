#!/usr/bin/env python3
"""coverage.py - prove "every requirement", instead of asserting it.

WHY THIS IS A SEPARATE TOOL AND NOT MORE ROWS IN A DOCUMENT

The task it was written for (2026-09-08): list every requirement of a space shooter as UML use
cases, in a way that can show the list gathers every single requirement and not merely most of them.

You cannot reach "every" by writing more rows. A longer list is still a list of what somebody
happened to think of, and no amount of careful prose turns that into completeness. "Every" is only
provable against a CLOSED SPACE: enumerate a source that is known to be finite, then show each
element is either mapped to a use case or explicitly absent with the search that proved it. That is
the anchor law's first step - propose from a fixed space - applied to requirements gathering rather
than to facts.

So this tool does not gather anything. It measures whether the gathering is COMPLETE, and exits
non-zero naming exactly what is missing. Loop 4's rule is that every rule which matters is an exit
code; this is that rule for coverage.

MEASURED STATE WHEN THIS WAS WRITTEN (2026-09-08, on a space-shooter project)
  genre/genre_matrix.json holds 70 features, F01-F70. 18 carry cells.starblast.v == "yes", and all
  18 cite basis "source" (a real URL) rather than "recall" - the space itself is clean.
  Of those 18, only 9 carried a use-case id. Nine did not: F02 F20 F40 F56 F58 F59 F64 F68 F69.
  Separately, TWO disjoint id schemes name the same game's use cases - UC-101..UC-606 (51 ids, used
  across the repo and referenced by the matrix) and SB-1.1..SB-4.3 (21 ids, in one document). A
  completeness claim spanning two unjoined schemes is not checkable, which is why this reports the
  collision as its own failure rather than picking a winner silently.

  py .opus-tools/autobot/coverage.py --space <project>/genre/genre_matrix.json \
      --game starblast --docs <project>/STARBLAST_USE_CASES.md
"""
import argparse
import collections
import io
import json
import os
import re
import sys

# The same use-case id grammar as interrogate.py's UCID: an optional LETTER namespace (UC-BP1, UC-A1) and any number of digits
# (UC-5, UC-901). It was `UC-\d{3}`, which saw NO id in a namespaced document, so every mapping read as an orphan - measured
# 2026-10-27 on the first Blueprint-view model (now quarantine/blueprint_view/history/USECASES_1027.md): 20/20 mapped, "0 UC-* id(s)" in a document defining all ten, 10 false orphans.
# interrogate.py had already been fixed for the same failure (59 false orphans on ASTEROID_USE_CASES.md); the two must agree.
UC = re.compile(r"\bUC-[A-Z]*\d+(?:\.\d+)*\b")
SB = re.compile(r"\bSB-\d\.\d+\b")


def dig(obj, path):
    """ours.uc -> obj['ours']['uc'], tolerating a missing link anywhere along the way."""
    for part in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


STEP_ROW = re.compile(r"^\|\s*\d+(?:\.\d+)*\s*\|")
# an alternate pathway carries requirements too (every pathway of a use case is accounted for, not only the main scenario), written
# as a bullet ("- 3a. ..."), an inline label ("**Extensions**: 1a. ...") or a bold label ("**Extension 3a - ...:**") - interrogate.py's shapes
EXT_ROW = re.compile(r"^\s*(?:[-*]\s+\**\d+[a-z]+\.|(?:[-*]\s+)?\**Extensions?\b)", re.I)


def uc_sections(texts):
    """use-case id -> the step rows AND alternate-pathway lines under the heading that names it (to the next heading)"""
    out = collections.defaultdict(list)
    for t in texts:
        cur = None
        for line in t.splitlines():
            h = re.match(r"^#{1,3}\s+(.*)$", line)
            if h:
                ids = UC.findall(h.group(1))
                cur = ids[0] if ids else None
                continue
            if cur and (STEP_ROW.match(line.strip()) or EXT_ROW.match(line)):
                out[cur].append(line)
    return out


def measure(feats, game, map_path, texts, missing_docs=()):
    """-> (printed lines, failures, selected count). Pure: the documents arrive as text, so --selftest can plant faults."""
    lines, fails = [], []
    sel, basis = [], collections.Counter()
    for f in feats:
        cell = (f.get("cells") or {}).get(game) or {}
        if cell.get("v") == "yes":
            sel.append(f)
            basis[cell.get("basis") or "none"] += 1

    mapped = [f for f in sel if dig(f, map_path)]
    unmapped = [f for f in sel if not dig(f, map_path)]
    ids_in_space = sorted({dig(f, map_path) for f in mapped})

    # What the documents actually carry, and under which scheme.
    doc_uc, doc_sb = set(), set()
    for t in texts:
        doc_uc |= set(UC.findall(t))
        doc_sb |= set(SB.findall(t))

    lines.append("  %d features in the space, %d selected by cells.%s.v == yes" % (len(feats), len(sel), game))
    lines.append("  basis of the selection: %s" % dict(basis))
    # An EMPTY selection must fail. Its null case was run when this was written: --game no_such_game
    # selected 0 features, scored 0/0 as 100% and PASSED - so a typo in the game name would have
    # green-lit a claim of total coverage over nothing at all. The sibling failure landed in the
    # benchmark the same night from the other direction (an empty ABSENCE category scored 0/0 as 0%
    # and dragged the score down). Empty is neither pass nor fail on its own: it means the selector
    # matched nothing, and that is a broken question, not an answer.
    if not sel:
        fails.append(("empty", "cells.%s.v == yes selected NOTHING out of %d features - the "
                               "selector matched no rows, so there is no space to prove anything "
                               "against (is '%s' spelled the way the matrix spells it?)"
                      % (game, len(feats), game)))
    if basis.get("recall"):
        fails.append(("basis", "%d selected feature(s) rest on RECALL, not a source - that is "
                               "memory, and memory is a guess under the anchor law"
                      % basis["recall"]))

    pct = (100.0 * len(mapped) / len(sel)) if sel else 100.0
    lines.append("  MAPPED     %5.1f%%   %d/%d carry a use-case id at '%s'" % (pct, len(mapped), len(sel), map_path))
    if unmapped:
        fails.append(("unmapped", "%d selected feature(s) have NO use case: %s"
                      % (len(unmapped), " ".join(f.get("id", "?") for f in unmapped))))

    lines.append("  DOCS       %d UC-* id(s), %d SB-* id(s) across %d document(s)"
                 % (len(doc_uc), len(doc_sb), len(texts)))
    for d in missing_docs:
        fails.append(("docs", "%s does not exist" % d))

    # An id scheme the space and the documents do not share cannot support a completeness claim,
    # because the denominator is ambiguous. The collision that matters is SPACE vs DOC, not doc vs
    # doc: the space here names UC-*, the document names SB-*, and nothing joins them.
    if ids_in_space and doc_sb and not (set(ids_in_space) & doc_uc):
        fails.append(("schemes", "the space names %d UC-* id(s) and the documents name %d SB-* "
                                 "id(s), with NO id in common - two schemes for one game"
                      % (len(ids_in_space), len(doc_sb))))

    # No `if doc_uc` guard here. An earlier version skipped this whole check when the documents
    # carried no UC ids at all - which is exactly the case where every id in the space is an
    # orphan. A guard that disables a check in its worst case is a check that proves nothing.
    orphan = sorted(set(ids_in_space) - doc_uc)
    if orphan:
        fails.append(("orphan", "%d id(s) the space names but no document defines: %s"
                      % (len(orphan), " ".join(orphan))))

    # A feature that also names its REQUIREMENT ('req') must find it carried by a step row of the use case it maps to.
    # Mapping a requirement to a use case's NAME proves nothing about the scenario: measured 2026-10-27 on the Blueprint
    # view model, 20/20 mapped and PASS while REQ-BPV-11 and REQ-BPV-13 were carried by no step of any use case.
    sections = uc_sections(texts)
    uncarried = []
    for f in mapped:
        reqs = f.get("req") if isinstance(f.get("req"), list) else ([f.get("req")] if f.get("req") else [])
        uc = dig(f, map_path)
        for r in reqs:
            if uc in doc_uc and not any(re.search(r"\b%s\b" % re.escape(r), row) for row in sections.get(uc, [])):
                uncarried.append("%s (%s -> %s)" % (f.get("id", "?"), r, uc))
    if uncarried:
        fails.append(("carrier", "%d requirement(s) mapped to a use case that no step row of it carries: %s"
                      % (len(uncarried), " ".join(uncarried))))
    return lines, fails, len(sel)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--space", help="the JSON that defines the CLOSED set")
    ap.add_argument("--game", default="starblast", help="cells.<game>.v == yes selects the subset")
    ap.add_argument("--map", default="ours.uc", help="dotted path to the use-case id on a feature")
    ap.add_argument("--docs", nargs="*", default=[], help="documents that should carry those ids")
    ap.add_argument("--selftest", action="store_true", help="plant one fault per failure kind and require each to fire")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.space:
        ap.error("--space is required")

    space = json.load(io.open(a.space, encoding="utf-8"))
    feats = space.get("features") or []
    if not feats:
        sys.exit("no 'features' in %s - this is not a space, so nothing can be proved against it"
                 % a.space)
    texts, missing = [], []
    for d in a.docs:
        if not os.path.exists(d):
            missing.append(d)
            continue
        texts.append(io.open(d, encoding="utf-8", errors="replace").read())

    print("COVERAGE  space=%s  game=%s" % (os.path.basename(a.space), a.game))
    lines, fails, nsel = measure(feats, a.game, a.map, texts, missing)
    print("\n".join(lines))
    if not fails:
        # Say WHY it passed, naming the numbers. A gate that prints only "PASS" is a gate that
        # cannot be distinguished from one that examined nothing.
        print("\n  PASS - all %d '%s' features carry a use-case id, every id is defined in the "
              "documents, one id scheme, and no selection rests on recall." % (nsel, a.game))
        return 0

    print("\n  %d FAILED - 'every' is not provable while these stand:" % len(fails))
    for kind, why in fails:
        print("    [%-8s] %s" % (kind, why))
    return 1


def selftest():
    """The null case passes; each failure kind is planted once and must fire."""
    import copy
    doc = ("## UC-BP1 Read a method\n| # | step | needs | code | req |\n|---|---|---|---|---|\n"
           "| 1 | read | x | y | REQ-A-1 |\n## UC-7 Watch\n| 1 | watch | x | y | REQ-A-2 |\n")
    feats = [{"id": "F1", "req": "REQ-A-1", "cells": {"g": {"v": "yes", "basis": "source"}}, "ours": {"uc": "UC-BP1"}},
             {"id": "F2", "req": "REQ-A-2", "cells": {"g": {"v": "yes", "basis": "source"}}, "ours": {"uc": "UC-7"}}]
    cases = [
        ("clean", None, lambda f, t: None),
        ("empty", "empty", lambda f, t: [x["cells"].clear() for x in f]),
        ("recall", "basis", lambda f, t: f[0]["cells"]["g"].update(basis="recall")),
        ("unmapped", "unmapped", lambda f, t: f[0].pop("ours")),
        ("orphan", "orphan", lambda f, t: f[1]["ours"].update(uc="UC-99")),
        ("carrier", "carrier", lambda f, t: f[0].update(req="REQ-A-9")),
        ("ext-carry", None, lambda f, t: (f[0].update(req="REQ-A-8"),
                                          t.__setitem__(0, t[0].replace("## UC-7", "- 1a. Not found: rejoin 1 (REQ-A-8).\n## UC-7")))),
        ("schemes", "schemes", lambda f, t: t.__setitem__(0, t[0].replace("UC-BP1", "SB-1.1").replace("UC-7", "SB-1.2"))),
    ]
    ok = True
    for name, want, plant in cases:
        f, t = copy.deepcopy(feats), [doc]
        plant(f, t)
        _, fails, _ = measure(f, "g", "ours.uc", t)
        got = sorted({k for k, _ in fails})
        good = (got == []) if want is None else (want in got)
        ok &= good
        print("  selftest %-9s want %-10s got %-28s %s" % (name, want or "nothing", got, "ok" if good else "WRONG"))
    print("coverage selftest: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
