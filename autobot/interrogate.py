#!/usr/bin/env python3
"""interrogate.py - turn holes in the use-case chain into QUESTIONS, ranked, with the hole cited.

THE QUESTION (2026-09-08): can a tool ask questions back, each one generated from a hole in the
use-case chain's reasoning, so that answering them fills in the entire set of requirements?

IT IS POSSIBLE, AND THE REASON IS THAT THE HOLES ARE ALREADY TYPED.
The survey that preceded this file (2026-09-08, across three projects: a tactics game, a space shooter, a site):

  escalation_router.py   ROUTES a question a stuck worker already wrote. It never composes one.
  gap_dashboard.py       counts holes - file_unannotated, method_unannotated, substantive_orphans,
                         pending_asks - and emits NUMBERS, which nobody can answer.
  check_feature_has_req.py --auto-stub  turns an unresolved REQ into a TODO STUB: a placeholder,
                         not a question, and a stub is answerable by nobody in particular.
  agent_graph.py         has rank (thin vs supported) and contradictions and treats UNKNOWN as
                         first class - the raw material - but emits no question either.
  genre_selfcheck.js     guards settled claims; it fails when one breaks, it does not ask.
  coverage.py            (2026-09-08) names which features are unmapped - a hole LIST.

So every piece produces a count, a stub, or a routed human-written question. NOTHING composes a
question from a hole. That is the gap this fills, and it is a small one, because the use-case model
already gives each hole a SHAPE, and a shape with data in it is a question:

  INFERRED requirement -> "step N needs X and no authored requirement covers it: intended?"
  unmapped feature     -> "the space says the parent game does X: do we, and what proves it?"
  orphan use-case id   -> "the space names UC-n and no document defines it: what is the story?"
  unanchored need      -> "step N needs X and no earlier step delivers X: which step should?"

WHY THIS IS THE ONLY ROUTE TO "EVERY REQUIREMENT"
"Did I think of everything?" cannot be answered - the failure is invisible by construction, since
what you did not think of leaves no trace. "Is the question queue empty?" CAN be answered, because
the queue is generated from a closed structure rather than from imagination. That inversion is the
whole idea: completeness stops being a feeling and becomes a count that has to reach zero.

The model's own record says this works. A tactics game's Docs/UseCases.md:86 - "as INFERRED, and all
five of them were real defects." Five holes in the chain, five genuine bugs, found by asking what
the chain needed rather than by reading the code.

  py .opus-tools/autobot/interrogate.py --doc <game>/Docs/UseCases.md \
      [--space <project>/genre/genre_matrix.json --game starblast]

Exit 1 while any question is unanswered. Candidates (heuristic) are REPORTED but never fail the
gate - a guess that can fail a build is worse than no check.
"""
import argparse
import io
import os
import re
import sys

# | 3   | Designer shapes the ground | designer can SEE the map | terrain sculpt | **INFERRED IR-1** |
# | 2.3 | Designer scrubs the timeline | the strip and the runner walk ... | `Rules` | **INFERRED IR-8** |
# The step id is DOTTED in every use case except the epic. An earlier version of this regex demanded
# a plain integer, so it read EPIC-1's table and silently skipped UC-2, -3 and -4: 10 steps and 5 of
# the document's 15 INFERRED markers, reported with a confident question count. Caught by checking
# the parse against a quantity known independently (grep -c INFERRED), which is the only reason a
# partial read is distinguishable from a complete one.
ROW = re.compile(r"^\|\s*(\d+(?:\.\d+)*)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|?\s*$")
INFERRED = re.compile(r"INFERRED\s+(IR-[\d.]+)")
INFERRED_ASKED = re.compile(r"\((IR-[\d.]+)\)\. Is that behaviour|rests on (IR-[\d.]+), which no one")   # the id a HOLE 1 question asks
HEAD = re.compile(r"^#{2,3}\s+(.+?)\s*$")
# An optional LETTER namespace: UC-1 and UC-A1 are both use-case ids. Without this the pattern
# sees NO ids at all in a namespaced document, and every mapping in the space then reads as an
# orphan - measured on starfighter/ASTEROID_USE_CASES.md, 59 orphan questions of which zero were
# real. A check that floods is worse than no check: it is the one people learn to scroll past.
UCID = re.compile(r"\bUC-[A-Z]*\d+(?:\.\d+)*\b")
# A MODULE is one slice of the epic - a use case or the epic itself. The three documents this runs
# against name them three different ways (`## UC-A1`, `### UC-2 (sea level)`, `## EPIC SB-E1`), so
# the pattern has to admit all three or the probe below silently finds nothing to probe.
MODULE_ID = re.compile(r"\b(?:UC|EPIC)[- ]?(?:[A-Z]{1,4}-)?[A-Z]*\d+(?:\.\d+)*\b")
STOP = set("the a an and or of to in on for with that this it its is are was were be been must "
           "can will shall should would could not no yes at by from as if then when what which "
           "who whom whose how why all any each every one two some most more less than".split())

