// CodeGraphReader: C# in, the node graph language out (PLAN.md phase 2). One .ngl file per source file, one graph per unit the
// census counts (GraphUnits.cs), every node classified by the census's own table (NodeFamilies.cs), so the graph files can be
// held to the census's numbers. What a node keeps is what a reader of any language needs: its family, its operands as
// references or terms, the types on its pins, the callee it binds to, the code place, the comments above it. Nothing in a node
// is C# that another language could not spell; a term is a name, a member path or a literal as the author wrote it.
//
// It writes only under --out. An unhandled syntax kind is an error that stops the run with its place (CLAUDE.md IRON LAW 2).
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace U2ue.CodeGraph;

public static class CodeGraphReader
{
    public static int Run(string measure, IReadOnlyList<string> with, string refDir, string outDir, string? lang)
    {
        var p = LoadedProject.Load(measure, with, refDir, lang, "graph", out var exit);
        if (p == null) return exit;
        outDir = Path.GetFullPath(outDir);
        Directory.CreateDirectory(outDir);
        var written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var families = new Dictionary<NodeFamily, int>();
        var vocabulary = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        int graphs = 0, nodes = 0, files = 0;
        foreach (var tree in p.Measured)
        {
            var model = p.Compilation.GetSemanticModel(tree);
            var units = GraphUnit.In(tree, model).ToList();
            if (units.Count == 0) continue;
            var rel = p.Relative(tree.FilePath);
            var sb = new StringBuilder();
            sb.Append("# ").Append(rel).Append(" - the node graph language (view/NGL.md), written by U2ue.CodeGraph graph from ")
              .Append(Path.GetFileName(p.Root)).Append(". One graph per method; one node per line. Generated: never edit by hand.\n");
            foreach (var unit in units)
            {
                var b = new GraphBuilder(p, model, unit);
                Ngl.Write(sb, b.Build());
                graphs++;
                foreach (var (f, kw) in b.Families)
                {
                    families[f] = families.GetValueOrDefault(f) + 1;
                    nodes++;
                    if (!vocabulary.TryGetValue(kw, out var set)) vocabulary[kw] = set = new SortedSet<string>(StringComparer.Ordinal);
                    set.Add($"{f.Tier}|{f.Name}|{f.Counterpart}");
                }
            }
            var target = Path.Combine(outDir, Path.ChangeExtension(rel, ".ngl"));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllText(target, sb.ToString().Replace("\r\n", "\n"));
            written.Add(Path.GetFullPath(target));
            files++;
        }
        // a source file that no longer exists must not leave its graphs behind to be read as current
        foreach (var stale in Directory.EnumerateFiles(outDir, "*.ngl", SearchOption.AllDirectories))
            if (!written.Contains(Path.GetFullPath(stale)) && Path.GetFileName(stale) != "VOCABULARY.ngl") File.Delete(stale);

        var voc = new StringBuilder("# VOCABULARY.ngl - every node keyword these graphs use: tier | the census family | the Blueprint node a reader would\n" +
                                    "# compare it to (U2ue.CodeGraph/NodeFamilies.cs). Structure keywords (block, section, catch, arm, empty) are not nodes.\n");
        foreach (var (kw, set) in vocabulary)
            foreach (var v in set) voc.Append("word ").Append(kw).Append(' ').Append(Ngl.Text(v)).Append('\n');
        File.WriteAllText(Path.Combine(outDir, "VOCABULARY.ngl"), voc.ToString());

        Console.WriteLine($"graph of {p.Root}: {files} files, {graphs} graphs, {nodes} nodes (the census counts the same families), {p.Version.ToDisplayString()} (READ {p.VersionFrom})");
        Console.WriteLine("  by tier: " + string.Join(", ", families.GroupBy(kv => kv.Key.Tier).OrderBy(g => g.Key).Select(g => $"{g.Key} {g.Sum(kv => kv.Value)}")));
        Console.WriteLine("  wrote " + outDir);
        return 0;
    }
}

