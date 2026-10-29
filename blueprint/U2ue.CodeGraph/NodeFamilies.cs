// The vocabulary of the Blueprint view: which node each piece of C# becomes (quarantine/blueprint_view: space S5 reads its family
// names from this file, UC-BV2). The census (Census.cs) counts this table over a whole project; the reader (PLAN.md phase 2) draws from the same table, so
// what the census measured is what will be drawn. Every syntax kind lands in exactly one place: a node family, "not a node"
// (structure, a name, a literal pin value), or UNCLASSIFIED - which the census prints and counts, because a kind this table
// does not know must never be dropped silently (CLAUDE.md IRON LAW 2).
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace U2ue.CodeGraph;

/// <summary>How far a piece of C# is from a Blueprint node. The view draws all three; the tier says how much new vocabulary a
/// Blueprint reader needs to read it.</summary>
public enum Tier
{
    /// <summary>Blueprint has this node: Branch, For Each Loop, Call Function, Select, Cast To, Set, Return Node.</summary>
    Blueprint,
    /// <summary>Blueprint has no such node, but it draws as a graph a reader can follow: a lambda as a collapsed sub-graph, a
    /// try/catch as a frame, a throw as a red terminal.</summary>
    Extended,
    /// <summary>No graph form: drawn as its own source text inside a code node, named with its file:line, never approximated.</summary>
    Island,
}

/// <summary>One kind of node in the Blueprint view: its name, its tier, and the Blueprint node a reader would compare it to
/// (empty when Blueprint has none).</summary>
public readonly record struct NodeFamily(string Name, Tier Tier, string Counterpart)
{
    public bool Unclassified => Name.StartsWith(NodeFamilies.UnclassifiedPrefix, StringComparison.Ordinal);
}

/// <summary>The mapping from C# syntax to node families. Statements are the exec chain (the white wires); expressions inside them
/// are the data nodes (the coloured wires). An expression that IS a statement's whole expression is that statement's node and is
/// not counted twice.</summary>
public static class NodeFamilies
{
    public const string UnclassifiedPrefix = "UNCLASSIFIED ";

    static NodeFamily B(string n, string counterpart) => new(n, Tier.Blueprint, counterpart);
    static NodeFamily X(string n) => new(n, Tier.Extended, "");
    static NodeFamily I(string n) => new(n, Tier.Island, "");
    static NodeFamily Unknown(SyntaxNode n) => new(UnclassifiedPrefix + n.Kind(), Tier.Island, "");

    /// <summary>The exec node a statement becomes, or null when it is structure only (a block, an empty statement, a switch
    /// section's own break).</summary>
    public static NodeFamily? ForStatement(StatementSyntax s) => s switch
    {
        BlockSyntax or EmptyStatementSyntax => null,
        ExpressionStatementSyntax es => ForStatementExpression(es.Expression),
        LocalDeclarationStatementSyntax d when d.Declaration.Type is RefTypeSyntax => I("ref local"),
        LocalDeclarationStatementSyntax d when d.UsingKeyword.IsKind(SyntaxKind.UsingKeyword) => X("using declaration (dispose frame)"),
        LocalDeclarationStatementSyntax => B("set local", "Local Variable + Set"),
        IfStatementSyntax => B("branch", "Branch"),
        SwitchStatementSyntax sw when sw.Sections.SelectMany(x => x.Labels).All(l => l is CaseSwitchLabelSyntax or DefaultSwitchLabelSyntax)
            => B("switch", "Switch on Int / Enum / String"),
        SwitchStatementSyntax => X("switch on patterns (a cast chain)"),
        ForStatementSyntax => B("for loop", "For Loop / While Loop"),
        ForEachStatementSyntax => B("for each loop", "For Each Loop"),
        ForEachVariableStatementSyntax => X("for each with deconstruction"),
        WhileStatementSyntax => B("while loop", "While Loop"),
        DoStatementSyntax => X("do-while loop"),
        ReturnStatementSyntax => B("return", "Return Node"),
        BreakStatementSyntax b when InSwitchSection(b) => null,
        BreakStatementSyntax => B("break", "For Loop With Break: Break"),
        ContinueStatementSyntax => X("continue"),
        ThrowStatementSyntax => X("throw (error terminal)"),
        TryStatementSyntax => X("try / catch / finally (frame)"),
        UsingStatementSyntax => X("using (dispose frame)"),
        LockStatementSyntax => X("lock (frame)"),
        YieldStatementSyntax => X("yield (emit)"),
        LocalFunctionStatementSyntax => B("local function (its own graph)", "Function"),
        GotoStatementSyntax or LabeledStatementSyntax => I("goto / label"),
        CheckedStatementSyntax => I("checked / unchecked block"),
        FixedStatementSyntax or UnsafeStatementSyntax => I("unsafe / fixed"),
        _ => Unknown(s),
    };

