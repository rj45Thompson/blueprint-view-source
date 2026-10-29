// The census: over a whole project, how much of its code draws as Blueprint nodes, how much needs the extended vocabulary and
// how much only as code islands, plus the measured size of each hazard the Blueprint discussion names - long wires (spaghetti),
// big graphs (zoom blindness), deep member chains (the multi-dimensional grid), casts (the casting trap) and the hierarchy a
// child graph hides. It is the measured basis of the viability verdict in quarantine/blueprint_view/PLAN.md; nothing in that verdict
// is estimated where this can count it.
//
// It refuses to count a project that does not compile: an unresolved call would be classified as something it is not.
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace U2ue.CodeGraph;

/// <summary>One graph the view would draw: a method, constructor, accessor, operator, expression-bodied member or local
/// function. A local function is its own graph, as a Blueprint function is.</summary>
public sealed class GraphUnitStats
{
    public string Name = "", At = "";
    public int Statements, MaxDepth, Locals, LongWires, FanOutWires;
    public Tier Worst = Tier.Blueprint;
    public readonly Dictionary<string, int> Families = new();
}

/// <summary>Counts a project. The three thresholds are parameters of the measurement, stated in its output, not facts about
/// Blueprints: a value read 6 or more statements after it was made would be a long wire in a one-to-one drawing; a value read 4
/// or more times fans out; a chain of 3 or more member accesses is the nested path the discussion calls a grid.</summary>
public sealed class Census
{
    public const int LongWireStatements = 6, FanOutUses = 4, DeepChain = 3;

    readonly string root;
    readonly List<GraphUnitStats> units = new();
    readonly Dictionary<(string Name, Tier Tier, string Counterpart), int> families = new();
    readonly Dictionary<string, (int Count, string First)> unclassified = new();
    readonly Dictionary<string, int> dispatch = new(), origin = new(), casts = new();
    readonly List<(string Family, string At, string Unit)> islands = new();
    int deepChains, maxChain, ctorBaseCalls, types, withSourceBase, maxBaseDepth, overrides, overridesOfOwn, ownInterfaces;
    string maxChainAt = "", maxBaseDepthAt = "";

    Census(string root) { this.root = root; }

    public static int Run(string measure, IReadOnlyList<string> with, string refDir, string outPath, string? lang)
    {
        var p = LoadedProject.Load(measure, with, refDir, lang, "census", out var exit);
        if (p == null) return exit;
        var c = new Census(p.Root);
        int lines = 0;
        foreach (var tree in p.Measured)
        {
            lines += tree.GetText().Lines.Count;
            var model = p.Compilation.GetSemanticModel(tree);
            c.Hierarchy(tree, model);
            c.Units(tree, model);
        }
        return c.Report(p.Measured.Count, lines, refDir, p.Version, p.VersionFrom, outPath);
    }

    internal string Where(SyntaxNode node)
    {
        var s = node.GetLocation().GetLineSpan();
        return Path.GetRelativePath(root, s.Path).Replace('\\', '/') + ":" + (s.StartLinePosition.Line + 1);
    }

    void Units(SyntaxTree tree, SemanticModel model)
    {
        foreach (var unit in GraphUnit.In(tree, model))
        {
            var u = new GraphUnitStats { Name = unit.Name, At = Where(unit.Decl) };
            new UnitWalker(this, model, u, unit.Owner).WalkBody(unit.Body);
            units.Add(u);
            if (unit.Decl is ConstructorDeclarationSyntax { Initializer: { } init } && init.IsKind(SyntaxKind.BaseConstructorInitializer))
                ctorBaseCalls++;
        }
    }

    internal void Count(GraphUnitStats u, NodeFamily f, SyntaxNode node)
    {
        var key = (f.Name, f.Tier, f.Counterpart);
        families[key] = families.GetValueOrDefault(key) + 1;
        u.Families[f.Name] = u.Families.GetValueOrDefault(f.Name) + 1;
        if (f.Tier > u.Worst) u.Worst = f.Tier;
        if (f.Unclassified)
        {
            var had = unclassified.GetValueOrDefault(f.Name);
            unclassified[f.Name] = (had.Count + 1, had.First ?? Where(node));
        }
        if (f.Tier == Tier.Island) islands.Add((f.Name, Where(node), u.Name));
    }

