import { test, expect, type Page } from "@playwright/test";
import type { State, Fact } from "../server/types";

test.use({ timezoneId: "Asia/Shanghai" });

async function workspace(page: Page, suffix: string) {
  const project = `facts-${suffix}-${Date.now()}`;
  const create = await page.request.post("/api/projects", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: { id: project },
  });
  expect(create.ok()).toBeTruthy();
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
    name: "Scoped DEMO",
    url: "https://example.com",
    product: "Demo item",
    parameters: "Synthetic products for testing only.",
    audience: "Demo audience",
    market: "US",
    competitors: [],
    image: "",
  });
  return { project, post, state };
}

test("product facts stay scoped; manual delivery receipts and withdrawal retain audit history", async ({
  page,
}) => {
  const { project, post, state } = await workspace(page, "receipts");
  await post("products/import", {
    format: "json",
    sourceName: "Synthetic catalog",
    sourceUrl: "https://example.com/catalog",
    currency: "USD",
    demo: true,
    text: JSON.stringify([
      {
        sku: "ALPHA",
        title: "Alpha DEMO",
        description: "Alpha capacity is 500 ml.",
        price: 10,
        currency: "USD",
        url: "https://example.com/alpha",
      },
      {
        sku: "BETA",
        title: "Beta DEMO",
        description: "Beta capacity is 1000 ml.",
        price: 20,
        currency: "USD",
        url: "https://example.com/beta",
      },
    ]),
  });
  const products = (await state()).products;
  await page.goto(`/?project=${project}&page=4&section=sources`);
  const form = page.locator('[data-draft-scope="fact-new"]');
  for (const product of products) {
    await form.getByLabel("证据", { exact: true }).selectOption(product.evidenceId);
    await form.getByLabel("逐字原文引用").fill(product.description);
    await form.getByLabel("确认的品牌事实").fill(product.description);
    await form.getByLabel("适用范围", { exact: true }).selectOption("product");
    await form.getByLabel("适用商品", { exact: true }).selectOption(product.id);
    await form.getByLabel("确认人（自报）").fill("Demo fact reviewer");
    await form.getByRole("button", { name: "保存确认事实" }).click();
    await expect(
      page.getByRole("heading", { name: product.description, exact: true }),
    ).toBeVisible();
  }
  const facts = (await state()).facts;
  await post(`products/${products[0].id}/use`, {});
  await post("tasks", { kind: "suggest" });
  await expect.poll(async () => (await state()).suggestions.length).toBe(3);
  await post("tasks", {
    kind: "content",
    payload: { suggestionId: (await state()).suggestions[0].id },
  });
  await expect.poll(async () => (await state()).contents.length).toBe(1);
  const content = (await state()).contents[0],
    revision = content.revisions[0];
  expect(revision.facts?.map((fact) => fact.id)).toEqual([facts[0].id]);
  expect(revision.brand.activeProductId).toBe(products[0].id);
  await post(`contents/${content.id}/approve`, { revisionId: revision.id });
  const campaign = await post("campaigns", {
    name: "Scoped delivery DEMO",
    objective: "Verify factual manual delivery",
    audience: "Demo audience",
    primaryMetric: "clicks",
    target: 10,
    budget: 0,
    currency: "USD",
    startsAt: new Date(Date.now() - 86400000).toISOString(),
    endsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    channels: ["x"],
    productIds: [products[0].id],
    assetIds: [],
    contentIds: [content.id],
  });
  const calendar = await post("calendar", {
    contentId: content.id,
    revisionId: revision.id,
    channel: "x",
    account: "demo-account",
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    headline: "Scoped delivery",
    copy: revision.copy,
    targetUrl: "https://example.com/alpha",
    campaign: "Scoped delivery DEMO",
    campaignId: campaign.id,
  });
  await post(`calendar/${calendar.id}/approve`, {});
  await page.goto(`/?project=${project}&page=4&section=calendar&target=${calendar.id}`);
  const card = page.locator(`#calendar-${calendar.id}`);
  await card.getByText("记录已完成的人工交付", { exact: true }).click();
  await card.getByRole("button", { name: "填入当前时间" }).click();
  await expect(page.getByText("有未保存的修改，离开当前页面前请先保存。")).toBeVisible();
  await card.getByLabel("记录人（自报）", { exact: true }).fill("Demo publisher");
  await card.getByLabel("外部发布或交付链接").fill("https://example.com/posts/first");
  await card.getByLabel("交付备注").fill("Synthetic publication receipt for testing.");
  await card.getByRole("button", { name: "保存人工交付记录" }).click();
  await expect(card.getByText("人工交付已记录 · 平台未验证", { exact: true })).toBeVisible();
  await expect(card.getByText("记录已完成的人工交付", { exact: true })).toHaveCount(0);
  await card.getByText("撤销这条人工记录", { exact: true }).click();
  await card.getByLabel("撤销人（自报）").fill("Demo reviewer");
  await card
    .getByLabel("撤销原因", { exact: true })
    .fill("Incorrect demonstration URL; keep the original audit record.");
  await card.getByRole("button", { name: "确认撤销记录，保留历史" }).click();
  await expect(card.getByText("已撤销的人工记录", { exact: true })).toBeVisible();
  await card.getByText("记录已完成的人工交付", { exact: true }).click();
  await card.getByRole("button", { name: "填入当前时间" }).click();
  await card.getByLabel("外部发布或交付链接").fill("https://example.com/posts/corrected");
  await card.getByRole("button", { name: "保存人工交付记录" }).click();
  await expect(card.getByText("人工交付已记录 · 平台未验证", { exact: true })).toBeVisible();
  await page.reload();
  await expect(card.getByText("已撤销的人工记录", { exact: true })).toBeVisible();
  await expect(card.getByText("人工交付已记录 · 平台未验证", { exact: true })).toBeVisible();
  await page.goto(`/?project=${project}&page=5&section=campaigns&target=${campaign.id}`);
  await expect(page.getByText("人工交付已记录 · 平台未验证", { exact: true })).toBeVisible();
  await page.goto(`/?project=${project}&page=4&section=sources&target=${facts[0].id}`);
  const factCard = page.locator(`#fact-${facts[0].id}`);
  await factCard.getByText("撤回这条事实并检查影响", { exact: true }).click();
  await expect(
    factCard.getByText(/关联 1 个内容版本、1 个排期、1 个活动、2 条人工交付记录/),
  ).toBeVisible();
  await factCard.getByLabel("撤回人（自报）").fill("Demo fact reviewer");
  await factCard
    .getByLabel("撤回理由")
    .fill("The demonstration capacity statement is no longer confirmed.");
  await factCard.getByRole("button", { name: "确认撤回事实，保留历史" }).click();
  await expect(factCard.getByText("已撤回", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "渠道日历", exact: true }).click();
  await expect(card.getByText("需复核事实后重新审批", { exact: false })).toBeVisible();
  await expect(card.getByRole("link", { name: "下载含 UTM 的交付包" })).toHaveCount(0);
  await expect(card.getByText("关联事实需要复核，已发生的交付仍保留：").first()).toBeVisible();
  const updated = await state();
  expect(updated.deliveries).toHaveLength(2);
  expect(updated.deliveries?.filter((receipt) => !receipt.voidedAt)).toHaveLength(1);
  expect(updated.facts.find((fact) => fact.id === facts[0].id)?.withdrawnBy).toBe(
    "Demo fact reviewer",
  );
  expect(
    (await page.request.get(`/api/calendar/${calendar.id}/export?project=${project}`)).status(),
  ).toBe(400);
  await page.goto(`/?project=${project}&page=2&target=${content.id}`);
  await expect(page.getByRole("button", { name: "批准当前版本 V1" })).toBeDisabled();
  await expect(page.getByText("事实依据需要复核，当前版本不能审批或交付")).toBeVisible();
  await page
    .getByLabel("可编辑文案")
    .fill("Meet Alpha DEMO. Review the product information before deciding.");
  for (let i = 1; i <= 3; i++)
    await page.getByLabel(`屏幕文案 ${i}`, { exact: true }).fill("Review the product information.");
  await page.getByLabel("本次保存包含事实复核").check();
  await page.getByLabel("事实复核人（自报）").fill("Demo reviewer");
  await page
    .getByLabel("事实复核说明")
    .fill("Removed the withdrawn capacity statement from the copy and scenes.");
  await page.getByLabel("我已核对全文与分镜").check();
  await page.getByRole("button", { name: "保存为新版本" }).click();
  await expect(page.getByRole("button", { name: "批准当前版本 V2" })).toBeEnabled();
  await page.getByRole("button", { name: "批准当前版本 V2" }).click();
  await expect(page.getByRole("link", { name: "下载文案、分镜与证据 JSON" })).toBeVisible();
  const repaired = (await state()).contents[0].revisions.at(-1)!;
  expect(repaired.facts).toEqual([]);
  expect(repaired.factReview?.previousFactIds).toEqual([facts[0].id]);
  expect((await state()).deliveries).toHaveLength(2);
  await post(`calendar/${calendar.id}/archive`, {});
  await page.goto(`/?project=${project}`);
  await page.getByRole("button", { name: "检查交付", exact: true }).click();
  await expect(card.getByText("已归档 · 保留历史交付记录", { exact: true })).toBeVisible();
  await expect(card.getByText("人工交付已记录 · 平台未验证", { exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: "下载含 UTM 的交付包" })).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/screenshots/facts-delivery-audit.png" });
});

