// RoundTripGate: the node graph language is trusted only while it round-trips (PLAN.md, TR-3). view/pl.js reads every stored
// graph back from disk and prints it as C#; this compares each printed body with the method it came from, as syntax trees with
// whitespace and comments ignored and grouping parentheses removed from both sides (the graph keeps grouping as structure, so the
// tree's SHAPE still has to match: a precedence the printer gets wrong is a different tree). Equal for every graph, or it fails.
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace U2ue.CodeGraph;

public static class RoundTripGate
{
    public const string Marker = "//@graph ";

    public static int Run(string measure, IReadOnlyList<string> with, string refDir, string printedDir, string? lang, int show)
    {
        var p = LoadedProject.Load(measure, with, refDir, lang, "roundtrip", out var exit);
        if (p == null) return exit;
        printedDir = Path.GetFullPath(printedDir);
        int units = 0, equal = 0, missing = 0, broken = 0;
        var failures = new List<string>();
        var seenFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int extra = 0;
        foreach (var tree in p.Measured)
        {
            var model = p.Compilation.GetSemanticModel(tree);
            var list = GraphUnit.In(tree, model).ToList();
            if (list.Count == 0) continue;
            var rel = p.Relative(tree.FilePath);
            var file = Path.Combine(printedDir, Path.ChangeExtension(rel, ".printed.txt"));
            seenFiles.Add(Path.GetFullPath(file));
            var printed = File.Exists(file) ? Split(File.ReadAllText(file)) : new Dictionary<string, string>();
            var used = new HashSet<string>();
            foreach (var u in list)
            {
                units++;
                var at = u.Decl.GetLocation().GetLineSpan().StartLinePosition;
                var key = $"{at.Line + 1}:{at.Character + 1}";
                if (!printed.TryGetValue(key, out var text))
                {
                    missing++;
                    failures.Add($"MISSING  {rel}:{at.Line + 1} {u.Name} - no printed body");
                    continue;
                }
                used.Add(key);
                var why = Compare(u.Body, text, p.Parse);
                if (why == null) equal++;
                else
                {
                    broken++;
                    failures.Add($"DIFFERS  {rel}:{at.Line + 1} {u.Name} - {why}");
                }
            }
            extra += printed.Keys.Count(k => !used.Contains(k));
        }
        if (Directory.Exists(printedDir))
            extra += Directory.EnumerateFiles(printedDir, "*.printed.txt", SearchOption.AllDirectories).Count(f => !seenFiles.Contains(Path.GetFullPath(f)));

        Console.WriteLine($"roundtrip of {p.Root}: {units} graphs, {equal} print back equal, {broken} differ, {missing} missing, {extra} printed with no graph");
        foreach (var fl in failures.Take(show)) Console.WriteLine("  " + fl);
        if (failures.Count > show) Console.WriteLine($"  ... and {failures.Count - show} more");
        return units > 0 && equal == units && extra == 0 ? 0 : 1;
    }

    /// <summary>graph key (line:col) -> printed body</summary>
    static Dictionary<string, string> Split(string text)
    {
        var map = new Dictionary<string, string>();
        string? key = null;
        var body = new System.Text.StringBuilder();
        foreach (var line in text.Replace("\r\n", "\n").Split('\n'))
        {
            if (line.StartsWith(Marker, StringComparison.Ordinal))
            {
                if (key != null) map[key] = body.ToString();
                key = line.Substring(Marker.Length).Trim().Split(' ')[0];
                body.Clear();
            }
            else body.Append(line).Append('\n');
        }
        if (key != null) map[key] = body.ToString();
        return map;
    }

