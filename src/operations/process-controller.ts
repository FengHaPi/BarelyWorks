import { spawn } from "node:child_process";

export interface ProcessController {
  terminateTree(processId: number): Promise<void>;
}

export class NativeProcessController implements ProcessController {
  async terminateTree(processId: number): Promise<void> {
    if (!Number.isInteger(processId) || processId <= 0) return;
    if (process.platform !== "win32") {
      try { process.kill(-processId, "SIGTERM"); } catch { try { process.kill(processId, "SIGTERM"); } catch { return; } }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("taskkill", ["/PID", String(processId), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 || code === 128 ? resolve() : reject(new Error(`taskkill 退出码 ${code ?? "unknown"}`)));
    });
  }
}