    internal void Call(InvocationExpressionSyntax inv, SemanticModel model)
    {
        var d = NodeFamilies.Dispatch(inv, model);
        dispatch[d] = dispatch.GetValueOrDefault(d) + 1;
        var info = model.GetSymbolInfo(inv);
        if ((info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) is IMethodSymbol m)
        {
            var o = m.Locations.Any(l => l.IsInSource) ? "own code" : "library " + TopNamespace(m.ContainingNamespace);
            origin[o] = origin.GetValueOrDefault(o) + 1;
        }
    }

    static string TopNamespace(INamespaceSymbol? ns)
    {
        var parts = (ns?.ToDisplayString() ?? "").Split('.');
        return string.Join(".", parts.Take(2));
    }

    internal void Shape(ExpressionSyntax e, SemanticModel model)
    {
        string? cast = e switch
        {
            CastExpressionSyntax c => model.GetTypeInfo(c.Type).Type is { } to
                && (to.SpecialType is >= SpecialType.System_Boolean and <= SpecialType.System_Double || to.TypeKind == TypeKind.Enum)
                ? "numeric or enum conversion" : "reference or unboxing cast",
            BinaryExpressionSyntax b when b.IsKind(SyntaxKind.AsExpression) => "as cast",
            BinaryExpressionSyntax b when b.IsKind(SyntaxKind.IsExpression) => "type test (is T)",
            IsPatternExpressionSyntax { Pattern: DeclarationPatternSyntax or TypePatternSyntax } => "type test (is T x)",
            _ => null,
        };
        if (cast != null) casts[cast] = casts.GetValueOrDefault(cast) + 1;

        if (e is MemberAccessExpressionSyntax or InvocationExpressionSyntax or ElementAccessExpressionSyntax && IsChainTop(e))
        {
            var depth = GetterPath(e, model);
            if (depth >= DeepChain) deepChains++;
            if (depth > maxChain) { maxChain = depth; maxChainAt = Where(e); }
        }
    }

    /// <summary>How many getter nodes a one-to-one drawing of this path needs: each field or property hop
    /// (Player.Weapon.Stats.Damage is three). A method hop is not a getter, and a call ends the path, so a fluent chain
    /// (sb.Append(a).Append(b)) is a run of calls, not a deep path.</summary>
    static int GetterPath(ExpressionSyntax e, SemanticModel model)
    {
        int d = 0;
        if (e is InvocationExpressionSyntax top) e = top.Expression;
        while (true)
        {
            switch (e)
            {
                case MemberAccessExpressionSyntax ma:
                    if (model.GetSymbolInfo(ma).Symbol is IPropertySymbol or IFieldSymbol) d++;
                    e = ma.Expression;
                    continue;
                case ElementAccessExpressionSyntax ea: e = ea.Expression; continue;
                case ParenthesizedExpressionSyntax p: e = p.Expression; continue;
                default: return d;
            }
        }
    }

    static bool IsChainTop(ExpressionSyntax e) => e.Parent switch
    {
        MemberAccessExpressionSyntax ma when ma.Expression == e => false,
        InvocationExpressionSyntax inv when inv.Expression == e => false,
        ElementAccessExpressionSyntax ea when ea.Expression == e => false,
        _ => true,
    };

    void Hierarchy(SyntaxTree tree, SemanticModel model)
    {
        foreach (var td in tree.GetRoot().DescendantNodes().OfType<TypeDeclarationSyntax>())
        {
            if (model.GetDeclaredSymbol(td) is not INamedTypeSymbol t) continue;
            // a partial type is counted at its first declaration only
            if (t.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() != td) continue;
            types++;
            int depth = 0;
            for (var b = t.BaseType; b != null && b.Locations.Any(l => l.IsInSource); b = b.BaseType) depth++;
            if (depth > 0) withSourceBase++;
            if (depth > maxBaseDepth) { maxBaseDepth = depth; maxBaseDepthAt = Where(td); }
            foreach (var m in t.GetMembers())
            {
                if (!m.IsOverride) continue;
                overrides++;
                var over = m switch { IMethodSymbol ms => (ISymbol?)ms.OverriddenMethod, IPropertySymbol ps => ps.OverriddenProperty, _ => null };
                if (over != null && over.Locations.Any(l => l.IsInSource)) overridesOfOwn++;
            }
            ownInterfaces += t.Interfaces.Count(i => i.Locations.Any(l => l.IsInSource));
        }
    }

