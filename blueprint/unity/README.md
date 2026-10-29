# Blueprint View for Unity

Your project's C# drawn as Blueprint-style node graphs: every method an event or function graph, its statements an exec chain,
its values nodes wired into the pins that read them - with the same method's C#, a C++ reading and plain pseudo-code beside it.

## Use

1. **Window > u2ue > Blueprint View**.
2. Pick an assembly (Assembly-CSharp is picked for you when your project has one).
3. **Read and open**. Your browser opens the page; click a method in the list to draw it.

The read takes seconds to a minute, depending on the size of the assembly. While Unity is compiling, wait for it to finish: the
compile rewrites what the reader reads.

## What it reads, and why it can refuse

Unity writes one compiler command line per assembly (`Library/Bee/artifacts/<build>/<assembly>.rsp`): its scripts, references,
defines, language version and source generators. The reader reads the assembly from that command line, so the graphs are of the
code exactly as Unity compiled it. It refuses rather than guesses, with the reason in the window:

- **The command line is older than the project.** A script was written since Unity last compiled, so the command line does not
  list it. Press **Recompile, then read again**.
- **The assembly does not compile here.** A graph of code that does not compile could draw a call as something it is not.

## What it needs

- The **.NET 8 runtime** or newer (`dotnet`): https://dotnet.microsoft.com/download. The reader (U2ue.CodeGraph, built on Roslyn)
  runs outside Unity, so it never loads into the editor.
- A Unity that writes its compiler command lines to `Library/Bee/artifacts` when it compiles a project (the window says so when
  it finds none). Compiled and run against Unity 6000.3; older versions are not measured.

## What it changes

Nothing under Assets or ProjectSettings. The reader is copied to `Library/U2ueBlueprintView/reader`, and its graphs and the page are
written under `Library/U2ueBlueprintView` - delete that folder to remove every trace. Everything runs on your machine: the page is
one file opened from disk, and the only thing it fetches is its two typefaces (Google Fonts; offline it uses your system's).

## Files

- `Editor/` - the window (`BlueprintViewWindow`), the compile folder it reads (`CompileFolder`), the reader's process
  (`GraphReader`) and the page writer (`GraphPage`), in the editor-only assembly `U2ue.BlueprintView.Editor`.
- `Reader/` - the reader's .NET assemblies, shipped as `.bytes` so Unity keeps them as data.
- `WebView/BlueprintView.html` - the page, with its scripts inside it; the window writes your graphs into a copy.

The source is open: the reader, the page and this package are one repository, under the MIT licence (`LICENSE.md`).
