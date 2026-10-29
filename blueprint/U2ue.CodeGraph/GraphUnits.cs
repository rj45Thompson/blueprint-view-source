// What counts as one graph, and how a project is loaded - shared by the census, the graph reader and the round trip, so the three
// can never disagree about which methods exist (PLAN.md phase 2: "what the census measured is what will be drawn").
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace U2ue.CodeGraph;

/// <summary>One graph the view draws: a method, constructor, accessor, operator, expression-bodied member or local function, with
/// the body that becomes its exec chain and the symbol that owns its parameters.</summary>
public readonly record struct GraphUnit(SyntaxNode Decl, SyntaxNode Body, IMethodSymbol? Owner)
{
    /// <summary>Type.Member, or Parent>Local for a local function - the census's names, unchanged.</summary>
    public string Name => Owner == null ? Decl.Kind().ToString()
        : Owner.MethodKind == MethodKind.LocalFunction ? Owner.ContainingSymbol?.Name + ">" + Owner.Name
        : Owner.ContainingType?.Name + "." + Owner.Name;

    /// <summary>Every unit in a tree, in source order.</summary>
    public static IEnumerable<GraphUnit> In(SyntaxTree tree, SemanticModel model)
    {
        foreach (var node in tree.GetRoot().DescendantNodes())
        {
            switch (node)
            {
                case BaseMethodDeclarationSyntax m when m.Body != null || m.ExpressionBody != null:
                    yield return new(m, (SyntaxNode?)m.Body ?? m.ExpressionBody!, model.GetDeclaredSymbol(m));
                    break;
                case AccessorDeclarationSyntax a when a.Body != null || a.ExpressionBody != null:
                    yield return new(a, (SyntaxNode?)a.Body ?? a.ExpressionBody!, model.GetDeclaredSymbol(a));
                    break;
                case PropertyDeclarationSyntax p when p.ExpressionBody != null:
                    yield return new(p, p.ExpressionBody, model.GetDeclaredSymbol(p)?.GetMethod);
                    break;
                case IndexerDeclarationSyntax ix when ix.ExpressionBody != null:
                    yield return new(ix, ix.ExpressionBody, model.GetDeclaredSymbol(ix)?.GetMethod);
                    break;
                case LocalFunctionStatementSyntax lf when lf.Body != null || lf.ExpressionBody != null:
                    yield return new(lf, (SyntaxNode?)lf.Body ?? lf.ExpressionBody!, model.GetDeclaredSymbol(lf) as IMethodSymbol);
                    break;
            }
        }
    }
}

/// <summary>A project compiled the way the census compiles it: its own sources (plus any --with sources it references) against a
/// reference-assembly folder, refusing to go on when it does not compile, because an unresolved call would be drawn as what it is not.</summary>
public sealed class LoadedProject
{
    public string Root = "";
    public CSharpCompilation Compilation = null!;
    public List<SyntaxTree> Measured = new();
    public LanguageVersion Version;
    public string VersionFrom = "";
    public CSharpParseOptions Parse = null!;

    /// <summary>A Unity command line (Program's --rsp): when set, a project loads from it - its sources, references, defines and
    /// generators exactly as Unity compiles that assembly - and --measure names the Unity project root its paths are relative to.</summary>
    public static string? Rsp;

    /// <summary>The project, or null with the reason printed and the exit code to return (2 bad input, 3 does not compile).</summary>
    public static LoadedProject? Load(string measure, IReadOnlyList<string> with, string refDir, string? lang, string tool, out int exit)
    {
        exit = 0;
        measure = Path.GetFullPath(measure);
        if (Rsp != null) return LoadUnity(measure, tool, out exit);
        var version = LanguageVersionOf(measure, lang, tool, out var versionFrom);
        if (version == null) { exit = 2; return null; }
        var measured = SourceFiles(measure).ToList();
        var extra = with.SelectMany(SourceFiles).ToList();
        if (measured.Count == 0) { Console.Error.WriteLine($"{tool}: no .cs files under {measure}"); exit = 2; return null; }
        var parse = new CSharpParseOptions(version.Value);
        var trees = measured.Concat(extra).Select(f => CSharpSyntaxTree.ParseText(File.ReadAllText(f), parse, path: f)).ToList();
        // the SDK's implicit global usings, as the build adds them: compiled with the project, never drawn as its code
        string? implicitWhy;
        var implicitUsings = ImplicitUsings(measure, parse, out implicitWhy);
        if (implicitWhy != null) { Console.Error.WriteLine($"{tool}: REFUSED - {implicitWhy}"); exit = 2; return null; }
        if (implicitUsings != null) trees.Add(implicitUsings);
        var refs = Directory.GetFiles(refDir, "*.dll").Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("U2ueCodeGraph", trees, refs, AsCsc(new CSharpCompilationOptions(
            OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true, nullableContextOptions: NullableContextOptions.Disable)));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        if (errors.Count > 0)
        {
            Console.Error.WriteLine($"{tool}: REFUSED - the project does not compile here ({errors.Count} errors), so a call could be read as what it is not:");
            foreach (var d in errors.Take(15)) Console.Error.WriteLine("  " + d);
            exit = 3;
            return null;
        }
        return new LoadedProject
        {
            Root = measure, Compilation = comp, Measured = trees.Take(measured.Count).ToList(), Version = version.Value,
            VersionFrom = versionFrom, Parse = parse,
        };
    }

