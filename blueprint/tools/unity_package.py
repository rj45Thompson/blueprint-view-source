#!/usr/bin/env python3
"""unity_package.py - the Blueprint view as a Unity package (.unitypackage), built WITHOUT Unity: a package of its own, which
stands alone and also works as a part of the toolkit.

What it holds, under Assets/U2ue/BlueprintView (from unity/):
  Editor/     the window and its three classes, in the editor-only assembly U2ue.BlueprintView.Editor
  Reader/     the reader U2ue.CodeGraph, `dotnet publish`ed, every file as <name>.bytes so Unity keeps it as data and never loads it
  WebView/    BlueprintView.html: view/index.html with its scripts written inside it and a slot the window writes the graphs into
  README.md, LICENSE.md
Every file and folder carries a .meta in the form Unity writes one (each importer READ off a meta Unity wrote: MonoImporter,
AssemblyDefinitionImporter and TextScriptImporter as u2ue release's store package reads them; TextScriptImporter for .bytes and
.html read 10-28 off metas Unity wrote for both) with a GUID that is the md5 of the product and the path - the same in every build.

A .unitypackage is a gzipped tar with one folder per asset, named by its GUID: `pathname` (the asset's path), `asset.meta`, and
for a file `asset` (its bytes) - the form Unity's Export Package writes.

    py -X utf8 tools/unity_package.py build <out.unitypackage>   publish the reader, write the page, assemble - then check it
    py -X utf8 tools/unity_package.py check <file.unitypackage> [--project <Unity project>]
        every entry well formed, every GUID its own, every folder of every file present, nothing executable and no script Unity
        would try to compile besides the C#; with --project, the package's C# compiled ALONE against that project's editor
        (u2ue release's PackageCompile: Unity's own assemblies and compiler, nothing of the project)
    py -X utf8 tools/unity_package.py run <file.unitypackage> --project <Unity project> --page <out.html>
        the window's own C# (CompileFolder, GraphReader, GraphPage) compiled into a console program and run over the PACKAGED
        files, as the window runs them - everything but the window's buttons, with no Unity
    py -X utf8 tools/unity_package.py --selftest     plants a missing meta, a GUID used twice, an .exe and a stray .js: each refused
Exit 0 done and checked; 1 a check failed; 2 bad arguments or a refusal.
"""
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.dirname(HERE)
UNITY = os.path.join(EXP, "unity")
VIEW = os.path.join(EXP, "view")
READER = os.path.join(EXP, "U2ue.CodeGraph")
ROOT = "Assets/U2ue/BlueprintView"
PRODUCT = "u2ue.blueprintview/"
# the page's scripts in the order view/index.html loads them, after its data (data/index.js, which the slot replaces)
SCRIPTS = ["pl.js", "bp_ops.js", "bp_self.js", "bp.js", "view.js"]
SLOT = "/*BPV_DATA*/"

_TAIL = "  externalObjects: {}\n%s  userData: \n  assetBundleName: \n  assetBundleVariant: \n"
IMPORTERS = {
    ".cs": "MonoImporter:\n" + _TAIL % "  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}\n",
    ".asmdef": "AssemblyDefinitionImporter:\n" + _TAIL % "",
    ".md": "TextScriptImporter:\n" + _TAIL % "",
    ".bytes": "TextScriptImporter:\n" + _TAIL % "",
    ".html": "TextScriptImporter:\n" + _TAIL % "",
}
FOLDER = "folderAsset: yes\nDefaultImporter:\n" + _TAIL % ""
EXECUTABLE = (".exe", ".msi", ".com", ".app", ".scr", ".jar", ".bat", ".cmd", ".sh")
NOT_UNITY_SCRIPT = (".js", ".ts", ".py", ".ps1", ".psm1", ".lua", ".rb", ".pl", ".php", ".vbs")


def guid(path):
    """a path's GUID: the md5 of the product and the path (a folder's ends in /), so every build gives every asset the same one"""
    return hashlib.md5((PRODUCT + path).encode("utf-8")).hexdigest()