    int Report(int files, int lines, string refDir, LanguageVersion version, string versionFrom, string outPath)
    {
        int Pct(int n, int d) => d == 0 ? 0 : (int)Math.Round(100.0 * n / d);
        static int At(List<int> sorted, double q) => sorted.Count == 0 ? 0 : sorted[Math.Min(sorted.Count - 1, (int)Math.Floor(q * sorted.Count))];
        var sizes = units.Select(u => u.Statements).OrderBy(x => x).ToList();
        var depths = units.Select(u => u.MaxDepth).OrderBy(x => x).ToList();
        var biggest = units.OrderByDescending(u => u.Statements).First();
        var deepest = units.OrderByDescending(u => u.MaxDepth).First();
        int byTier(Tier t) => units.Count(u => u.Worst == t);
        int nodes = families.Values.Sum();
        int nodesOf(Tier t) => families.Where(kv => kv.Key.Tier == t).Sum(kv => kv.Value);

        var report = new
        {
            tool = "U2ue.CodeGraph census",
            when = DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm zzz"),
            project = root.Replace('\\', '/'),
            language = version.ToDisplayString() + " (READ " + versionFrom + ")",
            references = refDir.Replace('\\', '/'),
            files,
            lines,
            compile_errors = 0,
            thresholds = new { long_wire_statements = LongWireStatements, fan_out_uses = FanOutUses, deep_chain = DeepChain },
            graphs = new
            {
                count = units.Count,
                blueprint_only = byTier(Tier.Blueprint),
                needs_extended = byTier(Tier.Extended),
                needs_island = byTier(Tier.Island),
            },
            nodes = new { count = nodes, blueprint = nodesOf(Tier.Blueprint), extended = nodesOf(Tier.Extended), island = nodesOf(Tier.Island) },
            unclassified = unclassified.Select(kv => new { kind = kv.Key, count = kv.Value.Count, first = kv.Value.First }).ToList(),
            families = families.OrderByDescending(kv => kv.Value)
                .Select(kv => new { name = kv.Key.Name, tier = kv.Key.Tier.ToString(), blueprint = kv.Key.Counterpart, count = kv.Value }).ToList(),
            calls = new { by_dispatch = dispatch.OrderByDescending(kv => kv.Value).ToDictionary(kv => kv.Key, kv => kv.Value),
                          by_origin = origin.OrderByDescending(kv => kv.Value).ToDictionary(kv => kv.Key, kv => kv.Value) },
            size = new { statements = sizes.Sum(), p50 = At(sizes, 0.5), p90 = At(sizes, 0.9), p99 = At(sizes, 0.99), max = biggest.Statements,
                         max_at = biggest.At + " " + biggest.Name, over_30 = sizes.Count(s => s > 30), over_60 = sizes.Count(s => s > 60) },
            nesting = new { p90 = At(depths, 0.9), max = deepest.MaxDepth, max_at = deepest.At + " " + deepest.Name },
            wires = new { values = units.Sum(u => u.Locals), @long = units.Sum(u => u.LongWires), graphs_with_long = units.Count(u => u.LongWires > 0),
                          fan_out = units.Sum(u => u.FanOutWires) },
            getter_paths = new { deep = deepChains, max = maxChain, max_at = maxChainAt },
            casts = casts.OrderByDescending(kv => kv.Value).ToDictionary(kv => kv.Key, kv => kv.Value),
            hierarchy = new { types, with_a_base_in_the_project = withSourceBase, deepest_base_chain = maxBaseDepth, deepest_at = maxBaseDepthAt,
                              override_members = overrides, overriding_the_projects_own = overridesOfOwn,
                              parent_calls = dispatch.GetValueOrDefault("parent (base.)"), base_constructor_calls = ctorBaseCalls,
                              implemented_own_interfaces = ownInterfaces },
            islands = islands.Select(i => new { family = i.Family, at = i.At, graph = i.Unit }).ToList(),
            graphs_detail = units.Select(u => new { name = u.Name, at = u.At, statements = u.Statements, depth = u.MaxDepth,
                                                    tier = u.Worst.ToString(), long_wires = u.LongWires }).ToList(),
        };
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        File.WriteAllText(outPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));