test("legacy fact UI requires explicit scope and keeps the historical record (API fixture)", async ({
  page,
}) => {
  const { project, state } = await workspace(page, "legacy");
  const snapshot = await state();
  const legacy: Fact = {
    id: "legacy-demo-fact",
    evidenceId: "legacy-demo-evidence",
    quote: "provides public product documentation",
    text: "The brand provides public product documentation.",
    confirmedAt: "2026-01-01T00:00:00.000Z",
  };
  snapshot.evidence.push({
    id: legacy.evidenceId,
    title: "Legacy DEMO source",
    url: "https://example.com/legacy",
    publishedAt: legacy.confirmedAt,
    capturedAt: legacy.confirmedAt,
    text: `DEMO: The brand ${legacy.quote}.`,
    hash: "synthetic-fixture",
    kind: "manual",
    demo: true,
  });
  snapshot.facts.push(legacy);
  await page.route("**/api/state?*", (route) =>
    route.fulfill({ json: { ...snapshot, mode: "demo-template" } }),
  );
  await page.route("**/api/facts?*", async (route) => {
    const input = route.request().postDataJSON();
    expect(input.reconfirmsFactId).toBe(legacy.id);
    expect(input.scope).toBe("brand");
    expect(input.actor).toBe("Legacy reviewer");
    snapshot.facts.push({
      ...legacy,
      id: "reconfirmed-demo-fact",
      scope: input.scope,
      confirmedBy: input.actor,
      reconfirmsFactId: legacy.id,
      confirmedAt: new Date().toISOString(),
    });
    await route.fulfill({ json: { id: "reconfirmed-demo-fact" } });
  });
  await page.goto(`/?project=${project}&page=4&section=sources`);
  const card = page.locator(`#fact-${legacy.id}`);
  await expect(card.getByText("历史未归类 · 需要重新确认", { exact: true })).toBeVisible();
  await card.getByText("明确适用范围并重新确认", { exact: true }).click();
  await expect(card.getByLabel("适用范围", { exact: true })).toHaveValue("");
  await card.getByLabel("适用范围", { exact: true }).selectOption("brand");
  await card.getByLabel("确认人（自报）").fill("Legacy reviewer");
  await card.getByRole("button", { name: "重新确认适用范围", exact: true }).click();
  await expect(card.getByText(/已重新确认，当前记录/)).toBeVisible();
  await expect(
    page.locator("#fact-reconfirmed-demo-fact").getByText("品牌通用", { exact: true }),
  ).toBeVisible();
  await expect(card).toBeVisible();
});
