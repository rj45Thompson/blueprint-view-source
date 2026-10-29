// SyntaxGate: is printed C# well formed? view/bp_cli.js writes each converted Blueprint graph as one `//@graph <at> <name>` section
// of a *.printed.txt; each section is wrapped as a method body and parsed by Roslyn, and a section with any syntax error fails. It
// is a PARSE and says nothing more: the Blueprint's engine types and functions have no declarations here, so no name is resolved
// and no type is checked (BC3 records that limit beside its measurement).
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace U2ue.CodeGraph;

public static class SyntaxGate
{
    public static int Run(string printedDir, int show)
    {
        if (!Directory.Exists(printedDir)) { Console.Error.WriteLine("syntax: no such directory " + printedDir); return 2; }
        int files = 0, sections = 0, bad = 0;
        var failures = new List<string>();
        var parse = new CSharpParseOptions(LanguageVersion.Latest);
        foreach (var f in Directory.EnumerateFiles(printedDir, "*.printed.txt", SearchOption.AllDirectories).OrderBy(x => x, StringComparer.Ordinal))
        {
            files++;
            foreach (var (name, body) in Sections(File.ReadAllText(f)))
            {
                sections++;
                // two lines in front of the body, so a body line is its error line minus 2
                var tree = CSharpSyntaxTree.ParseText("class Converted {\nvoid Method()\n" + body + "\n}\n", parse);
                var error = tree.GetDiagnostics().FirstOrDefault(d => d.Severity == DiagnosticSeverity.Error);
                if (error == null) continue;
                bad++;
                var line = error.Location.GetLineSpan().StartLinePosition.Line - 2;
                var text = body.Replace("\r\n", "\n").Split('\n');
                failures.Add($"{Path.GetRelativePath(printedDir, f)} {name}: {error.GetMessage()} - body line {line + 1}: " +
                             (line >= 0 && line < text.Length ? text[line].Trim() : "?"));
            }
        }
        // a converted Blueprint ASSEMBLED as classes (view/oo.js writes <set>.classes.cs: fields, methods, the parent and the interface)
        // is a whole compilation unit: parsed as one, the same way, its first error named
        int units = 0, badUnits = 0;
        foreach (var f in Directory.EnumerateFiles(printedDir, "*.classes.cs", SearchOption.AllDirectories).OrderBy(x => x, StringComparer.Ordinal))
        {
            units++;
            var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(f), parse);
            var error = tree.GetDiagnostics().FirstOrDefault(d => d.Severity == DiagnosticSeverity.Error);
            if (error == null) continue;
            badUnits++;
            var line = error.Location.GetLineSpan().StartLinePosition.Line;
            var text = File.ReadAllText(f).Replace("\r\n", "\n").Split('\n');
            failures.Add($"{Path.GetRelativePath(printedDir, f)}: {error.GetMessage()} - line {line + 1}: " + (line < text.Length ? text[line].Trim() : "?"));
        }
        Console.WriteLine($"syntax: {files} files, {sections} methods parsed as C#; {bad} with a syntax error" +
                          (units > 0 ? $"; {units} assembled class file(s) parsed whole, {badUnits} with a syntax error" : ""));
        foreach (var fl in failures.Take(show)) Console.WriteLine("  " + fl);
        if (failures.Count > show) Console.WriteLine($"  ... and {failures.Count - show} more");
        // nothing read is a broken selection, never a pass
        return sections > 0 && bad == 0 && badUnits == 0 ? 0 : 1;
    }

    /// <summary>every section in file order: (name, body). Unlike the round trip's map, two graphs may share a line here (one
    /// Blueprint node with several exec outputs starts several methods)</summary>
    static List<(string, string)> Sections(string text)
    {
        var list = new List<(string, string)>();
        string? name = null;
        var body = new System.Text.StringBuilder();
        foreach (var line in text.Replace("\r\n", "\n").Split('\n'))
        {
            if (line.StartsWith(RoundTripGate.Marker, StringComparison.Ordinal))
            {
                if (name != null) list.Add((name, body.ToString()));
                var head = line.Substring(RoundTripGate.Marker.Length).Trim();
                name = head.Contains(' ') ? head.Substring(head.IndexOf(' ') + 1) : head;
                body.Clear();
            }
            else if (name != null) body.Append(line).Append('\n');
        }
        if (name != null) list.Add((name, body.ToString()));
        return list;
    }
}
