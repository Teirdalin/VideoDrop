using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("VideoDrop Setup")]
[assembly: AssemblyProduct("VideoDrop")]

internal static class Setup
{
    private const string Marker = ".videodrop-install";
    private const string MarkerContents = "VideoDrop Full installer";

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        Application.Run(new SetupWindow(Path.Combine(localData, "VideoDrop")));
    }

    internal static void StageExtension(string installRoot)
    {
        Directory.CreateDirectory(installRoot);
        if ((File.GetAttributes(installRoot) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Choose a Windows account whose VideoDrop folder is a regular directory.");

        // A Windows file lock also covers concurrent setup runs from other sessions.
        using (File.Open(Path.Combine(installRoot, ".setup-lock"), FileMode.OpenOrCreate,
                         FileAccess.ReadWrite, FileShare.None))
        {
            string destination = Path.Combine(installRoot, "Full");
            string previous = Path.Combine(installRoot, "Full.previous");
            VerifyOwnedFolder(destination);
            VerifyOwnedFolder(previous);
            if (Directory.Exists(previous))
            {
                if (Directory.Exists(destination)) Directory.Delete(previous, true);
                else Directory.Move(previous, destination);
            }

            string staging = Path.Combine(installRoot, "setup-" + Guid.NewGuid().ToString("N"));
            try
            {
                using (Stream payload = typeof(Setup).Assembly.GetManifestResourceStream("VideoDrop.zip"))
                {
                    if (payload == null) throw new InvalidDataException("This setup file has no extension package.");
                    using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                        archive.ExtractToDirectory(staging);
                }
                if (!File.Exists(Path.Combine(staging, "manifest.json")))
                    throw new InvalidDataException("The extension package is missing its manifest.");
                File.WriteAllText(Path.Combine(staging, Marker), MarkerContents);

                if (Directory.Exists(destination)) Directory.Move(destination, previous);
                try
                {
                    Directory.Move(staging, destination);
                }
                catch
                {
                    if (Directory.Exists(previous)) Directory.Move(previous, destination);
                    throw;
                }
            }
            finally
            {
                RemoveTemporaryFolder(staging);
            }
            RemoveTemporaryFolder(previous);
        }
    }

    private static void VerifyOwnedFolder(string folder)
    {
        if (!Directory.Exists(folder)) return;
        string marker = Path.Combine(folder, Marker);
        if ((File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0 ||
            !File.Exists(marker) || File.ReadAllText(marker) != MarkerContents)
            throw new IOException("Setup cannot replace this existing folder: " + folder);
    }

    private static void RemoveTemporaryFolder(string folder)
    {
        try { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    internal static string FindChrome()
    {
        const string registration = @"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe";
        foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using (RegistryKey key = hive.OpenSubKey(registration))
            {
                string executable = key == null ? null : key.GetValue(null) as string;
                if (File.Exists(executable)) return executable;
            }
        }

        foreach (var folder in new[] { Environment.SpecialFolder.LocalApplicationData,
                                       Environment.SpecialFolder.ProgramFiles,
                                       Environment.SpecialFolder.ProgramFilesX86 })
        {
            string baseFolder = Environment.GetFolderPath(folder);
            if (String.IsNullOrEmpty(baseFolder)) continue;
            string executable = Path.Combine(baseFolder, @"Google\Chrome\Application\chrome.exe");
            if (File.Exists(executable)) return executable;
        }
        return null;
    }
}

internal sealed class SetupWindow : Form
{
    private readonly string installRoot;
    private readonly Label instructions;
    private readonly Label status;
    private readonly TextBox folder;
    private readonly Button primary;
    private readonly Button copy;
    private bool staged;

    internal SetupWindow(string installRoot)
    {
        this.installRoot = installRoot;
        Text = "VideoDrop Setup";
        Font = new Font("Segoe UI", 10F);
        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(545, 276);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;

        var title = new Label { Text = "VideoDrop for Chrome", AutoSize = true,
            Font = new Font(Font.FontFamily, 17F, FontStyle.Bold), Location = new Point(20, 17) };
        instructions = new Label { Location = new Point(22, 62), Size = new Size(500, 66),
            Text = "Set up VideoDrop with YouTube downloads and MP3 conversion. Setup copies the files and opens Chrome. Chrome then asks you to load the extension." };
        folder = new TextBox { Location = new Point(22, 137), Size = new Size(500, 27),
            ReadOnly = true, Text = Path.Combine(installRoot, "Full"), AccessibleName = "VideoDrop extension folder" };
        status = new Label { Location = new Point(22, 174), Size = new Size(500, 45) };
        copy = new Button { Text = "Copy folder", Location = new Point(22, 226), Size = new Size(115, 32), Enabled = false };
        primary = new Button { Text = "Set up VideoDrop", Location = new Point(232, 226), Size = new Size(174, 32) };
        var close = new Button { Text = "Close", Location = new Point(414, 226), Size = new Size(108, 32), DialogResult = DialogResult.Cancel };

        copy.Click += delegate
        {
            try { Clipboard.SetText(folder.Text); status.Text = "Folder path copied."; }
            catch (ExternalException) { status.Text = "Select the path and press Ctrl+C to copy it."; }
        };
        primary.Click += delegate { ContinueSetup(); };
        Controls.AddRange(new Control[] { title, instructions, folder, status, copy, primary, close });
        AcceptButton = primary;
        CancelButton = close;
    }

    private void ContinueSetup()
    {
        try
        {
            if (!staged)
            {
                Setup.StageExtension(installRoot);
                staged = true;
                instructions.Text = "In Chrome, turn on Developer mode, choose Load unpacked, and select the folder below. If you already loaded this folder, click Reload on the VideoDrop card.";
                copy.Enabled = true;
                primary.Text = "Open Chrome";
            }

            string chrome = Setup.FindChrome();
            if (chrome == null)
            {
                status.Text = "Files are ready. Install Chrome, then open chrome://extensions.";
                return;
            }

            using (Process.Start(new ProcessStartInfo(chrome, "chrome://extensions") { UseShellExecute = false })) { }
            status.Text = "Files are ready. Finish setup in Chrome.";
        }
        catch (Exception error)
        {
            if (!(error is IOException || error is UnauthorizedAccessException ||
                  error is InvalidDataException || error is Win32Exception)) throw;
            string heading = staged ? "Open chrome://extensions to finish setup." : "VideoDrop setup could not copy the extension.";
            MessageBox.Show(this, heading + "\n\n" + error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
