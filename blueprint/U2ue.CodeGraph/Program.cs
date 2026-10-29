// U2ue.CodeGraph - the Blueprint view's reader (quarantine/blueprint_view/PLAN.md). Five verbs over one project, all loading it the
// same way and reading the same units (GraphUnits.cs):
//
//   census    how much of the code draws as Blueprint nodes, and the size of each hazard (Census.cs)
//   graph     every unit written in the node graph language, one .ngl per source file (CodeGraphReader.cs)
//   roundtrip view/pl.js's printed C# compared with each unit's body (RoundTripGate.cs)
//   instrument a COPY of the project with a probe on every value node, keyed by its graph id (Instrumenter.cs)
//   edit      a typed command on a graph node turned into the smallest source change, as a proposal file (EditWriter.cs)
//   syntax    every method of a folder of *.printed.txt parsed as C# (SyntaxGate.cs; the Blueprint converter's output) - needs
//             only --printed
//
//   dotnet run -c Release --project blueprint/U2ue.CodeGraph -- census
//       --measure <project dir> --refs "<dotnet>/packs/Microsoft.NETCore.App.Ref/8.0.x/ref/net8.0"
//       --out census/<project>.json
//   ... -- graph --measure <project> --refs <dir> --out <graphs dir>
//   ... -- roundtrip --measure <project> --refs <dir> --printed <dir of *.printed.txt> [--show N]
//   (a project that references another: add --with <its source dir>; --lang overrides the csproj's LangVersion)
//
// Exit codes: 0 done and clean; 1 done, but something did not hold (census: an unclassified kind or unresolved call; roundtrip: a
// graph that does not print back); 2 bad arguments; 3 the project does not compile.
namespace U2ue.CodeGraph;

public static class Program
{
    const string Usage = "usage: U2ue.CodeGraph census|graph|roundtrip|instrument|edit --measure <project dir> --refs <reference assembly dir> " +
                         "(--out <census.json | graphs dir> | --printed <dir>) [--with <source dir>]... [--lang <C# version>] [--show N]\n" +
                         "       U2ue.CodeGraph census|graph|roundtrip --measure <Unity project root> --rsp <Library/Bee/artifacts/<dag>/<assembly>.rsp> " +
                         "(--out ... | --printed <dir>)   (a Unity assembly as Unity compiles it: no --refs)\n" +
                         "       U2ue.CodeGraph syntax --printed <dir> [--show N]";

    public static int Main(string[] args)
    {
        if (args.Length == 0 || args[0] is not ("census" or "graph" or "roundtrip" or "instrument" or "edit" or "syntax")) { Console.Error.WriteLine(Usage); return 2; }
        string? measure = null, refs = null, outPath = null, lang = null, printed = null, command = null, proposal = null, rsp = null;
        int show = 25;
        var with = new List<string>();
        for (int i = 1; i < args.Length; i++)
        {
            if (i + 1 >= args.Length) { Console.Error.WriteLine($"{args[i]} needs a value\n{Usage}"); return 2; }
            switch (args[i])
            {
                case "--measure": measure = args[++i]; break;
                case "--refs": refs = args[++i]; break;
                case "--out": outPath = args[++i]; break;
                case "--printed": printed = args[++i]; break;
                case "--command": command = args[++i]; break;
                case "--proposal": proposal = args[++i]; break;
                case "--with": with.Add(args[++i]); break;
                case "--lang": lang = args[++i]; break;
                case "--show": show = int.Parse(args[++i]); break;
                case "--rsp": rsp = args[++i]; break;
                default: Console.Error.WriteLine($"unknown argument {args[i]}\n{Usage}"); return 2;
            }
        }
        if (args[0] == "syntax")
        {
            if (printed == null) { Console.Error.WriteLine(Usage); return 2; }
            return SyntaxGate.Run(printed, show);
        }
        if (measure == null || (refs == null && rsp == null)) { Console.Error.WriteLine(Usage); return 2; }
        if (!Directory.Exists(measure)) { Console.Error.WriteLine($"{args[0]}: no such directory " + measure); return 2; }
        if (rsp != null)
        {
            // a Unity assembly: its references are the command line's own, so a --refs folder or --with sources would change it
            if (refs != null || with.Count > 0 || lang != null) { Console.Error.WriteLine($"{args[0]}: --rsp names every reference, source and version itself; drop --refs, --with and --lang"); return 2; }
            if (!File.Exists(rsp)) { Console.Error.WriteLine($"{args[0]}: no such command line " + rsp); return 2; }
            LoadedProject.Rsp = Path.GetFullPath(rsp);
            refs = "";
        }
        else if (!Directory.Exists(refs) || Directory.GetFiles(refs!, "*.dll").Length == 0)
        {
            Console.Error.WriteLine($"{args[0]}: no reference assemblies in " + refs);
            return 2;
        }
        foreach (var w in with)
            if (!Directory.Exists(w)) { Console.Error.WriteLine($"{args[0]}: no such directory " + w); return 2; }
        switch (args[0])
        {
            case "census":
                if (outPath == null) { Console.Error.WriteLine(Usage); return 2; }
                return Census.Run(measure, with, refs, outPath, lang);
            case "graph":
                if (outPath == null) { Console.Error.WriteLine(Usage); return 2; }
                return CodeGraphReader.Run(measure, with, refs, outPath, lang);
            case "instrument":
                if (outPath == null) { Console.Error.WriteLine(Usage); return 2; }
                return Instrumenter.Run(measure, with, refs, outPath, lang);
            case "edit":
                if (command == null || proposal == null) { Console.Error.WriteLine(Usage); return 2; }
                return EditWriter.Run(measure, with, refs, command, proposal, lang);
            default:
                if (printed == null) { Console.Error.WriteLine(Usage); return 2; }
                return RoundTripGate.Run(measure, with, refs, printed, lang, show);
        }
    }
}
