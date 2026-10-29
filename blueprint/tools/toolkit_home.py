#!/usr/bin/env python3
"""toolkit_home.py - where the toolkit sits, for the Blueprint view's tools: the use case checkers (autobot/), uml.py, bee_dag.py.

Run through the facade (`py -m u2ue blueprint ...`) a tool gets U2UE_HOME, the facade's own home. Run by hand, it is the folder above
this part that holds the use case checkers (autobot/usecase_model.py): the root of a u2ue release or of the public repository when
the part sits at <root>/blueprint, the toolkit's own tree when it sits at .opus-tools/quarantine/blueprint_view. A layout that is
none of those is REFUSED, never a written path. Measured 10-28: the first fresh
clone of a release ran `../../autobot/usecase_kg.py`, the toolkit tree's relative path, which in a release points outside the repository.

    py tools/toolkit_home.py          the toolkit's home as the tools see it, and how it was found
"""
import os
import sys

PART = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def home():
    """the toolkit's home: U2UE_HOME, else the nearest folder above the part that holds the use case checkers"""
    h = os.environ.get("U2UE_HOME")
    if h:
        return h.replace("\\", "/")
    d = os.path.dirname(PART)
    for _ in range(2):
        if os.path.isfile(os.path.join(d, "autobot", "usecase_model.py")):
            return d.replace("\\", "/")
        d = os.path.dirname(d)
    raise SystemExit("toolkit_home: REFUSED - no folder above %s holds the use case checkers (autobot/usecase_model.py): run it "
                     "from a u2ue release or the public repository, or through the facade (py -m u2ue blueprint ...)" % PART)


def tool(*parts):
    """a file of the toolkit by its path from the toolkit's home: tool("autobot", "usecase_kg.py"), tool("uml.py")"""
    return os.path.join(home(), *parts)


if __name__ == "__main__":
    print("toolkit home %s (%s)" % (home(), "U2UE_HOME" if os.environ.get("U2UE_HOME") else "the folder above the part holding autobot/"))
    sys.exit(0)
