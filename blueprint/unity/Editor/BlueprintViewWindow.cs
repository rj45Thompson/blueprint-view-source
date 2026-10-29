using System;
using System.IO;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace U2ue.BlueprintView.Editor
{
    /// <summary>Window &gt; u2ue &gt; Blueprint View. Pick one of this project's assemblies: the reader reads it the way Unity compiled it
    /// (CompileFolder, GraphReader) and the page draws every method as a Blueprint-style node graph, with its C#, C++ and pseudo-code
    /// beside it, in the browser (GraphPage). Nothing in the project is changed: the reader and what it writes live under
    /// Library/U2ueBlueprintView.</summary>
    public sealed class BlueprintViewWindow : EditorWindow
    {
        [MenuItem("Window/u2ue/Blueprint View")]
        public static void Open() => GetWindow<BlueprintViewWindow>("Blueprint View");

        CompileFolder folder;
        int pick;
        GraphReader reading;
        string status = "", lastPage = "";
        bool stale;
        Vector2 scroll;

        static string ProjectRoot => Path.GetDirectoryName(Application.dataPath);

        void OnEnable() => Find();

        void Find()
        {
            folder = CompileFolder.Find(ProjectRoot);
            pick = Mathf.Max(0, folder.Assemblies.IndexOf("Assembly-CSharp"));
        }

        /// <summary>the package's folder, wherever it was imported: two up from this script (&lt;package&gt;/Editor/BlueprintViewWindow.cs)</summary>
        string PackageRoot()
        {
            var script = AssetDatabase.GetAssetPath(MonoScript.FromScriptableObject(this));
            return Path.GetFullPath(Path.Combine(ProjectRoot, Path.GetDirectoryName(Path.GetDirectoryName(script))));
        }

        void OnGUI()
        {
            EditorGUILayout.LabelField("This project's C# as Blueprint-style node graphs", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Read the way Unity compiled it, drawn in your browser. Nothing in the project changes.",
                                       EditorStyles.wordWrappedMiniLabel);
            EditorGUILayout.Space();
            if (folder == null || folder.Dir == null || folder.Assemblies.Count == 0)
            {
                EditorGUILayout.HelpBox(folder == null ? "Not looked yet." : folder.Why, MessageType.Warning);
                if (GUILayout.Button("Look again")) Find();
                return;
            }
            pick = EditorGUILayout.Popup("Assembly", Mathf.Clamp(pick, 0, folder.Assemblies.Count - 1), folder.Assemblies.ToArray());
            if (EditorApplication.isCompiling)
                EditorGUILayout.HelpBox("Unity is compiling, which rewrites the command lines the reader reads. Read when it is done.", MessageType.Info);
            using (new EditorGUI.DisabledScope(reading != null || EditorApplication.isCompiling))
            {
                if (GUILayout.Button(reading != null ? "Reading..." : "Read and open", GUILayout.Height(28))) Read();
                if (stale && GUILayout.Button("Recompile, then read again"))
                {
                    stale = false;
                    AssetDatabase.Refresh();
                    CompilationPipeline.RequestScriptCompilation();
                }
            }
            if (lastPage.Length > 0 && File.Exists(lastPage) && GUILayout.Button("Open the last page")) Application.OpenURL(Url(lastPage));
            if (status.Length == 0) return;
            EditorGUILayout.Space();
            scroll = EditorGUILayout.BeginScrollView(scroll);
            var height = EditorStyles.wordWrappedLabel.CalcHeight(new GUIContent(status), position.width - 24);
            EditorGUILayout.SelectableLabel(status, EditorStyles.wordWrappedLabel, GUILayout.Height(height));
            EditorGUILayout.EndScrollView();
        }

        void Read()
        {
            var assembly = folder.Assemblies[pick];
            stale = false;
            reading = GraphReader.Start(PackageRoot(), ProjectRoot, folder.CommandLine(assembly), assembly, out var refused);
            status = refused ?? "Reading " + assembly + " from " + folder.CommandLine(assembly) + " ...";
        }

        void Update()
        {
            if (reading == null || !reading.Done) return;
            var r = reading;
            reading = null;
            r.WaitForExit();       // the last output lines arrive after the exit is seen
            var log = r.Log.Trim();
            if (r.ExitCode != 0)
            {
                // a command line older than the project: Unity has not compiled a script written since, and a recompile fixes it
                stale = log.Contains("older than the project");
                status = "REFUSED (the reader exited " + r.ExitCode + "):\n" + log;
                Repaint();
                return;
            }
            try
            {
                var template = Path.Combine(PackageRoot(), "WebView", "BlueprintView.html");
                var source = Application.productName + ": " + r.Assembly + " as Unity compiled it (" + Path.GetFileName(folder.Dir) + "/" + r.Assembly + ".rsp)";
                var page = Path.Combine(ProjectRoot, "Library", "U2ueBlueprintView", r.Assembly + ".html");
                lastPage = GraphPage.Write(template, r.Output, r.Assembly, source, page, out var files);
                status = log + "\n\nThe page: " + lastPage + " (" + files + " graph files inside it)";
                Application.OpenURL(Url(lastPage));
            }
            catch (Exception e) when (e is IOException || e is InvalidOperationException || e is UnauthorizedAccessException)
            {
                status = "The graphs were read, but the page was not written: " + e.Message + "\n\n" + log;
            }
            Repaint();
        }

        static string Url(string path) => new Uri(path).AbsoluteUri;
    }
}