    public string Relative(string path) => Path.GetRelativePath(Root, path).Replace('\\', '/');

    /// <summary>The options as the compiler itself sets them: csc matches a reference's assembly identities with the desktop
    /// comparer, which unifies framework versions and retargets retargetable ones - read from Unity's own copy of it
    /// (Editor/Data/DotNetSdkRoslyn/Microsoft.CodeAnalysis.CSharp.dll, CSharpCompiler.CreateCompilation: DesktopAssemblyIdentityComparer
    /// .Default unless /appconfig names another, an option the command line reader refuses). `dotnet build` runs the same class.
    /// Measured 2026-10-28: without it, a Unity plugin built against the Compact Framework's mscorlib 3.5.0.0 gave 119 CS0012
    /// errors in an assembly Unity had compiled from the same command line a minute after writing it.</summary>
    static CSharpCompilationOptions AsCsc(CSharpCompilationOptions o) => o.WithAssemblyIdentityComparer(DesktopAssemblyIdentityComparer.Default);

    /// <summary>A Unity assembly read from its command line (UnityCommandLine): the .rsp is a snapshot of Unity's last compile, so a
    /// file or reference it names that is gone is REFUSED (recompile in Unity, then read), as is a compile with errors.</summary>
    static LoadedProject? LoadUnity(string root, string tool, out int exit)
    {
        exit = 0;
        UnityCommandLine c;
        try { c = UnityCommandLine.Read(Rsp!, root); }
        catch (Exception e) when (e is InvalidOperationException or IOException) { Console.Error.WriteLine($"{tool}: REFUSED - {e.Message}"); exit = 2; return null; }
        if (c.LangVersion == null || !LanguageVersionFacts.TryParse(c.LangVersion, out var version))
        {
            Console.Error.WriteLine($"{tool}: REFUSED - {Rsp} names no C# language version the reader knows ({c.LangVersion ?? "none"})");
            exit = 2;
            return null;
        }
        var gone = c.Sources.Concat(c.References).Where(f => !File.Exists(f)).ToList();
        if (gone.Count > 0)
        {
            Console.Error.WriteLine($"{tool}: REFUSED - {gone.Count} file(s) the command line names are gone (it is the last compile's snapshot; recompile in Unity): {string.Join(", ", gone.Take(5))}");
            exit = 2;
            return null;
        }
        // the other way round: a script written since that compile is in no command line yet. Measured 2026-10-28 on the game's
        // own project: three scripts of 10-27 18:03 against a command line of 10-26 12:20 - the files that already used them did
        // not compile, and a script nothing used yet would have dropped out of the graphs without a word
        var unlisted = UnityCommandLine.Unlisted(root, Path.GetDirectoryName(Rsp!)!);
        if (unlisted.Count > 0)
        {
            Console.Error.WriteLine($"{tool}: REFUSED - the command line is older than the project: {unlisted.Count} script(s) under Assets are in no command " +
                                    $"line of {Path.GetFileName(Path.GetDirectoryName(Rsp!))} (written {File.GetLastWriteTime(Rsp!):yyyy-MM-dd HH:mm}), " +
                                    "so Unity has not compiled them yet - let Unity recompile, then read again:");
            foreach (var f in unlisted.Take(8)) Console.Error.WriteLine($"  {Path.GetRelativePath(root, f).Replace('\\', '/')} (written {File.GetLastWriteTime(f):yyyy-MM-dd HH:mm})");
            exit = 2;
            return null;
        }
        var parse = new CSharpParseOptions(version, preprocessorSymbols: c.Defines);
        var trees = c.Sources.Select(f => CSharpSyntaxTree.ParseText(File.ReadAllText(f), parse, path: f)).ToList();
        var refs = c.References.Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("U2ueCodeGraph", trees, refs, AsCsc(new CSharpCompilationOptions(
            OutputKind.DynamicallyLinkedLibrary, allowUnsafe: c.Unsafe, nullableContextOptions: c.Nullable)));
        comp = c.RunGenerators(comp, parse, out var notes);
        Console.WriteLine($"{tool}: {Path.GetFileName(Rsp)}: {trees.Count} sources, {refs.Count} references, {c.Defines.Count} defines, C# {c.LangVersion}; " +
                          (notes.Count == 0 ? "no generators" : string.Join("; ", notes)));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        if (errors.Count > 0)
        {
            Console.Error.WriteLine($"{tool}: REFUSED - the assembly does not compile here ({errors.Count} errors), so a call could be read as what it is not:");
            foreach (var d in errors.Take(15)) Console.Error.WriteLine("  " + d);
            exit = 3;
            return null;
        }
        return new LoadedProject { Root = root, Compilation = comp, Measured = trees, Version = version, VersionFrom = Path.GetFileName(Rsp) + " -langversion", Parse = parse };
    }

