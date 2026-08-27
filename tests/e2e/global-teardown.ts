import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export default async function globalTeardown() {
  const temporaryParent = path.resolve(os.tmpdir());
  const runtimeRoot = path.resolve(path.join(os.tmpdir(), "ai-video-studio-agent-first-e2e"));
  if (!runtimeRoot.startsWith(`${temporaryParent}${path.sep}`)) throw new Error("拒绝清理系统临时目录之外的 E2E 路径");
  await fetch("http://127.0.0.1:4328/__e2e/shutdown", { method: "POST" }).catch(() => undefined);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
