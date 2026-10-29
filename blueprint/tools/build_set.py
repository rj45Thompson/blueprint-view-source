#!/usr/bin/env python3
"""build_set.py - one paste set built end to end: the Blueprints converted, traced and assembled into classes, the model's spaces
mapped, the city's data written, then the closed loop - its verdict is the build's last word - and its report.

The u2ue toolkit runs it as `py -m u2ue blueprint build <set> "<title>"`; on its own it is

    py -X utf8 tools/build_set.py samples/online/<set> "<title>"

Needs Node.js 18+, Python 3.9+ with PyYAML, the use case checkers (autobot/, found by toolkit_home), the pastes fetched
(`py -I tools/online_sample.py fetch samples/online/<set>/SOURCES.json`), and UE_ROOT naming an Unreal install: the class assembly
reads the engine's own headers for the members a Blueprint uses on itself, and refuses rather than guesses without them.
Exit 0 when every step ran and the loop holds every hole of ours closed; otherwise the failing step's exit code, and nothing after it.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import toolkit_home  # noqa: E402  the use case checkers, in the toolkit's tree, a release or the public repository


def steps(set_dir, title):
    py = [sys.executable, "-X", "utf8"]
    name = os.path.basename(set_dir.rstrip("/\\"))
    exclusions = os.path.join(set_dir, "exclusions.yaml")
    return [["node", "view/bp_cli.js", "convert", set_dir, set_dir + "/graphs"],
            ["node", "view/trace_cli.js", "build", set_dir + "/graphs", set_dir, set_dir + "/trace"],
            ["node", "view/oo_cli.js", "assemble", set_dir, set_dir + "/graphs", set_dir + "/trace", title],
            py + ["tools/logic_map.py", "build", set_dir + "/model", set_dir + "/trace"]
            + (["--exclusions", exclusions] if os.path.exists(os.path.join(EXP, exclusions)) else []),
            py + [toolkit_home.tool("autobot", "usecase_model.py"), set_dir + "/model"],
            ["node", "view/scene_cli.js", "build", set_dir, "view/data/" + name + "_3d.js", title],
            # the closed loop last (10-28): its verdict is the build's final word - every hole of ours closed, the owner's counted
            py + [toolkit_home.tool("autobot", "usecase_kg.py"), "loop", set_dir + "/model", "--verdicts", set_dir + "/trace/verdicts.json",
                  "--ours"],
            py + ["tools/loop_report.py", set_dir, title]]


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 0 if argv in (["--help"], ["-h"]) else 2
    set_dir, title = argv[0].replace("\\", "/"), argv[1]
    if not os.path.isfile(os.path.join(EXP, set_dir, "SOURCES.json")):
        print("build_set: REFUSED - %s holds no SOURCES.json (a paste set's manifest), from %s" % (set_dir, EXP))
        return 2
    for s in steps(set_dir, title):
        print("$ " + " ".join(os.path.basename(x) if i < 2 else x for i, x in enumerate(s[:4])) + (" ..." if len(s) > 4 else ""), flush=True)
        code = subprocess.call(s, cwd=EXP)
        if code:
            print("build_set: stopped - that step exited %s" % code)
            return code
    print("build_set: %s done" % set_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
