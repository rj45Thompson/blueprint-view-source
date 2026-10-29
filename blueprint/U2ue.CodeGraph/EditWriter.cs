// EditWriter: a typed command, aimed at a node of the graph, turned into the smallest text change in the SANDBOX's source that does
// what the command says (PLAN.md phase 6; IR-10: changes act on the sandbox only). It never reprints a method: a command replaces
// one span - a literal token, an operator token, or one expression - so every comment and every line break the author wrote stays.
//
//   edit --measure <sandbox project> --refs <dir> --command "<command>" --proposal <file>
//
// Commands (the node is `File.cs:line:col#id`: the graph's `at` and the node's id, as the page and the probes name it):
//   literal <node> <old> <new>   a literal or name token of the node's OWN syntax (not inside a child node), exactly one match
//   op      <node> <new>         the operator of an operator node or a compound set (+ - * / ... += -= ...)
//   scale   <node> <x>           the node's value times x - what a kept valve `*x` becomes
//   set     <node> <x>           the node's value replaced by the literal x - what a kept valve `=x` becomes
//
// It writes only --proposal (the whole new file); tools/edit.py applies it through the sandbox's guard and runs the gates, or puts
// the file back byte for byte. Exit: 0 a proposal written, 1 the command cannot be applied (why printed), 2 bad arguments.
using System.Globalization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace U2ue.CodeGraph;

public static class EditWriter
{
    public static int Run(string measure, IReadOnlyList<string> with, string refDir, string command, string proposal, string? lang)
    {
        var parts = command.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 3 || parts[0] is not ("literal" or "op" or "scale" or "set")) return Refuse("a command is `literal|op|scale|set <File.cs:line:col#id> ...`: " + command, 2);
        var key = parts[1];
        var hash = key.LastIndexOf('#');
        var lastColon = hash < 0 ? -1 : key.LastIndexOf(':', hash);
        var lineColon = lastColon < 0 ? -1 : key.LastIndexOf(':', lastColon - 1);
        if (hash < 0 || lineColon < 0) return Refuse("a node is File.cs:line:col#id, not " + key, 2);
        string file = key[..lineColon], at = key[(lineColon + 1)..hash], id = key[(hash + 1)..];

        var p = LoadedProject.Load(measure, with, refDir, lang, "edit", out var exit);
        if (p == null) return exit;
        var tree = p.Measured.FirstOrDefault(t => p.Relative(t.FilePath) == file);
        if (tree == null) return Refuse($"{file} is not a file of {p.Root}");
        var model = p.Compilation.GetSemanticModel(tree);
        var unit = GraphUnit.In(tree, model).FirstOrDefault(u =>
        {
            var pos = u.Decl.GetLocation().GetLineSpan().StartLinePosition;
            return $"{pos.Line + 1}:{pos.Character + 1}" == at;
        });
        if (unit.Decl == null) return Refuse($"no graph at {file}:{at}");
        var builder = new GraphBuilder(p, model, unit);
        builder.Build();
        if (!builder.NodeSyntax.TryGetValue(id, out var syntax)) return Refuse($"the graph {unit.Name} has no node {id}");

        TextSpan span;
        string replacement;
        switch (parts[0])
        {
            case "literal":
            {
                if (parts.Length != 4) return Refuse("literal <node> <old> <new>", 2);
                // the node's OWN tokens: those not inside a child graph node
                var children = builder.NodeSyntax.Values.Where(n => n != syntax && syntax.Span.Contains(n.Span) && n.Span != syntax.Span).ToList();
                var own = syntax.DescendantTokens().Where(t => !children.Any(c => c.Span.Contains(t.Span))).Where(t => t.Text == parts[2]).ToList();
                if (own.Count != 1) return Refuse($"`{parts[2]}` occurs {own.Count} times among {id}'s own tokens; a literal edit needs exactly one");
                span = own[0].Span;
                replacement = parts[3];
                break;
            }
            case "op":
            {
                SyntaxToken token = syntax switch
                {
                    BinaryExpressionSyntax b => b.OperatorToken,
                    AssignmentExpressionSyntax a => a.OperatorToken,
                    ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a } => a.OperatorToken,
                    _ => default,
                };
                if (token.IsKind(SyntaxKind.None)) return Refuse($"{id} is a {syntax.Kind()}, which has no operator to change");
                span = token.Span;
                replacement = parts[2];
                break;
            }
            default:   // scale, set: the node's whole value
            {
                if (syntax is not ExpressionSyntax x) return Refuse($"{id} is a statement; {parts[0]} needs a value node (an e-node)");
                var t = model.GetTypeInfo(x).Type;
                if (!double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var number)) return Refuse("not a number: " + parts[2], 2);
                var text = x.ToString();
                var name = t?.SpecialType;
                string Lit(double v) => name switch
                {
                    SpecialType.System_Single => v.ToString("R", CultureInfo.InvariantCulture) + "f",
                    SpecialType.System_Double => v.ToString("R", CultureInfo.InvariantCulture) + (v == Math.Floor(v) ? ".0" : ""),
                    _ => v.ToString("R", CultureInfo.InvariantCulture),
                };
                bool whole = number == Math.Floor(number);
                switch (name)
                {
                    case SpecialType.System_Int32 or SpecialType.System_Int64:
                        var cast = name == SpecialType.System_Int32 ? "int" : "long";
                        if (parts[0] == "set" && !whole) return Refuse($"{id} is {cast}; set it to a whole number");
                        replacement = parts[0] == "set" ? ((long)number).ToString(CultureInfo.InvariantCulture)
                            : whole ? $"({text}) * {(long)number}"
                            // the probe's own rounding (U2ueProbe.cs Apply), so the edit and the valve give the same numbers
                            : $"({cast})System.Math.Round(({text}) * {Lit(number)}, System.MidpointRounding.AwayFromZero)";
                        break;
                    case SpecialType.System_Single or SpecialType.System_Double:
                        replacement = parts[0] == "set" ? Lit(number) : $"({text}) * {Lit(number)}";
                        break;
                    case SpecialType.System_Boolean when parts[0] == "set":
                        replacement = number != 0 ? "true" : "false";
                        break;
                    default:
                        return Refuse($"{id} is a {t?.ToDisplayString() ?? "value of no type"}; {parts[0]} takes a number wire");
                }
                span = x.Span;
                break;
            }
        }
        var source = tree.GetText();
        var changed = source.Replace(span, replacement).ToString();
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(proposal))!);
        File.WriteAllText(proposal, changed);
        var pos2 = tree.GetLineSpan(span).StartLinePosition;
        Console.WriteLine($"edit: {unit.Name} {id} ({file}:{pos2.Line + 1}:{pos2.Character + 1}): `{source.ToString(span)}` -> `{replacement}`");
        Console.WriteLine($"  proposal written to {proposal} ({changed.Length} chars; the sandbox is not touched here)");
        return 0;
    }

    static int Refuse(string why, int code = 1)
    {
        Console.Error.WriteLine("edit: REFUSED - " + why);
        return code;
    }
}