# ---------------------------------------------------------------------------------------------
# THE BASELINE PROBE (2026-09-08). Every use-case module is questioned on who, what, why, when
# and where, and on what runs before it and after it, to grow a baseline of knowledge about the
# module before its steps are judged. It is an on/off option, ON by default; --no-probe switches it off.
#
# WHY THIS IS NOT A TEMPLATE THAT SPAMS SEVEN QUESTIONS PER SECTION. The constant-space check
# above can only find a hole of one SHAPE: a knob nobody claimed. Measured on
# starfighter/ASTEROID_USE_CASES.md - the space said 61/61 claimed and the gate was green, while
# the document had no step at all for "a bullet damages a rock" (`astHitBullet`, a real function).
# A space of constants is structurally blind to a missing STEP, because a missing step consumes no
# constant. So each round of interrogation needs a space of a DIFFERENT SHAPE, and this is the
# shape that finds missing steps: the facts a reader needs about a module before its steps can be
# checked at all. Who acts, what it delivers, why it exists, when it fires, where it lives, what
# runs before it and what runs after.
#
# It asks only what the document does NOT already answer - each facet is detected, not assumed -
# and every question carries the exact line to add, so a question can actually be closed. A check
# that fires on what is already answered is the one people learn to scroll past.
FACETS = [
    ("who", ("actor", "who", "actors"),
     "Who or what drives this module - which actor or system starts it, and where does that actor "
     "live in the code?",
     "**Actor:** <who> - `<symbol>` <file>:<line>"),
    ("what", ("goal", "outcome", "delivers", "what", "result"),
     "What has this module delivered when it is done - the one observable a reader could check?",
     "**Goal:** <the observable that proves it ran>"),
    ("why", ("why", "value", "rationale", "motivation"),
     "Why does this module exist - what breaks, or what is worse, if it is deleted?",
     "**Why:** <what is lost without it>"),
    ("when", ("trigger", "when", "precondition", "entry", "entry precondition"),
     "When does this module run - what event or precondition fires it, and can it fire twice?",
     "**Trigger:** <event or precondition> - `<symbol>` <file>:<line>"),
    ("where", ("where", "code", "lives in", "files"),
     "Where does this module live - which file and which functions are the whole of it?",
     "**Where:** `<symbol>` <file>:<line>, `<symbol>` <file>:<line>"),
    # "After: UC-1" is ambiguous in English - it can mean "this runs after UC-1" or "UC-1 runs
    # after this" - so the two lists must not share a word. Before/After read as the pair; Follows
    # is the unambiguous synonym for the predecessor side. An ambiguous label is worse than a
    # missing one, because the cross-check below would then compare two claims in opposite
    # directions and report the agreement as a contradiction.
    ("before", ("before", "follows", "predecessor", "upstream", "requires"),
     "What must have already happened before this module can run - which module, or is it an "
     "entry point with nothing before it?",
     "**Before:** UC-n  (or: none - entry point)"),
    ("after", ("after", "then", "next", "leads to", "successor", "downstream", "feeds"),
     "What consumes this module's output - which module runs next, or is it terminal?",
     "**After:** UC-n  (or: none - terminal)"),
]
# `**Actor:** x`, `- Actor: x`, `> **Who** - x`. A label has to open the line: a sentence that
# merely contains the word "why" is prose, not an answer, and counting it would make the probe
# pass on documents that answer nothing.
def facet_re(labels):
    alt = "|".join(re.escape(w) for w in labels)
    return re.compile(r"^\s*(?:[-*>]\s*)?\**\s*(?:%s)\s*\**\s*[:—-]\s*\S" % alt, re.I)


FACET_RE = {k: facet_re(labels) for k, labels, _, _ in FACETS}
# A step row whose Thing or Requirement cell carries a backticked symbol or a file:line answers
# "where" on its own - the table already said it, and asking again would be noise.
ANCHOR = re.compile(r"`[A-Za-z_][\w.]{2,}`|\b[\w./-]+\.(?:js|html|cs|py):\d+")


