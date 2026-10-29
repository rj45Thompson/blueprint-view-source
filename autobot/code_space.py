#!/usr/bin/env python3
"""code_space.py - a CLOSED space read from C# code, for a use-case document to be measured against.

usecase-interrogate's rule: each round of interrogation needs a space of a different SHAPE, because a space of one shape
cannot see a hole of another (a space of constants never sees a missing step). The step tables and the who/what/why
baseline are one shape; the CODE is another. This builds that one generically - every method (and expression-bodied
property) the given files declare, optionally only names matching --match - and marks each OWNED by the use case whose
section names it in backticks (`Name`, `Type.Name`, `Name(`). A declared method no use case names is a hole: behaviour
the model does not describe. Written 2026-10-26 for a gap check of a lighting feature's use case descriptions; the
inventory has its own, richer builder (.opus-tools/inventory/inventory_spaces.py), this is the general one.

    py .opus-tools/autobot/code_space.py --doc DOC.md --file A.cs [--file B.cs] [--match REGEX] --game NAME --out SPACE.json
    py .opus-tools/autobot/coverage.py   --space SPACE.json --game NAME --docs DOC.md      # exit 1 while any is unowned
    py .opus-tools/autobot/code_space.py --selftest

A use-case section is a heading that names a UC id (`## UC-901 ...`, `### UC-5 ...`) up to the next heading of any level;
naming a method anywhere else (a class model, prose) does not own it - only a use case does. The tool never edits the
document it measures. It prints how many declarations it read per file, so the count can be held against an outside one.
"""
import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

KEYWORDS = ("if for foreach while switch catch using return new lock else do try throw await yield case var get set "
            "when nameof typeof sizeof default checked unchecked fixed").split()
MODS = r"(?:(?:public|internal|private|protected|static|override|virtual|abstract|sealed|async|unsafe|new|partial|extern|readonly)\s+)*"
TYPE = r"(?!(?:%s)\b)[\w.]+(?:<[^()=;]*?>)?(?:\[\])?\??" % "|".join(KEYWORDS)
METHOD = re.compile(r"^\s*(?:\[[^\]\n]*\]\s*)*" + MODS + TYPE + r"\s+(\w+)\s*(?:<[\w\s,]*>)?\s*\(", re.M)
PROPERTY = re.compile(r"^\s*" + MODS + TYPE + r"\s+(\w+)\s*=>", re.M)
UC_HEADING = re.compile(r"^#{1,6}\s.*?\b(UC-\d+)\b")
ANY_HEADING = re.compile(r"^#{1,6}\s")


def declarations(path):
    """[(name, line)] for every method and expression-bodied property the file declares, in file order."""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    found = []
    for rx in (METHOD, PROPERTY):
        for m in rx.finditer(text):
            name = m.group(1)
            if name in KEYWORDS:
                continue
            found.append((name, text.count("\n", 0, m.start(1)) + 1))
    found.sort(key=lambda d: d[1])
    return found


def uc_sections(doc):
    """{UC id: section text} - only headings that name a UC id open a section; any heading closes it."""
    secs, cur, buf = {}, None, []
    for line in Path(doc).read_text(encoding="utf-8").splitlines():
        if ANY_HEADING.match(line):
            if cur:
                secs[cur] = secs.get(cur, "") + "\n".join(buf)
            m = UC_HEADING.match(line)
            cur, buf = (m.group(1) if m else None), []
            continue
        if cur:
            buf.append(line)
    if cur:
        secs[cur] = secs.get(cur, "") + "\n".join(buf)
    return secs


def owner(name, secs):
    rx = re.compile(r"`(?:[\w.]+\.)?" + re.escape(name) + r"(?:`|\(|<)")
    for uc, text in secs.items():
        if rx.search(text):
            return uc
    return None


def build(doc, files, match, game):
    secs = uc_sections(doc)
    if not secs:
        sys.exit("code_space: %s has no use-case section (a heading naming UC-n) - nothing could own anything" % doc)
    keep = re.compile(match) if match else None
    feats = []
    for f in files:
        decls = declarations(f)
        picked = [(n, ln) for n, ln in decls if not keep or keep.search(n)]
        print("  %-60s %4d declarations read, %d selected" % (Path(f).name, len(decls), len(picked)))
        seen = set()
        for name, line in picked:
            if name in seen:      # overloads: one feature per name per file, at its first declaration
                continue
            seen.add(name)
            uc = owner(name, secs)
            feats.append({"id": "CODE-%s.%s" % (Path(f).stem, name), "name": name,
                          "cells": {game: {"v": "yes", "basis": "source", "src": "%s:%d" % (Path(f).as_posix(), line)}},
                          "ours": {"uc": uc} if uc else {}})
    return {"about": "code_space.py: every declaration in %s%s, owned by the use case of %s that names it"
                     % (", ".join(Path(f).name for f in files), " matching /%s/" % match if match else "", Path(doc).name),
            "features": feats}


def selftest():
    with tempfile.TemporaryDirectory() as d:
        cs = Path(d, "T.cs")
        cs.write_text("class T {\n"
                      "    internal static int Alpha(int x) { return Beta(x); }\n"
                      "    void Beta(int y)\n    {\n        var q = Gamma(2);\n        Foo.Bar(q);\n        if (q > 0) Delta(1);\n    }\n"
                      "    public static System.Collections.Generic.HashSet<string> Gamma<U>(System.Collections.Generic.IList<U> l) where U : struct => null;\n"
                      "    internal bool Showing =>\n        true;\n"
                      "}\n", encoding="utf-8")
        doc = Path(d, "D.md")
        doc.write_text("# Model\n\nProse naming `Beta` outside any use case.\n\n## UC-001 - first\n\n| 1 | step | - | `T.Alpha`, `Gamma` | r |\n\n"
                       "## Class model\n\n`Showing` is named here, not in a use case.\n", encoding="utf-8")
        got = {f["name"]: f["ours"].get("uc") for f in build(doc, [cs], None, "t")["features"]}
        want = {"Alpha": "UC-001", "Beta": None, "Gamma": "UC-001", "Showing": None}
        ok = got == want
        print("selftest: declarations %s -> %s" % (sorted(got), "PASS" if ok else "FAIL, wanted %r got %r" % (want, got)))
        print("  (a call `Beta(x)`, `var q = Gamma(2)`, `Foo.Bar(q)` and `if (...) Delta(1)` are not declarations; "
              "`Beta` named outside a use case and `Showing` named in the class model are NOT owned)")
        return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--doc")
    ap.add_argument("--file", action="append", default=[])
    ap.add_argument("--match", help="keep only declarations whose name matches this regex")
    ap.add_argument("--game", default="code", help="the cells.<game> column coverage.py selects on")
    ap.add_argument("--out")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not (a.doc and a.file and a.out):
        ap.error("--doc, --file and --out are required (or --selftest)")
    space = build(a.doc, a.file, a.match, a.game)
    if not space["features"]:
        sys.exit("code_space: 0 declarations selected - an empty space proves nothing (check --file / --match)")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(space, indent=1), encoding="utf-8")
    owned = sum(1 for f in space["features"] if f["ours"])
    print("code_space: %d declarations, %d owned by a use case, %d not -> %s" % (len(space["features"]), owned,
          len(space["features"]) - owned, a.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
