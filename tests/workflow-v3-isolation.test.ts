import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow-v3 isolation boundary", () => {
  it("does not import or call legacy repair/state-machine/database services", async () => {
    const root = path.resolve("src/workflow-v3");
    const files = (await fs.readdir(root)).filter((name) => name.endsWith(".ts"));
    const forbidden = [
      "project-service",
      "revision-service",
      "approval-service",
      "operation-runner",
      "continuity-repair",
      "database/",
      "artifact-repository",
      "production-operation-service",
      "studio.sqlite",
      "project_heads",
      "current_stage",
      "stale_stages",
    ];
    for (const file of files) {
      const source = await fs.readFile(path.join(root, file), "utf8");
      for (const token of forbidden) expect(source, `${file} contains ${token}`).not.toContain(token);
      expect(source, `${file} exposes old repair provider`).not.toMatch(/\.repair(?:ShootingScript|Storyboard)\s*\(/u);
      expect(source, `${file} calls old model verification`).not.toContain(".reviewContinuity(");
    }
  });

  it("keeps the live test opt-in and binds it to CodexCliProvider", async () => {
    const defaultConfig = await fs.readFile(path.resolve("vitest.config.ts"), "utf8");
    const liveConfig = await fs.readFile(path.resolve("vitest.workflow-v3-live.config.ts"), "utf8");
    const liveTest = await fs.readFile(path.resolve("tests/workflow-v3-minimal-chain-001.live.test.ts"), "utf8");
    const liveProvider = await fs.readFile(path.resolve("src/workflow-v3/live-provider.ts"), "utf8");

    expect(defaultConfig).toContain('exclude: ["tests/**/*.live.test.ts"]');
    expect(liveConfig).toContain('include: ["tests/workflow-v3-minimal-chain-001.live.test.ts"]');
    expect(liveTest).toContain('process.env.WORKFLOW_V3_LIVE === "1"');
    expect(liveTest).not.toMatch(/\b(?:mock|stub|fixture|test-double|spyOn|vi\.mock|jest\.mock)\b/iu);
    expect(liveProvider).toContain("new CodexCliProvider(");
    expect(liveProvider).not.toContain("TextIntelligenceProvider");
  });

  it("keeps production candidate generation separate from explicit human decision and Adoption", async () => {
    const candidateChain = await fs.readFile(path.resolve("src/workflow-v3/minimal-chain.ts"), "utf8");
    const humanAdoption = await fs.readFile(path.resolve("src/workflow-v3/human-adoption.ts"), "utf8");

    expect(candidateChain).not.toContain("recordHumanDecision(");
    expect(candidateChain).not.toContain("adoptArtifact(");
    expect(humanAdoption).not.toContain("CodexCliProvider");
    expect(humanAdoption).not.toMatch(/generate(?:Outline|Screenplay|AssetBible|ShootingScript|Storyboard)\s*\(/u);
  });
});