def meta(path, folder=False):
    if folder:
        return "fileFormatVersion: 2\nguid: %s\n%s" % (guid(path + "/"), FOLDER)
    importer = IMPORTERS.get(os.path.splitext(path)[1].lower())
    if importer is None:
        raise SystemExit("unity_package: REFUSED - no importer read for %s (a kind of file Unity's own metas were not read for)" % path)
    return "fileFormatVersion: 2\nguid: %s\n%s" % (guid(path), importer)


def run(argv, cwd=None):
    p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout + p.stderr).strip()


def page_template():
    """view/index.html with its loader replaced by its scripts, written inside it, and the slot the window fills with the graphs"""
    html = io.open(os.path.join(VIEW, "index.html"), encoding="utf-8").read()
    m = re.search(r"<script>\s*// load in order.*?</script>\s*", html, re.S)
    if not m:
        raise SystemExit("unity_package: REFUSED - view/index.html has no loader script to replace (its `// load in order` block)")
    parts = ["<script>%s</script>\n" % SLOT]
    for s in SCRIPTS:
        text = io.open(os.path.join(VIEW, s), encoding="utf-8").read()
        if "</script" in text.lower():
            raise SystemExit("unity_package: REFUSED - view/%s holds `</script`, which would close its element in the page" % s)
        parts.append("<script>\n// view/%s\n%s\n</script>\n" % (s, text))
    return html[:m.start()] + "".join(parts) + html[m.end():]


def publish(work):
    """the reader, framework-dependent (`dotnet U2ue.CodeGraph.dll`): its assemblies, deps and runtimeconfig - no apphost (an
    executable), no symbols, no satellite resource folders (Roslyn's messages in other languages; it reads English without them)"""
    out = os.path.join(work, "reader")
    # a plain publish: `-p:UseAppHost=false` rebuilt the reader's own bin/Release WITHOUT its .exe, and the game's round trips, which
    # run that .exe, then read "not built" (10-28). The apphost is left out below with every other executable
    code, text = run(["dotnet", "publish", READER, "-c", "Release", "-o", out, "--nologo"])
    if code != 0:
        raise SystemExit("unity_package: REFUSED - dotnet publish of the reader failed:\n" + text[-1500:])
    files = sorted(f for f in os.listdir(out) if os.path.isfile(os.path.join(out, f)) and not f.endswith((".pdb",) + EXECUTABLE))
    rc = json.load(io.open(os.path.join(out, "U2ue.CodeGraph.runtimeconfig.json"), encoding="utf-8"))
    if rc.get("runtimeOptions", {}).get("rollForward") != "Major":
        raise SystemExit("unity_package: REFUSED - the reader's runtimeconfig does not roll forward to a newer .NET (RollForward=Major)")
    return {f: open(os.path.join(out, f), "rb").read() for f in files}


def assets():
    """{asset path: bytes} of the package's files; folders are derived"""
    out = {}
    for root, dirs, files in os.walk(os.path.join(UNITY, "Editor")):
        for f in sorted(files):
            out["%s/Editor/%s" % (ROOT, f)] = open(os.path.join(root, f), "rb").read()
    for f in ("README.md", "LICENSE.md"):
        out["%s/%s" % (ROOT, f)] = open(os.path.join(UNITY, f), "rb").read()
    out["%s/WebView/BlueprintView.html" % ROOT] = page_template().encode("utf-8")
    return out


def folders(paths):
    out = set()
    for p in paths:
        d = os.path.dirname(p)
        while d and d != "Assets":
            out.add(d)
            d = os.path.dirname(d)
    return sorted(out)


def write(files, target):
    """the .unitypackage: per asset a GUID folder with pathname, asset.meta and (a file's) asset; fixed times, sorted, so the same
    files always make the same bytes"""
    entries = [(p, data) for p, data in sorted(files.items())] + [(d, None) for d in folders(files)]
    raw = io.BytesIO()
    # the tar in memory, then gzip with a fixed time and no file name: tarfile's own w:gz stamps the build's time into the gzip
    # header, so two builds of the same files differed (the selftest's plant, 10-28)
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as tar:
        def add(name, data=None, isdir=False):
            info = tarfile.TarInfo(name)
            info.mtime = 0
            if isdir:
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                tar.addfile(info)
            else:
                info.size, info.mode = len(data), 0o644
                tar.addfile(info, io.BytesIO(data))
        for path, data in sorted(entries, key=lambda e: guid(e[0] + ("/" if e[1] is None else ""))):
            g = guid(path + ("/" if data is None else ""))
            add(g, isdir=True)
            add(g + "/pathname", path.encode("utf-8"))
            add(g + "/asset.meta", meta(path, folder=data is None).encode("utf-8"))
            if data is not None:
                add(g + "/asset", data)
    with open(target, "wb") as fh, gzip.GzipFile(filename="", mode="wb", fileobj=fh, mtime=0) as gz:
        gz.write(raw.getvalue())
    return len(entries)


