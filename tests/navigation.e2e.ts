import { test, expect, type Page } from "@playwright/test";
import type { State } from "../server/types";
test.use({ timezoneId: "Asia/Shanghai" });

async function openProject(page: Page, suffix: string, initialPage?: number) {
  const project = `navigation-${suffix}-${Date.now()}`;
  const response = await page.request.post("/api/projects", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { id: project },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto(`/?project=${project}${initialPage === undefined ? "" : `&page=${initialPage}`}`);
  return project;
}

async function fillBrand(page: Page) {
  await page.getByLabel("品牌名称", { exact: true }).fill("Navigation DEMO");
  await page.getByLabel("品牌网址", { exact: true }).fill("https://example.com");
  await page.getByLabel("产品名称").fill("Demo bottle");
  await page.getByLabel("产品参数").fill("Synthetic demonstration product only.");
  await page.getByLabel("目标受众", { exact: true }).fill("Demo audience");
}

test("home navigation survives reload and cancelled browser history after reload", async ({
  page,
}) => {
  await openProject(page, "history");
  await expect(page.getByRole("heading", { name: "今日工作台", exact: true })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "品牌档案" }).click();
  await expect(page).toHaveURL(/page=0/);
  await page.locator("nav").getByRole("button", { name: "市场动态" }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "市场动态", exact: true })).toBeVisible();
  await page.getByLabel("资料标题").fill("Keep this draft");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/page=1/);
  await expect(page.getByLabel("资料标题")).toHaveValue("Keep this draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.goBack();
  await expect(page).toHaveURL(/page=0/);
  await expect(page.getByRole("heading", { name: "品牌档案", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "市场动态", exact: true })).toBeVisible();
  await expect(page.getByLabel("资料标题")).toHaveValue("");
});

test("failed saves retain drafts, successful saves and reverted inputs remove protection", async ({
  page,
}) => {
  await openProject(page, "drafts", 0);
  await fillBrand(page);
  await page.route("**/api/brand?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary test failure" }),
    }),
  );
  await page.getByRole("button", { name: "保存品牌档案" }).click();
  await expect(page.getByText("Temporary test failure")).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("nav").getByRole("button", { name: "市场动态" }).click();
  await expect(page.getByLabel("品牌名称", { exact: true })).toHaveValue("Navigation DEMO");
  await page.unroute("**/api/brand?*");
  await page.getByRole("button", { name: "保存品牌档案" }).click();
  await expect(page.getByText("有未保存的修改，离开当前页面前请先保存。")).toHaveCount(0);
  await page.getByLabel("品牌名称", { exact: true }).fill("Changed draft");
  await page.getByLabel("品牌名称", { exact: true }).fill("Navigation DEMO");
  await expect(page.getByText("有未保存的修改，离开当前页面前请先保存。")).toHaveCount(0);
  await page.locator("nav").getByRole("button", { name: "市场动态" }).click();
  await expect(page.getByRole("heading", { name: "市场动态", exact: true })).toBeVisible();
});

test("workflow errors are recoverable and saving one form preserves other drafts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/workflows?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Workflow test failure" }),
    }),
  );
  await openProject(page, "workflow", 4);
  await expect(page.getByRole("alert")).toContainText("Workflow test failure");
  await page.unroute("**/api/workflows?*");
  await page.getByRole("button", { name: "重试加载运营流程" }).click();
  await page.getByLabel("来源名称").fill("Demo source");
  await page.getByLabel("来源地址").fill("https://example.com");
  await page.getByLabel("确认的品牌事实", { exact: true }).fill("Keep this unsaved fact");
  await page.getByRole("button", { name: "保存来源", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Demo source/ })).toBeVisible();
  await expect(page.getByText("有未保存的修改，离开当前页面前请先保存。")).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("nav").getByRole("button", { name: "今日工作台" }).click();
  await expect(page.getByLabel("确认的品牌事实", { exact: true })).toHaveValue(
    "Keep this unsaved fact",
  );
  await page.route("**/api/workflows?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Background test failure" }),
    }),
  );
  await expect(page.getByRole("alert")).toContainText("Background test failure", {
    timeout: 10000,
  });
  await expect(page.getByLabel("确认的品牌事实", { exact: true })).toHaveValue(
    "Keep this unsaved fact",
  );
  expect(errors).toEqual([]);
});