    /// <summary>The global usings an SDK project gets when its .csproj sets ImplicitUsings (the build writes them into a generated
    /// file): null when it does not; `why` says so when it does under an SDK whose list the reader does not know - never guessed.
    /// Microsoft.NET.Sdk's list is the one its targets write (System, System.Collections.Generic, System.IO, System.Linq,
    /// System.Net.Http, System.Threading, System.Threading.Tasks).</summary>
    static SyntaxTree? ImplicitUsings(string measure, CSharpParseOptions parse, out string? why)
    {
        why = null;
        var projects = Directory.GetFiles(measure, "*.csproj");
        if (projects.Length != 1) return null;
        var doc = XDocument.Load(projects[0]);
        var on = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "ImplicitUsings")?.Value.Trim().ToLowerInvariant();
        if (on is not ("enable" or "true")) return null;
        var sdk = doc.Root?.Attribute("Sdk")?.Value;
        if (sdk != "Microsoft.NET.Sdk")
        {
            why = $"{Path.GetFileName(projects[0])} turns ImplicitUsings on under the SDK '{sdk}', whose implicit usings the reader does not know";
            return null;
        }
        var text = string.Join("\n", new[] { "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http",
                                             "System.Threading", "System.Threading.Tasks" }.Select(n => $"global using global::{n};"));
        return CSharpSyntaxTree.ParseText(text, parse, path: Path.Combine(measure, "obj", "ImplicitUsings.g.cs"));
    }

    static LanguageVersion? LanguageVersionOf(string measure, string? lang, string tool, out string from)
    {
        from = "--lang";
        var text = lang;
        if (text == null)
        {
            var projects = Directory.GetFiles(measure, "*.csproj");
            if (projects.Length != 1)
            {
                Console.Error.WriteLine($"{tool}: {projects.Length} .csproj files in {measure}; pass --lang to name the language version");
                return null;
            }
            text = XDocument.Load(projects[0]).Descendants().FirstOrDefault(e => e.Name.LocalName == "LangVersion")?.Value.Trim();
            from = Path.GetFileName(projects[0]) + " <LangVersion>";
            if (string.IsNullOrEmpty(text))
            {
                Console.Error.WriteLine($"{tool}: {projects[0]} names no LangVersion (the SDK would pick the target framework's); pass --lang");
                return null;
            }
        }
        if (!LanguageVersionFacts.TryParse(text, out var v))
        {
            Console.Error.WriteLine($"{tool}: '{text}' ({from}) is not a C# language version");
            return null;
        }
        return v;
    }

    /// <summary>The .cs files a project builds: every one under its folder (bin and obj aside), less those its .csproj takes out with
    /// <c>&lt;Compile Remove="a.cs;b\c.cs" /&gt;</c> - the project's own list of its sources. Measured 2026-10-28 on a second game
    /// (Zombie Crossing's MonoGame port), whose network files are removed there: read as plain files, they would not compile. A
    /// project that lists its sources another way (a wildcard Remove, Compile Include, EnableDefaultCompileItems false) is REFUSED,
    /// never read as a different set of files than its build compiles.</summary>
    static IEnumerable<string> SourceFiles(string dir)
    {
        var root = Path.GetFullPath(dir);
        var removed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var proj in Directory.GetFiles(root, "*.csproj"))
        {
            var doc = System.Xml.Linq.XDocument.Load(proj);
            foreach (var e in doc.Descendants())
            {
                if (e.Name.LocalName == "EnableDefaultCompileItems" && e.Value.Trim().Equals("false", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException(proj + " lists its sources itself (EnableDefaultCompileItems false), which the reader does not read");
                if (e.Name.LocalName != "Compile") continue;
                if (e.Attribute("Include") != null)
                    throw new InvalidOperationException(proj + ": <Compile Include=\"" + e.Attribute("Include")!.Value + "\"> - a source list the reader does not read");
                var rm = e.Attribute("Remove")?.Value;
                if (rm == null) continue;
                foreach (var part in rm.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    if (part.Contains('*') || part.Contains('$'))
                        throw new InvalidOperationException(proj + ": <Compile Remove=\"" + part + "\"> is a pattern, which the reader does not expand");
                    removed.Add(Path.GetFullPath(Path.Combine(root, part.Replace('\\', Path.DirectorySeparatorChar))));
                }
            }
        }
        return Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar)
                     && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar)
                     && !removed.Contains(Path.GetFullPath(f)))
            .OrderBy(f => f, StringComparer.Ordinal);
    }
}