    /// <summary>An expression-bodied member (`=> x`) is one node: its value goes to the Return Node.</summary>
    public static NodeFamily ForExpressionBody() => B("expression body", "Return Node");

    /// <summary>An expression used as a statement is the node of that expression: a call, a set, an increment. That is an
    /// expression statement, and also the body of a void expression-bodied member (`set => x = value;`) or of a void lambda
    /// (`() => count++`), which Blueprint would draw as the same exec node.</summary>
    public static NodeFamily ForStatementExpression(ExpressionSyntax expression) => expression switch
    {
        AssignmentExpressionSyntax a when a.IsKind(SyntaxKind.SimpleAssignmentExpression) && a.Left is TupleExpressionSyntax
            => X("deconstructing set"),
        AssignmentExpressionSyntax a when a.IsKind(SyntaxKind.SimpleAssignmentExpression) => B("set", "Set"),
        AssignmentExpressionSyntax a when a.IsKind(SyntaxKind.CoalesceAssignmentExpression) => X("set if null (??=)"),
        AssignmentExpressionSyntax => B("set with math", "Set + math node / Bind Event"),
        PostfixUnaryExpressionSyntax or PrefixUnaryExpressionSyntax => B("increment", "Increment / Decrement"),
        InvocationExpressionSyntax => B("call", "Call Function"),
        AwaitExpressionSyntax => X("await (latent)"),
        ConditionalAccessExpressionSyntax => X("call if valid (?.)"),
        ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax => B("construct", "Construct"),
        ThrowExpressionSyntax => X("throw (error terminal)"),
        _ => Unknown(expression),
    };

