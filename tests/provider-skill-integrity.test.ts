import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderSkillRegistry } from "../src/skills/provider-skill-registry";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("provider Skill integrity lock", () => {
  it("rejects a modified provider Skill whose content no longer matches the lock", async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "provider-skill-lock-"));
    temporaryRoots.push(runtimeRoot);
    await fs.cp(path.resolve("provider-skills"), path.join(runtimeRoot, "provider-skills"), { recursive: true });
    const skillPath = path.join(runtimeRoot, "provider-skills", "updream-handoff", "SKILL.md");
    await fs.appendFile(skillPath, "\nlocal tamper test\n", "utf8");
    await expect(new ProviderSkillRegistry(runtimeRoot).load("updream-handoff")).rejects.toThrow(/锁文件不一致/);
  });
});
