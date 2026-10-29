#!/usr/bin/env python3
"""bp_titletable.py - the titles the editor gives engine functions' nodes, READ from their UFUNCTION metadata.

The 2D reference beside the city draws a paste the way Unreal's Blueprint editor draws it, titles included. A node's title in the
editor is not the name a paste stores: UK2Node_CallFunction::GetNodeTitle shows the function's user-facing name, which is its
DisplayName metadata where the C++ declaration gives one (K2_AddActorWorldOffset -> "Add Actor World Offset", ReceiveBeginPlay ->
"BeginPlay", so the event reads "Event BeginPlay"), and a pure math node is drawn compact with its CompactNodeTitle ("*"). Without
the metadata the 2D reference (view/unreal2d.js) would print "K2 Add Actor World Offset". This reads every DisplayName and
CompactNodeTitle in the engine's Runtime headers and the function each is declared on.

    py -X utf8 tools/bp_titletable.py              # writes view/bp_titles.js
    py -X utf8 tools/bp_titletable.py --selftest   # a planted header must be read, a declaration that cannot be read refused

Every entry keeps the header line it came from. A UFUNCTION with title metadata whose declaration cannot be read is refused, never
skipped. A name not in the table is shown by FName::NameToDisplayString, the engine's own rule (view/unreal2d.js), and said so.
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.dirname(HERE)
import ue_engine  # noqa: E402  the engine UE_ROOT names, and its version
UE = ue_engine.root()
RUNTIME = UE + "/Engine/Source/Runtime"
DISPLAY = re.compile(r'\bDisplayName\s*=\s*"([^"]*)"')
COMPACT = re.compile(r'\bCompactNodeTitle\s*=\s*"([^"]*)"')
# a pointer or reference return may sit against the name: `class UClass *GetObjectClass(` (GameplayStatics.h:373, refused once)
DECL = re.compile(r"(?:static\s+)?(?:virtual\s+)?(?:[A-Z]+_API\s+)?(?:FORCEINLINE\s+)?[\w:<>,\s\*&]+?[\s\*&]+(\w+)\s*\(")
# the class a UFUNCTION is declared in: a UObject (U), an Actor (A) or an interface (I) - the prefix is dropped, as a paste names it
CLASS = re.compile(r"^\s*class\s+(?:[A-Z]+_API\s+)?([UAI][A-Z]\w*)\s*(?::|$|\{)", re.M)


def read(text, where):
    """-> {Class.Function: {display, compact, at}} for one header's text"""
    out = {}
    lines = text.split("\n")
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line) + 1)
    for i, line in enumerate(lines):
        if "UFUNCTION" not in line or line.lstrip().startswith("//"):
            continue
        block, j = line, i
        # parens are counted outside string literals: the engine's own MultiLineEditableText.h:150 has DisplayName="SetIsReadOnly
        # (Multi-Line Editable Text", an open paren inside a title, which swallowed the declaration after it (refused once)
        bare = lambda s: re.sub(r'"(?:[^"\\]|\\.)*"', '""', s)
        while bare(block).count("(") > bare(block).count(")") and j + 1 < len(lines):
            j += 1
            block += " " + lines[j].strip()
        dm, cm = DISPLAY.search(block), COMPACT.search(block)
        if not dm and not cm:
            continue
        decl, k = "", j + 1
        while k < len(lines) and len(decl) < 600:
            decl += " " + lines[k].strip()
            if "(" in decl:
                break
            k += 1
        d = DECL.search(decl)
        if not d:
            raise ValueError("%s:%d has title metadata and no readable declaration after it" % (where, i + 1))
        cls = list(CLASS.finditer(text[: starts[i]]))
        owner = cls[-1].group(1)[1:] if cls else "?"
        e = {"at": "%s:%d" % (where, i + 1)}
        if dm:
            e["display"] = dm.group(1)
        if cm:
            e["compact"] = cm.group(1)
        out["%s.%s" % (owner, d.group(1))] = e
    return out


def scan():
    out, files = {}, 0
    for root, _, names in os.walk(RUNTIME):
        for n in names:
            if not n.endswith(".h"):
                continue
            p = os.path.join(root, n).replace("\\", "/")
            text = io.open(p, encoding="utf-8", errors="replace").read()
            if "UFUNCTION" not in text or ("DisplayName" not in text and "CompactNodeTitle" not in text):
                continue
            files += 1
            out.update(read(text, p.split("/Source/")[1]))
    return out, files


def selftest():
    ok = True
    hdr = ('class ENGINE_API AActor : public UObject\n{\n'
           '\tUFUNCTION(BlueprintCallable, meta=(DisplayName="Add Actor World Offset", ScriptName="AddActorWorldOffset"))\n'
           '\tvoid K2_AddActorWorldOffset(FVector DeltaLocation, bool bSweep);\n'
           '\tUFUNCTION(BlueprintPure, meta=(DisplayName = "vector * float",\n\t\tCompactNodeTitle = "*"))\n'
           '\tstatic FVector Multiply_VectorFloat(FVector A, double B);\n};\n')
    got = read(hdr, "planted.h")
    want = {"Actor.K2_AddActorWorldOffset": {"at": "planted.h:3", "display": "Add Actor World Offset"},
            "Actor.Multiply_VectorFloat": {"at": "planted.h:5", "display": "vector * float", "compact": "*"}}
    print("  selftest a planted header, one title on one line and one across two -> %s" % ("read" if got == want else "WRONG: %s" % got))
    ok &= got == want
    try:
        read('class UX : public UObject\n{\n\tUFUNCTION(meta=(DisplayName="Lost"))\n\t// the declaration is gone\n', "planted.h")
        refused = False
    except ValueError as e:
        refused = "no readable declaration" in str(e)
    print("  selftest title metadata with no declaration after it -> %s" % ("refused, as it must" if refused else "ACCEPTED - WRONG"))
    ok &= refused
    print("bp_titletable selftest: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main(argv):
    if "--selftest" in argv:
        return selftest()
    try:
        table, files = scan()
    except ValueError as e:
        sys.exit("bp_titletable: REFUSED: %s" % e)
    if not table:
        sys.exit("bp_titletable: no title metadata found under %s - an empty table proves nothing" % RUNTIME)
    js = ("// bp_titles.js - generated by tools/bp_titletable.py from %s: the DisplayName and CompactNodeTitle metadata of engine\n"
          "// functions (the titles UK2Node_CallFunction::GetNodeTitle shows), each with the header line it was read from.\n"
          "// Never edit by hand; regenerate.\nvar BP_TITLES = %s;\nif (typeof module !== 'undefined' && module.exports) module.exports = BP_TITLES;\n"
          % (ue_engine.version(UE) + ", Engine/Source/Runtime", json.dumps(table, indent=0, sort_keys=True)))
    io.open(os.path.join(EXP, "view", "bp_titles.js"), "w", encoding="utf-8", newline="\n").write(js)
    print("bp_titletable: %d functions in %d headers -> view/bp_titles.js (e.g. Actor.ReceiveBeginPlay: %s)" % (
        len(table), files, table.get("Actor.ReceiveBeginPlay")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