def read(target):
    """{guid: {pathname, meta, asset}} from a .unitypackage"""
    out = {}
    with tarfile.open(target, "r:gz") as tar:
        for m in tar.getmembers():
            if not m.isfile():
                continue
            g, _, leaf = m.name.partition("/")
            out.setdefault(g, {})[leaf] = tar.extractfile(m).read()
    return out


def check(target):
    """[(problem)] for a .unitypackage - an empty list is a pass"""
    bad = []
    pkg = read(target)
    paths = {}
    for g, e in sorted(pkg.items()):
        if not re.fullmatch(r"[0-9a-f]{32}", g):
            bad.append("%s: a folder name that is not a GUID" % g)
        if "pathname" not in e or "asset.meta" not in e:
            bad.append("%s: no %s" % (g, "pathname" if "pathname" not in e else "asset.meta"))
            continue
        p = e["pathname"].decode("utf-8").strip()
        m = re.search(r"^guid: ([0-9a-f]{32})$", e["asset.meta"].decode("utf-8"), re.M)
        if not m or m.group(1) != g:
            bad.append("%s: its .meta names GUID %s, not its own" % (p, m.group(1) if m else "none"))
        isfolder = "folderAsset: yes" in e["asset.meta"].decode("utf-8")
        if isfolder == ("asset" in e):
            bad.append("%s: a %s %s an asset file" % (p, "folder" if isfolder else "file", "with" if isfolder else "without"))
        if p in paths:
            bad.append("%s: two assets (%s, %s)" % (p, paths[p], g))
        paths[p] = g
        if not p.startswith(ROOT + "/") and p not in ("Assets/U2ue", ROOT):
            bad.append("%s: outside %s" % (p, ROOT))
        if p.lower().endswith(EXECUTABLE):
            bad.append("%s: an executable (the Asset Store takes none)" % p)
        if p.lower().endswith(NOT_UNITY_SCRIPT):
            bad.append("%s: a script Unity does not compile (keep it inside the page)" % p)
    for d in folders([p for p in paths if p not in ("Assets/U2ue", ROOT)]):
        if d not in paths:
            bad.append("%s: a folder of the package's files with no asset of its own" % d)
    for need in ("%s/Editor/BlueprintViewWindow.cs" % ROOT, "%s/Reader/U2ue.CodeGraph.dll.bytes" % ROOT,
                 "%s/Reader/U2ue.CodeGraph.runtimeconfig.json.bytes" % ROOT, "%s/WebView/BlueprintView.html" % ROOT):
        if need not in paths:
            bad.append("%s: missing" % need)
    return bad, paths, pkg


def extract(target, dest):
    """the package's files under dest/<asset path>, as an import writes them"""
    for g, e in read(target).items():
        if "asset" in e:
            p = os.path.join(dest, e["pathname"].decode("utf-8").strip())
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "wb").write(e["asset"])
    return os.path.join(dest, ROOT)


def compile_check(target, project):
    """the package's C# compiled ALONE against the project's editor, by u2ue release's PackageCompile (the toolkit's)"""
    sys.path.insert(0, HERE)
    import toolkit_home
    if not os.path.isfile(toolkit_home.tool("u2ue", "release.py")):
        # the compile is the toolkit's own PackageCompile, in its release builder, which a release keeps home (ToolkitHistory) and
        # the public repository never had: there the package is built and checked, and this compile is said not to be here (10-28:
        # a fresh release clone stopped on the import)
        raise SystemExit("unity_package: REFUSED - the compile check is the u2ue toolkit's PackageCompile (u2ue/release.py), "
                         "which only the toolkit's own tree holds; `build` and `check` without --project need nothing of it")
    sys.path.insert(0, toolkit_home.home())
    from u2ue.release import PackageCompile
    sources = {e["pathname"].decode("utf-8").strip(): e["asset"].decode("utf-8") for e in read(target).values()
               if "asset" in e and e["pathname"].decode("utf-8").strip().endswith(".cs")}
    r = PackageCompile(project, sources, "U2ue.BlueprintView.Editor").run()
    return r