def keywords(text):
    """Content words, lowercased. Used ONLY for the heuristic candidate check."""
    return {w for w in re.findall(r"[a-zA-Z][a-zA-Z0-9_]{2,}", text.lower()) if w not in STOP}


def parse(doc):
    """Steps grouped under the heading they sit beneath. The doc is READ-ONLY here: it is edited by
    another session, and a tool that rewrites the artifact it audits cannot be trusted about it."""
    ucs, cur = {}, "(no heading)"
    for n, ln in enumerate(io.open(doc, encoding="utf-8", errors="replace"), 1):
        h = HEAD.match(ln)
        if h:
            cur = h.group(1)
            ucs.setdefault(cur, [])
            continue
        m = ROW.match(ln.strip())
        if not m:
            continue
        step, what, needs, code, req = m.groups()
        # dotted ids sort as tuples; str sort puts "2.10" before "2.2"
        ucs.setdefault(cur, []).append(
            {"line": n, "step": step, "what": what, "needs": needs, "code": code, "req": req})
    return ucs


def sections(doc):
    """Every heading, its line, and the raw lines beneath it up to the next heading of any level.

    Separate from parse() on purpose: parse() reads TABLE ROWS and throws prose away, and the
    probe's whole job is to look at the prose that is or is not there.
    """
    out, cur = [], None
    for n, ln in enumerate(io.open(doc, encoding="utf-8", errors="replace"), 1):
        h = HEAD.match(ln)
        if h:
            cur = {"title": h.group(1), "line": n, "body": []}
            out.append(cur)
        elif cur is not None:
            cur["body"].append(ln)
    return out


def probe(doc, ucs):
    """The five Ws plus before/after, asked once per module, only where the document is silent.

    Returns (questions, grid). `grid` is what the probe EXAMINED - printed whether or not anything
    fired, because a check that reports only its failures cannot be distinguished from one that
    looked at nothing. That distinction has cost this project real time twice.
    """
    questions, grid, declared = [], [], {}
    for sec in sections(doc):
        ids = MODULE_ID.findall(sec["title"])
        if not ids:
            continue                      # prose section, not a module - nothing to probe
        mid = ids[0]
        body = "".join(sec["body"])
        rows = ucs.get(sec["title"], [])
        answered, open_ = {}, []
        for key, _labels, ask, howto in FACETS:
            m = None
            for ln_no, ln in enumerate(sec["body"], sec["line"] + 1):
                if FACET_RE[key].match(ln):
                    m = ln_no
                    break
            if m is None and key == "where" and any(
                    ANCHOR.search(r["code"]) or ANCHOR.search(r["req"]) for r in rows):
                m = rows[0]["line"]       # the table already names the code; do not ask again
            if m is None:
                open_.append(key)
                questions.append((
                    "baseline", sec["line"],
                    "%s: %s  ->  close it by adding one line under the heading: %s"
                    % (mid, ask, howto)))
            else:
                answered[key] = m
        # a declared link is a claim about ANOTHER module, so it can be checked against that one.
        # Every module gets an entry even when it declares nothing, so the cross-check can tell
        # "said something else" from "said nothing" - the second is already an open facet
        # question and asking about it twice would inflate the count.
        declared.setdefault(mid, {"@line": sec["line"]})
        for key in ("before", "after"):
            if key in answered:
                ln = sec["body"][answered[key] - sec["line"] - 1]
                declared[mid][key] = [i for i in MODULE_ID.findall(ln) if i != mid]
        grid.append((mid, sec["title"], sec["line"], answered, open_))

    # A one-sided link is a hole the probe can find on its own: if A says it feeds B, B has to
    # agree, or one of the two documents a chain that does not exist. This is the recursion - an
    # answered question generating the next question rather than closing the file.
    for mid, links in declared.items():
        for nxt in links.get("after", []):
            if (nxt in declared and "before" in declared[nxt]
                    and mid not in declared[nxt]["before"]):
                questions.append((
                    "link", links["@line"],
                    "%s says %s runs after it, but %s does not name %s as what comes before. "
                    "Which of the two is right?" % (mid, nxt, nxt, mid)))
        for prv in links.get("before", []):
            if (prv in declared and "after" in declared[prv]
                    and mid not in declared[prv]["after"]):
                questions.append((
                    "link", links["@line"],
                    "%s says it runs after %s, but %s does not name %s as what comes next. "
                    "Which of the two is right?" % (mid, prv, prv, mid)))
    return questions, grid


