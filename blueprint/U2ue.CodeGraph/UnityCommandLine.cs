using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace U2ue.CodeGraph;

/// <summary>The compiler command line Unity wrote for one assembly (a Bee .rsp under Library/Bee/artifacts/&lt;dag&gt;/): every
/// source, reference, define, the language version and the source generators, exactly as Unity compiles that assembly. Reading a
/// Unity project through it reads the project the way its build compiles it - the generated .csproj lists the same sources but
/// not the generators, and a project of many assemblies has one .rsp per assembly (the toolkit's typecheck.py compiles from the
/// same files, bee_dag.py picks the editor's folder). Relative paths are the project root's: Unity runs the compiler there.</summary>
public sealed class UnityCommandLine
{
    public readonly List<string> Sources = new();
    public readonly List<string> References = new();
    public readonly List<string> Defines = new();
    public readonly List<string> Analyzers = new();
    public string? LangVersion;
    public bool Unsafe;
    public NullableContextOptions Nullable = NullableContextOptions.Disable;

    /// <summary>The .rsp read line by line (one argument per line, as Unity writes it); an option it does not know is ignored only
    /// when it cannot change what compiles (output paths, warnings, debug info) - any other is REFUSED, never guessed at.</summary>
    public static UnityCommandLine Read(string rsp, string root)
    {
        var c = new UnityCommandLine();
        string Full(string p) => Path.GetFullPath(Path.IsPathRooted(p) ? p : Path.Combine(root, p));
        foreach (var raw in File.ReadAllLines(rsp))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;
            var arg = Unquote(line);
            if (!line.StartsWith("-") && !line.StartsWith("/")) { if (arg.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) c.Sources.Add(Full(arg)); else throw Unknown(rsp, line); continue; }
            var (name, value) = Split(line);
            switch (name)
            {
                case "r": case "reference": c.References.Add(Full(Unquote(value))); break;
                case "define": c.Defines.AddRange(value.Split(';', ',').Select(d => d.Trim()).Where(d => d.Length > 0)); break;
                case "langversion": c.LangVersion = value; break;
                case "analyzer": c.Analyzers.Add(Full(Unquote(value))); break;
                case "unsafe": case "unsafe+": c.Unsafe = true; break;
                case "nullable": case "nullable+": c.Nullable = value is "" or "enable" ? NullableContextOptions.Enable : value == "disable" ? NullableContextOptions.Disable :
                                                                value == "warnings" ? NullableContextOptions.Warnings : value == "annotations" ? NullableContextOptions.Annotations :
                                                                throw Unknown(rsp, line); break;
                // what cannot change which code compiles or what it means: outputs, diagnostics' reporting, debug and build info
                case "target": case "out": case "refout": case "nowarn": case "warnaserror": case "warnaserror+": case "warnaserror-":
                case "nologo": case "deterministic": case "debug": case "optimize": case "optimize-": case "optimize+": case "utf8output":
                case "preferreduilang": case "additionalfile": case "runtimemetadataversion": case "nostdlib": case "nostdlib+":
                case "nostdlib-": case "noconfig": case "ruleset": case "warn": case "errorreport": case "fullpaths": case "pathmap":
                case "generatedfilesout": case "analyzerconfig":
                    break;
                default: throw Unknown(rsp, line);
            }
        }
        if (c.Sources.Count == 0) throw new InvalidOperationException(rsp + " names no source file");
        return c;
    }

    /// <summary>The scripts under Assets that no command line in the .rsp's folder lists. That folder is one build's command lines
    /// (Unity writes one per assembly), so a script missing from all of them was written after that build: the snapshot is older
    /// than the project, and reading it would draw a project that no longer exists. Only the scripts Unity's own rule puts in a
    /// predefined assembly are checked - every one of those is compiled - so a folder with an .asmdef or .asmref (its own
    /// assembly, on its own terms) is skipped, as are the folders Unity ignores (hidden, ending in '~', or named cvs: the Unity
    /// manual's "Special folder names").</summary>
    public static List<string> Unlisted(string root, string rspDir)
    {
        var listed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var rsp in Directory.GetFiles(rspDir, "*.rsp"))
        {
            // <assembly>.dll.mvfrm.rsp beside each command line lists the build's inputs for another step, not a compile
            if (rsp.EndsWith(".mvfrm.rsp", StringComparison.OrdinalIgnoreCase)) continue;
            foreach (var raw in File.ReadLines(rsp))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line[0] == '-' || line[0] == '/') continue;
                var arg = Unquote(line);
                if (arg.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                    listed.Add(Path.GetFullPath(Path.IsPathRooted(arg) ? arg : Path.Combine(root, arg)));
            }
        }
        var unlisted = new List<string>();
        var assets = Path.Combine(root, "Assets");
        if (!Directory.Exists(assets)) return unlisted;
        var dirs = new Stack<string>();
        dirs.Push(assets);
        while (dirs.Count > 0)
        {
            var dir = dirs.Pop();
            var files = Directory.GetFiles(dir);
            if (files.Any(f => f.EndsWith(".asmdef", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".asmref", StringComparison.OrdinalIgnoreCase))) continue;
            foreach (var f in files)
                if (f.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) && !listed.Contains(Path.GetFullPath(f))) unlisted.Add(f);
            foreach (var d in Directory.GetDirectories(dir))
            {
                var name = Path.GetFileName(d);
                if (name.StartsWith(".") || name.EndsWith("~") || name.Equals("cvs", StringComparison.OrdinalIgnoreCase)) continue;
                dirs.Push(d);
            }
        }
        unlisted.Sort(StringComparer.Ordinal);
        return unlisted;
    }

    static (string, string) Split(string line)
    {
        var body = line.Substring(1);
        var k = body.IndexOf(':');
        var name = (k < 0 ? body : body.Substring(0, k)).ToLowerInvariant();
        return (name, k < 0 ? "" : body.Substring(k + 1));
    }

    static string Unquote(string s) => s.Length >= 2 && s[0] == '"' && s[^1] == '"' ? s.Substring(1, s.Length - 2) : s;

    static InvalidOperationException Unknown(string rsp, string line) =>
        new(rsp + ": an option the reader does not know, which may change what compiles: " + line);

    /// <summary>The source generators the command line names, run over the compilation as the compiler runs them: what they write is
    /// compiled with the project (an attribute's partial members) but is not the project's own code, so it is never drawn.</summary>
    public CSharpCompilation RunGenerators(CSharpCompilation comp, CSharpParseOptions parse, out List<string> notes)
    {
        notes = new List<string>();
        var generators = new List<ISourceGenerator>();
        foreach (var a in Analyzers)
        {
            if (!File.Exists(a)) throw new InvalidOperationException("a source generator the command line names is missing: " + a);
            var gens = new Microsoft.CodeAnalysis.Diagnostics.AnalyzerFileReference(a, AssemblyLoader.Instance).GetGenerators(LanguageNames.CSharp);
            generators.AddRange(gens);
            notes.Add(Path.GetFileName(a) + ": " + gens.Length + " generator(s)");
        }
        if (generators.Count == 0) return comp;
        var driver = CSharpGeneratorDriver.Create(generators, parseOptions: parse);
        driver.RunGeneratorsAndUpdateCompilation(comp, out var updated, out _);
        return (CSharpCompilation)updated;
    }

    sealed class AssemblyLoader : Microsoft.CodeAnalysis.IAnalyzerAssemblyLoader
    {
        public static readonly AssemblyLoader Instance = new();
        public void AddDependencyLocation(string fullPath) { }
        public System.Reflection.Assembly LoadFromPath(string fullPath) => System.Reflection.Assembly.LoadFrom(fullPath);
    }
}
