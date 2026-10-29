// Instrumenter: a COPY of a project in which every value node a reader could put a valve on calls a probe (PLAN.md phases 5 and
// 7). The probe is keyed by the node's id in the graph language - `File.cs:line:col#e12`, the graph's `at` and the node's id, the
// same names the page shows - so a valve the reader sets on a wire lands on that wire. With no valve and no trace a probe returns
// its value untouched; the replay holds the instrumented build's events to the plain build's, so a probe that changed the program
// is caught (traced and untraced digests equal, or the trace is refused).
//
// It reads the project (the sandbox) and writes only --out. A node is wrapped only where wrapping cannot change what the code
// means; every skip is counted by its reason, never silent.
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace U2ue.CodeGraph;

public static class Instrumenter
{
    /// <summary>the node families whose value a valve can change: a computed number, truth or object</summary>
    static readonly HashSet<string> Wrappable = new(StringComparer.Ordinal)
        { "operator", "pure-call", "select", "coalesce", "cast", "get-at-index", "type-test" };

    public static int Run(string measure, IReadOnlyList<string> with, string refDir, string outDir, string? lang)
    {
        var p = LoadedProject.Load(measure, with, refDir, lang, "instrument", out var exit);
        if (p == null) return exit;
        outDir = Path.GetFullPath(outDir);
        if (Directory.Exists(outDir))
            foreach (var old in Directory.EnumerateFiles(outDir, "*.cs", SearchOption.AllDirectories)
                         .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar)
                                  && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar)))
                File.Delete(old);
        Directory.CreateDirectory(outDir);
        foreach (var proj in Directory.GetFiles(p.Root, "*.csproj")) File.Copy(proj, Path.Combine(outDir, Path.GetFileName(proj)), true);

        int wrapped = 0, files = 0;
        var skipped = new SortedDictionary<string, int>(StringComparer.Ordinal);
        // a probe carries an INTEGER into the key table, never the key as a string literal: C# 10 allows no `"` inside an
        // interpolated string's hole (measured 2026-10-28: UnitData.cs's $"...{GetStatByLevel(...)}" stopped compiling)
        var table = new List<string>();
        foreach (var tree in p.Measured)
        {
            var model = p.Compilation.GetSemanticModel(tree);
            var keys = new Dictionary<SyntaxNode, (int Key, string Type)>();
            foreach (var unit in GraphUnit.In(tree, model))
            {
                var b = new GraphBuilder(p, model, unit);
                var g = b.Build();
                var families = new Dictionary<string, string>();
                foreach (var n in Walk(g.Roots)) families[n.Id] = n.Keyword;
                foreach (var (syntax, id) in b.ExpressionIds)
                {
                    if (!Wrappable.Contains(families[id])) continue;
                    var why = WhyNot((ExpressionSyntax)syntax, model, out var type);
                    if (why != null) { skipped[why] = skipped.GetValueOrDefault(why) + 1; continue; }
                    keys[syntax] = (table.Count, type!);
                    table.Add($"{b.File}:{b.At}#{id}");
                }
            }
            var rel = p.Relative(tree.FilePath);
            var target = Path.Combine(outDir, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            var text = keys.Count == 0 ? tree.GetText().ToString() : new Wrap(keys).Visit(tree.GetRoot())!.ToFullString();
            File.WriteAllText(target, text);
            wrapped += keys.Count;
            files++;
        }
        var keyLines = string.Join(",\n", table.Select(k => "            " + SymbolDisplay.FormatLiteral(k, true)));
        File.WriteAllText(Path.Combine(outDir, "U2ueProbe.cs"), ProbeSource.Replace("/*KEYS*/", keyLines));
        Console.WriteLine($"instrument {p.Root}: {files} files copied to {outDir}, {wrapped} value nodes wrapped in a probe");
        Console.WriteLine("  not wrapped, by reason: " + (skipped.Count == 0 ? "none" : string.Join(", ", skipped.Select(kv => kv.Key + " " + kv.Value))));
        return 0;
    }

    static IEnumerable<GraphNode> Walk(IEnumerable<GraphNode> nodes)
    {
        foreach (var n in nodes)
        {
            yield return n;
            foreach (var c in Walk(n.Below)) yield return c;
        }
    }

    /// <summary>null when wrapping cannot change the meaning; otherwise the reason it would (and `type` is then unset)</summary>
    static string? WhyNot(ExpressionSyntax x, SemanticModel model, out string? type)
    {
        type = null;
        var info = model.GetTypeInfo(x);
        var t = info.Type;
        if (t == null || t is IErrorTypeSymbol) return "no natural type (target-typed)";
        if (t.IsRefLikeType) return "a ref struct (cannot be a type argument)";
        if (t.IsAnonymousType || t.TypeKind == TypeKind.Pointer || t.TypeKind == TypeKind.FunctionPointer) return "an anonymous or pointer type";
        if (!SymbolEqualityComparer.Default.Equals(t, info.ConvertedType) && info.ConvertedType != null
            && model.ClassifyConversion(x, info.ConvertedType).IsUserDefined) return "a user-defined conversion at the use";
        if (model.GetConstantValue(x).HasValue) return "a constant (a constant context may need it)";
        if (x.Parent is AssignmentExpressionSyntax a && a.Left == x) return "an assignment target";
        if (x.Parent is ArgumentSyntax arg && !arg.RefKindKeyword.IsKind(SyntaxKind.None)) return "a ref/out/in argument";
        if (x.Parent is PrefixUnaryExpressionSyntax or PostfixUnaryExpressionSyntax
            && x.Parent.Kind() is SyntaxKind.PreIncrementExpression or SyntaxKind.PreDecrementExpression or SyntaxKind.PostIncrementExpression
                or SyntaxKind.PostDecrementExpression or SyntaxKind.AddressOfExpression) return "an increment or address target";
        if (t.IsValueType && x.Parent is MemberAccessExpressionSyntax ma && ma.Expression == x)
            return "a struct a member is read or called on (a copy would lose a mutation)";
        if (t.IsValueType && x.Parent is ElementAccessExpressionSyntax ea && ea.Expression == x) return "a struct indexed in place";
        if (StartsWithBinding(x)) return "inside a ?. chain (its receiver is implicit)";
        // `TryGet(k, out var v) && v > 0`, `x is Foo f && f.Ok`: the compiler knows `v` and `f` are assigned "when true", and a
        // method call in between hides that (measured 2026-10-28: 44 CS0165/CS0177 errors in the first instrumented build)
        if (x.DescendantNodesAndSelf().Any(n => n is DeclarationExpressionSyntax or SingleVariableDesignationSyntax
                || n is ArgumentSyntax { RefKindKeyword.RawKind: not (int)SyntaxKind.None }))
            return "declares or assigns a variable through it (definite assignment)";
        foreach (var anc in x.Ancestors())
        {
            switch (anc)
            {
                case RefExpressionSyntax: return "under ref";
                case PatternSyntax or CaseSwitchLabelSyntax or InterpolationAlignmentClauseSyntax or AttributeArgumentSyntax
                    or EqualsValueClauseSyntax { Parent: ParameterSyntax }: return "a constant context";
                case LocalDeclarationStatementSyntax ld when ld.Modifiers.Any(SyntaxKind.ConstKeyword): return "a constant context";
                case StackAllocArrayCreationExpressionSyntax or FixedStatementSyntax or UnsafeStatementSyntax: return "unsafe code";
                case AnonymousFunctionExpressionSyntax fn when model.GetTypeInfo(fn).ConvertedType is INamedTypeSymbol nt
                    && nt.ToDisplayString().StartsWith("System.Linq.Expressions.Expression", StringComparison.Ordinal): return "inside an expression tree";
            }
        }
        type = t.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return null;
    }

    static bool StartsWithBinding(ExpressionSyntax x)
    {
        while (true)
        {
            switch (x)
            {
                case MemberBindingExpressionSyntax or ElementBindingExpressionSyntax: return true;
                case MemberAccessExpressionSyntax m: x = m.Expression; continue;
                case InvocationExpressionSyntax i: x = i.Expression; continue;
                case ElementAccessExpressionSyntax e: x = e.Expression; continue;
                case PostfixUnaryExpressionSyntax p when p.IsKind(SyntaxKind.SuppressNullableWarningExpression): x = p.Operand; continue;
                default: return false;
            }
        }
    }

    /// <summary>replaces each chosen node of the ORIGINAL tree (matched by reference while it is visited) with a probe call around
    /// its own rewritten self, so nested probes nest</summary>
    sealed class Wrap(Dictionary<SyntaxNode, (int Key, string Type)> keys) : CSharpSyntaxRewriter
    {
        public override SyntaxNode? Visit(SyntaxNode? node)
        {
            if (node == null) return null;
            var inner = base.Visit(node);
            if (!keys.TryGetValue(node, out var k)) return inner;
            var call = SyntaxFactory.ParseExpression(
                // the whole call in parentheses: in an interpolation hole a bare `global::` reads as `global` + a format clause
                $"(global::U2ue.Probe.V<{k.Type}>({k.Key}, ({inner!.WithoutTrivia().ToFullString()})))");
            return call.WithTriviaFrom(node);
        }
    }

    const string ProbeSource = """
// U2ueProbe.cs - written by U2ue.CodeGraph instrument into an instrumented COPY of the sandbox (quarantine/blueprint_view/runs/).
// Not part of the game. Every wrapped node calls V(key, value): with no valve and no trace it returns the value untouched.
namespace U2ue
{
    using System;
    using System.Collections.Generic;
    using System.Globalization;

    public static class Probe
    {
        /// <summary>record what each probe sees; the replay holds a traced run's events to an untraced run's</summary>
        public static bool Trace;
        /// <summary>record only keys that start with one of these (null: hash every value, keep none)</summary>
        public static List<string> Keep;
        /// <summary>the replay's clock: events appended so far</summary>
        public static Func<int> Clock;
        /// <summary>probe number -> its key, `File.cs:line:col#e12` (the graph's at and the node's id)</summary>
        public static readonly string[] Keys = new string[]
        {
/*KEYS*/
        };
        /// <summary>probe number -> ('=', x) set the value to x, or ('*', x) scale it by x; set through SetValve, by key</summary>
        public static readonly Dictionary<int, KeyValuePair<char, double>> Valves = new Dictionary<int, KeyValuePair<char, double>>();

        /// <summary>false when no probe has that key (the node is not wrapped, or the key is misspelt) - the caller must refuse</summary>
        public static bool SetValve(string key, char op, double x)
        {
            int i = Array.IndexOf(Keys, key);
            if (i < 0) return false;
            Valves[i] = new KeyValuePair<char, double>(op, x);
            return true;
        }
        public static readonly List<string> Log = new List<string>();
        public static readonly Dictionary<string, int> Applied = new Dictionary<string, int>();
        public static long Hits;
        public static ulong TraceHash = 1469598103934665603UL;

        public static T V<T>(int probe, T value)
        {
            Hits++;
            string key = Keys[probe];
            if (Valves.Count > 0 && Valves.TryGetValue(probe, out var v))
            {
                value = Apply(key, value, v.Key, v.Value);
                Applied[key] = Applied.TryGetValue(key, out var n) ? n + 1 : 1;
            }
            if (Trace)
            {
                string shown = Show(value);
                foreach (char c in key) TraceHash = (TraceHash ^ c) * 1099511628211UL;
                foreach (char c in shown) TraceHash = (TraceHash ^ c) * 1099511628211UL;
                if (Keep != null)
                    foreach (var prefix in Keep)
                        if (key.StartsWith(prefix, StringComparison.Ordinal))
                        {
                            Log.Add((Clock != null ? Clock() : 0).ToString(CultureInfo.InvariantCulture) + "\t" + key + "\t" + shown);
                            break;
                        }
            }
            return value;
        }

        static T Apply<T>(string key, T value, char op, double x)
        {
            object o = value;
            double d;
            switch (o)
            {
                case int i: d = i; break;
                case float f: d = f; break;
                case double db: d = db; break;
                case long l: d = l; break;
                case bool b: if (op != '=') throw new InvalidOperationException("valve on " + key + ": a bool wire takes set, not scale"); return (T)(object)(x != 0);
                default: throw new InvalidOperationException("valve on " + key + ": a " + typeof(T).Name + " wire takes no number");
            }
            double r = op == '=' ? x : d * x;
            if (o is int) return (T)(object)(int)Math.Round(r, MidpointRounding.AwayFromZero);
            if (o is float) return (T)(object)(float)r;
            if (o is long) return (T)(object)(long)Math.Round(r, MidpointRounding.AwayFromZero);
            return (T)(object)r;
        }

        /// <summary>a primitive's invariant text; anything else only its type's name (never a user ToString, which could do anything)</summary>
        static string Show<T>(T v)
        {
            object o = v;
            if (o == null) return "null";
            if (o is float f) return f.ToString("R", CultureInfo.InvariantCulture);
            if (o is double d) return d.ToString("R", CultureInfo.InvariantCulture);
            if (o is IConvertible c) return c.ToString(CultureInfo.InvariantCulture);
            return o.GetType().Name;
        }
    }
}
""";
}
