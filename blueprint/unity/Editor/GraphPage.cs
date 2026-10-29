using System;
using System.IO;
using System.Linq;
using System.Text;

namespace U2ue.BlueprintView.Editor
{
    /// <summary>The page: the package's WebView/BlueprintView.html - the Blueprint view's own page with its scripts written inside it -
    /// with the graphs of one read written inside it too, as the page's bundle (NGL_BUNDLES, the shape `pl_cli.js bundle` writes). It
    /// is ONE file, opened from disk: no server, nothing installed, nothing fetched but its fonts.</summary>
    public static class GraphPage
    {
        /// <summary>where the template takes the graphs: a script element holding only this comment</summary>
        public const string Slot = "/*BPV_DATA*/";

        /// <summary>the page for the .ngl files under `graphs` (VOCABULARY.ngl as the vocabulary, as the bundler reads it); returns
        /// its path and the number of graph files it holds</summary>
        public static string Write(string template, string graphs, string project, string source, string page, out int files)
        {
            var html = File.ReadAllText(template);
            var at = html.IndexOf(Slot, StringComparison.Ordinal);
            if (at < 0) throw new InvalidOperationException(template + " has no " + Slot + " slot for the graphs");
            var data = new StringBuilder();
            data.Append("var NGL_MANIFEST = []; var NGL_BUNDLES = [{\"project\":").Append(Json(project))
                .Append(",\"ext\":\".cs\",\"source\":").Append(Json(source)).Append(",\"files\":{");
            files = 0;
            var vocabulary = "";
            foreach (var f in Directory.GetFiles(graphs, "*.ngl", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal))
            {
                var rel = f.Substring(graphs.Length).TrimStart('\\', '/').Replace('\\', '/');
                var text = File.ReadAllText(f);
                if (rel == "VOCABULARY.ngl")
                {
                    vocabulary = text;
                    continue;
                }
                if (files++ > 0) data.Append(',');
                data.Append(Json(rel)).Append(':').Append(Json(text));
            }
            if (files == 0) throw new InvalidOperationException("the read wrote no graphs under " + graphs);
            data.Append("},\"vocabulary\":").Append(Json(vocabulary)).Append("}];");
            Directory.CreateDirectory(Path.GetDirectoryName(page));
            File.WriteAllText(page, html.Substring(0, at) + data + html.Substring(at + Slot.Length));
            return page;
        }

        /// <summary>a JSON string that is safe inside a script element: "&lt;/" is written "&lt;\/", so no text in a graph can close
        /// the element, and the two separators JavaScript reads as line ends are escaped</summary>
        public static string Json(string s)
        {
            var sb = new StringBuilder(s.Length + 16).Append('"');
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '/': sb.Append(i > 0 && s[i - 1] == '<' ? "\\/" : "/"); break;
                    case (char)0x2028: sb.Append("\\u2028"); break;
                    case (char)0x2029: sb.Append("\\u2029"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }
    }
}
