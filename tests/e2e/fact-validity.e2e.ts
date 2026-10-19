import { test, expect, type Page } from "@playwright/test";
import type { State } from "../../server/types";
import { mkdirSync } from "node:fs";

test.use({ timezoneId: "Asia/Shanghai" });
const localTime = (value: number) =>
  new Date(value + 8 * 3600000)
    .toISOString()
    .slice(0, 23)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.000$/, "")
    .replace(/:00$/, "");
const day = 86400000;

async function workspace(page: Page, suffix: string) {
  const project = `validity-${suffix}-${Date.now()}`;
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
    name: "Validity DEMO",
    url: "https://example.com",
    product: "Demo item",
    parameters: "Synthetic test information.",
    audience: "Demo audience",
    market: "US",
    competitors: [],
    image: "",
  });
  await post("evidence", {
    title: "Synthetic company source",
    url: "https://example.com/company",
    publishedAt: new Date(Date.now() - day).toISOString(),
    text: "The annual company celebration is on May 12. Support is provided on weekdays. The company identifier is COMPANY-1.",
    demo: true,
  });
  return { project, post, state, evidenceId: (await state()).evidence[0].id };
}

async function saveFact(
  page: Page,
  input: {
    evidenceId: string;
    text: string;
    quote: string;
    scope?: "brand" | "product";
    productId?: string;
    validFrom?: number;
    validUntil?: number;
    attribute?: string;
    value?: string;
  },
) {
  const form = page.locator('[data-draft-scope="fact-new"]');
  await form.getByLabel("证据", { exact: true }).selectOption(input.evidenceId);
  await form.getByLabel("逐字原文引用").fill(input.quote);
  await form.getByLabel("确认的品牌事实").fill(input.text);
  await form.getByLabel("适用范围", { exact: true }).selectOption(input.scope || "brand");
  if (input.scope === "product")
    await form.getByLabel("适用商品", { exact: true }).selectOption(input.productId!);
  await form.getByLabel("确认人（自报）").fill("Demo validity reviewer");
  await form
    .getByLabel("有效起始", { exact: true })
    .fill(input.validFrom === undefined ? "" : localTime(input.validFrom));
  await form
    .getByLabel("有效截止", { exact: true })
    .fill(input.validUntil === undefined ? "" : localTime(input.validUntil));
  await form.getByLabel("属性", { exact: true }).fill(input.attribute || "");
  await form.getByLabel("属性值", { exact: true }).fill(input.value || "");
  const response = page.waitForResponse(
    (response) => /\/api\/facts\?/.test(response.url()) && response.request().method() === "POST",
  );
  await form.getByRole("button", { name: "保存确认事实" }).click();
  return response;
}

