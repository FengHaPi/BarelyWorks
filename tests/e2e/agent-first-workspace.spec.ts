import { expect, test } from "@playwright/test";
import { createReferencePng } from "../fixtures/reference-image";

test("旧版本、历史快照、失败停止、刷新恢复与取消均在 Agent-first 工作区成立", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Playwright Agent-first 项目/ }).click();

  await expect(page.getByRole("heading", { name: "V002" })).toBeVisible();
  await page.getByPlaceholder("输入问题").fill("这不是固定回答吧？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("真实项目 Agent 已排队", { exact: false })).toBeVisible();
  await expect(page.getByText("真实 Agent 测试回答：这不是固定回答吧？", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: /个待处理问题/ }).click();
  const issueCenter = page.getByRole("dialog", { name: "问题中心" });
  await expect(issueCenter).toBeVisible();
  await expect(issueCenter.getByRole("button", { name: "标记已处理" }).first()).toBeVisible();
  await expect(issueCenter.getByRole("button", { name: "记录理由并忽略" }).first()).toBeDisabled();
  await expect(issueCenter.getByText("问题只作用于对应内容")).toBeVisible();
  await expect(issueCenter.getByRole("button", { name: "创建结构化修复版本" })).toHaveCount(0);
  await expect(issueCenter.getByRole("textbox", { name: /处理说明/ }).first()).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(issueCenter.getByRole("button", { name: "关闭问题中心" })).toHaveCSS("color", "rgb(28, 29, 26)");
  await issueCenter.getByRole("button", { name: "关闭问题中心" }).click();

  await page.route("**/api/projects/*/artifacts/*/decisions", (route) => route.fulfill({
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ error: "测试门禁未通过，当前版本没有被批准" }),
  }));
  await page.getByRole("button", { name: "批准此版本" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "测试门禁未通过，当前版本没有被批准" })).toBeVisible();
  await page.unroute("**/api/projects/*/artifacts/*/decisions");

  await page.getByRole("button", { name: /影视剧本 V002/ }).click();
  await expect(page.getByRole("heading", { name: "V002" })).toBeVisible();

  await page.getByRole("button", { name: /资产定义/ }).click();
  await expect(page.getByRole("heading", { name: "参考图片" })).toBeVisible();
  await page.getByRole("checkbox", { name: /我确认拥有这些图片的使用权/ }).check();
  await page.getByLabel(/新增图片/).setInputFiles({ name: "character.png", mimeType: "image/png", buffer: createReferencePng(128, 128) });
  await expect(page.getByText("测试角色 已新增一张主参考")).toBeVisible();
  await expect(page.getByRole("img", { name: /测试角色 主参考/ })).toBeVisible();
  await page.getByLabel("替换").setInputFiles({ name: "character-replacement.png", mimeType: "image/png", buffer: createReferencePng(144, 144) });
  await expect(page.getByText(/旧文件已归档/)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "移除" }).click();
  await expect(page.getByText(/历史文件已归档/)).toBeVisible();

  await page.getByRole("button", { name: /镜头与视频/ }).click();
  await expect(page.getByText("批准后从这里继续")).toBeVisible();
  await expect(page.getByRole("button", { name: /准备素材清单/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "3. 扫描并导入视频" })).toBeVisible();

  await page.getByRole("button", { name: /影视剧本 V002/ }).click();
  await page.getByRole("button", { name: /V001 历史版本/ }).click();
  await expect(page.getByRole("heading", { name: "V001" })).toBeVisible();
  await page.getByRole("button", { name: /V002 当前 Head/ }).click();
  await page.getByRole("button", { name: "与上一版对比" }).click();
  await expect(page.getByText("V001", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: /剪辑与交付 1 个历史结果/ }).click();
  await expect(page.getByText("旧结果不会被删除，也不会冒充当前结果")).toBeVisible();
  await expect(page.getByText("无法完整证明输入关系，不作为当前完成证据")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "剪辑与交付" })).toBeVisible();

  await page.getByRole("button", { name: /影视剧本 V002/ }).click();
  await page.getByRole("button", { name: /V001 历史版本/ }).click();
  await page.getByRole("button", { name: "修改" }).click();
  await page.getByPlaceholder(/只改第三场对白/).fill("从历史 V1 创建 V3，不改变 Head");
  await page.getByRole("button", { name: "创建修订作业" }).click();
  await expect(page.getByText("已创建新版本；Head 未改变")).toBeVisible();
  await expect(page.getByRole("button", { name: /V003 历史版本/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /V001 历史版本/ })).toBeVisible();

  await page.getByRole("button", { name: /V002 当前 Head/ }).click();
  await page.getByPlaceholder(/只改第三场对白/).fill("[fail] 模拟 Provider 超时");
  await page.getByRole("button", { name: "创建修订作业" }).click();
  await expect(page.getByText("失败", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/注入的 Provider 失败/)).toBeVisible();
  await expect(page.getByRole("button", { name: /V004/ })).toHaveCount(0);

  await page.getByPlaceholder(/只改第三场对白/).fill("[hang] 刷新后取消长任务");
  await page.getByRole("button", { name: "创建修订作业" }).click();
  await expect(page.getByText("运行中", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("运行中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消作业" }).click();
  await expect(page.getByText("已取消", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /V004/ })).toHaveCount(0);
});