test("workflow tabs have shareable URLs and mobile navigation stays within the viewport", async ({
  page,
}) => {
  await openProject(page, "tabs", 4);
  await page.getByRole("button", { name: "渠道日历", exact: true }).click();
  await expect(page).toHaveURL(/section=calendar/);
  await page.reload();
  await expect(page.getByRole("button", { name: "渠道日历", exact: true })).toHaveClass(/selected/);
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(layout.content).toBeLessThanOrEqual(layout.viewport + 1);
});

test("targeted content preserves edits across another tab's revision and metrics preserve currency and local time", async ({
  page,
  context,
}) => {
  const project = await openProject(page, "content", 0);
  await fillBrand(page);
  await page.getByRole("button", { name: "保存品牌档案" }).click();
  await expect(page.getByText("有未保存的修改，离开当前页面前请先保存。")).toHaveCount(0);
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api/${path}?project=${project}`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data,
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const state = async (): Promise<State> =>
    (await page.request.get(`/api/state?project=${project}`)).json();
  await post("evidence", {
    title: "Synthetic navigation test",
    url: "https://example.com/source",
    publishedAt: "2026-01-01T00:00:00.000Z",
    text: "This synthetic example provides no actual customer research or commercial performance.",
    demo: true,
  });
  await post("tasks", { kind: "suggest" });
  await expect.poll(async () => (await state()).suggestions.length).toBe(3);
  const suggestions = (await state()).suggestions;
  await post("tasks", { kind: "content", payload: { suggestionId: suggestions[0].id } });
  await post("tasks", { kind: "content", payload: { suggestionId: suggestions[1].id } });
  await expect.poll(async () => (await state()).contents.length).toBe(2);
  const content = (await state()).contents[0];
  const url = `/?project=${project}&page=2&target=${content.id}`;
  await page.goto(url);
  await expect(page.getByLabel("选择内容", { exact: true })).toHaveValue(content.id);
  await page.getByLabel("可编辑文案").fill("My unsaved local draft.");
  const otherTab = await context.newPage();
  await otherTab.goto(url);
  await otherTab.getByLabel("可编辑文案").fill("A new revision saved in another tab.");
  await otherTab.getByRole("button", { name: "保存为新版本" }).click();
  await expect(otherTab.getByRole("button", { name: "批准当前版本 V2" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("服务器已有 V2", { timeout: 10000 });
  await expect(page.getByLabel("可编辑文案")).toHaveValue("My unsaved local draft.");
  await page.getByRole("button", { name: "保留我的修改，基于最新版本继续" }).click();
  await page.getByRole("button", { name: "保存为新版本" }).click();
  await expect(page.getByRole("button", { name: "批准当前版本 V3" })).toBeVisible();
  await expect(page.getByText("有未保存的修改，离开当前页面前请先保存。")).toHaveCount(0);
  await page.getByRole("button", { name: "批准当前版本 V3" }).click();
  await page.locator("nav").getByRole("button", { name: "效果记录" }).click();
  await page.getByLabel("发布链接", { exact: true }).fill("https://example.com/post");
  await page.getByLabel("统计窗口开始", { exact: true }).fill("2026-01-01T00:00");
  await page.getByLabel("统计窗口结束（不含）", { exact: true }).fill("2026-01-01T12:00");
  await page.getByLabel("采样时间", { exact: true }).fill("2026-01-01T12:00");
  await page.getByLabel("花费币种", { exact: true }).fill("CNY");
  await page.getByLabel("花费（CNY）", { exact: true }).fill("5");
  await page.getByRole("button", { name: "保存效果记录" }).click();
  await expect(page.getByRole("cell", { name: "5.00 CNY", exact: true })).toBeVisible();
  const metric = (await state()).metrics[0];
  expect(metric.currency).toBe("CNY");
  expect(metric.timezone).toBe("Asia/Shanghai");
  expect(metric.date).toBe("2026-01-01T04:00:00.000Z");
  await otherTab.close();
});