test("validity uses explicit local time, rejects empty intervals and renews without replacing history", async ({
  page,
}) => {
  const { project, state, evidenceId } = await workspace(page, "periods");
  await page.goto(`/?project=${project}&page=4&section=sources`);
  const form = page.locator('[data-draft-scope="fact-new"]');
  await form.getByLabel("属性", { exact: true }).fill("celebration-date");
  await expect(form.getByLabel("属性值", { exact: true })).toHaveAttribute("required", "");
  await form.getByLabel("属性", { exact: true }).fill("");
  const now = Date.now();
  const birthday = {
    evidenceId,
    quote: "annual company celebration is on May 12",
    text: "The company celebration is on May 12.",
  };
  const invalid = await saveFact(page, {
    ...birthday,
    validFrom: now + day,
    validUntil: now + day,
  });
  expect(invalid.status()).toBe(400);
  await expect(
    page.getByRole("status").filter({ hasText: "有效截止时间必须晚于有效起始时间" }),
  ).toBeVisible();
  expect((await state()).facts).toHaveLength(0);
  const unlimitedResponse = await saveFact(page, birthday);
  expect(unlimitedResponse.ok()).toBeTruthy();
  const unlimited = (await unlimitedResponse.json()).id;
  await expect(
    page.locator(`#fact-${unlimited}`).getByText("未设置有效期限制", { exact: true }),
  ).toBeVisible();
  expect((await state()).facts[0].validFrom).toBeUndefined();
  expect((await state()).facts[0].validUntil).toBeUndefined();
  const futureResponse = await saveFact(page, {
    evidenceId,
    quote: "Support is provided on weekdays",
    text: "Upcoming weekday support confirmation.",
    validFrom: now + 2 * day,
    validUntil: now + 3 * day,
    attribute: "support-days",
    value: "weekdays",
  });
  expect(futureResponse.ok()).toBeTruthy();
  const future = (await futureResponse.json()).id;
  await expect(
    page.locator(`#fact-${future}`).getByText("尚未生效", { exact: true }),
  ).toBeVisible();
  expect((await state()).facts.find((fact) => fact.id === future)?.validFrom).toBe(
    new Date(now + 2 * day).toISOString(),
  );
  const expiredResponse = await saveFact(page, {
    evidenceId,
    quote: "Support is provided on weekdays",
    text: "Previous weekday support confirmation.",
    validFrom: now - 2 * day,
    validUntil: now - day,
    attribute: "support-days",
    value: "weekdays",
  });
  expect(expiredResponse.ok()).toBeTruthy();
  const expiredId = (await expiredResponse.json()).id;
  const original = (await state()).facts.find((fact) => fact.id === expiredId)!;
  const expiredCard = page.locator(`#fact-${expiredId}`);
  await expect(expiredCard.getByText("已到期", { exact: true })).toBeVisible();
  await expiredCard.getByText("确认新的有效期，保留旧记录", { exact: true }).click();
  await expect(expiredCard.getByLabel("属性", { exact: true })).toHaveAttribute("readonly", "");
  await expect(expiredCard.getByRole("button", { name: "保存新的有效期确认" })).toBeDisabled();
  await expiredCard.getByLabel("确认人（自报）", { exact: true }).fill("Renewal reviewer");
  await expiredCard.getByLabel("有效起始", { exact: true }).fill(localTime(now - 1000));
  await expiredCard.getByLabel("有效截止", { exact: true }).fill(localTime(now + day));
  await expiredCard.getByRole("button", { name: "保存新的有效期确认" }).click();
  await expect(expiredCard.getByText(/已新增有效期确认，关联记录/)).toBeVisible();
  const renewed = (await state()).facts.find((fact) => fact.reconfirmsFactId === expiredId)!;
  expect(renewed.id).not.toBe(expiredId);
  expect(renewed.confirmedBy).toBe("Renewal reviewer");
  expect(renewed.attribute).toBe(original.attribute);
  expect(renewed.value).toBe(original.value);
  expect((await state()).facts.find((fact) => fact.id === expiredId)).toEqual(original);
  await expect(
    page.locator(`#fact-${renewed.id}`).getByText("有效期内", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(expiredCard.getByText("已到期", { exact: true })).toBeVisible();
  await expect(
    page.locator(`#fact-${renewed.id}`).getByText("有效期内", { exact: true }),
  ).toBeVisible();
  await expiredCard.getByText("确认新的有效期，保留旧记录", { exact: true }).click();
  await expiredCard.evaluate((element) => element.scrollIntoView({ block: "start" }));
  mkdirSync("artifacts/screenshots", { recursive: true });
  await page.screenshot({ path: "artifacts/screenshots/fact-validity.png" });
});

test("potential conflicts stay within their product scope and withdrawal restores the other fact", async ({
  page,
}) => {
  const { project, post, state, evidenceId } = await workspace(page, "conflicts");
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
        description: "Demo identifiers ALPHA-1 and ALPHA-2 appear in this synthetic source.",
        price: 10,
        currency: "USD",
        url: "https://example.com/alpha",
      },
      {
        sku: "BETA",
        title: "Beta DEMO",
        description: "The demo identifier BETA-1 is assigned to this sample.",
        price: 20,
        currency: "USD",
        url: "https://example.com/beta",
      },
    ]),
  });
  const [alpha, beta] = (await state()).products;
  const betaFact = await post("facts", {
    evidenceId: beta.evidenceId,
    quote: "BETA-1",
    text: "Beta identifier is BETA-1.",
    scope: "product",
    productId: beta.id,
    actor: "Demo reviewer",
    attribute: "identifier",
    value: "BETA-1",
  });
  const brandFact = await post("facts", {
    evidenceId,
    quote: "COMPANY-1",
    text: "Company identifier is COMPANY-1.",
    scope: "brand",
    actor: "Demo reviewer",
    attribute: "identifier",
    value: "COMPANY-1",
  });
  await page.goto(`/?project=${project}&page=4&section=sources`);
  const firstResponse = await saveFact(page, {
    evidenceId: alpha.evidenceId,
    quote: "ALPHA-1",
    text: "Alpha identifier is ALPHA-1.",
    scope: "product",
    productId: alpha.id,
    attribute: "identifier",
    value: "ALPHA-1",
  });
  expect(firstResponse.ok()).toBeTruthy();
  const first = (await firstResponse.json()).id;
  await post(`products/${alpha.id}/use`, {});
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
  const secondResponse = await saveFact(page, {
    evidenceId: alpha.evidenceId,
    quote: "ALPHA-2",
    text: "Alpha identifier is ALPHA-2.",
    scope: "product",
    productId: alpha.id,
    attribute: "identifier",
    value: "ALPHA-2",
  });
  expect(secondResponse.ok()).toBeTruthy();
  const second = (await secondResponse.json()).id;
  for (const id of [first, second])
    await expect(
      page.locator(`#fact-${id}`).getByText("存在潜在冲突", { exact: true }),
    ).toBeVisible();
  for (const id of [betaFact.id, brandFact.id])
    await expect(
      page.locator(`#fact-${id}`).getByText("存在潜在冲突", { exact: true }),
    ).toHaveCount(0);
  const blocked = await page.request.post(
    `/api/contents/${content.id}/approve?project=${project}`,
    { headers: { "Idempotency-Key": crypto.randomUUID() }, data: { revisionId: revision.id } },
  );
  expect(blocked.status()).toBe(400);
  expect((await blocked.json()).error).toContain("潜在冲突");
  const conflictCard = page.locator(`#fact-${second}`);
  await conflictCard.getByText("撤回这条事实并检查影响", { exact: true }).click();
  await conflictCard.getByLabel("撤回人（自报）").fill("Conflict reviewer");
  await conflictCard
    .getByLabel("撤回理由")
    .fill("After checking the source, this demo identifier is not applicable.");
  await conflictCard.getByRole("button", { name: "确认撤回事实，保留历史" }).click();
  await expect(conflictCard.getByText("已撤回", { exact: true })).toBeVisible();
  await expect(
    page.locator(`#fact-${first}`).getByText("存在潜在冲突", { exact: true }),
  ).toHaveCount(0);
  await post(`contents/${content.id}/approve`, { revisionId: revision.id });
  expect((await state()).facts.find((fact) => fact.id === first)?.withdrawnAt).toBeUndefined();
});