        Console.WriteLine($"census of {root}: {files} files, {lines} lines, 0 compile errors, {version.ToDisplayString()} (READ {versionFrom})");
        Console.WriteLine($"  graphs {units.Count}: blueprint only {byTier(Tier.Blueprint)} ({Pct(byTier(Tier.Blueprint), units.Count)}%), " +
                          $"needs extended {byTier(Tier.Extended)} ({Pct(byTier(Tier.Extended), units.Count)}%), " +
                          $"needs an island {byTier(Tier.Island)} ({Pct(byTier(Tier.Island), units.Count)}%)");
        Console.WriteLine($"  nodes {nodes}: blueprint {nodesOf(Tier.Blueprint)} ({Pct(nodesOf(Tier.Blueprint), nodes)}%), " +
                          $"extended {nodesOf(Tier.Extended)} ({Pct(nodesOf(Tier.Extended), nodes)}%), island {nodesOf(Tier.Island)}");
        Console.WriteLine($"  unclassified kinds: {unclassified.Count}" + string.Concat(unclassified.Select(kv => $"  [{kv.Key} x{kv.Value.Count} first {kv.Value.First}]")));
        Console.WriteLine($"  size (statements per graph): p50 {At(sizes, 0.5)}, p90 {At(sizes, 0.9)}, p99 {At(sizes, 0.99)}, max {biggest.Statements} at {biggest.At} {biggest.Name}; over 30: {sizes.Count(s => s > 30)}, over 60: {sizes.Count(s => s > 60)}");
        Console.WriteLine($"  nesting: p90 {At(depths, 0.9)}, max {deepest.MaxDepth} at {deepest.At}");
        Console.WriteLine($"  wires: {units.Sum(u => u.Locals)} values, {units.Sum(u => u.LongWires)} long (>= {LongWireStatements} statements) in {units.Count(u => u.LongWires > 0)} graphs, {units.Sum(u => u.FanOutWires)} fan out (>= {FanOutUses} reads)");
        Console.WriteLine($"  getter paths >= {DeepChain} hops: {deepChains}, max {maxChain} at {maxChainAt}");
        Console.WriteLine("  calls: " + string.Join(", ", dispatch.OrderByDescending(kv => kv.Value).Select(kv => kv.Key + " " + kv.Value)));
        Console.WriteLine("  casts: " + string.Join(", ", casts.OrderByDescending(kv => kv.Value).Select(kv => kv.Key + " " + kv.Value)));
        Console.WriteLine($"  hierarchy: {types} types, {withSourceBase} with a base in the project (deepest {maxBaseDepth} at {maxBaseDepthAt}), " +
                          $"{overrides} overrides ({overridesOfOwn} of the project's own), {dispatch.GetValueOrDefault("parent (base.)")} base. calls, {ctorBaseCalls} : base(...) calls");
        Console.WriteLine("  top families: " + string.Join(", ", families.OrderByDescending(kv => kv.Value).Take(12).Select(kv => $"{kv.Key.Name} {kv.Value}")));
        Console.WriteLine("  wrote " + Path.GetFullPath(outPath));
        return unclassified.Count == 0 && !dispatch.ContainsKey("UNRESOLVED") ? 0 : 1;
    }
}

/// <summary>Walks one graph's body: the statements in order (the exec chain), the expressions inside them (the data nodes), and
/// every value from where it is made to where it is read (the wires).</summary>
sealed class UnitWalker : CSharpSyntaxWalker
{
    readonly Census census;
    readonly SemanticModel model;
    readonly GraphUnitStats unit;
    readonly Stack<int> at = new();
    readonly Dictionary<ISymbol, (int Made, List<int> Read)> wires = new(SymbolEqualityComparer.Default);
    // expressions that stand where a statement would: the body of a void `=>` member or of a void lambda
    readonly HashSet<SyntaxNode> statementLevel = new();
    readonly IMethodSymbol? owner;
    int ordinal, depth;

