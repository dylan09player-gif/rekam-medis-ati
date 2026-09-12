using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

namespace KlinikNafila
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            Directory.SetCurrentDirectory(appDir);

            string configFile = Path.Combine(appDir, "config.json");
            string vpsUrl = "https://greatest-reverse-joke-turned.trycloudflare.com";
            string mode = "auto"; // "vps", "offline", or "auto"

            if (File.Exists(configFile))
            {
                try
                {
                    string json = File.ReadAllText(configFile);
                    if (json.Contains("\"mode\": \"vps\"") || json.Contains("\"mode\":\"vps\"")) mode = "vps";
                    else if (json.Contains("\"mode\": \"offline\"") || json.Contains("\"mode\":\"offline\"")) mode = "offline";
                    else mode = "auto";

                    int vpsIdx = json.IndexOf("\"vps_url\"");
                    if (vpsIdx >= 0)
                    {
                        int start = json.IndexOf("\"", vpsIdx + 9);
                        int end = json.IndexOf("\"", start + 1);
                        if (start > 0 && end > start)
                        {
                            vpsUrl = json.Substring(start + 1, end - start - 1).Trim();
                        }
                    }
                }
                catch { }
            }

            // Cek apakah konek ke VPS
            bool connectVps = false;
            if (mode == "vps")
            {
                connectVps = true;
            }
            else if (mode == "auto")
            {
                connectVps = CheckVpsAvailable(vpsUrl);
            }

            if (connectVps && !string.IsNullOrEmpty(vpsUrl))
            {
                LaunchAppWindow(vpsUrl);
                return;
            }

            // Jika mode offline atau VPS tidak terjangkau (tanpa internet di pabrik)
            bool isRunning = IsPortInUse(3000);
            if (!isRunning)
            {
                string nodePath = FindNodePath();
                if (string.IsNullOrEmpty(nodePath))
                {
                    MessageBox.Show(
                        "Runtime Node.js tidak ditemukan di komputer ini.\nSilakan instal Node.js terlebih dahulu agar aplikasi dapat berjalan offline.",
                        "Klinik Nafila Medika - Peringatan",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                    return;
                }

                string serverScript = Path.Combine(appDir, "server.js");
                if (!File.Exists(serverScript))
                {
                    MessageBox.Show("File server.js tidak ditemukan di direktori:\n" + appDir, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodePath;
                psi.Arguments = "\"" + serverScript + "\"";
                psi.WorkingDirectory = appDir;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;

                try
                {
                    Process.Start(psi);
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Gagal memulai server offline:\n" + ex.Message, "Klinik Nafila Medika", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                for (int i = 0; i < 30; i++)
                {
                    Thread.Sleep(500);
                    if (IsPortInUse(3000)) break;
                }
            }

            LaunchAppWindow("http://localhost:3000");
        }

        static bool CheckVpsAvailable(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 2500;
                req.Method = "HEAD";
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return ((int)resp.StatusCode >= 200 && (int)resp.StatusCode < 400);
                }
            }
            catch
            {
                return false;
            }
        }

        static bool IsPortInUse(int port)
        {
            try
            {
                using (TcpClient tcp = new TcpClient())
                {
                    IAsyncResult ar = tcp.BeginConnect("127.0.0.1", port, null, null);
                    bool success = ar.AsyncWaitHandle.WaitOne(400);
                    if (success && tcp.Connected)
                    {
                        tcp.EndConnect(ar);
                        return true;
                    }
                }
            }
            catch { }
            return false;
        }

        static string FindNodePath()
        {
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string localNode = Path.Combine(appDir, "node.exe");
            if (File.Exists(localNode)) return localNode;

            string[] paths = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
            foreach (string p in paths)
            {
                try
                {
                    if (string.IsNullOrWhiteSpace(p)) continue;
                    string cand = Path.Combine(p.Trim(), "node.exe");
                    if (File.Exists(cand)) return cand;
                }
                catch { }
            }

            string[] defaults = new string[] {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\node\node.exe")
            };
            foreach (string d in defaults)
            {
                if (File.Exists(d)) return d;
            }
            return null;
        }

        static void LaunchAppWindow(string url)
        {
            string edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe");
            if (!File.Exists(edge))
            {
                edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe");
            }

            string chrome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe");
            if (!File.Exists(chrome))
            {
                chrome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe");
            }

            try
            {
                if (File.Exists(edge))
                {
                    Process.Start(new ProcessStartInfo(edge, "--app=\"" + url + "\""));
                }
                else if (File.Exists(chrome))
                {
                    Process.Start(new ProcessStartInfo(chrome, "--app=\"" + url + "\""));
                }
                else
                {
                    Process.Start(new ProcessStartInfo(url));
                }
            }
            catch
            {
                Process.Start(new ProcessStartInfo(url));
            }
        }
    }
}