/// <summary>Reads one unit into a CodeGraph. Ids: s1.. are the census's statement ordinals (the order it counts statements in,
/// which is what a long wire is measured in), e1.. expressions, f1.. local-function declarations (the census gives them no ordinal),
/// k1.. structure.</summary>
sealed class GraphBuilder
{
    readonly LoadedProject project;
    readonly SemanticModel model;
    readonly GraphUnit unit;
    // each local or parameter -> the node that declares it ("p" for the graph's own parameters). Two lambdas in one statement each
    // declare their own `ctx`, so a value is named by its declaring NODE, never by its statement (measured 2026-10-28: naming by
    // statement merged them and lost 11 of the census's 2,343 long wires in AIBrain.cs, DEBUG.md D21). Its row - the census's
    // ordinal - is the statement that node sits in.
    readonly Dictionary<ISymbol, string> made = new(SymbolEqualityComparer.Default);
    int s, e, f, k;
    public readonly List<(NodeFamily Family, string Keyword)> Families = new();
    /// <summary>each expression node's syntax -> its id: the instrumenter (Instrumenter.cs) keys a probe by the SAME id the graph
    /// file and the page show, so a valve names a node a reader can see</summary>
    public readonly Dictionary<SyntaxNode, string> ExpressionIds = new();
    /// <summary>every node's id -> its syntax (statements, expressions, local functions, structure): the edit writer (EditWriter.cs)
    /// finds the exact span a command changes through it</summary>
    public readonly Dictionary<string, SyntaxNode> NodeSyntax = new(StringComparer.Ordinal);
    /// <summary>the unit's file, relative to its project, and its line:col - with a node id, a probe's key</summary>
    public string File => project.Relative(unit.Decl.SyntaxTree.FilePath);
    public string At { get { var p = unit.Decl.GetLocation().GetLineSpan().StartLinePosition; return $"{p.Line + 1}:{p.Character + 1}"; } }

