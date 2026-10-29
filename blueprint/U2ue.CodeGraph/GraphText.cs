// The node graph language (NGL): the stored, language-agnostic form of every graph (PLAN.md "The pseudo-language"; REQ-BPV-26,
// REQ-BPV-23). One node per line; a node is `id keyword key=value ...`; values are references (#e4), lists ([a b]), or terms.
// Every view (the Blueprint style, blocks, pseudo-code, C#, C++) is a projection printed from these lines by view/pl.js; none of
// them reads the C# again. The grammar is written out in view/NGL.md.
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace U2ue.CodeGraph;

/// <summary>One node of a graph: an exec node (a statement: s), a data node (an expression: e), a local function's declaring
/// node (f) or a piece of structure (k: a nested block, a switch section, a catch, a switch-expression arm). The nodes it created
/// while being read are written indented below it, so the file reads in source order.</summary>
public sealed class GraphNode
{
    public string Id = "", Keyword = "";
    public NodeFamily? Family;
    public int Line;
    /// <summary>1-based, with Line: where the node's syntax starts, so a node resolves to file, line AND column (TR-2; round 1
    /// measured nodes carrying the line only)</summary>
    public int Column;
    public readonly List<(string Key, string Value)> Attrs = new();
    public readonly List<GraphNode> Below = new();
    public readonly List<string> Reads = new();

    public GraphNode Set(string key, string value)
    {
        Attrs.Add((key, value));
        return this;
    }
}

/// <summary>One graph: a method, constructor, accessor, operator, expression-bodied member or local function.</summary>
public sealed class CodeGraph
{
    public string Name = "", Kind = "", At = "";
    public readonly List<(string Key, string Value)> Attrs = new();
    public readonly List<GraphNode> Roots = new();
}

/// <summary>How values are spelled in a .ngl line.</summary>
public static class Ngl
{
    static readonly JsonSerializerOptions Relaxed = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string Ref(GraphNode n) => "#" + n.Id;

    public static string List(IEnumerable<string> items) => "[" + string.Join(" ", items) + "]";

    /// <summary>An operator token (+, -, ??=, ...): one token, never a list item, so even `-` (a list's "none") is written bare.</summary>
    public static string Op(string token) => token.Length > 0 && !token.Any(char.IsWhiteSpace) ? token : Value(token);

    /// <summary>Free text (a note, a doc summary): always a JSON string.</summary>
    public static string Text(string s) => JsonSerializer.Serialize(s, Relaxed);

    /// <summary>A term or a piece of spelled syntax: bare when it is one token the reader cannot misread, a C#-style string token
    /// when it is exactly one single-line string literal, and otherwise ~"..." (a JSON string holding the text).</summary>
    public static string Value(string raw)
    {
        if (IsBare(raw) || IsOneStringLiteral(raw)) return raw;
        return "~" + JsonSerializer.Serialize(raw, Relaxed);
    }

    static bool IsBare(string s)
    {
        if (s.Length == 0 || s == "-" || s[0] is '[' or '~' or '"') return false;
        int depth = 0;
        foreach (var c in s)
        {
            if (char.IsWhiteSpace(c) || c == '"') return false;
            if (c == '[') depth++;
            else if (c == ']' && --depth < 0) return false;
        }
        return depth == 0;
    }

    static bool IsOneStringLiteral(string s)
    {
        if (s.Length < 2 || s[0] != '"' || s.Contains('\n') || s.Contains('\r')) return false;
        for (int i = 1; i < s.Length; i++)
        {
            if (s[i] == '\\') { i++; continue; }
            if (s[i] == '"') return i == s.Length - 1;
        }
        return false;
    }

    /// <summary>The keyword a family is written as: its name up to any parenthesis, " / " and spaces turned into hyphens
    /// ("lambda (a sub-graph)" is lambda, "try / catch / finally (frame)" is try-catch-finally).</summary>
    public static string Keyword(NodeFamily f)
    {
        if (f.Unclassified) throw new InvalidOperationException("an unclassified syntax kind reached the writer: " + f.Name);
        var s = f.Name;
        var i = s.IndexOf(" (", StringComparison.Ordinal);
        if (i >= 0) s = s[..i];
        return s.Replace(" / ", "-").Replace(' ', '-');
    }

    public static void Write(StringBuilder sb, CodeGraph g)
    {
        sb.Append("graph ").Append(Value(g.Name));
        foreach (var (k, v) in g.Attrs) sb.Append(' ').Append(k).Append('=').Append(v);
        sb.Append('\n');
        foreach (var r in g.Roots) Write(sb, r, 1);
        sb.Append("end\n");
    }

    static void Write(StringBuilder sb, GraphNode n, int depth)
    {
        sb.Append(' ', 2 * depth).Append(n.Id).Append(' ').Append(n.Keyword);
        foreach (var (k, v) in n.Attrs) sb.Append(' ').Append(k).Append('=').Append(v);
        if (n.Reads.Count > 0) sb.Append(" reads=").Append(List(n.Reads.Distinct()));
        sb.Append(" at=").Append(n.Line).Append(':').Append(n.Column).Append('\n');
        foreach (var c in n.Below) Write(sb, c, depth + 1);
    }
}