    /// <summary>null when equal; otherwise the first place they part, in words</summary>
    public static string? Compare(SyntaxNode original, string printed, CSharpParseOptions parse)
    {
        SyntaxNode? reparsed;
        SyntaxNode orig;
        if (original is ArrowExpressionClauseSyntax arrow)
        {
            reparsed = SyntaxFactory.ParseExpression(printed, options: parse);
            orig = arrow.Expression;
        }
        else
        {
            reparsed = SyntaxFactory.ParseStatement(printed, options: parse);
            orig = original;
        }
        var errors = reparsed.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        if (errors.Count > 0) return "the printed C# does not parse: " + errors[0].GetMessage() + " near '" + Snip(printed, errors[0].Location.SourceSpan.Start) + "'";
        var a = Strip.Apply(orig);
        var b = Strip.Apply(reparsed);
        return Same(a, b) ? null : FirstDifference(a, b);
    }

    /// <summary>The two trees, compared here rather than by SyntaxFactory.AreEquivalent: every node the same kind with the same
    /// children in the same order, every token the same kind and text, trivia ignored. Measured 2026-10-28: AreEquivalent said
    /// FALSE for a constructor body and its own reparse, with identical kinds and tokens throughout, and the answer flipped with
    /// the length of an identifier (`_c = c ?? throw new X(nameof(c))` equal, `_children = children ?? ...` not) - so it cannot
    /// be the arbiter of a gate (quarantine/blueprint_view/DEBUG.md D20).</summary>
    public static bool Same(SyntaxNodeOrToken a, SyntaxNodeOrToken b)
    {
        if (a.RawKind != b.RawKind) return false;
        if (a.IsToken)
        {
            var ta = a.AsToken();
            var tb = b.AsToken();
            return ta.IsMissing == tb.IsMissing && ta.Text == tb.Text;
        }
        var ca = a.ChildNodesAndTokens();
        var cb = b.ChildNodesAndTokens();
        if (ca.Count != cb.Count) return false;
        for (int i = 0; i < ca.Count; i++)
            if (!Same(ca[i], cb[i])) return false;
        return true;
    }

    static string Snip(string s, int at)
    {
        int from = Math.Max(0, at - 30), to = Math.Min(s.Length, at + 30);
        return s[from..to].Replace('\n', ' ');
    }

    static string FirstDifference(SyntaxNode a, SyntaxNode b)
    {
        var ta = a.DescendantTokens().Where(t => !t.IsKind(SyntaxKind.None)).ToList();
        var tb = b.DescendantTokens().Where(t => !t.IsKind(SyntaxKind.None)).ToList();
        for (int i = 0; i < Math.Min(ta.Count, tb.Count); i++)
        {
            if (ta[i].RawKind != tb[i].RawKind || ta[i].Text != tb[i].Text)
            {
                string Around(List<SyntaxToken> ts) => string.Join(" ", ts.Skip(Math.Max(0, i - 6)).Take(12).Select(t => t.Text));
                var line = ta[i].GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                return $"token {i} (source line {line}): source '{Around(ta)}' | printed '{Around(tb)}'";
            }
        }
        if (ta.Count != tb.Count) return $"the source has {ta.Count} tokens, the print {tb.Count} (same up to there)";
        // same tokens: name the first node where the two trees part
        var na = a.DescendantNodesAndSelf().ToList();
        var nb = b.DescendantNodesAndSelf().ToList();
        for (int i = 0; i < Math.Min(na.Count, nb.Count); i++)
        {
            if (na[i].RawKind != nb[i].RawKind)
            {
                var line = na[i].GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                string Show(SyntaxNode n) { var s = n.ToString().Replace('\n', ' '); return s.Length > 70 ? s[..70] : s; }
                return $"same tokens, different tree at source line {line}: source {na[i].Kind()} '{Show(na[i])}' | printed {nb[i].Kind()} '{Show(nb[i])}'";
            }
        }
        return "same tokens and node kinds, different tree (" + na.Count + " vs " + nb.Count + " nodes)";
    }

    /// <summary>grouping parentheses removed, so `(a) + b` and `a + b` compare equal while `(a + b) * c` and `a + b * c` do not</summary>
    sealed class Strip : CSharpSyntaxRewriter
    {
        public static SyntaxNode Apply(SyntaxNode n) => new Strip().Visit(n)!;
        public override SyntaxNode? VisitParenthesizedExpression(ParenthesizedExpressionSyntax node) => Visit(node.Expression);
    }
}