    /// <summary>The data node an expression becomes, or null when it is not a node of its own (a name, a literal, a getter pin,
    /// parentheses, a type).</summary>
    public static NodeFamily? ForExpression(ExpressionSyntax e, SemanticModel model) => e switch
    {
        // parts of a node drawn elsewhere: an initializer's `Name = value` is a pin of its Make node, a dictionary
        // initializer's `[key]` the key pin, and a for loop's `i = 0` / `i++` belong to the For Loop node itself
        AssignmentExpressionSyntax when e.Parent is InitializerExpressionSyntax => null,
        ImplicitElementAccessSyntax => null,
        _ when e.Parent is ForStatementSyntax f && (f.Initializers.Contains(e) || f.Incrementors.Contains(e)) => null,
        InvocationExpressionSyntax inv when IsNameof(inv, model) => null,
        InvocationExpressionSyntax => B("pure call", "Call Function (pure)"),
        ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax => B("construct", "Make Struct / Construct Object"),
        ArrayCreationExpressionSyntax or ImplicitArrayCreationExpressionSyntax or CollectionExpressionSyntax => B("make array", "Make Array"),
        AnonymousObjectCreationExpressionSyntax => X("anonymous object"),
        AnonymousFunctionExpressionSyntax => X("lambda (a sub-graph)"),
        QueryExpressionSyntax => X("query pipeline"),
        ConditionalExpressionSyntax => B("select", "Select"),
        BinaryExpressionSyntax b when b.IsKind(SyntaxKind.CoalesceExpression) => X("coalesce (??)"),
        BinaryExpressionSyntax b when b.IsKind(SyntaxKind.AsExpression) => B("cast", "Cast To"),
        BinaryExpressionSyntax b when b.IsKind(SyntaxKind.IsExpression) => B("type test", "Cast To (success pin)"),
        BinaryExpressionSyntax => B("operator", "math / logic node"),
        PrefixUnaryExpressionSyntax p when p.IsKind(SyntaxKind.AddressOfExpression) || p.IsKind(SyntaxKind.PointerIndirectionExpression)
            => I("pointer"),
        PrefixUnaryExpressionSyntax p when p.IsKind(SyntaxKind.IndexExpression) => X("index from the end (^)"),
        PrefixUnaryExpressionSyntax p when p.IsKind(SyntaxKind.PreIncrementExpression) || p.IsKind(SyntaxKind.PreDecrementExpression)
            => X("increment inside an expression"),
        PrefixUnaryExpressionSyntax => B("operator", "math / logic node"),
        PostfixUnaryExpressionSyntax p when p.IsKind(SyntaxKind.SuppressNullableWarningExpression) => null,
        PostfixUnaryExpressionSyntax => X("increment inside an expression"),
        ConditionalAccessExpressionSyntax => X("if valid (?.)"),
        SwitchExpressionSyntax sw when sw.Arms.All(a => a.WhenClause == null && a.Pattern is ConstantPatternSyntax or DiscardPatternSyntax)
            => B("select", "Select"),
        SwitchExpressionSyntax => X("switch expression on patterns"),
        IsPatternExpressionSyntax ip when ip.Pattern is DeclarationPatternSyntax or TypePatternSyntax => B("type test", "Cast To (success pin)"),
        IsPatternExpressionSyntax ip when ip.Pattern is ConstantPatternSyntax => B("compare", "== / Is Valid"),
        IsPatternExpressionSyntax ip when ip.Pattern is UnaryPatternSyntax { Pattern: ConstantPatternSyntax } => B("compare", "!= / Is Valid"),
        IsPatternExpressionSyntax => X("pattern match"),
        CastExpressionSyntax => B("cast", "Cast To / To Float, To Int"),
        InterpolatedStringExpressionSyntax => B("format", "Format Text / Append"),
        TupleExpressionSyntax => X("tuple"),
        ElementAccessExpressionSyntax => B("get at index", "Get (array) / Find (map)"),
        AssignmentExpressionSyntax => X("assignment inside an expression"),
        AwaitExpressionSyntax => X("await (latent)"),
        ThrowExpressionSyntax => X("throw (error terminal)"),
        WithExpressionSyntax => X("with (copy and set)"),
        RangeExpressionSyntax => X("range"),
        CheckedExpressionSyntax => I("checked / unchecked"),
        StackAllocArrayCreationExpressionSyntax or ImplicitStackAllocArrayCreationExpressionSyntax => I("stackalloc"),
        RefExpressionSyntax or RefValueExpressionSyntax or RefTypeExpressionSyntax or MakeRefExpressionSyntax => I("ref expression"),
        MemberAccessExpressionSyntax pm when pm.IsKind(SyntaxKind.PointerMemberAccessExpression) => I("pointer"),
        // not nodes of their own: a name or type is a wire's source, a literal is a pin's default, a member access is a getter
        // pin, an initializer belongs to its creation
        TypeSyntax or LiteralExpressionSyntax or MemberAccessExpressionSyntax or MemberBindingExpressionSyntax
            or ElementBindingExpressionSyntax or ParenthesizedExpressionSyntax or ThisExpressionSyntax or BaseExpressionSyntax
            or DeclarationExpressionSyntax or InitializerExpressionSyntax or DefaultExpressionSyntax or TypeOfExpressionSyntax
            or SizeOfExpressionSyntax or OmittedArraySizeExpressionSyntax => null,
        _ => Unknown(e),
    };

    /// <summary>What a call binds to - the dimension the casting trap is about (a polymorphic call is ONE node, never a Cast To
    /// chain). Read from the semantic model, never from the spelling.</summary>
    public static string Dispatch(InvocationExpressionSyntax inv, SemanticModel model)
    {
        var info = model.GetSymbolInfo(inv);
        if ((info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) is not IMethodSymbol m)
            return IsNameof(inv, model) ? "nameof (a literal)" : "UNRESOLVED";
        if (m.MethodKind == MethodKind.DelegateInvoke) return "delegate";
        if (m.MethodKind == MethodKind.LocalFunction) return "local function";
        if (m.ReducedFrom != null || m.IsExtensionMethod)
            return m.ContainingNamespace?.ToDisplayString() == "System.Linq" ? "LINQ" : "extension";
        if (inv.Expression is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax }) return "parent (base.)";
        if (m.IsStatic) return "static";
        if (m.ContainingType?.TypeKind == TypeKind.Interface) return "interface";
        if (m.IsVirtual || m.IsAbstract || m.IsOverride) return "virtual";
        return "instance";
    }

    public static bool IsNameof(InvocationExpressionSyntax inv, SemanticModel model) =>
        inv.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" } && model.GetSymbolInfo(inv).Symbol == null;

    static bool InSwitchSection(SyntaxNode n)
    {
        for (var p = n.Parent; p != null; p = p.Parent)
        {
            if (p is SwitchSectionSyntax) return true;
            if (p is ForStatementSyntax or CommonForEachStatementSyntax or WhileStatementSyntax or DoStatementSyntax) return false;
            if (p is MemberDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax) return false;
        }
        return false;
    }
}
