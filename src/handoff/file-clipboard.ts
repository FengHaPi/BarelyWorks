import { spawn } from "node:child_process";
import path from "node:path";

export interface FileClipboard {
  copyFiles(filePaths: string[]): Promise<void>;
}

const clipboardScript = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AI_VIDEO_STUDIO_CLIPBOARD_FILES_B64))",
  "$paths = ConvertFrom-Json -InputObject $json",
  "if ($paths.Count -eq 0) { throw 'No files were supplied.' }",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$files = [System.Collections.Specialized.StringCollection]::new()",
  "foreach ($item in $paths) {",
  "  $resolved = [IO.Path]::GetFullPath([string]$item)",
  "  if (-not [IO.File]::Exists($resolved)) { throw ('File does not exist: ' + $resolved) }",
  "  [void]$files.Add($resolved)",
  "}",
  "$clipboardWritten = $false",
  "for ($attempt = 1; $attempt -le 5; $attempt++) {",
  "  try { [Windows.Forms.Clipboard]::SetFileDropList($files); $clipboardWritten = $true; break }",
  "  catch { if ($attempt -eq 5) { throw }; Start-Sleep -Milliseconds (60 * $attempt) }",
  "}",
  "if (-not $clipboardWritten) { throw 'Clipboard write failed.' }",
  "$copied = [Windows.Forms.Clipboard]::GetFileDropList()",
  "if ($copied.Count -ne $files.Count) { throw 'Clipboard file verification failed.' }",
  "[Console]::Out.Write($copied.Count)",
].join("\n");

export class WindowsFileClipboard implements FileClipboard {
  async copyFiles(filePaths: string[]): Promise<void> {
    if (process.platform !== "win32") throw new Error("直接复制素材文件目前只支持 Windows");
    if (!filePaths.length) throw new Error("没有可复制的本地素材文件");
    const payload = Buffer.from(JSON.stringify(filePaths), "utf8").toString("base64");
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const powershellPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    await new Promise<void>((resolve, reject) => {
      const child = spawn(powershellPath, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        clipboardScript,
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AI_VIDEO_STUDIO_CLIPBOARD_FILES_B64: payload },
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("复制素材文件超时，请稍后重试"));
      }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`无法启动 Windows 文件剪贴板：${error.message}`));
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`复制素材文件失败${stderr.trim() ? `：${stderr.trim().slice(0, 500)}` : ""}`));
          return;
        }
        if (Number(stdout.trim()) !== filePaths.length) {
          reject(new Error("Windows 剪贴板返回的文件数量不一致"));
          return;
        }
        resolve();
      });
    });
  }
}
