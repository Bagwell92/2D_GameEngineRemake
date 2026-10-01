// PixelForge launcher.
// Serves the editor (the "app" folder next to this exe) on a private localhost port, provides a
// small file API so projects are saved as real files in Documents\PixelForge, and opens the editor
// in a chromeless Microsoft Edge "app" window. Exits a few seconds after that window closes.
//
// Built by build.ps1 with the C# compiler that ships with Windows (C# 5 syntax only).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.VisualBasic.FileIO;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("PixelForge")]
[assembly: System.Reflection.AssemblyDescription("PixelForge 2D game maker")]
[assembly: System.Reflection.AssemblyProduct("PixelForge")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

static class Program
{
    const int PreferredPort = 47821;

    static string WebRoot, DataDir, ProjectsDir, ExportsDir, BackupDir, AutosaveFile, LocalDir;
    static int Port;
    // Last time the editor page said it was still open. Starts in the future as a grace period.
    static long lastPingTicks = DateTime.UtcNow.AddSeconds(60).Ticks;

    static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" },
        { ".css", "text/css; charset=utf-8" }, { ".json", "application/json; charset=utf-8" },
        { ".png", "image/png" }, { ".ico", "image/x-icon" }, { ".svg", "image/svg+xml" },
        { ".woff2", "font/woff2" }, { ".txt", "text/plain; charset=utf-8" },
    };

    [STAThread]
    static void Main(string[] args)
    {
        try { Run(args); }
        catch (Exception ex)
        {
            MessageBox.Show("PixelForge could not start:\n\n" + ex.Message, "PixelForge", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static void Run(string[] args)
    {
        WebRoot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app"));
        if (!File.Exists(Path.Combine(WebRoot, "index.html")))
            throw new Exception("The 'app' folder is missing. Keep PixelForge.exe next to its app folder.\n\nLooked in: " + WebRoot);

        DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "PixelForge");
        ProjectsDir = Path.Combine(DataDir, "Projects");
        ExportsDir = Path.Combine(DataDir, "Exports");
        BackupDir = Path.Combine(ProjectsDir, ".backups");
        AutosaveFile = Path.Combine(DataDir, "autosave.json");
        LocalDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PixelForge");
        foreach (string d in new[] { ProjectsDir, ExportsDir, BackupDir, LocalDir }) Directory.CreateDirectory(d);
        try { File.SetAttributes(BackupDir, File.GetAttributes(BackupDir) | FileAttributes.Hidden); } catch { }

        bool noBrowser = args.Contains("--no-browser");
        int fixedPort = 0;
        foreach (string a in args) if (a.StartsWith("--port=")) int.TryParse(a.Substring(7), out fixedPort);

        string portFile = Path.Combine(LocalDir, "port.txt");
        bool firstInstance;
        using (var mutex = new Mutex(true, "PixelForge.Launcher.SingleInstance", out firstInstance))
        {
            if (!firstInstance)
            {
                // Already running: open another window onto the running server.
                int existing;
                if (File.Exists(portFile) && int.TryParse(File.ReadAllText(portFile).Trim(), out existing)) { OpenWindow(existing); return; }
                throw new Exception("PixelForge is already running.");
            }

            HttpListener listener = StartListener(fixedPort);
            File.WriteAllText(portFile, Port.ToString());
            var server = new Thread(() => Serve(listener));
            server.IsBackground = true;
            server.Start();

            if (noBrowser) { Thread.Sleep(Timeout.Infinite); }

            Process browser = OpenWindow(Port);
            // Keep serving while our window is open or any editor page keeps pinging.
            while (true)
            {
                Thread.Sleep(1000);
                bool alive = browser != null && !HasExited(browser);
                double sincePing = (DateTime.UtcNow - new DateTime(Interlocked.Read(ref lastPingTicks))).TotalSeconds;
                if ((!alive && sincePing > (browser == null ? 90 : 15)) || sincePing > 150) break;
            }
            listener.Stop();
        }
    }

    static bool HasExited(Process p)
    {
        try { return p.HasExited; } catch { return true; }
    }

    static HttpListener StartListener(int fixedPort)
    {
        int first = fixedPort > 0 ? fixedPort : PreferredPort, count = fixedPort > 0 ? 1 : 40;
        Exception last = null;
        for (int p = first; p < first + count; p++)
        {
            var l = new HttpListener();
            l.Prefixes.Add("http://localhost:" + p + "/");
            try { l.Start(); Port = p; return l; }
            catch (Exception ex) { last = ex; try { l.Close(); } catch { } }
        }
        throw new Exception("Could not open a local port for the editor. " + (last != null ? last.Message : ""));
    }

    // ---------- Browser window ----------
    static string FindBrowser()
    {
        foreach (string exe in new[] { "msedge.exe", "chrome.exe" })
            foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
                using (RegistryKey key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                {
                    string path = key == null ? null : key.GetValue("") as string;
                    if (!string.IsNullOrEmpty(path) && File.Exists(path)) return path;
                }
        string[] guesses =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
        };
        foreach (string g in guesses) if (File.Exists(g)) return g;
        return null;
    }

    // Opens the editor as its own app window (separate browser profile, no tabs or address bar).
    static Process OpenWindow(int port)
    {
        string url = "http://localhost:" + port + "/";
        string browser = FindBrowser();
        if (browser == null) { Process.Start(url); return null; }
        string profile = Path.Combine(LocalDir, "BrowserProfile");
        var psi = new ProcessStartInfo(browser,
            "--app=" + url + " --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check" +
            " --disable-features=Translate --window-size=1440,900");
        psi.UseShellExecute = false;
        return Process.Start(psi);
    }

    // ---------- HTTP ----------
    static void Serve(HttpListener listener)
    {
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); } catch { break; }
            ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
        }
    }

    static void Handle(HttpListenerContext ctx)
    {
        HttpListenerRequest req = ctx.Request;
        HttpListenerResponse res = ctx.Response;
        try
        {
            // Only answer requests for our own origin (guards against DNS-rebinding tricks).
            if ((req.Headers["Host"] ?? "") != "localhost:" + Port) { Send(res, 403, "text/plain", "Forbidden"); return; }
            string path = Uri.UnescapeDataString(req.Url.AbsolutePath);
            if (path.StartsWith("/api/"))
            {
                // Web pages from other sites can't send this header without our permission,
                // so only the editor itself can use the file API.
                if (req.Headers["X-PixelForge"] != "1") { Send(res, 403, "text/plain", "Forbidden"); return; }
                Api(req, res, path.Substring(5));
            }
            else ServeFile(res, path);
        }
        catch (Exception ex)
        {
            try { Send(res, 500, "text/plain; charset=utf-8", ex.Message); } catch { }
        }
    }

    static void ServeFile(HttpListenerResponse res, string path)
    {
        if (path == "/") path = "/index.html";
        string full = Path.GetFullPath(Path.Combine(WebRoot, path.TrimStart('/').Replace('/', '\\')));
        if (!full.StartsWith(WebRoot + "\\", StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
        {
            Send(res, 404, "text/plain", "Not found");
            return;
        }
        string type;
        if (!Types.TryGetValue(Path.GetExtension(full), out type)) type = "application/octet-stream";
        res.Headers["Cache-Control"] = "no-cache";
        SendBytes(res, 200, type, File.ReadAllBytes(full));
    }

    static void Api(HttpListenerRequest req, HttpListenerResponse res, string route)
    {
        string method = req.HttpMethod;
        switch (route)
        {
            case "ping":
                Interlocked.Exchange(ref lastPingTicks, DateTime.UtcNow.Ticks);
                Send(res, 200, "text/plain", "ok");
                return;

            case "info":
                Send(res, 200, "application/json", "{\"desktop\":true,\"version\":\"1.0\",\"projectsDir\":" + Json(ProjectsDir) +
                    ",\"exportsDir\":" + Json(ExportsDir) + "}");
                return;

            case "projects":
                Send(res, 200, "application/json; charset=utf-8", ListProjects());
                return;

            case "project":
            {
                string file = Path.Combine(ProjectsDir, SafeName(req.QueryString["file"], ".pixelforge"));
                if (method == "GET")
                {
                    if (!File.Exists(file)) { Send(res, 404, "text/plain", "Project not found"); return; }
                    SendBytes(res, 200, "text/plain; charset=utf-8", File.ReadAllBytes(file));
                    return;
                }
                if (method == "POST")
                {
                    string body = ReadBody(req);
                    if (File.Exists(file)) File.Copy(file, Path.Combine(BackupDir, Path.GetFileName(file) + ".bak"), true);
                    WriteAtomic(file, body);
                    Send(res, 200, "application/json", "{\"ok\":true}");
                    return;
                }
                if (method == "DELETE")
                {
                    if (File.Exists(file)) FileSystem.DeleteFile(file, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin);
                    Send(res, 200, "application/json", "{\"ok\":true}");
                    return;
                }
                break;
            }

            case "autosave":
                if (method == "GET")
                {
                    if (File.Exists(AutosaveFile)) SendBytes(res, 200, "application/json; charset=utf-8", File.ReadAllBytes(AutosaveFile));
                    else Send(res, 204, "text/plain", "");
                    return;
                }
                if (method == "POST") { WriteAtomic(AutosaveFile, ReadBody(req)); Send(res, 200, "application/json", "{\"ok\":true}"); return; }
                if (method == "DELETE") { if (File.Exists(AutosaveFile)) File.Delete(AutosaveFile); Send(res, 200, "application/json", "{\"ok\":true}"); return; }
                break;

            case "export":
                if (method == "POST")
                {
                    string path = Path.Combine(ExportsDir, SafeName(req.QueryString["file"], ".html"));
                    WriteAtomic(path, ReadBody(req));
                    Send(res, 200, "application/json; charset=utf-8", "{\"path\":" + Json(path) + "}");
                    return;
                }
                break;

            case "reveal":
            {
                string target = req.QueryString["target"] ?? "";
                if (target == "projects") Process.Start("explorer.exe", "\"" + ProjectsDir + "\"");
                else if (target == "exports") Process.Start("explorer.exe", "\"" + ExportsDir + "\"");
                else
                {
                    string full = Path.GetFullPath(target);
                    if (!full.StartsWith(DataDir + "\\", StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) { Send(res, 403, "text/plain", "Forbidden"); return; }
                    Process.Start("explorer.exe", "/select,\"" + full + "\"");
                }
                Send(res, 200, "application/json", "{\"ok\":true}");
                return;
            }
        }
        Send(res, 404, "text/plain", "Unknown API call");
    }

    // ---------- Files ----------
    // Accepts a bare file name only (no folders), and adds the extension if it's missing.
    static string SafeName(string name, string ext)
    {
        if (string.IsNullOrWhiteSpace(name)) throw new Exception("Missing file name");
        name = name.Trim();
        if (name != Path.GetFileName(name) || name.StartsWith(".") || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new Exception("Invalid file name: " + name);
        if (!name.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) name += ext;
        return name;
    }

    // Writes to a temporary file first, so a crash mid-save never leaves a half-written project.
    static void WriteAtomic(string path, string text)
    {
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        if (File.Exists(path))
        {
            try { File.Replace(tmp, path, null); return; }
            catch (IOException) { File.Copy(tmp, path, true); File.Delete(tmp); return; }
        }
        File.Move(tmp, path);
    }

    static string ReadBody(HttpListenerRequest req)
    {
        using (var r = new StreamReader(req.InputStream, Encoding.UTF8)) return r.ReadToEnd();
    }

    static string ListProjects()
    {
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (FileInfo f in new DirectoryInfo(ProjectsDir).GetFiles("*.pixelforge").OrderByDescending(x => x.LastWriteTimeUtc))
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"file\":").Append(Json(f.Name))
              .Append(",\"name\":").Append(Json(ReadProjectName(f.FullName) ?? Path.GetFileNameWithoutExtension(f.Name)))
              .Append(",\"modified\":").Append(Json(f.LastWriteTimeUtc.ToString("o")))
              .Append(",\"size\":").Append(f.Length).Append('}');
        }
        return sb.Append(']').ToString();
    }

    // The project's name is near the start of the file; read just enough to find it.
    static string ReadProjectName(string path)
    {
        try
        {
            char[] buf = new char[4096];
            int n;
            using (var r = new StreamReader(path, Encoding.UTF8)) n = r.Read(buf, 0, buf.Length);
            Match m = Regex.Match(new string(buf, 0, n), "\"name\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? Regex.Unescape(m.Groups[1].Value) : null;
        }
        catch { return null; }
    }

    static string Json(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }

    static void Send(HttpListenerResponse res, int code, string type, string text)
    {
        SendBytes(res, code, type, Encoding.UTF8.GetBytes(text));
    }

    static void SendBytes(HttpListenerResponse res, int code, string type, byte[] bytes)
    {
        res.StatusCode = code;
        res.ContentType = type;
        res.ContentLength64 = bytes.Length;
        if (bytes.Length > 0) res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }
}
