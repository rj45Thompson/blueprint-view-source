#!/usr/bin/env python3
"""online_sample.py - a Blueprint someone pasted on blueprintue.com, read into the experiment with its provenance.

The worked example is a real Blueprint, badly written the way many posted online are, converted to code. A paste
on blueprintue.com is the text a person's Unreal editor put on the clipboard (Ctrl+C on selected nodes) - the one kind of input
the converter had never seen (TASKS.md BC5: every earlier sample was an engine export).

The site says authors keep the rights to their pastes (blueprintue.com/terms-of-service, read 2026-10-28), so the TEXT is never
committed: it lands in samples/online/<set>/<name>.t3d, which git ignores, and only the manifest is committed - each paste's URL,
title, author, engine version, node count and the sha256 of the text read. `check` re-reads every URL and fails if a byte moved.

    py -I tools/online_sample.py fetch samples/online/lockon/SOURCES.json     # read every paste the manifest lists
    py -I tools/online_sample.py check samples/online/lockon/SOURCES.json     # re-read; exit 1 if a hash or a count differs
    py -I tools/online_sample.py selftest

The text is the textarea `#code_to_copy` the page renders from, decoded the way a browser fills a textarea's value (HTML
entities decoded, CR LF and lone CR read as LF, one newline right after the start tag dropped), so it equals what Ctrl+C on
the page copies. Every failure stops the run: a page with no textarea, a node count that differs from the manifest's, a hash
that moved. Nothing is substituted.
"""
import hashlib
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

TEXTAREA = re.compile(r'<textarea[^>]*\bid="code_to_copy"[^>]*>(.*?)</textarea>', re.S)
NODE = re.compile(r"^Begin Object Class=", re.M)
UA = "u2ue-blueprint-view-experiment/1 (read-only; one request per paste)"


def textarea_value(page):
    """The value a browser gives the textarea: entities decoded, newlines normalised, the first newline dropped (HTML spec)."""
    m = TEXTAREA.search(page)
    if not m:
        raise ValueError("no <textarea id=\"code_to_copy\"> on the page")
    raw = m.group(1).replace("\r\n", "\n").replace("\r", "\n")
    if raw.startswith("\n"):
        raw = raw[1:]
    return html.unescape(raw)


def read_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        if r.status != 200:
            raise IOError("%s answered HTTP %d" % (url, r.status))
        return r.read().decode("utf-8")


def page_meta(page):
    """Title, author and engine version as the page states them (blueprint__title, blueprint__author, blueprint__infos)."""
    def first(rx):
        m = re.search(rx, page, re.S)
        return html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else None
    return {"title": first(r'class="blueprint__title"[^>]*>(.*?)</h1>'),
            "author": first(r'class="blueprint__author"[^>]*>(.*?)</h2>'),
            "ue": first(r"UE Version:\s*(?:<[^>]+>\s*)*([0-9.]+)")}


def run(manifest_path, check):
    mp = Path(manifest_path)
    man = json.loads(mp.read_text(encoding="utf-8"))
    bad = 0
    for p in man["pastes"]:
        page = read_url(p["url"])
        text = textarea_value(page)
        nodes = len(NODE.findall(text))
        sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        meta = page_meta(page)
        out = mp.parent / (p["name"] + ".t3d")
        problems = []
        if nodes != p["nodes"]:
            problems.append("%d nodes read, the manifest says %d" % (nodes, p["nodes"]))
        if len(text) != p["chars"]:
            problems.append("%d characters read, the manifest says %d (the browser's textarea value)" % (len(text), p["chars"]))
        for k in ("title", "author", "ue"):
            if meta[k] != p[k]:
                problems.append("%s %r on the page, the manifest says %r" % (k, meta[k], p[k]))
        if check:
            if p.get("sha256") != sha:
                problems.append("sha256 %s.. differs from the recorded %s.." % (sha[:12], (p.get("sha256") or "none")[:12]))
            if out.exists() and hashlib.sha256(out.read_text(encoding="utf-8").encode("utf-8")).hexdigest() != sha:
                problems.append("the local %s no longer matches the page" % out.name)
        print("  %-22s %-5s %6d chars %4d nodes  sha256 %s..  %s" % (p["name"], "OK" if not problems else "FAIL", len(text),
                                                                      nodes, sha[:12], p["url"]))
        for pr in problems:
            print("      " + pr)
        bad += len(problems)
        if not problems and not check:
            out.write_text(text, encoding="utf-8", newline="\n")
            p["sha256"] = sha
            p["read"] = time.strftime("%Y-%m-%d %H:%MZ", time.gmtime())
        time.sleep(1)                          # one request a second: a polite reader of somebody else's site
    if not check and not bad:
        mp.write_text(json.dumps(man, indent=1) + "\n", encoding="utf-8")
    print("%s: %d paste(s), %d problem(s)" % ("check" if check else "fetch", len(man["pastes"]), bad))
    return 1 if bad else 0


def selftest():
    page = ('<h1 class="blueprint__title">T &amp; U</h1><h2 class="blueprint__author">someone</h2>'
            '<div class="blueprint__infos"><span>UE Version: </span><span>5.0</span></div>'
            '<textarea id="code_to_copy" class="x">\r\nBegin Object Class=/Script/BlueprintGraph.K2Node_Knot Name=&quot;K&quot;\r\n'
            'End Object\rBegin Object Class=/Script/X.Y Name=&quot;Z&quot;\nEnd Object\n</textarea>')
    v = textarea_value(page)
    want = 'Begin Object Class=/Script/BlueprintGraph.K2Node_Knot Name="K"\nEnd Object\nBegin Object Class=/Script/X.Y Name="Z"\nEnd Object\n'
    ok1 = v == want
    ok2 = page_meta(page) == {"title": "T & U", "author": "someone", "ue": "5.0"}
    try:
        textarea_value("<html>no textarea</html>")
        ok3 = False
    except ValueError:
        ok3 = True
    ok4 = len(NODE.findall(v)) == 2
    print("selftest: textarea value %s, page facts %s, a page with no textarea refused %s, node count %s"
          % (*("PASS" if o else "FAIL" for o in (ok1, ok2, ok3, ok4)),))
    return 0 if ok1 and ok2 and ok3 and ok4 else 1


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "selftest":
        sys.exit(selftest())
    if len(sys.argv) != 3 or sys.argv[1] not in ("fetch", "check"):
        sys.exit(__doc__)
    sys.exit(run(sys.argv[2], sys.argv[1] == "check"))
