import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local project recovery", () => {
  it("creates an immutable source and restores the project after restart", async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-video-studio-test-"));
    temporaryRoots.push(runtimeRoot);
    const firstApp = await createApp({ runtimeRoot, logger: false });
    const createResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        title: "恢复测试",
        sourceType: "story",
        sourceText: "一名旅人走进雨夜客栈。",
        targetDurationSec: 45,
        aspectRatio: "16:9",
        resolution: "1920x1080",
        videoType: "叙事短片",
        visualStyle: "冷灰电影感",
        releasePlatform: "本地验收",
        targetAudience: "成人观众",
        allowStorySuggestions: true,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().project;
    expect(await fs.readFile(created.sourcePath, "utf8")).toBe("一名旅人走进雨夜客栈。");
    await firstApp.close();

    const restartedApp = await createApp({ runtimeRoot, logger: false });
    const restoredResponse = await restartedApp.inject({ method: "GET", url: `/api/projects/${created.id}` });
    expect(restoredResponse.statusCode).toBe(200);
    expect(restoredResponse.json().project.currentStage).toBe("SOURCE_IMPORTED");
    await restartedApp.close();
  });

  it("archives a project without deleting its files and restores it after restart", async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-video-studio-archive-test-"));
    temporaryRoots.push(runtimeRoot);
    const firstApp = await createApp({ runtimeRoot, logger: false });
    const createResponse = await firstApp.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        title: "可恢复删除测试",
        sourceType: "story",
        sourceText: "这段原始内容在项目归档后仍须完整保留。",
        targetDurationSec: 30,
        aspectRatio: "16:9",
        resolution: "1920x1080",
        videoType: "叙事短片",
        visualStyle: "夜景电影感",
        releasePlatform: "本地验收",
        targetAudience: "成人观众",
        allowStorySuggestions: true,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().project;

    const archiveResponse = await firstApp.inject({ method: "DELETE", url: `/api/projects/${created.id}` });
    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().recoverable).toBe(true);
    expect(archiveResponse.json().project.archivedAt).toEqual(expect.any(String));
    expect(await fs.readFile(created.sourcePath, "utf8")).toBe("这段原始内容在项目归档后仍须完整保留。");
    expect((await firstApp.inject({ method: "GET", url: "/api/projects" })).json().projects).toHaveLength(0);
    expect((await firstApp.inject({ method: "GET", url: `/api/projects/${created.id}` })).statusCode).toBe(404);
    expect((await firstApp.inject({ method: "GET", url: `/api/projects/${created.id}/quality-center` })).statusCode).toBe(404);
    expect((await firstApp.inject({ method: "GET", url: "/api/projects/archived" })).json().projects[0].id).toBe(created.id);
    await firstApp.close();

    const restartedApp = await createApp({ runtimeRoot, logger: false });
    expect((await restartedApp.inject({ method: "GET", url: "/api/projects" })).json().projects).toHaveLength(0);
    expect((await restartedApp.inject({ method: "GET", url: "/api/projects/archived" })).json().projects[0].id).toBe(created.id);

    const restoreResponse = await restartedApp.inject({ method: "POST", url: `/api/projects/${created.id}/restore` });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().project.archivedAt).toBeNull();
    expect((await restartedApp.inject({ method: "GET", url: `/api/projects/${created.id}` })).statusCode).toBe(200);
    expect(await fs.readFile(created.sourcePath, "utf8")).toBe("这段原始内容在项目归档后仍须完整保留。");
    await restartedApp.close();
  });
});
