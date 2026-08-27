import { describe, expect, it } from "vitest";
import { OperationCoordinator, OperationInProgressError } from "../src/server/operation-coordinator";

describe("project operation coordination", () => {
  it("rejects a duplicate in-flight project operation and releases the key afterward", async () => {
    const coordinator = new OperationCoordinator();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.run("project-1", async () => {
      await barrier;
      return "first";
    });

    await expect(coordinator.run("project-1", async () => "duplicate")).rejects.toBeInstanceOf(OperationInProgressError);
    release();
    await expect(first).resolves.toBe("first");
    await expect(coordinator.run("project-1", async () => "next")).resolves.toBe("next");
  });

  it("does not block independent projects", async () => {
    const coordinator = new OperationCoordinator();
    await expect(Promise.all([
      coordinator.run("project-1", async () => 1),
      coordinator.run("project-2", async () => 2),
    ])).resolves.toEqual([1, 2]);
  });

  it("reports phase changes for a long-running operation and clears them afterward", async () => {
    const coordinator = new OperationCoordinator();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const running = coordinator.run("project-1", async () => {
      coordinator.update("project-1", { phase: "continuity", phaseLabel: "正在检查连续性" });
      await barrier;
    }, { operation: "storyboard.generate", phase: "storyboard", phaseLabel: "正在生成分镜草案" });

    expect(coordinator.get("project-1")).toMatchObject({
      operation: "storyboard.generate",
      phase: "continuity",
      phaseLabel: "正在检查连续性",
    });
    release();
    await running;
    expect(coordinator.get("project-1")).toBeNull();
  });
});
