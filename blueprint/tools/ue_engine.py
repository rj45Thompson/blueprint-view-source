#!/usr/bin/env python3
"""ue_engine.py - the Unreal engine the table generators read (bp_titletable.py, bp_selftable.py, bp_optable.py): the install that
UE_ROOT names (the folder holding Engine/, e.g. .../Epic Games/UE_5.7), never a default path on one machine. Its version is READ
from Engine/Build/Build.version and is what a generated table says it came from - so a table names the engine, not the machine.
A missing UE_ROOT, or one holding no engine source, stops the generator with the reason; nothing is guessed."""
import io
import json
import os


def root():
    """the engine install UE_ROOT names, checked to hold the engine's source"""
    r = os.environ.get("UE_ROOT")
    if not r:
        raise SystemExit("UE_ROOT is not set: name the Unreal install the tables are read from (the folder holding Engine/)")
    r = r.replace("\\", "/").rstrip("/")
    if not os.path.isdir(r + "/Engine/Source/Runtime"):
        raise SystemExit("UE_ROOT %s holds no Engine/Source/Runtime - not an engine install with its source" % r)
    return r


def version(r):
    """the engine's version as its Build.version states it"""
    v = json.load(io.open(r + "/Engine/Build/Build.version", encoding="utf-8"))
    return "Unreal Engine %d.%d.%d (changelist %d)" % (v["MajorVersion"], v["MinorVersion"], v["PatchVersion"], v["Changelist"])
