import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/storage/store.ts";
import { createApp } from "../../server/app.ts";
import { previewProducts } from "../../server/connectors/products.ts";
const brand = {
  name: "DEMO Brand",
  url: "https://example.com",
  product: "Demo",
  parameters: "User provided demo",
  audience: "Demo audience",
  market: "US",
  image: "",
  competitors: [],
};
const guidelines = {
  goal: "Test informed product interest",
  tone: "Calm and factual",
  valueProposition: "Clear product information",
  forbiddenClaims: ["miracle cure"],
  primaryMetric: "clicks",
  target: 50,
};
const standard = {
  format: "csv",
  text: "sku,title,description,price,currency,url\nDEMO-1,Sample bottle,Sample product for demonstration only,20,USD,https://example.com/bottle",
  sourceName: "demo.csv",
  sourceUrl: "https://example.com",
  currency: "USD",
  demo: true,
};
test("Shopify file contract: variants inherit product data, skip image rows, reject missing SKU and private URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-product-"));
  const store = new Store(join(dir, "db.sqlite"));
  try {
    const rows = previewProducts(
      {
        ...standard,
        format: "shopify-csv",
        text: "Handle,Title,Body (HTML),Variant SKU,Variant Price,Image Src\nbottle,Demo Bottle,<p>Demonstration only bottle</p>,SKU-A,10,\nbottle,,,SKU-B,12,\nbottle,,,,,https://example.com/image.png",
      },
      store.read(),
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0].product?.description, "Demonstration only bottle");
    assert.equal(rows[1].product?.title, "Demo Bottle");
    assert.equal(rows[1].product?.url, "https://example.com/products/bottle");
    assert.equal(rows[2].skipped, true);
    const invalid = previewProducts(
      {
        ...standard,
        format: "json",
        text: JSON.stringify([
          {
            sku: "",
            title: "Demo",
            description: "Demo",
            price: 10,
            currency: "USD",
            url: "http://127.0.0.1",
          },
        ]),
      },
      store.read(),
    );
    assert.equal(invalid[0].valid, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("onboarding → product evidence → content → campaign approval/export; guidelines, revisions and archival invalidate safely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-campaign-")),
    store = new Store(join(dir, "db.sqlite"));
  const app = createApp(store, dir),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  const post = async (path: string, body: unknown, key = crypto.randomUUID()) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    return { status: r.status, ...(await r.json()) };
  };
  const get = async (path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, ...(await r.json()) };
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const t = store.read().tasks.find((t) => t.id === id)!;
      if (t.status === "failed") throw new Error(t.error);
      if (t.status === "succeeded") return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("task timeout");
  };
  try {
    assert.equal((await get("planning")).onboarding.filter((x: any) => x.done).length, 0);
    await post("brand", brand);
    await post("guidelines", guidelines);
    assert.equal((await post("products/preview", standard)).rows[0].valid, true);
    assert.equal(store.read().products.length, 0);
    assert.equal(
      (
        await post("products/import", {
          ...standard,
          text: standard.text + "\n,broken,bad,20,USD,https://example.com",
        })
      ).status,
      400,
    );
    assert.equal(store.read().products.length, 0);
    const key = crypto.randomUUID();
    assert.equal((await post("products/import", standard, key)).count, 1);
    await post("products/import", standard, key);
    assert.equal((await post("products/import", standard)).count, 0);
    const product = store.read().products[0];
    assert.equal(store.read().evidence.length, 1);
    assert.equal(store.read().evidence[0].demo, true);
    assert.equal(product.evidenceId, store.read().evidence[0].id);
    await post(`products/${product.id}/use`, {});
    const image =
      "data:image/png;base64," + readFileSync("fixtures/demo-product.png").toString("base64");
    const asset = await post("assets", {
      name: "DEMO",
      image,
      alt: "Demo image",
      rights: "Self-made demonstration fixture",
      demo: true,
    });
    assert.equal(asset.status, 200);
    assert.equal(
      (
        await post("assets", {
          name: "fake",
          image: "data:image/png;base64,YmFk",
          alt: "fake",
          rights: "test",
        })
      ).status,
      400,
    );
    assert.equal((await get("state")).assets[0].image, "");
    await wait((await post("tasks", { kind: "suggest" })).id);
    const suggestion = store.read().suggestions[0];
    await wait(
      (
        await post("tasks", {
          kind: "content",
          payload: { suggestionId: suggestion.id },
        })
      ).id,
    );
    let content = store.read().contents[0],
      revision = content.revisions.at(-1)!;
    await post(`contents/${content.id}/approve`, { revisionId: revision.id });
    const brief = {
      name: "DEMO launch",
      objective: "Test relevance before spending",
      audience: "Demo audience",
      primaryMetric: "clicks",
      target: 50,
      budget: 0,
      currency: "USD",
      startsAt: "2026-01-01",
      endsAt: "2027-12-31",
      channels: ["x"],
      productIds: [product.id],
      assetIds: [asset.id],
      contentIds: [content.id],
      suggestionId: suggestion.id,
    };
    assert.equal((await post("campaigns", { ...brief, productIds: ["other-brand"] })).status, 400);
    const campaign = await post("campaigns", brief);
    assert.equal((await post(`campaigns/${campaign.id}/approve`, { baseVersion: 1 })).status, 400);
    const schedule = {
      contentId: content.id,
      revisionId: revision.id,
      channel: "x",
      account: "DEMO account",
      scheduledAt: "2026-10-15T12:00:00Z",
      copy: "Meet our demonstration product.",
      headline: "Demo launch",
      targetUrl: brand.url,
      campaign: brief.name,
      campaignId: campaign.id,
    };
    const entry = await post("calendar", schedule);
    assert.equal(entry.status, 200);
    await post(`calendar/${entry.id}/approve`, {});
    assert.equal((await post(`campaigns/${campaign.id}/approve`, { baseVersion: 1 })).status, 200);
    const exported = await get(`campaigns/${campaign.id}/export`);
    assert.equal(exported.status, 200);
    assert.equal(exported.externalActions, "none");
    assert.equal(exported.products[0].evidenceId, product.evidenceId);
    assert.equal(exported.assets[0].rights, "Self-made demonstration fixture");
    assert.match(exported.calendar[0].targetUrl, /utm_campaign=DEMO/);
    assert.equal(exported.campaign.opportunity.id, suggestion.id);
    await post(`calendar/${entry.id}/archive`, {});
    assert.equal((await get(`campaigns/${campaign.id}/export`)).status, 400);
    assert.equal((await get(`calendar/${entry.id}/export`)).status, 400);
    await post(`calendar/${entry.id}/archive`, { restore: true });
    assert.equal((await get(`campaigns/${campaign.id}/export`)).status, 200);
    await post("guidelines", { ...guidelines, tone: "Friendly and factual" });
    assert.equal((await get(`campaigns/${campaign.id}/export`)).status, 400);
    assert.equal((await get(`contents/${content.id}/${revision.id}/download`)).status, 400);
    assert.equal((await post(`calendar/${entry.id}/approve`, {})).status, 400);
    await post(`contents/${content.id}/approve`, { revisionId: revision.id });
    await post(`calendar/${entry.id}/approve`, {});
    await post(`campaigns/${campaign.id}/approve`, { baseVersion: 1 });
    assert.equal((await get(`campaigns/${campaign.id}/export`)).status, 200);
    await post(`contents/${content.id}/revise`, {
      baseRevisionId: revision.id,
      copy: "A miracle cure claim",
      scenes: revision.scenes,
    });
    content = store.read().contents[0];
    revision = content.revisions.at(-1)!;
    assert.equal(
      (
        await post(`contents/${content.id}/approve`, {
          revisionId: revision.id,
        })
      ).status,
      400,
    );
    assert.equal((await get(`campaigns/${campaign.id}/export`)).status, 400);
    const badEdit = await post(`campaigns/${campaign.id}/revise`, {
      ...brief,
      baseVersion: 99,
    });
    assert.equal(badEdit.status, 400);
    const reopen = new Store(join(dir, "db.sqlite"));
    assert.equal(reopen.read().products.length, 1);
    assert.equal(reopen.read().assets.length, 1);
    assert.equal(reopen.read().campaigns.length, 1);
    reopen.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