    public UnitWalker(Census census, SemanticModel model, GraphUnitStats unit, IMethodSymbol? owner) : base(SyntaxWalkerDepth.Node)
    {
        this.census = census; this.model = model; this.unit = unit; this.owner = owner;
        at.Push(0);
        if (owner != null) foreach (var p in owner.Parameters) Make(p);
    }

    public void WalkBody(SyntaxNode body)
    {
        if (body is ArrowExpressionClauseSyntax arrow && owner is { ReturnsVoid: false })
        {
            // a value: the expression's nodes feed the Return Node
            at.Push(++ordinal);
            unit.Statements++;
            census.Count(unit, NodeFamilies.ForExpressionBody(), arrow);
            Visit(arrow.Expression);
            at.Pop();
        }
        else if (body is ArrowExpressionClauseSyntax voidArrow)
        {
            statementLevel.Add(voidArrow.Expression);
            Visit(voidArrow.Expression);
        }
        else Visit(body);
        foreach (var (made, read) in wires.Values)
        {
            if (read.Count == 0) continue;
            if (read.Max() - made >= Census.LongWireStatements) unit.LongWires++;
            if (read.Count >= Census.FanOutUses) unit.FanOutWires++;
        }
    }

    public override void Visit(SyntaxNode? node)
    {
        if (node == null) return;
        if (node is LocalFunctionStatementSyntax lf)
        {
            // its own graph (Census.Units walks it); in this one it is only the statement that declares it
            unit.Statements++;
            census.Count(unit, NodeFamilies.ForStatement(lf)!.Value, lf);
            return;
        }
        if (node is AnonymousFunctionExpressionSyntax { ExpressionBody: { } lambdaBody } fn
            && model.GetSymbolInfo(fn).Symbol is IMethodSymbol { ReturnsVoid: true })
            statementLevel.Add(lambdaBody);
        bool asStatement = node is ExpressionSyntax && statementLevel.Contains(node);
        bool counted = asStatement || node is StatementSyntax and not BlockSyntax and not EmptyStatementSyntax;
        bool control = node is IfStatementSyntax or ForStatementSyntax or CommonForEachStatementSyntax or WhileStatementSyntax
            or DoStatementSyntax or SwitchStatementSyntax or TryStatementSyntax or UsingStatementSyntax or LockStatementSyntax
            or FixedStatementSyntax or CheckedStatementSyntax or UnsafeStatementSyntax;
        if (counted)
        {
            at.Push(++ordinal);
            unit.Statements++;
            var f = asStatement ? NodeFamilies.ForStatementExpression((ExpressionSyntax)node) : NodeFamilies.ForStatement((StatementSyntax)node);
            if (f is { } family) census.Count(unit, family, node);
        }
        if (control) { depth++; unit.MaxDepth = Math.Max(unit.MaxDepth, depth); }
        Observe(node);
        base.Visit(node);
        if (control) depth--;
        if (counted) at.Pop();
    }

    void Observe(SyntaxNode node)
    {
        switch (node)
        {
            case ExpressionSyntax e:
                // an expression that is a statement's whole expression is that statement's node, already counted
                if (e.Parent is not ExpressionStatementSyntax && !statementLevel.Contains(e) && NodeFamilies.ForExpression(e, model) is { } f)
                    census.Count(unit, f, e);
                if (e is InvocationExpressionSyntax inv) census.Call(inv, model);
                census.Shape(e, model);
                if (e is IdentifierNameSyntax id) Read(id);
                break;
            case VariableDeclaratorSyntax v: Make(model.GetDeclaredSymbol(v)); break;
            case SingleVariableDesignationSyntax d: Make(model.GetDeclaredSymbol(d)); break;
            case CatchDeclarationSyntax c: Make(model.GetDeclaredSymbol(c)); break;
            case ParameterSyntax p: Make(model.GetDeclaredSymbol(p)); break;
            case ForEachStatementSyntax fe: Make(model.GetDeclaredSymbol(fe)); break;
        }
    }

    void Make(ISymbol? s)
    {
        if (s is not (ILocalSymbol or IParameterSymbol)) return;
        wires[s] = (at.Peek(), new List<int>());
        unit.Locals++;
    }

    void Read(IdentifierNameSyntax id)
    {
        if (model.GetSymbolInfo(id).Symbol is { } s && wires.TryGetValue(s, out var w)) w.Read.Add(at.Peek());
    }
}
