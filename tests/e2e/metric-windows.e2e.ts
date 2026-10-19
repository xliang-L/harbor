import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { State } from "../../server/types";

test.use({ timezoneId: "Asia/Shanghai" });

async function workspace(page: Page, suffix: string) {
  const project = `metric-${suffix}-${Date.now()}`;
  expect(
    (
      await page.request.post("/api/projects", {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        data: { id: project },
      })
    ).ok(),
  ).toBeTruthy();
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api/${path}?project=${project}`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const state = async (): Promise<State> =>
    (await page.request.get(`/api/state?project=${project}`)).json();
  await post("brand", {
    name: "Metric windows DEMO",
    url: "https://example.com",
    product: "Demo item",
    parameters: "Synthetic test product.",
    audience: "Demo audience",
    market: "US",
    competitors: [],
    image: "",
  });
  await post("evidence", {
    title: "Synthetic metric test source",
    url: "https://example.com/source",
    publishedAt: "2026-01-01T00:00:00Z",
    text: "This is synthetic demonstration material, not measured customer research.",
    demo: true,
  });
  await post("tasks", { kind: "suggest" });
  await expect.poll(async () => (await state()).suggestions.length).toBe(3);
  await post("tasks", {
    kind: "content",
    payload: { suggestionId: (await state()).suggestions[0].id },
  });
  await expect.poll(async () => (await state()).contents.length).toBe(1);
  const content = (await state()).contents[0],
    revision = content.revisions[0];
  await post(`contents/${content.id}/approve`, { revisionId: revision.id });
  const campaign = await post("campaigns", {
    name: "Metric window campaign",
    objective: "Verify aggregate observation windows",
    audience: "Demo audience",
    primaryMetric: "clicks",
    target: 100,
    budget: 0,
    currency: "CNY",
    startsAt: "2026-01-01T00:00:00Z",
    endsAt: "2027-01-01T00:00:00Z",
    channels: ["x"],
    productIds: [],
    assetIds: [],
    contentIds: [content.id],
  });
  return { project, state, content, revision, campaign };
}

test("manual windows preserve dimensions, reject overlap and allow audited correction", async ({
  page,
}) => {
  const { project, state, campaign } = await workspace(page, "manual");
  await page.goto(`/?project=${project}&page=3`);
  const form = page.locator('[data-draft-scope="metric-new"]');
  await form.getByLabel("发布链接", { exact: true }).fill("https://example.com/post");
  await form.getByLabel("统计窗口开始", { exact: true }).fill("2026-01-01T08:00");
  await form.getByLabel("统计窗口结束（不含）", { exact: true }).fill("2026-01-02T08:00");
  await form.getByLabel("采样时间", { exact: true }).fill("2026-01-02T09:00");
  await form.getByLabel("关联活动（可选）", { exact: true }).selectOption(campaign.id);
  await form.getByLabel("效果渠道（可选）", { exact: true }).fill("x");
  await form.getByLabel("花费币种", { exact: true }).fill("CNY");
  await form.getByLabel("曝光", { exact: true }).fill("100");
  await form.getByLabel("点击", { exact: true }).fill("10");
  await form.getByLabel("花费（CNY）", { exact: true }).fill("5");
  const save = async () => {
    const pending = page.waitForResponse(
      (response) =>
        /\/api\/metrics\?/.test(response.url()) && response.request().method() === "POST",
    );
    await form.getByRole("button", { name: "保存效果记录" }).click();
    return pending;
  };
  expect((await save()).ok()).toBeTruthy();
  const original = (await state()).metrics[0];
  expect(original.windowStart).toBe("2026-01-01T00:00:00.000Z");
  expect(original.windowEnd).toBe("2026-01-02T00:00:00.000Z");
  expect(original.date).toBe("2026-01-02T01:00:00.000Z");
  expect(original.campaignId).toBe(campaign.id);
  expect(original.channel).toBe("x");
  await form.getByLabel("报表时区（IANA）").fill("UTC");
  await form.getByLabel("采样时间", { exact: true }).fill("2026-01-02T10:00");
  expect((await (await save()).json()).count).toBe(0);
  expect((await state()).metrics).toHaveLength(1);
  await form.getByLabel("统计窗口开始", { exact: true }).fill("2026-01-01T20:00");
  await form.getByLabel("统计窗口结束（不含）", { exact: true }).fill("2026-01-02T20:00");
  await form.getByLabel("采样时间", { exact: true }).fill("2026-01-02T21:00");
  await form.getByLabel("曝光", { exact: true }).fill("150");
  expect((await save()).status()).toBe(400);
  await expect(page.getByRole("status").filter({ hasText: "统计窗口重叠" })).toBeVisible();
  expect((await state()).metrics).toHaveLength(1);
  await form.getByLabel("统计窗口开始", { exact: true }).fill("2026-01-02T08:00");
  await form.getByLabel("统计窗口结束（不含）", { exact: true }).fill("2026-01-03T08:00");
  await form.getByLabel("采样时间", { exact: true }).fill("2026-01-03T09:00");
  expect((await save()).ok()).toBeTruthy();
  const summary = page.locator('article[aria-label="效果汇总与数据质量"]');
  await expect(summary.getByRole("cell", { name: "250", exact: true })).toBeVisible();
  const row = page.locator(`#metric-${original.id}`);
  await row.getByText("撤销需要更正的记录", { exact: true }).click();
  await row.getByLabel("撤销人（自报）").fill("Metric reviewer");
  await row
    .getByLabel("指标撤销原因")
    .fill("Correcting the first report after checking the source.");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("nav").getByRole("button", { name: "品牌档案" }).click();
  await expect(row.getByLabel("指标撤销原因")).toHaveValue(
    "Correcting the first report after checking the source.",
  );
  await row.getByRole("button", { name: "确认撤销指标记录" }).click();
  await expect(row.getByText("已撤销", { exact: true })).toBeVisible();
  await expect(summary.getByRole("cell", { name: "150", exact: true })).toBeVisible();
  await form.getByLabel("统计窗口开始", { exact: true }).fill("2026-01-01T08:00");
  await form.getByLabel("统计窗口结束（不含）", { exact: true }).fill("2026-01-02T08:00");
  await form.getByLabel("曝光", { exact: true }).fill("110");
  expect((await save()).ok()).toBeTruthy();
  await expect(summary.getByRole("cell", { name: "260", exact: true })).toBeVisible();
  await page.reload();
  await expect(row.getByText("已撤销", { exact: true })).toBeVisible();
  expect((await state()).metrics).toHaveLength(3);
  expect((await state()).metrics[0].voidedBy).toBe("Metric reviewer");
  expect((await state()).metrics[0].impressions).toBe(100);
  await page
    .locator("#metric-records")
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  mkdirSync("artifacts/screenshots", { recursive: true });
  await page.screenshot({ path: "artifacts/screenshots/metric-windows.png" });
});