# Windows hands a cp1252 stdout to a subprocess, so every accented character in a document this
# tool only READS came back as a replacement glyph: "résumé" printed as "r?sum?" in every
# question about it. The parse was fine - the report was not, and a question you cannot read is a
# question nobody answers. Found by running the tool on a new document (an unrelated tool's) whose subject
# matter happens to contain accents; the asteroid docs are pure ASCII and never exposed it.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (ValueError, OSError):
        pass


# ---------------------------------------------------------------------------------------------
# ALTERNATE PATHWAYS (K2, 2026-10-27). Every pathway of a UML use case description is accounted for, not only the main scenario.
# MEASURED before this existed (quarantine/blueprint_view/GAPCHECK_BASELINE.md): on a model this tool passed, 14 of 14
# extensions named no requirement and 10 of 14 stated no outcome - the tool read table rows only, so every alternate pathway
# was prose to it. Three shapes are in use across the repo's documents, and all three are read:
#   - 3a. text            a bullet (u2ue/USECASES.md, a game's Docs/UseCases.md)
#   **Extensions**: 1a. text 2a. text      inline after the label
#   **Extension 3a - title:** text         a bold label (a game's per-feature file under Docs/UseCases/)
# A pathway with no requirement citation is a FACT (the citation forms are listed in REQ_CITE) and fails the gate; a pathway
# that never says where it ends is a keyword HEURISTIC and only a candidate. A use case with three or more steps and no
# alternate pathway at all is a question too: what happens when a step cannot complete is exactly what was never written.
EXT_BULLET = re.compile(r"^\s*[-*]\s+\**(\d+[a-z]+)\.?\**\s+(.*)$")
EXT_BOLD = re.compile(r"\*\*Extension\s+(\d+[a-z]+)\b[^*]*\*\*:?\s*(.*)$", re.I)
# the label may sit behind a bullet: "- **Extensions**: 2a. ..." (u2ue/USECASES.md UC-1) - missed by the first version, caught by
# holding the parser to an outside count (7 extensions written, 6 read)
EXT_INLINE_LABEL = re.compile(r"^\s*(?:[-*]\s+)?\**Extensions?\**\s*:?\**\s*(.*)$", re.I)
EXT_INLINE_SPLIT = re.compile(r"(?:^|\s)(\d+[a-z]+)\.\s+")
NEW_BLOCK = re.compile(r"^\s*(?:\||#|```|~~~|>|[-*+]\s|\d+[.)]\s)")
REQ_CITE = re.compile(r"\b(?:REQ-[A-Z0-9][A-Z0-9-]*\d|IR-\d+(?:\.\d+)*|[\w.]*Requirements\.txt:\d+)\b|\bINFERRED\b")
# "end success" / "end minimal" name the guarantee a pathway ends on (Cockburn), and an "Outcome:" label states it outright; both
# were unknown here until 2026-10-27, when they made 30 of the Blueprint model's 88 pathways false candidates.
OUTCOME = re.compile(r"\b(rejoin\w*|resume\w*|returns? to|continues? (?:at|with)|back to step|use case ends|ends|stops|"
                     r"fails?|refus\w+|abandon\w*|not applied|is named|end (?:success|minimal|failure)|outcome(?=\s*:))\b", re.I)


def parse_extensions(doc):
    """module heading -> [(line, extension id, text)], every alternate pathway the document writes, in any of the three shapes"""
    out, cur, ext = {}, "(no heading)", None
    for n, ln in enumerate(io.open(doc, encoding="utf-8", errors="replace"), 1):
        h = HEAD.match(ln)
        if h:
            cur, ext = h.group(1), None
            out.setdefault(cur, [])
            continue
        t = ln.rstrip("\n")
        m = EXT_BOLD.search(t) or EXT_BULLET.match(t)
        if m:
            ext = [n, m.group(1), m.group(2)]
            out.setdefault(cur, []).append(ext)
            continue
        lab = EXT_INLINE_LABEL.match(t)
        if lab and EXT_INLINE_SPLIT.search(" " + lab.group(1)):
            parts = EXT_INLINE_SPLIT.split(" " + lab.group(1))
            for i in range(1, len(parts) - 1, 2):
                ext = [n, parts[i], parts[i + 1].strip()]
                out.setdefault(cur, []).append(ext)
            continue
        # A pathway runs to the end of its paragraph, as markdown reads it: every following line up to a blank line or a new
        # block (a table, a heading, a fence, another list item) belongs to it, indented or not. Measured 2026-10-27: an
        # indented-only rule cut GodRays.md's bold "Extension 3a" off before its fourth line, where its requirement is written,
        # so the gate asked "cites no requirement" of a pathway that cites one and never asked the inferred one it cites.
        if not t.strip() or NEW_BLOCK.match(t):
            ext = None
        elif ext is not None:
            ext[2] += " " + t.strip()
    return out


