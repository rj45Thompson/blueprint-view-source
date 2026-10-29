# Blueprint View

C# and Unreal Blueprints read into ONE graph language and printed back as either: a project's methods drawn as Blueprint-style
node graphs (with the same method's C#, a C++ reading and plain pseudo-code beside it), and a Blueprint's text converted to code
with every node traced to the use case step and the requirement it serves - drawn as a 3D city whose games run on the converted
code while their nodes light up.

The language is trusted only while it round-trips: every graph, read back from disk, prints C# whose syntax tree equals its
method's - 5,018 of 5,018 methods of a Unity project read from Unity's own compiler command line, and the Blueprint converter's
output parses as C# for every template Blueprint of Unreal Engine 5.7 (275 of 275 methods).

## What is here

- `blueprint/U2ue.CodeGraph` - the C# reader (.NET 8, Roslyn). `graph` writes a project's methods as `.ngl` files; `--rsp` reads a
  Unity assembly from the command line Unity wrote for it, and refuses one older than the project it describes.
- `blueprint/view` - the page (`index.html`), the 3D city (`view3d.html`), the graph language and its printers (`pl.js`), the
  Blueprint converter (`bp.js`), the trace (`trace.js`), the classes (`oo.js`), and their command lines (`*_cli.js`).
- `blueprint/samples/online` - four Blueprint sets people pasted on blueprintue.com (a lock-on system, a two-paddle game, an asteroid
  shooter, and a 1,009-node enemy AI chosen for its friction): each paste's manifest and each set's use case model. The paste text is
  its author's, so it is fetched, never committed.
- `blueprint/unity` - a Unity package: Window > u2ue > Blueprint View draws your project's assemblies (`blueprint/unity/README.md`).
- `autobot` - the use case checkers a set's build runs: the model's rules and its closed loop.

## Run it

Needs Python with PyYAML, Node.js, a .NET SDK that builds net8.0 (and a .NET 8 runtime or newer to run the reader), and for a set's
build an Unreal Engine install named by `UE_ROOT` - the class assembly reads the engine's own headers. Measured with Python 3.13,
Node.js 25, .NET SDK 10 with the .NET 8 runtime, and Unreal Engine 5.7; older versions are not measured.

```
py -I -X utf8 blueprint/tools/online_sample.py fetch blueprint/samples/online/pong/SOURCES.json
py -X utf8 blueprint/tools/build_set.py samples/online/pong "Pong"
py -m http.server 8797 --directory blueprint
```

Then open http://127.0.0.1:8797/view/view3d.html#pong. The build's last word is the closed loop: every requirement it reads from
the Blueprints is held to the code, each one planted the other way must flip, and every hole that is not the owner's to answer
must be closed.

The Unity package: `py -X utf8 blueprint/tools/unity_package.py build U2ue.BlueprintView.unitypackage`, then Assets > Import
Package > Custom Package in Unity.

## Licence

MIT (`LICENSE`).
