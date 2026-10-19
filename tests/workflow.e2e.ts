import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
test("four-page workflow with persistence, revisions, retry and download", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/?page=0");
  await expect(page.getByRole("heading", { name: "品牌档案", exact: true })).toBeVisible();
  await page.getByLabel("品牌名称", { exact: true }).fill("North Coast · 演示品牌");
  await page.getByLabel("品牌网址", { exact: true }).fill("https://example.com");
  await page.getByLabel("产品名称").fill("Everyday bottle (DEMO)");
  await page.getByLabel("产品参数").fill("Demo-only specification: 500 ml. Not a real product.");
  await page.getByLabel("目标受众").fill("Urban commuters");
  await page.locator("input[type=file]").setInputFiles("fixtures/demo-product.png");
  await page.getByRole("button", { name: "保存品牌档案" }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await page.reload();
  await expect(page.getByLabel("品牌名称", { exact: true })).toHaveValue("North Coast · 演示品牌");
  mkdirSync("artifacts/screenshots", { recursive: true });
  await page.screenshot({
    path: "artifacts/screenshots/01-brand.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "市场动态" }).click();
  await page.getByLabel("来源 URL").fill("https://example.com");
  await page.getByLabel("资料发布时间").fill("2026-01-01T12:00");
  await page.getByLabel("资料标题").fill("演示资料 · 通勤内容测试");
  await page
    .getByLabel("公开原文")
    .fill(
      "This is a synthetic demonstration source for testing the workflow. It does not represent actual audience research.",
    );
  await page.getByLabel("这是测试").check();
  await page.getByRole("button", { name: "保存证据" }).click();
  await expect(page.getByRole("status")).toContainText("已导入");
  await page.getByRole("button", { name: "生成 3 条营销建议" }).click();
  await expect(page.getByRole("button", { name: "选择并生成内容" })).toHaveCount(3);
  await page.screenshot({
    path: "artifacts/screenshots/02-market.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "选择并生成内容" }).first().click();
  await expect(page.getByLabel("可编辑文案")).toBeVisible();
  await page.getByRole("button", { name: "批准当前版本 V1" }).click();
  await expect(page.getByRole("link", { name: "下载文案" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载文案" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("harbor-v1.json");
  await page
    .getByLabel("可编辑文案")
    .fill("Meet North Coast.\nReviewed copy for a demo product.\nLearn more at example.com");
  await expect(page.getByRole("link", { name: "下载文案" })).toHaveCount(0);
  const renderer = process.env.TEST_RENDERER === "remotion" ? "Remotion" : "HyperFrames";
  await page.getByLabel("视频渲染器").selectOption(renderer.toLowerCase());
  await page.getByRole("button", { name: "保存为新版本" }).click();
  await expect(page.getByRole("button", { name: "批准当前版本 V2" })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载文案" })).toHaveCount(0);
  await page.getByRole("button", { name: "批准当前版本 V2" }).click();
  await page.frameLocator("iframe").locator("h1").first().waitFor();
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "artifacts/screenshots/03-studio.png" });
  await page.getByRole("button", { name: `使用 ${renderer} 渲染 MP4` }).click();
  await expect(page.getByText("MP4 已生成并通过 ffprobe 时长校验", { exact: false })).toBeVisible({
    timeout: 240000,
  });
  const videoPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载 MP4 视频" }).click();
  const video = await videoPromise;
  expect(video.suggestedFilename()).toBe("harbor-v2.mp4");
  await video.saveAs(`artifacts/e2e-${renderer.toLowerCase()}-approved-video.mp4`);
  await expect(page.getByLabel("已渲染 MP4 预览")).toBeVisible();
  await expect
    .poll(async () => page.locator("video").evaluate((v: HTMLVideoElement) => v.duration))
    .toBe(30);
  await page.screenshot({
    path: `artifacts/screenshots/${renderer.toLowerCase()}-rendered.png`,
  });
  await page.locator("nav").getByRole("button", { name: "效果记录" }).click();
  await page.getByLabel("发布链接").fill("https://example.com/demo-post");
  await page.getByLabel("统计窗口开始", { exact: true }).fill("2026-01-02T00:00");
  await page.getByLabel("统计窗口结束（不含）", { exact: true }).fill("2026-01-02T12:00");
  await page.getByLabel("采样时间", { exact: true }).fill("2026-01-02T12:00");
  await page.getByLabel("曝光", { exact: true }).fill("1000");
  await page.getByLabel("点击", { exact: true }).fill("30");
  await page.getByLabel("观察与复盘").fill("演示测试数据，非实际发布效果。");
  await page.getByRole("button", { name: "保存效果记录" }).click();
  await expect(page.getByRole("cell", { name: "3.0%" })).toBeVisible();
  await page.reload();
  await page.locator("nav").getByRole("button", { name: "效果记录" }).click();
  await expect(page.getByRole("cell", { name: "3.0%" })).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/04-results.png",
    fullPage: true,
  });
  // Create deterministic failure via invalid suggestion; exercise visible retry action.
  await page.evaluate(async () => {
    await fetch("/api/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        kind: "content",
        payload: { suggestionId: "missing" },
      }),
    });
  });
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText(/尝试 2 次/)).toBeVisible();
});