    static readonly SymbolDisplayFormat TypeFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
        .WithMiscellaneousOptions(SymbolDisplayFormat.MinimallyQualifiedFormat.MiscellaneousOptions | SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    public GraphBuilder(LoadedProject project, SemanticModel model, GraphUnit unit)
    {
        this.project = project; this.model = model; this.unit = unit;
        if (unit.Owner != null) foreach (var prm in unit.Owner.Parameters) made[prm] = "p";
    }

    public CodeGraph Build()
    {
        var g = new CodeGraph { Name = unit.Name };
        var span = unit.Decl.GetLocation().GetLineSpan().StartLinePosition;
        g.Attrs.Add(("kind", KindOf(unit.Decl)));
        g.Attrs.Add(("at", $"{span.Line + 1}:{span.Character + 1}"));
        var mods = (unit.Decl as MemberDeclarationSyntax)?.Modifiers ?? (unit.Decl as LocalFunctionStatementSyntax)?.Modifiers
                   ?? (unit.Decl as AccessorDeclarationSyntax)?.Modifiers;
        if (mods is { Count: > 0 } m) g.Attrs.Add(("mods", Ngl.List(m.Select(t => t.Text))));
        if (unit.Owner != null)
        {
            if (unit.Owner.Parameters.Length > 0)
                g.Attrs.Add(("params", Ngl.List(unit.Owner.Parameters.Select(x => Ngl.Value(x.Name + ":" + Type(x.Type))))));
            g.Attrs.Add(("returns", Ngl.Value(Type(unit.Owner.ReturnType))));
        }
        var doc = Doc(unit.Decl);
        if (doc != null) g.Attrs.Add(("doc", Ngl.Text(doc)));

        if (unit.Body is BlockSyntax block)
        {
            var ids = new List<string>();
            foreach (var st in block.Statements) { var n = Stmt(st); g.Roots.Add(n); ids.Add(n.Id); }
            g.Attrs.Add(("body", Ngl.List(ids)));
        }
        else
        {
            var arrow = (ArrowExpressionClauseSyntax)unit.Body;
            GraphNode n;
            if (unit.Owner is { ReturnsVoid: false })
            {
                n = NewStatement(NodeFamilies.ForExpressionBody(), arrow);
                n.Set("value", Value(arrow.Expression, n));
            }
            else n = StatementExpression(arrow.Expression);
            g.Roots.Add(n);
            g.Attrs.Add(("arrow", n.Id));
        }
        return g;
    }

    // ---- node creation

    GraphNode NewStatement(NodeFamily? family, SyntaxNode syntax, string? keyword = null)
    {
        var n = new GraphNode { Id = "s" + ++s, Keyword = keyword ?? Ngl.Keyword(family!.Value), Family = family, Line = LineOf(syntax), Column = ColOf(syntax) };
        NodeSyntax[n.Id] = syntax;
        if (family is { } fam) Families.Add((fam, n.Keyword));
        var note = Note(syntax);
        if (note != null) n.Set("note", Ngl.Text(note));
        return n;
    }

    GraphNode NewExpression(NodeFamily family, SyntaxNode syntax, GraphNode owner)
    {
        var n = new GraphNode { Id = "e" + ++e, Keyword = Ngl.Keyword(family), Family = family, Line = LineOf(syntax), Column = ColOf(syntax) };
        Families.Add((family, n.Keyword));
        owner.Below.Add(n);
        ExpressionIds[syntax] = n.Id;
        NodeSyntax[n.Id] = syntax;
        return n;
    }

    GraphNode NewStructure(string keyword, SyntaxNode syntax)
    {
        var n = new GraphNode { Id = "k" + ++k, Keyword = keyword, Line = LineOf(syntax), Column = ColOf(syntax) };
        NodeSyntax[n.Id] = syntax;
        var note = Note(syntax);
        if (note != null) n.Set("note", Ngl.Text(note));
        return n;
    }

    void Make(ISymbol? sym, GraphNode declaredBy)
    {
        if (sym is ILocalSymbol or IParameterSymbol) made[sym] = declaredBy.Id;
    }

    // ---- statements

    GraphNode Stmt(StatementSyntax st)
    {
        switch (st)
        {
            case BlockSyntax b:
            {
                var n = NewStructure("block", b);
                n.Set("body", Block(b, n));
                return n;
            }
            case EmptyStatementSyntax es:
                return NewStructure("empty", es);
            case LocalFunctionStatementSyntax lf:
            {
                var fam = NodeFamilies.ForStatement(lf)!.Value;
                var n = new GraphNode { Id = "f" + ++f, Keyword = Ngl.Keyword(fam), Family = fam, Line = LineOf(lf), Column = ColOf(lf) };
                NodeSyntax[n.Id] = lf;
                Families.Add((fam, n.Keyword));
                var note = Note(lf);
                if (note != null) n.Set("note", Ngl.Text(note));
                var at = lf.GetLocation().GetLineSpan().StartLinePosition;
                // the census does not walk a local function's declaration in its parent graph, so neither does this: plain text,
                // no nodes made from a default value, no locals declared
                n.Set("sig", Ngl.Value(Raw(lf, n, observe: false, nodes: false, skip: new SyntaxNode?[] { lf.Body, lf.ExpressionBody })
                    .TrimEnd(';').TrimEnd()));
                n.Set("graph", $"{at.Line + 1}:{at.Character + 1}");
                return n;
            }
            case ExpressionStatementSyntax es:
                return StatementExpression(es.Expression, es);
        }

        var family = NodeFamilies.ForStatement(st);
        if (family is { Unclassified: true }) throw new InvalidOperationException($"unclassified statement {st.Kind()} at {Place(st)}");
        var node = family == null
            ? NewStatement(null, st, "section-break")   // a switch section's own break: an ordinal, not a node (NodeFamilies)
            : NewStatement(family, st);
        {
            switch (st)
            {
                case LocalDeclarationStatementSyntax d:
                    var mods = new List<string>();
                    if (d.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword)) mods.Add("await");
                    if (d.UsingKeyword.IsKind(SyntaxKind.UsingKeyword)) mods.Add("using");
                    mods.AddRange(d.Modifiers.Select(t => t.Text));
                    if (mods.Count > 0) node.Set("mods", Ngl.List(mods));
                    Declaration(d.Declaration, node);
                    break;
                case IfStatementSyntax i:
                    node.Set("cond", Value(i.Condition, node));
                    node.Set("then", Body(i.Statement, node));
                    if (i.Else != null) node.Set("else", Body(i.Else.Statement, node));
                    break;
                case SwitchStatementSyntax sw:
                    node.Set("on", Value(sw.Expression, node));
                    var sections = new List<string>();
                    foreach (var sec in sw.Sections)
                    {
                        var kn = NewStructure("section", sec);
                        node.Below.Add(kn);
                        var labels = new List<string>();
                        foreach (var label in sec.Labels)
                        {
                            switch (label)
                            {
                                case CaseSwitchLabelSyntax c: labels.Add("case"); labels.Add(Value(c.Value, kn)); break;
                                case DefaultSwitchLabelSyntax: labels.Add("default"); break;
                                case CasePatternSwitchLabelSyntax cp:
                                    labels.Add("pattern"); labels.Add(Ngl.Value(Raw(cp.Pattern, kn)));
                                    if (cp.WhenClause != null) { labels.Add("when"); labels.Add(Value(cp.WhenClause.Condition, kn)); }
                                    break;
                                default: throw new InvalidOperationException($"switch label {label.Kind()} at {Place(label)}");
                            }
                        }
                        kn.Set("labels", Ngl.List(labels));
                        kn.Set("body", Ngl.List(sec.Statements.Select(x => Add(kn, Stmt(x)).Id)));
                        sections.Add(kn.Id);
                    }
                    node.Set("sections", Ngl.List(sections));
                    break;
                case ForStatementSyntax fo:
                    if (fo.Declaration != null) Declaration(fo.Declaration, node);
                    if (fo.Initializers.Count > 0) node.Set("init", Ngl.List(fo.Initializers.Select(x => Value(x, node))));
                    if (fo.Condition != null) node.Set("cond", Value(fo.Condition, node));
                    if (fo.Incrementors.Count > 0) node.Set("step", Ngl.List(fo.Incrementors.Select(x => Value(x, node))));
                    node.Set("body", Body(fo.Statement, node));
                    break;
                case ForEachStatementSyntax fe:
                    Make(model.GetDeclaredSymbol(fe), node);
                    if (fe.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword)) node.Set("mods", "[await]");
                    node.Set("decl", Ngl.Value(Raw(fe.Type, node)));
                    node.Set("var", Ngl.Value(fe.Identifier.Text));
                    node.Set("in", Value(fe.Expression, node));
                    node.Set("body", Body(fe.Statement, node));
                    break;
                case ForEachVariableStatementSyntax fv:
                    if (fv.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword)) node.Set("mods", "[await]");
                    node.Set("var", Ngl.Value(Raw(fv.Variable, node)));
                    node.Set("in", Value(fv.Expression, node));
                    node.Set("body", Body(fv.Statement, node));
                    break;
                case WhileStatementSyntax w:
                    node.Set("cond", Value(w.Condition, node));
                    node.Set("body", Body(w.Statement, node));
                    break;
                case DoStatementSyntax dw:
                    node.Set("body", Body(dw.Statement, node));
                    node.Set("cond", Value(dw.Condition, node));
                    break;
                case ReturnStatementSyntax r:
                    if (r.Expression != null) node.Set("value", Value(r.Expression, node));
                    break;
                case BreakStatementSyntax or ContinueStatementSyntax:
                    break;
                case ThrowStatementSyntax th:
                    if (th.Expression != null) node.Set("value", Value(th.Expression, node));
                    break;
                case TryStatementSyntax t:
                    node.Set("body", Block(t.Block, node));
                    if (t.Catches.Count > 0)
                    {
                        var catches = new List<string>();
                        foreach (var c in t.Catches)
                        {
                            var kn = NewStructure("catch", c);
                            node.Below.Add(kn);
                            if (c.Declaration != null)
                            {
                                Make(model.GetDeclaredSymbol(c.Declaration), kn);
                                kn.Set("decl", Ngl.Value(Raw(c.Declaration.Type, kn)));
                                if (!c.Declaration.Identifier.IsKind(SyntaxKind.None)) kn.Set("var", Ngl.Value(c.Declaration.Identifier.Text));
                            }
                            if (c.Filter != null) kn.Set("when", Value(c.Filter.FilterExpression, kn));
                            kn.Set("body", Block(c.Block, kn));
                            catches.Add(kn.Id);
                        }
                        node.Set("catches", Ngl.List(catches));
                    }
                    if (t.Finally != null) node.Set("finally", Block(t.Finally.Block, node));
                    break;
                case UsingStatementSyntax u:
                    if (u.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword)) node.Set("mods", "[await]");
                    if (u.Declaration != null) Declaration(u.Declaration, node);
                    if (u.Expression != null) node.Set("res", Value(u.Expression, node));
                    node.Set("body", Body(u.Statement, node));
                    break;
                case LockStatementSyntax l:
                    node.Set("on", Value(l.Expression, node));
                    node.Set("body", Body(l.Statement, node));
                    break;
                case YieldStatementSyntax y:
                    node.Set("kind", y.IsKind(SyntaxKind.YieldBreakStatement) ? "break" : "return");
                    if (y.Expression != null) node.Set("value", Value(y.Expression, node));
                    break;
                case GotoStatementSyntax gt:
                    node.Set("text", Ngl.Value(Raw(gt, node, skipTokens: new[] { gt.SemicolonToken })));
                    break;
                case LabeledStatementSyntax ls:
                    node.Set("label", Ngl.Value(ls.Identifier.Text));
                    node.Set("stmt", Add(node, Stmt(ls.Statement)).Id);
                    break;
                case CheckedStatementSyntax ch:
                    node.Set("kw", ch.Keyword.Text);
                    node.Set("body", Block(ch.Block, node));
                    break;
                case UnsafeStatementSyntax us:
                    node.Set("kw", "unsafe");
                    node.Set("body", Block(us.Block, node));
                    break;
                case FixedStatementSyntax fx:
                    node.Set("kw", "fixed");
                    Declaration(fx.Declaration, node);
                    node.Set("body", Body(fx.Statement, node));
                    break;
                default:
                    throw new InvalidOperationException($"statement {st.Kind()} has no reading at {Place(st)}");
            }
        }
        return node;
    }

    static GraphNode Add(GraphNode owner, GraphNode child)
    {
        owner.Below.Add(child);
        return child;
    }

    /// <summary>a body: a list for a braced block, a single statement id for an embedded statement (`if (x) return;`)</summary>
    string Body(StatementSyntax st, GraphNode owner) =>
        st is BlockSyntax b ? Block(b, owner) : Add(owner, Stmt(st)).Id;

    string Block(BlockSyntax b, GraphNode owner) => Ngl.List(b.Statements.Select(x => Add(owner, Stmt(x)).Id));

    void Declaration(VariableDeclarationSyntax d, GraphNode n)
    {
        n.Set("decl", Ngl.Value(Raw(d.Type, n)));
        var vars = new List<string>();
        var values = new List<string>();
        foreach (var v in d.Variables)
        {
            Make(model.GetDeclaredSymbol(v), n);
            vars.Add(Ngl.Value(v.Identifier.Text + (v.ArgumentList != null ? Raw(v.ArgumentList, n) : "")));
            values.Add(v.Initializer != null ? Value(v.Initializer.Value, n) : "-");
        }
        n.Set("vars", Ngl.List(vars));
        n.Set("values", Ngl.List(values));
        if (d.Variables.Count > 0 && model.GetDeclaredSymbol(d.Variables[0]) is ILocalSymbol loc) n.Set("t", Ngl.Value(Type(loc.Type)));
    }

    /// <summary>an expression standing where a statement would: an expression statement, the body of a void `=>` member, or of a
    /// void lambda. It is the statement's node (the census counts it once, as a statement).</summary>
    GraphNode StatementExpression(ExpressionSyntax x, SyntaxNode? statementSyntax = null)
    {
        var family = NodeFamilies.ForStatementExpression(x);
        if (family.Unclassified) throw new InvalidOperationException($"unclassified statement expression {x.Kind()} at {Place(x)}");
        var n = NewStatement(family, statementSyntax ?? x);
        Fill(n, x);
        return n;
    }

    // ---- expressions

    bool IsNode(ExpressionSyntax x)
    {
        var fam = NodeFamilies.ForExpression(x, model);
        if (fam is { Unclassified: true }) throw new InvalidOperationException($"unclassified expression {x.Kind()} at {Place(x)}");
        return fam != null;
    }

    /// <summary>the value an expression gives a pin: a reference to its node, or a term (its text, any nodes inside as references)</summary>
    string Value(ExpressionSyntax x, GraphNode owner)
    {
        while (x is ParenthesizedExpressionSyntax p) x = p.Expression;   // grouping is the printer's job; it adds what precedence needs
        if (IsNode(x)) return Ngl.Ref(Expression(x, owner));
        return Ngl.Value(Raw(x, owner));
    }

    GraphNode Expression(ExpressionSyntax x, GraphNode owner)
    {
        var n = NewExpression(NodeFamilies.ForExpression(x, model)!.Value, x, owner);
        Fill(n, x);
        if (model.GetTypeInfo(x).Type is { } t && t is not IErrorTypeSymbol) n.Set("t", Ngl.Value(Type(t)));
        return n;
    }

    void Fill(GraphNode n, ExpressionSyntax x)
    {
        switch (x)
        {
            case InvocationExpressionSyntax inv:
                switch (inv.Expression)
                {
                    case MemberAccessExpressionSyntax ma when ma.IsKind(SyntaxKind.SimpleMemberAccessExpression):
                        n.Set("on", Value(ma.Expression, n));
                        n.Set("method", Ngl.Value(Raw(ma.Name, n)));
                        break;
                    case MemberBindingExpressionSyntax mb:
                        n.Set("on", "?");
                        n.Set("method", Ngl.Value(Raw(mb.Name, n)));
                        break;
                    case SimpleNameSyntax sn:
                        n.Set("method", Ngl.Value(Raw(sn, n)));
                        break;
                    default:
                        n.Set("callee", Value(inv.Expression, n));
                        break;
                }
                Arguments(n, inv.ArgumentList, "args");
                n.Set("dispatch", Ngl.Value(NodeFamilies.Dispatch(inv, model)));
                Callee(n, model.GetSymbolInfo(inv));
                break;
            case ObjectCreationExpressionSyntax oc:
                n.Set("type", Ngl.Value(Raw(oc.Type, n)));
                Arguments(n, oc.ArgumentList, "args");
                if (oc.Initializer != null) n.Set("init", Ngl.Value(Raw(oc.Initializer, n)));
                Callee(n, model.GetSymbolInfo(oc));
                break;
            case ImplicitObjectCreationExpressionSyntax ic:
                n.Set("implicit", "1");
                Arguments(n, ic.ArgumentList, "args");
                if (ic.Initializer != null) n.Set("init", Ngl.Value(Raw(ic.Initializer, n)));
                Callee(n, model.GetSymbolInfo(ic));
                break;
            case ArrayCreationExpressionSyntax ac:
                n.Set("form", Ngl.Value(Raw(ac, n, skip: new SyntaxNode?[] { ac.Initializer })));
                if (ac.Initializer != null) Elements(n, ac.Initializer);
                break;
            case ImplicitArrayCreationExpressionSyntax ia:
                n.Set("form", Ngl.Value(Raw(ia, n, skip: new SyntaxNode?[] { ia.Initializer })));
                Elements(n, ia.Initializer);
                break;
            case AnonymousFunctionExpressionSyntax fn:
                Lambda(n, fn);
                break;
            case ConditionalExpressionSyntax c:
                n.Set("cond", Value(c.Condition, n));
                n.Set("then", Value(c.WhenTrue, n));
                n.Set("else", Value(c.WhenFalse, n));
                break;
            case BinaryExpressionSyntax b when b.IsKind(SyntaxKind.AsExpression) || b.IsKind(SyntaxKind.IsExpression):
                n.Set("form", b.IsKind(SyntaxKind.AsExpression) ? "as" : "is");
                n.Set("a", Value(b.Left, n));
                n.Set("to", Ngl.Value(Raw(b.Right, n)));
                break;
            case BinaryExpressionSyntax b:
                n.Set("op", Ngl.Op(b.OperatorToken.Text));
                n.Set("a", Value(b.Left, n));
                n.Set("b", Value(b.Right, n));
                break;
            case PrefixUnaryExpressionSyntax pu:
                n.Set("op", Ngl.Op(pu.OperatorToken.Text));
                n.Set("a", Value(pu.Operand, n));
                break;
            case PostfixUnaryExpressionSyntax po:
                n.Set("op", Ngl.Op(po.OperatorToken.Text));
                n.Set("a", Value(po.Operand, n));
                n.Set("post", "1");
                break;
            case ConditionalAccessExpressionSyntax ca:
                n.Set("on", Value(ca.Expression, n));
                n.Set("then", Value(ca.WhenNotNull, n));
                break;
            case SwitchExpressionSyntax sw:
                n.Set("on", Value(sw.GoverningExpression, n));
                var arms = new List<string>();
                foreach (var arm in sw.Arms)
                {
                    var kn = NewStructure("arm", arm);
                    n.Below.Add(kn);
                    kn.Set("pat", Ngl.Value(Raw(arm.Pattern, kn)));
                    if (arm.WhenClause != null) kn.Set("when", Value(arm.WhenClause.Condition, kn));
                    kn.Set("value", Value(arm.Expression, kn));
                    arms.Add(kn.Id);
                }
                n.Set("arms", Ngl.List(arms));
                if (sw.Arms.Count > 0 && sw.Arms.SeparatorCount == sw.Arms.Count) n.Set("comma", "1");   // `_ => x,` keeps its comma
                break;
            case IsPatternExpressionSyntax ip:
                n.Set("a", Value(ip.Expression, n));
                n.Set("pat", Ngl.Value(Raw(ip.Pattern, n)));
                break;
            case CastExpressionSyntax ce:
                n.Set("form", "cast");
                n.Set("to", Ngl.Value(Raw(ce.Type, n)));
                n.Set("a", Value(ce.Expression, n));
                break;
            case InterpolatedStringExpressionSyntax istr:
                n.Set("text", Ngl.Value(Raw(istr, n)));
                break;
            case TupleExpressionSyntax tu:
                n.Set("elems", Ngl.List(tu.Arguments.Select(a => Value(a.Expression, n))));
                if (tu.Arguments.Any(a => a.NameColon != null))
                    n.Set("names", Ngl.List(tu.Arguments.Select(a => a.NameColon != null ? Ngl.Value(a.NameColon.Name.Identifier.Text) : "-")));
                break;
            case ElementAccessExpressionSyntax ea:
                n.Set("on", Value(ea.Expression, n));
                Arguments(n, ea.ArgumentList, "index");
                break;
            case AssignmentExpressionSyntax asg:
                n.Set("target", Value(asg.Left, n));
                n.Set("op", Ngl.Op(asg.OperatorToken.Text));
                n.Set("value", Value(asg.Right, n));
                break;
            case AwaitExpressionSyntax aw:
                n.Set("a", Value(aw.Expression, n));
                break;
            case ThrowExpressionSyntax te:
                n.Set("value", Value(te.Expression, n));
                break;
            case WithExpressionSyntax we:
                n.Set("a", Value(we.Expression, n));
                n.Set("init", Ngl.Value(Raw(we.Initializer, n)));
                break;
            case RangeExpressionSyntax re:
                if (re.LeftOperand != null) n.Set("a", Value(re.LeftOperand, n));
                if (re.RightOperand != null) n.Set("b", Value(re.RightOperand, n));
                break;
            case CheckedExpressionSyntax ck:
                n.Set("kw", ck.Keyword.Text);
                n.Set("a", Value(ck.Expression, n));
                break;
            case RefExpressionSyntax rf:
                n.Set("kw", "ref");
                n.Set("a", Value(rf.Expression, n));
                break;
            case AnonymousObjectCreationExpressionSyntax or QueryExpressionSyntax or CollectionExpressionSyntax or StackAllocArrayCreationExpressionSyntax
                or ImplicitStackAllocArrayCreationExpressionSyntax or RefValueExpressionSyntax or RefTypeExpressionSyntax
                or MakeRefExpressionSyntax or MemberAccessExpressionSyntax:
                // no structure a second language could use: kept as its own text, with any nodes inside as references
                n.Set("text", Ngl.Value(Raw(x, n)));
                break;
            default:
                throw new InvalidOperationException($"expression {x.Kind()} has no reading at {Place(x)}");
        }
    }

    /// <summary>an array initializer's elements, and whether the author left a comma after the last one (`{ a, b, }`)</summary>
    void Elements(GraphNode n, InitializerExpressionSyntax init)
    {
        n.Set("elems", Ngl.List(init.Expressions.Select(v => Value(v, n))));
        if (init.Expressions.Count > 0 && init.Expressions.SeparatorCount == init.Expressions.Count) n.Set("comma", "1");
    }

    void Lambda(GraphNode n, AnonymousFunctionExpressionSyntax fn)
    {
        if (fn.Modifiers.Count > 0) n.Set("mods", Ngl.List(fn.Modifiers.Select(t => t.Text)));
        switch (fn)
        {
            case SimpleLambdaExpressionSyntax sl:
                n.Set("params", Ngl.Value(Raw(sl.Parameter, n)));
                break;
            case ParenthesizedLambdaExpressionSyntax pl:
                if (pl.ReturnType != null) n.Set("ret", Ngl.Value(Raw(pl.ReturnType, n)));
                n.Set("params", Ngl.Value(Raw(pl.ParameterList, n)));
                break;
            case AnonymousMethodExpressionSyntax am:
                n.Set("delegate", "1");
                if (am.ParameterList != null) n.Set("params", Ngl.Value(Raw(am.ParameterList, n)));
                break;
        }
        if (fn.Block != null) n.Set("body", Block(fn.Block, n));
        else if (fn.ExpressionBody != null)
        {
            if (model.GetSymbolInfo(fn).Symbol is IMethodSymbol { ReturnsVoid: true })
                n.Set("do", Add(n, StatementExpression(fn.ExpressionBody)).Id);
            else n.Set("value", Value(fn.ExpressionBody, n));
        }
    }

    void Arguments(GraphNode n, BaseArgumentListSyntax? list, string key)
    {
        if (list == null) return;
        var values = new List<string>();
        var names = new List<string>();
        var mods = new List<string>();
        foreach (var a in list.Arguments)
        {
            names.Add(a.NameColon != null ? Ngl.Value(a.NameColon.Name.Identifier.Text) : "-");
            mods.Add(a.RefKindKeyword.IsKind(SyntaxKind.None) ? "-" : a.RefKindKeyword.Text);
            values.Add(Value(a.Expression, n));
        }
        n.Set(key, Ngl.List(values));
        if (names.Any(x => x != "-")) n.Set(key == "args" ? "argnames" : key + "names", Ngl.List(names));
        if (mods.Any(x => x != "-")) n.Set(key == "args" ? "argmods" : key + "mods", Ngl.List(mods));
    }

    /// <summary>what a call or construction binds to: its parameters (the Blueprint node's input pins) and, when it is the
    /// project's own code, where its graph is (`def`, the click-through)</summary>
    void Callee(GraphNode n, SymbolInfo info)
    {
        if ((info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) is not IMethodSymbol m) return;
        var target = m.ReducedFrom ?? m;
        if (target.Parameters.Length > 0)
            n.Set("params", Ngl.List(target.Parameters.Select(x => Ngl.Value(x.Name + ":" + Type(x.Type)))));
        var decl = target.OriginalDefinition.DeclaringSyntaxReferences.FirstOrDefault();
        if (decl != null && project.Compilation.SyntaxTrees.Contains(decl.SyntaxTree))
        {
            // `def` only when the callee HAS a graph (a body); a declaration with none - an interface or abstract member, a
            // delegate's Invoke, a record's positional constructor, a partial without its half - is `binds` with what it is, so a
            // click-through never lands on nothing (measured 2026-10-28: 1,974 of 16,301 targets had no graph to open)
            var syn = decl.GetSyntax();
            var pos = syn.GetLocation().GetLineSpan();
            var at = Ngl.Value(project.Relative(pos.Path) + ":" + (pos.StartLinePosition.Line + 1));
            var hasBody = syn switch
            {
                BaseMethodDeclarationSyntax bm => bm.Body != null || bm.ExpressionBody != null,
                LocalFunctionStatementSyntax lf => lf.Body != null || lf.ExpressionBody != null,
                _ => false,
            };
            if (hasBody) n.Set("def", at);
            else
            {
                n.Set("binds", at);
                n.Set("bindskind", Ngl.Value(target.ContainingType?.TypeKind == TypeKind.Interface ? "interface"
                    : target.IsAbstract ? "abstract" : target.MethodKind == MethodKind.DelegateInvoke ? "delegate"
                    : syn is RecordDeclarationSyntax ? "record" : target.IsPartialDefinition ? "partial" : target.IsExtern ? "extern"
                    : syn.Kind().ToString()));
            }
        }
    }

    // ---- text

    /// <summary>The text of a piece of syntax with every graph node inside it written as its reference (#e4), tokens joined by one
    /// space where the source had any trivia between them - so a term is always one line, keeps no comment, and prints back as the
    /// same tokens. Walking it also records the locals it reads and declares, as the census does.</summary>
    string Raw(SyntaxNode root, GraphNode owner, bool observe = true, SyntaxNode?[]? skip = null, SyntaxToken[]? skipTokens = null,
               bool nodes = true)
    {
        var sb = new StringBuilder();
        bool space = false, first = true;

        void Piece(string text, bool leading, bool trailing)
        {
            if (!first && (space || leading)) sb.Append(' ');
            sb.Append(text);
            first = false;
            space = trailing;
        }

        void Walk(SyntaxNodeOrToken x)
        {
            if (x.IsToken)
            {
                var t = x.AsToken();
                if (skipTokens != null && skipTokens.Contains(t)) return;
                Piece(t.Text, t.HasLeadingTrivia, t.HasTrailingTrivia);
                return;
            }
            var node = x.AsNode()!;
            if (skip != null && skip.Contains(node)) return;
            if (nodes && node != root && node is ExpressionSyntax ex && IsNode(ex))
            {
                var child = Expression(ex, owner);
                Piece(Ngl.Ref(child), node.GetFirstToken().HasLeadingTrivia, node.GetLastToken().HasTrailingTrivia);
                return;
            }
            if (observe) Observe(node, owner);
            foreach (var c in node.ChildNodesAndTokens()) Walk(c);
        }

        Walk(root);
        return sb.ToString();
    }

    /// <summary>the census's Observe: a local or parameter read, or one declared inside a term</summary>
    void Observe(SyntaxNode node, GraphNode owner)
    {
        switch (node)
        {
            case IdentifierNameSyntax id:
                if (model.GetSymbolInfo(id).Symbol is { } sym && made.TryGetValue(sym, out var at))
                    owner.Reads.Add(Ngl.Value(id.Identifier.ValueText + "@" + at));
                break;
            case SingleVariableDesignationSyntax d: Make(model.GetDeclaredSymbol(d), owner); break;
            case ParameterSyntax prm: Make(model.GetDeclaredSymbol(prm), owner); break;
            case VariableDeclaratorSyntax v: Make(model.GetDeclaredSymbol(v), owner); break;
            case CatchDeclarationSyntax c: Make(model.GetDeclaredSymbol(c), owner); break;
        }
    }

    static string Type(ITypeSymbol t) => t.ToDisplayString(TypeFormat).Replace(", ", ",");

    static int LineOf(SyntaxNode n) => n.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
    static int ColOf(SyntaxNode n) => n.GetLocation().GetLineSpan().StartLinePosition.Character + 1;

    string Place(SyntaxNode n) => project.Relative(n.SyntaxTree.FilePath) + ":" + LineOf(n);

    static string KindOf(SyntaxNode decl) => decl switch
    {
        MethodDeclarationSyntax => "method",
        ConstructorDeclarationSyntax => "constructor",
        DestructorDeclarationSyntax => "destructor",
        OperatorDeclarationSyntax => "operator",
        ConversionOperatorDeclarationSyntax => "conversion",
        AccessorDeclarationSyntax a => a.Keyword.Text,
        PropertyDeclarationSyntax => "property",
        IndexerDeclarationSyntax => "indexer",
        LocalFunctionStatementSyntax => "local",
        _ => decl.Kind().ToString(),
    };

    /// <summary>the comments a reader sees above (and at the end of the line of) a statement - kept for the view, never compared</summary>
    static string? Note(SyntaxNode n)
    {
        var parts = new List<string>();
        foreach (var tr in n.GetLeadingTrivia().Concat(n.GetLastToken().TrailingTrivia))
        {
            if (tr.IsKind(SyntaxKind.SingleLineCommentTrivia)) parts.Add(tr.ToString().TrimStart('/').Trim());
            else if (tr.IsKind(SyntaxKind.MultiLineCommentTrivia)) parts.Add(tr.ToString().Trim('/', '*').Trim());
        }
        parts.RemoveAll(string.IsNullOrEmpty);
        return parts.Count == 0 ? null : string.Join(" / ", parts);
    }

    static string? Doc(SyntaxNode decl)
    {
        var doc = decl.GetLeadingTrivia().Select(t => t.GetStructure()).OfType<DocumentationCommentTriviaSyntax>().FirstOrDefault();
        if (doc == null) return null;
        var summary = doc.Content.OfType<XmlElementSyntax>().FirstOrDefault(x => x.StartTag.Name.LocalName.Text == "summary");
        var text = string.Concat((summary?.Content ?? doc.Content).Select(c => c switch
        {
            XmlTextSyntax xt => string.Concat(xt.TextTokens.Select(t => t.Text)),
            XmlEmptyElementSyntax ee => " " + string.Concat(ee.Attributes.Select(a => a is XmlCrefAttributeSyntax cr ? cr.Cref.ToString() : a is XmlNameAttributeSyntax na ? na.Identifier.ToString() : "")) + " ",
            XmlElementSyntax el => string.Concat(el.Content.Select(cc => cc.ToString())),
            _ => "",
        }));
        text = System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " ").Trim();
        return text.Length == 0 ? null : text;
    }
}