def run(a):
    """The whole interrogation as data: (use cases, steps, questions, candidates, grid, source_read, pathways). main() prints it;
    selftest() plants faults in it."""
    ucs = parse(a.doc)
    steps = [s for v in ucs.values() for s in v]
    questions, candidates = [], []

    # ---- HOLE 1: a step the chain needs and nobody authored a requirement for. -----------------
    for uc, rows in ucs.items():
        for s in rows:
            for ir in INFERRED.finditer(s["req"]):      # every cite is its own hole: Inventory.md:236 cites two
                questions.append((
                    "inferred", s["line"],
                    "%s step %s needs \"%s\" and no authored requirement covers it (%s). "
                    "Is that behaviour intended, and which requirements file should carry it?"
                    % (uc.split(" - ")[0], s["step"], s["needs"][:70], ir.group(1))))
    # The same hole on an alternate pathway. Measured 2026-10-27: 5 of the blueprint view's 16 inferred requirements were
    # cited only by extensions, and this loop read step rows alone, so it asked 11 of the 16 and passed the rest unasked.
    exts = parse_extensions(a.doc)
    for uc, rows in exts.items():
        for line, eid, text in rows:
            for ir in INFERRED.finditer(text):
                questions.append((
                    "inferred", line,
                    "%s extension %s (\"%s\") rests on %s, which no one authored. "
                    "Is that pathway intended, and which requirements file should carry it?"
                    % (uc.split(" - ")[0], eid, text[:70], ir.group(1))))

    # ---- HOLE 2 / 3: the closed space, if one was given. ---------------------------------------
    if a.space:
        import json
        sp = json.load(io.open(a.space, encoding="utf-8"))
        text = io.open(a.doc, encoding="utf-8", errors="replace").read()
        defined = set(UCID.findall(text))
        for f in sp.get("features", []):
            cell = (f.get("cells") or {}).get(a.game) or {}
            if cell.get("v") != "yes":
                continue
            uc = ((f.get("ours") or {}).get("uc") or "").strip()
            if not uc:
                questions.append((
                    "unmapped", 0,
                    "%s: the space says %s does \"%s\". Do we? If yes, which use case covers it "
                    "and what file:line proves it; if no, what search proves it absent?"
                    % (f.get("id"), a.game, (f.get("capability") or "")[:70])))
            elif uc not in defined:
                questions.append((
                    "orphan", 0,
                    "%s maps to %s, which the space names but %s never defines. What is that use "
                    "case's goal, or should the mapping be retired?"
                    % (f.get("id"), uc, os.path.basename(a.doc))))

    # ---- HOLE 6 / 7: a rule the SOURCE states that no requirement cites, or cites in another subject. ---------
    source_read = None
    if a.source:
        import json
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import source_rules
        ex = source_rules.exclusions_from_space(json.load(io.open(a.space, encoding="utf-8"))) if a.space else []
        sents, holes = source_rules.check(a.source, a.reqs, ex, every=getattr(a, "every_sentence", False))
        source_read = (len(sents), len(ex))
        if not sents:
            sys.exit("  --source read NO sentences from %s - a pass would mean nothing" % a.source)
        for kind, s, detail in holes:
            questions.append((kind, 0, "%s%s says \"%s\" - %s. Which requirement states it (cite %s), or why is it excluded?"
                              % (os.path.basename(a.source), s.where(), s.text[:110], detail, s.where())))

    # ---- HOLE 8: alternate pathways - each must cite a requirement; a use case of 3+ steps must have one. ------
    pathways = None
    if getattr(a, "pathways", True):
        pathways = sum(len(v) for v in exts.values())
        for uc, rows in ucs.items():
            if not MODULE_ID.search(uc):
                continue
            mine = exts.get(uc, [])
            if len(rows) >= 3 and not mine:
                line = min(r["line"] for r in rows)
                questions.append((
                    "pathway", line,
                    "%s has %d steps and no alternate pathway. For each step: what happens when it cannot complete, "
                    "where does that pathway end, and which requirement does it carry?" % (uc.split(" - ")[0], len(rows))))
            for line, eid, text in mine:
                if not REQ_CITE.search(text):
                    questions.append((
                        "pathway", line,
                        "%s extension %s (\"%s\") cites no requirement. Which requirement does this pathway carry "
                        "(REQ-..., IR-n, or a requirements file:line)?" % (uc.split(" - ")[0], eid, text[:70])))
                if not OUTCOME.search(text):
                    candidates.append((
                        "outcome", line,
                        "%s extension %s never says where it ends: does it rejoin a step of the main scenario, or end "
                        "the use case, and with which guarantee?" % (uc.split(" - ")[0], eid)))

    # ---- HOLE 4 / 5: the baseline probe, per module. -------------------------------------------
    grid = []
    if a.probe:
        pq, grid = probe(a.doc, ucs)
        questions.extend(pq)

    # ---- CANDIDATE: a need no earlier step in the same use case delivers. -----------------------
    # HEURISTIC, and labelled as one. It compares content words, so it cannot tell a real break in
    # the chain from a rewording, and it never fails the gate. A guess that can fail a build is
    # worse than no check at all - that is the whole reason this is a separate bucket.
    for uc, rows in ucs.items():
        seen = set()
        for s in sorted(rows, key=lambda r: [int(x) for x in r["step"].split(".")]):
            need = keywords(s["needs"])
            if need and seen and not (need & seen):
                candidates.append((
                    "unanchored", s["line"],
                    "%s step %s needs \"%s\" - no earlier step in this use case mentions any of "
                    "it. Which step is meant to deliver it, or is it an entry precondition?"
                    % (uc.split(" - ")[0], s["step"], s["needs"][:70])))
            seen |= keywords(s["what"]) | need
    return ucs, steps, questions, candidates, grid, source_read, pathways


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc")
    ap.add_argument("--space", help="a closed feature space (genre_matrix.json)")
    ap.add_argument("--game", default="starblast")
    ap.add_argument("--max", type=int, default=0, help="print at most N questions (0 = all)")
    # ON by default, because a module's steps cannot be checked until its baseline is known (THE BASELINE
    # PROBE above). --no-probe restores the pre-2026-09-08 gate for a document that is deliberately
    # steps-only; it is an escape hatch, not the normal way to run this.
    ap.add_argument("--probe", dest="probe", action="store_true", default=True,
                    help="ask who/what/why/when/where + before/after per module (DEFAULT ON)")
    ap.add_argument("--no-probe", dest="probe", action="store_false",
                    help="skip the baseline probe and gate on step-level holes only")
    # The space is a SUMMARY of the reference; checking only the summary certifies the summariser (Rampart 10-24: the space's
    # S15 had dropped the manual's "you", and the per-player death rule became a team rule nobody's gate could see).
    ap.add_argument("--source", help="the reference text itself: every rule sentence in it must be cited by a requirement "
                                     "(source_rules.py); exclusions come from the space's source_excluded and copy=no rows")
    ap.add_argument("--reqs", help="the requirements file --source checks citations against")
    ap.add_argument("--every-sentence", action="store_true",
                    help="with --source: hold EVERY sentence to a requirement (an essay), not only rule-word sentences")
    ap.add_argument("--no-pathways", dest="pathways", action="store_false", default=True,
                    help="skip the alternate-pathway holes (ON by default: each extension must cite a requirement)")
    ap.add_argument("--selftest", action="store_true", help="plant one fault per hole kind and require each to be asked")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.doc:
        ap.error("--doc is required")
    if bool(a.source) != bool(a.reqs):
        sys.exit("--source and --reqs go together: the check is 'is every rule in the source cited by a requirement'")
    if not os.path.exists(a.doc):
        sys.exit("ABSENT: %s - there is no chain to find holes in" % a.doc)

    ucs, steps, questions, candidates, grid, source_read, pathways = run(a)

    print("INTERROGATE  %s" % os.path.basename(a.doc))
    print("  %d use-case section(s), %d scenario step(s) parsed" % (len(ucs), len(steps)))
    if not steps:
        sys.exit("  parsed NO steps - the row shape does not match this document, so an empty "
                 "question list would mean nothing. Fix the parser before trusting a pass.")

    # What the probe LOOKED AT, not only what it found - printed even when every facet is answered,
    # because "nothing fired" and "nothing was examined" produce identical silence otherwise.
    if a.probe:
        if not grid:
            print("  PROBE examined 0 modules - no heading in this document carries a UC/EPIC id, "
                  "so an empty probe result here means the selector missed, not that the document "
                  "is complete. Fix the heading convention or pass --no-probe.")
        else:
            done = sum(len(a_) for _, _, _, a_, _ in grid)
            print("  BASELINE   %d module(s), %d/%d facets answered  (who what why when where "
                  "before after)" % (len(grid), done, len(grid) * len(FACETS)))
            for mid, title, line, ans, open_ in grid:
                marks = " ".join(
                    ("%s:%d" % (k, ans[k])) if k in ans else (k + "?")
                    for k, _, _, _ in FACETS)
                print("    %-10s %-46s %s" % (mid, title[:46], marks))
                print("               ^ %s:%d" % (os.path.basename(a.doc), line))

    if source_read:
        print("  SOURCE     %d %ssentence(s) read from %s, %d excluded range(s) with a reason"
              % (source_read[0], "" if a.every_sentence else "rule ", os.path.basename(a.source), source_read[1]))
    if pathways is not None:
        print("  PATHWAYS   %d alternate pathway(s) read (bullets, inline, bold labels)" % pathways)
    kinds = {}
    for k, _, _ in questions:
        kinds[k] = kinds.get(k, 0) + 1
    # The outside count for HOLE 1, printed every run: what the text cites against what was asked. A cite in a definitions
    # list is a legitimate difference; a cite in a pathway or a step the parser did not read is not, and the ids name it.
    cited = INFERRED.findall(io.open(a.doc, encoding="utf-8", errors="replace").read())
    asked = {a_ or b_ for k, _, q in questions if k == "inferred" for a_, b_ in INFERRED_ASKED.findall(q)}
    never = sorted(set(cited) - asked, key=lambda s: [int(x) for x in re.findall(r"\d+", s)])
    print("  INFERRED   %d cite(s) in the text, %d asked%s" % (len(cited), kinds.get("inferred", 0),
          ("; never asked: " + ", ".join(never)) if never else ""))
    print("  QUESTIONS  %d   %s" % (len(questions), kinds or "{}"))
    print("  candidates %d (heuristic, do not fail the gate)" % len(candidates))

    shown = questions if a.max <= 0 else questions[:a.max]
    if shown:
        print()
        for i, (kind, line, q) in enumerate(shown, 1):
            where = ("%s:%d" % (os.path.basename(a.doc), line)) if line else "space"
            print("  Q%-3d [%-9s] %s" % (i, kind, q))
            print("        ^ %s" % where)
    if candidates:
        print("\n  candidates (answer only if the chain really breaks):")
        for kind, line, q in candidates[:5]:
            print("    ? [%-10s] %s  (%s:%d)" % (kind, q, os.path.basename(a.doc), line))

    if questions:
        print("\n  %d unanswered question(s). 'Every requirement' is reachable exactly when this "
              "count is 0 - and that is a count, not a feeling." % len(questions))
        return 1
    print("\n  PASS - %d steps carry an authored requirement, every mapped id is defined, and "
          "nothing in the space is unmapped." % len(steps))
    return 0


