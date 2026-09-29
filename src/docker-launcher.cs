using System;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;

public class DockerLauncher {
  // Windows CRT quoting; argv is forwarded without cmd.exe or string evaluation.
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); }
      else { result.Append('\\', slashes); result.Append(ch); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"');
    return result.ToString();
  }
  public static int Main(string[] args) {
    try {
      var node = Environment.GetEnvironmentVariable("DSH_SERVICE_NODE");
      var proxy = Environment.GetEnvironmentVariable("DSH_SERVICE_DOCKER_PROXY");
      if (String.IsNullOrEmpty(node) || String.IsNullOrEmpty(proxy)) return 127;
      var command = new StringBuilder(Quote(proxy));
      foreach (var arg in args) command.Append(" ").Append(Quote(arg));
      var info = new ProcessStartInfo(node, command.ToString());
      info.UseShellExecute = false;
      info.CreateNoWindow = true;
      info.RedirectStandardInput = true;
      info.RedirectStandardOutput = true;
      info.RedirectStandardError = true;
      using (var process = Process.Start(info)) {
        var output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        var error = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        Task.Run(async () => {
          try { await Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream); process.StandardInput.Close(); }
          catch (System.IO.IOException) {} catch (ObjectDisposedException) {} catch (InvalidOperationException) {}
        });
        process.WaitForExit();
        Task.WaitAll(output, error);
        return process.ExitCode;
      }
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 127; }
  }
}
