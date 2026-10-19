import { test, expect } from "@playwright/test";

test("daily workspace shows real pending work, targets the right content and lead, and preserves brand isolation", async ({
  page,
  request,
}) => {
  const project = "overview-browser";
  const post = async (path: string, body: unknown) => {
    const response = await request.post(
      `/api/${path}?project=${path === "projects" ? "default" : project}`,
      {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        data: body,
      },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const state = () => request.get(`/api/state?project=${project}`).then((r) => r.json());
  await post("projects", { id: project });
  await post("brand", {
    name: "DAILY DEMO",
    url: "https://example.com",
    product: "Demo product",
    parameters: "Test only",
    audience: "Teams",
    market: "US",
    competitors: [],
    image: "",
  });
  await post("evidence", {
    title: "Daily test",
    url: "https://example.com",
    publishedAt: "2026-01-01",
    text: "Synthetic evidence used only for the daily workspace browser test.",
    demo: true,
  });
  await post("tasks", { kind: "suggest" });
  await expect.poll(async () => (await state()).suggestions.length).toBe(3);
  const suggestions = (await state()).suggestions;
  for (const suggestion of suggestions.slice(0, 2))
    await post("tasks", { kind: "content", payload: { suggestionId: suggestion.id } });
  await expect.poll(async () => (await state()).contents.length).toBe(2);
  const first = (await state()).contents[0];
  const scheduledAt = new Date(Date.now() + 86400000).toISOString();
  await post("calendar", {
    contentId: first.id,
    revisionId: first.revisions[0].id,
    channel: "x",
    account: "Demo account",
    headline: "DEMO upcoming",
    copy: "Synthetic test content",
    scheduledAt,
    targetUrl: "https://example.com",
    campaign: "Demo",
  });
  await post("sources", {
    label: "Paused DEMO source",
    url: "https://example.com",
    connector: "web",
    category: "market",
    intervalHours: 24,
    enabled: false,
  });
  await post("crm/leads", {
    company: "DEMO company",
    domain: "example.com",
    name: "Demo person",
    email: "demo@example.com",
    industry: "software",
    region: "US",
    owner: "Demo owner",
    sourceUrl: "https://example.com",
    stage: "new",
  });
  const lead = (await state()).crm.leads[0];
  await post(`crm/leads/${lead.id}/tasks`, {
    title: "Confirm demo requirements",
    owner: "Demo owner",
    dueAt: new Date(Date.now() - 3600000).toISOString(),
  });

  await page.goto(`/?project=${project}`);
  await expect(page.getByRole("heading", { name: "今日工作台", exact: true })).toBeVisible();
  await expect(page.getByLabel("工作概况").getByRole("button", { name: /待审核/ })).toContainText(
    "3",
  );
  await expect(
    page.getByLabel("工作概况").getByRole("button", { name: /已到期跟进/ }),
  ).toContainText("1");
  await expect(page.getByText("Paused DEMO source", { exact: true })).toBeVisible();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "DEMO upcoming", exact: true }).last(),
  ).toBeVisible();
  const item = page
    .locator(".overview-row")
    .filter({ has: page.getByRole("heading", { name: first.suggestion.title, exact: true }) });
  await item.getByRole("button", { name: "前往审核" }).click();
  await expect(page).toHaveURL(new RegExp(`target=${first.id}`));
  await expect(page.getByLabel("可编辑文案")).toHaveValue(first.revisions[0].copy);
  await page.locator("nav").getByRole("button", { name: "今日工作台" }).click();
  await page.getByRole("button", { name: "查看线索", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`target=${lead.id}`));
  await expect(page.getByRole("heading", { name: "DEMO company · Demo person" })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "今日工作台" }).click();
  await page.getByRole("button", { name: "渠道日历", exact: true }).click();
  await expect(page).toHaveURL(/page=4&section=calendar/);
  await expect(page.getByRole("heading", { name: "建立渠道交付计划" })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "今日工作台" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: "artifacts/screenshots/daily-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: "artifacts/screenshots/daily-workspace.png", fullPage: true });
  await page.getByLabel("品牌项目").selectOption("default");
  await expect(page.getByText("Paused DEMO source", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Confirm demo requirements", exact: true }),
  ).toHaveCount(0);
});

test("overview survives a slow response and recovers from a refresh failure without losing its last state", async ({
  page,
}) => {
  let fail = false;
  let first = true;
  await page.route("**/api/overview?*", async (route) => {
    if (fail) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"temporary"}',
      });
      return;
    }
    if (first) {
      first = false;
      await new Promise((resolve) => setTimeout(resolve, 2600));
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByLabel("工作概况")).toBeVisible({ timeout: 10000 });
  fail = true;
  await expect(page.getByRole("alert").filter({ hasText: "工作台状态" })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByLabel("工作概况")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "重试更新" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "工作台状态" })).toHaveCount(0);
});