test("batch previews explain conflicts and missing windows, and stale previews cannot be imported", async ({
  page,
}) => {
  const { project, state, content, revision, campaign } = await workspace(page, "preview");
  const metric = {
    contentId: content.id,
    revisionId: revision.id,
    campaignId: campaign.id,
    channel: "x",
    url: "https://example.com/post",
    date: "2026-01-05T00:00:00Z",
    currency: "CNY",
    timezone: "Asia/Shanghai",
    impressions: 100,
    clicks: 10,
    conversions: 1,
    spend: 5,
    notes: "Synthetic report",
  };
  await page.goto(`/?project=${project}&page=4&section=metrics`);
  const input = page.getByLabel("指标数据", { exact: true });
  await input.fill(
    JSON.stringify([
      { ...metric, windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-01-03T00:00:00Z" },
      { ...metric, windowStart: "2026-01-02T00:00:00Z", windowEnd: "2026-01-04T00:00:00Z" },
    ]),
  );
  await page.getByRole("button", { name: "校验预览", exact: true }).click();
  const preview = page.getByRole("table", { name: "指标导入预览" });
  await expect(preview.getByRole("cell", { name: "需修正", exact: true })).toHaveCount(2);
  await expect(preview.getByText(/本批第 2 行/)).toBeVisible();
  await expect(page.getByRole("button", { name: "确认导入有效新行" })).toHaveCount(0);
  expect((await state()).metrics).toHaveLength(0);
  await input.fill(JSON.stringify([metric]));
  await page.getByRole("button", { name: "校验预览", exact: true }).click();
  await expect(preview.getByRole("cell", { name: "可保留 · 不计汇总", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认导入有效新行" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已新增 1 条指标" })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "效果记录" }).click();
  await expect(page.getByText("统计窗口未确认", { exact: true })).toBeVisible();
  await expect(page.getByText(/已有 1 条原始记录，当前没有可汇总数据/)).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "今日工作台" }).click();
  await expect(page.getByText(/0 条指标可汇总，1 条待核查/)).toBeVisible();
  await expect(page.getByRole("button", { name: "核对效果记录" })).toBeVisible();
  await page.goto(`/?project=${project}&page=5&section=campaigns`);
  await expect(page.getByText(/暂无可汇总观察值/)).toBeVisible();
  await page.goto(`/?project=${project}&page=4&section=metrics`);
  await input.fill(JSON.stringify([metric]));
  await page.getByRole("button", { name: "校验预览", exact: true }).click();
  await expect(page.getByText("全部是已保存的相同记录，无需再次导入。")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认导入有效新行" })).toHaveCount(0);
  await page.route("**/api/metrics/preview?*", (route) =>
    route.fulfill({ status: 503, json: { error: "Preview service unavailable" } }),
  );
  await page.getByRole("button", { name: "校验预览", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Preview service unavailable" }),
  ).toBeVisible();
  await expect(page.getByText(/JSON 格式无效/)).toHaveCount(0);
  await page.unroute("**/api/metrics/preview?*");
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/metrics/preview?*", async (route) => {
    started();
    await waiting;
    await route.continue();
  });
  await page.getByRole("button", { name: "校验预览", exact: true }).click();
  await requested;
  await input.fill('[{"unfinished":');
  release();
  await expect(page.getByText("输入已变化，请重新校验当前数据。")).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认导入有效新行" })).toHaveCount(0);
  await expect(input).toHaveValue('[{"unfinished":');
  expect((await state()).metrics).toHaveLength(1);
});
