using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace U2ue.BlueprintView.Editor
{
    /// <summary>The compile folder of this editor: Library/Bee/artifacts/&lt;dag&gt;, where Unity writes one compiler command line per
    /// assembly (&lt;assembly&gt;.rsp) - its sources, references, defines, language version and source generators. Of several folders
    /// (a player build writes its own; an older editor's outlives an upgrade) it is the one whose command lines define UNITY_EDITOR,
    /// the newest written - the u2ue toolkit's bee_dag rule. The reader reads an assembly from its command line, so the graphs are of
    /// the code exactly as Unity compiled it.</summary>
    public sealed class CompileFolder
    {
        /// <summary>the folder, or null with the reason in Why</summary>
        public string Dir;
        public string Why = "";
        /// <summary>the assemblies that compile this project's own scripts (a source under Assets/), by name</summary>
        public readonly List<string> Assemblies = new List<string>();

        public string CommandLine(string assembly) => Path.Combine(Dir, assembly + ".rsp");

        public static CompileFolder Find(string projectRoot)
        {
            var found = new CompileFolder();
            var artifacts = Path.Combine(projectRoot, "Library", "Bee", "artifacts");
            if (!Directory.Exists(artifacts))
            {
                found.Why = "This project has no Library/Bee/artifacts, where Unity writes its compiler command lines when it compiles: let Unity compile the project, or this editor does not write them (measured on Unity 6000.3).";
                return found;
            }
            var newest = DateTime.MinValue;
            foreach (var dir in Directory.GetDirectories(artifacts, "*.dag"))
            {
                var lines = CommandLines(dir);
                if (lines.Count == 0) continue;
                // a player build's command lines do not define UNITY_EDITOR and the editor's all do, so one of them tells
                if (!File.ReadLines(lines[0]).Any(l => l.Trim() == "-define:UNITY_EDITOR")) continue;
                var written = lines.Max(f => File.GetLastWriteTimeUtc(f));
                if (written > newest)
                {
                    newest = written;
                    found.Dir = dir;
                }
            }
            if (found.Dir == null)
            {
                found.Why = "No compile folder of the editor under Library/Bee/artifacts (no command line defines UNITY_EDITOR): let Unity compile the project once.";
                return found;
            }
            foreach (var rsp in CommandLines(found.Dir))
                if (File.ReadLines(rsp).Any(l => l.Trim().TrimStart('"').StartsWith("Assets/", StringComparison.Ordinal)))
                    found.Assemblies.Add(Path.GetFileNameWithoutExtension(rsp));
            if (found.Assemblies.Count == 0)
                found.Why = "No command line in " + found.Dir + " compiles a script under Assets/.";
            return found;
        }

        // <assembly>.rsp; the <assembly>.dll.mvfrm.rsp beside each lists inputs for another build step, not a compile
        static List<string> CommandLines(string dir) =>
            Directory.GetFiles(dir, "*.rsp").Where(f => !f.EndsWith(".mvfrm.rsp", StringComparison.OrdinalIgnoreCase))
                     .OrderBy(f => f, StringComparer.Ordinal).ToList();
    }
}