test("calendar shows a future expiry as an approval blocker", async ({ page }) => {
  const { project, post, state, evidenceId } = await workspace(page, "calendar");
  await post("facts", {
    evidenceId,
    quote: "Support is provided on weekdays",
    text: "Weekday support remains confirmed until the stated deadline.",
    scope: "brand",
    actor: "Demo reviewer",
    validUntil: new Date(Date.now() + day).toISOString(),
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
  const entry = await post("calendar", {
    contentId: content.id,
    revisionId: revision.id,
    channel: "x",
    account: "expiry-demo-account",
    scheduledAt: new Date(Date.now() + 2 * day).toISOString(),
    headline: "Expiry demonstration",
    copy: revision.copy,
    targetUrl: "https://example.com",
    campaign: "Expiry demo",
  });
  await page.goto(`/?project=${project}&page=4&section=calendar&target=${entry.id}`);
  const card = page.locator(`#calendar-${entry.id}`);
  await expect(card.getByText(/排期时间：.*已过期/).first()).toBeVisible();
  await expect(
    card.getByRole("button", { name: "批准此渠道 / 账号 / 文案", exact: true }),
  ).toBeDisabled();
  await expect(card.getByRole("link", { name: "下载含 UTM 的交付包" })).toHaveCount(0);
});