def selftest():
    """A clean document asks nothing; each hole kind is planted once and must be asked. The parser is also held to an
    outside count: the clean document holds exactly two alternate pathways and three step rows per use case."""
    import json, tempfile, types
    d = tempfile.mkdtemp(prefix="interrogate_selftest_")
    facets = ("**Actor:** the reader\n**Goal:** the graph is read\n**Why:** text hides the flow\n**Trigger:** a method opened\n"
              "**Where:** `Census` Census.cs:10\n**Before:** none - entry point\n**After:** none - terminal\n")
    table = ("| # | step | needs | code | req |\n|---|---|---|---|---|\n"
             "| 1 | open the method | a name | `Census` | REQ-T-1 |\n"
             "| 2 | draw it | the method | `Census` | REQ-T-2 |\n"
             "| 3 | read it | the graph | `Census` | REQ-T-3 |\n")
    clean = ("# doc\n\n## UC-T1 Read a method\n\n" + facets + "\n" + table +
             "\n**Extensions**:\n- 2a. The method does not compile: refused and named, rejoins step 1 (REQ-T-4).\n"
             "\n**Extension 3a - too long:** folded into groups, then it continues at step 3 (REQ-T-5).\n")
    space = {"features": [{"id": "F1", "cells": {"g": {"v": "yes"}}, "ours": {"uc": "UC-T1"}}]}
    source = "The reader must see the flow.\n"
    reqs = "REQ-T-1 the reader sees the flow [:1]\n"

    def make(doc_text, space_obj, reqs_text, **kw):
        paths = {}
        for name, body in (("doc.md", doc_text), ("space.json", json.dumps(space_obj)), ("src.txt", source),
                           ("reqs.txt", reqs_text)):
            paths[name] = os.path.join(d, name)
            io.open(paths[name], "w", encoding="utf-8").write(body)
        a = types.SimpleNamespace(doc=paths["doc.md"], space=paths["space.json"], game="g", probe=True,
                                  source=paths["src.txt"], reqs=paths["reqs.txt"], every_sentence=True, pathways=True)
        for k, v in kw.items():
            setattr(a, k, v)
        return a

    ok = True
    ucs, steps, q, c, grid, src_read, nexts = run(make(clean, space, reqs))
    good = not q and nexts == 2 and len(steps) == 3
    print("  selftest clean      questions %d, pathways read %d (want 2), steps %d (want 3)  %s" % (
        len(q), nexts, len(steps), "ok" if good else "WRONG: " + str(q[:2])))
    ok &= good
    plants = [
        ("inferred", lambda: make(clean.replace("| REQ-T-3 |", "| INFERRED IR-1 |"), space, reqs)),
        ("inferred", lambda: make(clean.replace(" (REQ-T-4)", " (INFERRED IR-2)"), space, reqs)),    # on a pathway only
        ("unmapped", lambda: make(clean, {"features": [{"id": "F1", "cells": {"g": {"v": "yes"}}}]}, reqs)),
        ("orphan", lambda: make(clean, {"features": [{"id": "F1", "cells": {"g": {"v": "yes"}}, "ours": {"uc": "UC-T9"}}]}, reqs)),
        ("source", lambda: make(clean, space, "REQ-T-1 something else entirely\n")),
        ("pathway", lambda: make(clean.replace(" (REQ-T-4)", ""), space, reqs)),
        ("pathway", lambda: make(clean.split("**Extensions**")[0], space, reqs)),
        ("baseline", lambda: make(clean.replace("**Why:** text hides the flow\n", ""), space, reqs)),
    ]
    for want, mk in plants:
        _, _, q, _, _, _, _ = run(mk())
        got = sorted({k for k, _, _ in q})
        hit = want in got
        ok &= hit
        print("  selftest %-10s -> %s %s" % (want, "ASKED" if hit else "MISSED", got))
    # Counts, not kinds: two inferred cites on one row are two questions, and a pathway's unindented tail is still the pathway.
    _, _, q, _, _, _, _ = run(make(clean.replace("| REQ-T-3 |", "| INFERRED IR-1, INFERRED IR-2 |"), space, reqs))
    n = sum(1 for k, _, _ in q if k == "inferred")
    print("  selftest two inferred cites on one row -> %d question(s) (want 2)  %s" % (n, "ok" if n == 2 else "WRONG"))
    ok &= n == 2
    _, _, q, _, _, _, _ = run(make(clean.replace(" (REQ-T-5).\n", "\nand stays folded.\nRequirement: INFERRED IR-3.\n"), space, reqs))
    got = sorted(k for k, _, _ in q)
    print("  selftest a pathway's unindented tail -> %s (want ['inferred'] and no 'pathway')  %s"
          % (got, "ok" if got == ["inferred"] else "WRONG"))
    ok &= got == ["inferred"]
    # The outcome candidate: it still fires on a pathway that never says where it ends, and stays quiet on a stated guarantee.
    quiet = [k for k, _, _ in run(make(clean.replace("refused and named, rejoins step 1", "a message shows. Outcome: end minimal"),
                                       space, reqs))[3] if k == "outcome"]
    fires = [k for k, _, _ in run(make(clean.replace("refused and named, rejoins step 1", "a message shows"), space, reqs))[3]
             if k == "outcome"]
    good = not quiet and fires == ["outcome"]
    print("  selftest outcome candidate: stated guarantee -> %d, no outcome -> %d (want 0 and 1)  %s"
          % (len(quiet), len(fires), "ok" if good else "WRONG"))
    ok &= good
    print("interrogate selftest: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