HARNESS = """using System;
using System.IO;
using U2ue.BlueprintView.Editor;

// the window's Update, without its buttons: find the compile folder, read Assembly-CSharp (or the first), write the page
public static class Harness
{
    public static int Main(string[] a)
    {
        string project = a[0], package = a[1], page = a[2];
        var folder = CompileFolder.Find(project);
        if (folder.Dir == null || folder.Assemblies.Count == 0) { Console.Error.WriteLine("REFUSED - " + folder.Why); return 2; }
        var asm = folder.Assemblies.Contains("Assembly-CSharp") ? "Assembly-CSharp" : folder.Assemblies[0];
        Console.WriteLine("compile folder " + Path.GetFileName(folder.Dir) + ": " + folder.Assemblies.Count + " assemblies of the project's own scripts; reading " + asm);
        var r = GraphReader.Start(package, project, folder.CommandLine(asm), asm, out var refused);
        if (r == null) { Console.Error.WriteLine("REFUSED - " + refused); return 2; }
        r.WaitForExit();
        Console.WriteLine(r.Log.Trim());
        if (r.ExitCode != 0) return r.ExitCode;
        GraphPage.Write(Path.Combine(package, "WebView", "BlueprintView.html"), r.Output, asm, asm + " as Unity compiled it (" + Path.GetFileName(folder.Dir) + ")", page, out var files);
        Console.WriteLine("page " + page + ": " + files + " graph files inside it");
        return 0;
    }
}
"""


def run_window(target, project, page):
    """the window's three classes, compiled from the PACKAGED files into a console program, run over `project`"""
    work = tempfile.mkdtemp(prefix="bpv_unity_run_")
    try:
        root = extract(target, os.path.join(work, "project_copy"))
        h = os.path.join(work, "harness")
        os.makedirs(h)
        srcs = "".join('    <Compile Include="%s" />\n' % os.path.join(root, "Editor", f).replace("\\", "/")
                       for f in ("CompileFolder.cs", "GraphReader.cs", "GraphPage.cs"))
        io.open(os.path.join(h, "harness.csproj"), "w", encoding="utf-8").write(
            '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework>'
            '<Nullable>disable</Nullable><RollForward>Major</RollForward></PropertyGroup>\n  <ItemGroup>\n%s  </ItemGroup>\n</Project>\n' % srcs)
        io.open(os.path.join(h, "Harness.cs"), "w", encoding="utf-8").write(HARNESS)
        code, text = run(["dotnet", "build", h, "-c", "Release", "--nologo", "-v", "q"])
        if code != 0:
            print(text[-2000:])
            return 1
        dll = os.path.join(h, "bin", "Release", "net8.0", "harness.dll")
        code, text = run(["dotnet", dll, project, root, page])
        print(text)
        return code
    finally:
        shutil.rmtree(work, ignore_errors=True)


def build(target):
    work = tempfile.mkdtemp(prefix="bpv_unity_pkg_")
    try:
        files = assets()
        for name, data in publish(work).items():
            files["%s/Reader/%s.bytes" % (ROOT, name)] = data
        n = write(files, target)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    bad, paths, _ = check(target)
    size = os.path.getsize(target)
    print("unity_package: %s - %d assets (%d files, %d folders), %.1f MB" % (target, n, len(files), n - len(files), size / 1048576.0))
    for p in sorted(paths):
        print("  %s" % p)
    for b in bad:
        print("  BAD %s" % b)
    print("unity_package check: %s" % ("PASS" if not bad else "%d problem(s) - FAIL" % len(bad)))
    return 1 if bad else 0


