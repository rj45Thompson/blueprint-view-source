using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

namespace U2ue.BlueprintView.Editor
{
    /// <summary>The reader - U2ue.CodeGraph, a .NET program built on Roslyn - run over one assembly's command line. It ships in the
    /// package as Reader/*.bytes, so that Unity never tries to load a .NET 8 assembly into its own runtime, and runs from
    /// Library/U2ueBlueprintView/reader as `dotnet U2ue.CodeGraph.dll graph --measure &lt;project&gt; --rsp &lt;command line&gt; --out
    /// &lt;graphs&gt;`. It refuses rather than guesses: a command line older than the project, or an assembly that does not compile as
    /// written, ends with the reason, and the window shows it.</summary>
    public sealed class GraphReader
    {
        public readonly string Assembly, Output;
        readonly Process process;
        readonly StringBuilder log = new StringBuilder();

        GraphReader(string assembly, string output, Process process)
        {
            Assembly = assembly;
            Output = output;
            this.process = process;
        }

        public bool Done => process.HasExited;
        public int ExitCode => process.ExitCode;
        public string Log { get { lock (log) return log.ToString(); } }

        /// <summary>dotnet as a shell would find it - DOTNET_ROOT, then PATH - then in the installers' own folders, since an editor
        /// started from the Hub or the Dock does not get a shell's PATH; null with the reason in `why`</summary>
        public static string FindDotnet(out string why)
        {
            why = null;
            var exe = Path.DirectorySeparatorChar == '\\' ? "dotnet.exe" : "dotnet";
            var dirs = new List<string> { Environment.GetEnvironmentVariable("DOTNET_ROOT") };
            dirs.AddRange((Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator));
            dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet"));
            dirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dotnet"));
            dirs.AddRange(new[] { "/usr/local/share/dotnet", "/opt/homebrew/bin", "/usr/share/dotnet", "/usr/lib/dotnet", "/usr/bin" });
            foreach (var d in dirs)
            {
                if (string.IsNullOrEmpty(d)) continue;
                var p = Path.Combine(d.Trim().Trim('"'), exe);
                if (File.Exists(p)) return p;
            }
            why = "dotnet was not found (DOTNET_ROOT, PATH, or the installers' folders). Install the .NET 8 runtime or newer: https://dotnet.microsoft.com/download";
            return null;
        }

        /// <summary>the reader started on `commandLine`; null with the reason in `refused` when it cannot start</summary>
        public static GraphReader Start(string packageRoot, string projectRoot, string commandLine, string assembly, out string refused)
        {
            refused = null;
            var dotnet = FindDotnet(out var why);
            if (dotnet == null)
            {
                refused = why;
                return null;
            }
            var shipped = Path.Combine(packageRoot, "Reader");
            var bytes = Directory.Exists(shipped) ? Directory.GetFiles(shipped, "*.bytes") : new string[0];
            if (!bytes.Any(f => Path.GetFileName(f) == "U2ue.CodeGraph.dll.bytes"))
            {
                refused = "The reader is not in the package: no U2ue.CodeGraph.dll.bytes in " + shipped;
                return null;
            }
            var work = Path.Combine(projectRoot, "Library", "U2ueBlueprintView");
            var lib = Path.Combine(work, "reader");
            Directory.CreateDirectory(lib);
            foreach (var f in bytes)
                File.Copy(f, Path.Combine(lib, Path.GetFileNameWithoutExtension(f)), true);
            var output = Path.Combine(work, "graphs", assembly);
            if (Directory.Exists(output)) Directory.Delete(output, true);
            var args = Args(Path.Combine(lib, "U2ue.CodeGraph.dll"), "graph", "--measure", projectRoot, "--rsp", commandLine, "--out", output);
            var p = new Process
            {
                StartInfo = new ProcessStartInfo(dotnet, args)
                {
                    UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true,
                    WorkingDirectory = projectRoot,
                },
            };
            var reader = new GraphReader(assembly, output, p);
            p.OutputDataReceived += (s, e) => reader.Add(e.Data);
            p.ErrorDataReceived += (s, e) => reader.Add(e.Data);
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return reader;
        }

        void Add(string line)
        {
            if (line == null) return;
            lock (log) log.AppendLine(line);
        }

        public void WaitForExit() => process.WaitForExit();

        static string Args(params string[] a) => string.Join(" ", a.Select(Quote));

        static string Quote(string s) => s.Length > 0 && s.IndexOfAny(new[] { ' ', '"', '\t' }) < 0 ? s : "\"" + s.Replace("\"", "\\\"") + "\"";
    }
}