def selftest():
    """each plant refused by check(); the unplanted package passes"""
    work = tempfile.mkdtemp(prefix="bpv_unity_self_")
    fails = []
    try:
        base = {"%s/Editor/BlueprintViewWindow.cs" % ROOT: b"class A {}\n", "%s/Reader/U2ue.CodeGraph.dll.bytes" % ROOT: b"MZ",
                "%s/Reader/U2ue.CodeGraph.runtimeconfig.json.bytes" % ROOT: b"{}", "%s/WebView/BlueprintView.html" % ROOT: b"<html></html>"}
        clean = os.path.join(work, "clean.unitypackage")
        write(base, clean)
        if check(clean)[0]:
            fails.append("the clean package failed: %s" % check(clean)[0])

        def planted(name, edit):
            p = os.path.join(work, name + ".unitypackage")
            pkg = read(clean)
            edit(pkg)
            with tarfile.open(p, "w:gz") as tar:
                for g, e in pkg.items():
                    for leaf, data in e.items():
                        info = tarfile.TarInfo(g + "/" + leaf)
                        info.size = len(data)
                        tar.addfile(info, io.BytesIO(data))
            return check(p)[0]
        g0 = guid("%s/Editor/BlueprintViewWindow.cs" % ROOT)
        cases = [
            ("a missing meta", lambda pkg: pkg[g0].pop("asset.meta"), "no asset.meta"),
            ("a GUID used twice", lambda pkg: pkg.__setitem__("f" * 32, dict(pkg[g0], **{"asset.meta": pkg[g0]["asset.meta"].replace(g0.encode(), b"f" * 32)})), "two assets"),
            ("an executable", lambda pkg: pkg.__setitem__("e" * 32, {"pathname": ("%s/Reader/tool.exe" % ROOT).encode(), "asset": b"MZ",
                                                                      "asset.meta": ("fileFormatVersion: 2\nguid: %s\nDefaultImporter:\n" % ("e" * 32)).encode()}), "an executable"),
            ("a stray .js", lambda pkg: pkg.__setitem__("d" * 32, {"pathname": ("%s/WebView/view.js" % ROOT).encode(), "asset": b"x",
                                                                    "asset.meta": ("fileFormatVersion: 2\nguid: %s\nTextScriptImporter:\n" % ("d" * 32)).encode()}), "a script Unity does not compile"),
        ]
        for what, edit, want in cases:
            got = planted(what.replace(" ", "_"), edit)
            ok = any(want in b for b in got)
            print("unity_package selftest: %s %s" % (what, "refused - PASS" if ok else "NOT refused - FAIL (%s)" % got))
            if not ok:
                fails.append(what)
        a1, a2 = os.path.join(work, "a.unitypackage"), os.path.join(work, "b.unitypackage")
        write(base, a1)
        write(base, a2)
        same = open(a1, "rb").read() == open(a2, "rb").read()
        print("unity_package selftest: two builds of the same files are the same bytes %s" % ("- PASS" if same else "- FAIL"))
        if not same:
            fails.append("not reproducible")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print("unity_package selftest: %s" % ("PASS" if not fails else "FAIL: " + ", ".join(fails)))
    return 1 if fails else 0


def main(argv):
    if argv == ["--selftest"]:
        return selftest()
    if len(argv) == 2 and argv[0] == "build":
        return build(argv[1])
    if len(argv) >= 2 and argv[0] == "check":
        bad, paths, _ = check(argv[1])
        for b in bad:
            print("  BAD %s" % b)
        code = 1 if bad else 0
        print("unity_package check: %d assets, %s" % (len(paths), "PASS" if not bad else "%d problem(s) - FAIL" % len(bad)))
        if argv[2:3] == ["--project"] and len(argv) == 4:
            r = compile_check(argv[1], argv[3])
            print("unity_package compile: U2ue.BlueprintView.Editor against %s's editor (Unity %s): %d error(s), %d warning(s)"
                  % (argv[3], r["version"], len(r["errors"]), len(r["warnings"])))
            for line in r["errors"] + r["warnings"]:
                print("  " + line)
            code = code or (1 if r["errors"] or r["warnings"] else 0)
        return code
    if len(argv) == 6 and argv[0] == "run" and argv[2] == "--project" and argv[4] == "--page":
        return run_window(argv[1], argv[3], argv[5])
    print(__doc__)
    return 0 if argv in (["--help"], ["-h"]) else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
