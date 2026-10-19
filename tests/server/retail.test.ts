import { reviewQueue } from "../../server/routes/console.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/storage/store.ts";
import {
  emptyRetail,
  importSales,
  importInventory,
  retailInsights,
  retailSummary,
} from "../../server/domain/retail.ts";
import type { State } from "../../server/types.ts";
const now = Date.now();
const date = new Date(now - 86400000).toISOString();
function fixture(): State {
  return {
    retail: {
      ...emptyRetail(),
      stores: [
        {
          id: "shop",
          name: "Shop",
          region: "North",
          address: "Local",
          updatedAt: date,
        },
        {
          id: "other",
          name: "Other",
          region: "South",
          address: "Local",
          updatedAt: date,
        },
      ],
    },
    products: [{ id: "product", sku: "SKU" }],
    campaigns: [
      {
        id: "campaign",
        name: "Demo",
        contentIds: [],
        channels: [],
        productIds: [],
        assetIds: [],
        startsAt: date,
        endsAt: new Date(now + 86400000).toISOString(),
        version: 1,
        objective: "Demo",
        audience: "Demo",
        primaryMetric: "clicks",
        target: 1,
        budget: 0,
        currency: "USD",
        createdAt: date,
        updatedAt: date,
      },
    ],
    guidelines: null,
    brand: null,
  } as unknown as State;
}
const sale = {
  externalId: "sale",
  storeId: "shop",
  sku: "SKU",
  date,
  quantity: 2,
  revenue: 10,
  currency: "USD",
  kind: "sale",
  originalId: "",
  campaignId: "",
  channel: "",
  sourceName: "register.csv",
  demo: false,
};
const refund = {
  ...sale,
  externalId: "return",
  kind: "return",
  originalId: "sale",
  quantity: -1,
  revenue: -5,
};
const stock = {
  storeId: "shop",
  sku: "SKU",
  asOf: date,
  quantity: 25,
  sourceName: "stock.csv",
  demo: false,
};

test("invalid calendar/locale dates are rejected without writes", () => {
  for (const asOf of ["2026-02-30", "01/02/2026", "2026-01-01T12:00:00"])
    assert.throws(() => importInventory(fixture(), [{ ...stock, asOf }]));
});

test("inventory rejects missing/noninteger/negative stock and preserves batch atomicity; equivalent timestamps are idempotent", () => {
  const s = fixture();
  for (const quantity of ["", " ", null, undefined, "0x10", "1e2", -1, 1.5, Infinity])
    assert.throws(() =>
      importInventory(s, [stock, { ...stock, asOf: new Date(now - 1000).toISOString(), quantity }]),
    );
  assert.equal(s.retail!.inventory.length, 0);
  assert.deepEqual(importInventory(s, [stock, stock]), {
    count: 1,
    duplicates: 1,
  });
  assert.deepEqual(importInventory(s, [stock]), { count: 0, duplicates: 1 });
  assert.throws(() => importInventory(s, [{ ...stock, quantity: 24 }]), /冲突/);
  assert.equal(s.retail!.inventory[0].quantity, 25);
});
test("sales import resolves reverse-order returns, rejects conflicting IDs and bounds cumulative quantities and cents", () => {
  const s = fixture();
  assert.deepEqual(importSales(s, [refund, sale]), { count: 2, duplicates: 0 });
  assert.deepEqual(importSales(s, [sale, refund]), { count: 0, duplicates: 2 });
  assert.throws(() => importSales(s, [{ ...sale, revenue: 11 }]), /冲突/);
  for (const value of [
    { quantity: -2, revenue: -5 },
    { quantity: -1, revenue: -6 },
  ])
    assert.throws(() => importSales(s, [{ ...refund, ...value, externalId: "excess" }]), /超过/);
  assert.equal(s.retail!.sales.length, 2);
  importSales(s, [{ ...refund, externalId: "remaining" }]);
  assert.equal(retailSummary(s).groups[0].netRevenue, 0);
  assert.equal(retailSummary(s).groups[0].netUnits, 0);
});
test("returns reject cross-store/currency/sku/demo/attribution and dates before sale", () => {
  for (const change of [
    { storeId: "other" },
    { currency: "EUR" },
    { sku: "FOREIGN" },
    { demo: true },
    { campaignId: "campaign" },
    { channel: "email" },
    { date: new Date(now - 2 * 86400000).toISOString() },
    { originalId: "missing" },
    { quantity: 1 },
    { revenue: 1 },
  ]) {
    const s = fixture();
    importSales(s, [sale]);
    assert.throws(() => importSales(s, [{ ...refund, ...change }]));
    assert.equal(s.retail!.sales.length, 1);
  }
});
test("current-brand references are required; demo and currency groups never mix; unknown attribution remains explicit", () => {
  const s = fixture();
  for (const change of [{ storeId: "foreign" }, { sku: "foreign" }, { campaignId: "foreign" }])
    assert.throws(() => importSales(s, [{ ...sale, ...change }]));
  for (const change of [{ storeId: "foreign" }, { sku: "foreign" }])
    assert.throws(() => importInventory(s, [{ ...stock, ...change }]));
  importSales(s, [
    sale,
    { ...sale, externalId: "demo", demo: true },
    { ...sale, externalId: "eur", currency: "EUR", campaignId: "campaign" },
  ]);
  const summary = retailSummary(s);
  assert.equal(summary.groups.length, 3);
  assert.equal(summary.unknownAttribution, 2);
  importInventory(s, [stock, { ...stock, demo: true }]);
  assert.equal(retailInsights(s, now).length, 2);
  assert.equal(retailInsights(s, now)[0].netUnits, 4);
  assert.equal(retailInsights(s, now)[1].netUnits, 2);
});
test("missing sales and stale stock do not produce promotion recommendations", () => {
  const s = fixture();
  importInventory(s, [stock]);
  assert.equal(retailInsights(s, now)[0].eligible, false);
  assert.match(retailInsights(s, now)[0].suggestion, /缺少/);
  importSales(s, [sale]);
  assert.equal(retailInsights(s, now)[0].eligible, true);
  assert.equal(retailInsights(s, now + 8 * 86400000)[0].eligible, false);
  assert.match(retailInsights(s, now + 8 * 86400000)[0].suggestion, /刷新/);
});
test("failed import transaction rolls back SQLite and survives reload without partial rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-retail-"));
  const path = join(dir, "state.sqlite");
  const store = new Store(path);
  try {
    store.change((s) => Object.assign(s, fixture()));
    assert.throws(() =>
      store.change((s) => {
        importSales(s, [sale]);
        importSales(s, [{ ...refund, quantity: -3 }]);
      }),
    );
    assert.equal(store.read().retail!.sales.length, 0);
    const again = new Store(path);
    assert.equal(again.read().retail!.sales.length, 0);
    again.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retail API preview/import, approval versioning, redemption limits, return offsets and immutable void audit", async () => {
  const { createApp } = await import("../../server/app.ts");
  const dir = mkdtempSync(join(tmpdir(), "harbor-retail-api-"));
  const store = new Store(join(dir, "test.sqlite"));
  store.change((s) => Object.assign(s, fixture()));
  const server = createApp(store, join(dir, "artifacts")).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/retail`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const get = () => fetch(base).then((r) => r.json());
  const csv = (rows: Record<string, unknown>[], fields: string[]) =>
    [fields.join(","), ...rows.map((row) => fields.map((k) => row[k] ?? "").join(","))].join("\n");
  const salesFields = [
    "externalId",
    "storeId",
    "sku",
    "date",
    "quantity",
    "revenue",
    "currency",
    "kind",
    "originalId",
    "campaignId",
    "channel",
  ];
  const importRows = (kind: string, rows: Record<string, unknown>[], preview = false) =>
    post(preview ? "/import/preview" : "/import", {
      kind,
      csv: csv(rows, kind === "inventory" ? ["storeId", "sku", "asOf", "quantity"] : salesFields),
      sourceName: kind === "inventory" ? "stock.csv" : "register.csv",
      demo: false,
    });
  try {
    assert.equal(
      (await post("/stores", { id: "shop", name: "Overwrite", region: "West" })).status,
      400,
    );
    assert.equal((await importRows("inventory", [stock], true)).body.dryRun, true);
    assert.equal(store.read().retail!.inventory.length, 0);
    assert.equal(
      (await importRows("inventory", [stock, { ...stock, sku: "foreign" }])).status,
      400,
    );
    assert.equal(store.read().retail!.inventory.length, 0);
    assert.equal((await importRows("inventory", [stock])).body.count, 1);
    assert.equal((await importRows("inventory", [stock])).body.duplicates, 1);
    assert.equal(
      (
        await importRows("sales", [
          sale,
          { ...sale, externalId: "second", quantity: 1, revenue: 5 },
        ])
      ).body.count,
      2,
    );
    const created = await post("/promotions", {
      storeId: "shop",
      sku: "SKU",
      demo: false,
    });
    assert.equal(created.status, 200);
    const id = created.body.id;
    assert.equal(
      reviewQueue("local", store.read()).filter((x) => x.kind === "promotion").length,
      1,
    );
    const exportStatus = () => fetch(base + `/promotions/${id}/export`).then((r) => r.status);
    assert.equal(await exportStatus(), 400);
    const original = (await get()).promotions[0];
    const edit = {
      baseVersion: 1,
      title: "Clear offer",
      copy: "Local offer terms",
      discountPercent: 10,
      startsAt: new Date(now - 2 * 86400000).toISOString(),
      endsAt: new Date(now + 86400000).toISOString(),
      maxRedemptions: 1,
    };
    assert.equal((await post(`/promotions/${id}/update`, edit)).status, 200);
    assert.equal(
      (
        await post(`/promotions/${id}/approve`, {
          baseVersion: 1,
          actor: "Reviewer",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(`/promotions/${id}/approve`, {
          baseVersion: 2,
          actor: "Reviewer",
        })
      ).status,
      200,
    );
    assert.equal(await exportStatus(), 200);
    assert.equal(
      reviewQueue("local", store.read()).filter((x) => x.kind === "promotion").length,
      0,
    );
    const audit = store.read().reviewEvents!.find((x) => x.kind === "promotion")!;
    assert.equal(audit.targetVersion, 2);
    assert.ok(audit.approvedFingerprint);
    let state = await get();
    const receipt = {
      promotionId: id,
      saleId: state.sales.find((x: { externalId: string }) => x.externalId === "sale").id,
      externalId: "receipt",
      actor: "Operator",
    };
    const redeemed = await post("/redemptions", receipt);
    assert.equal(redeemed.status, 200);
    assert.equal((await post("/redemptions", receipt)).body.duplicate, true);
    assert.equal(
      (
        await post("/redemptions", {
          ...receipt,
          externalId: "other",
          saleId: state.sales.find((x: { externalId: string }) => x.externalId === "second").id,
        })
      ).status,
      400,
    );
    assert.equal((await importRows("sales", [refund])).body.count, 1);
    state = await get();
    assert.equal(state.summary.promotions[0].groups[0].netUnits, 1);
    assert.equal(state.summary.promotions[0].groups[0].netRevenue, 5);
    assert.equal(await exportStatus(), 400);
    assert.equal(
      (
        await post(`/redemptions/${redeemed.body.id}/void`, {
          reason: "Recorded in error",
          actor: "Operator",
        })
      ).status,
      200,
    );
    state = await get();
    assert.equal(state.redemptions.length, 1);
    assert.equal(state.redemptions[0].voidReason, "Recorded in error");
    assert.equal(state.summary.promotions[0].recorded, 0);
    assert.equal(state.summary.promotions[0].voided, 1);
    assert.equal((await post("/redemptions", receipt)).status, 400);
    assert.equal((await post(`/promotions/${id}/update`, { ...edit, baseVersion: 2 })).status, 200);
    assert.equal(
      (
        await post(`/promotions/${id}/approve`, {
          baseVersion: 3,
          actor: "Reviewer",
        })
      ).status,
      200,
    );
    assert.equal(await exportStatus(), 200);
    assert.equal(
      (
        await importRows("inventory", [
          { ...stock, asOf: new Date(now - 1000).toISOString(), quantity: 24 },
        ])
      ).status,
      200,
    );
    assert.equal(await exportStatus(), 400);
    assert.equal(
      (
        await post(`/promotions/${id}/update`, {
          ...edit,
          baseVersion: 3,
          startsAt: new Date(now - 3 * 86400000).toISOString(),
          endsAt: new Date(now - 2 * 86400000).toISOString(),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post(`/promotions/${id}/approve`, {
          baseVersion: 4,
          actor: "Reviewer",
        })
      ).status,
      400,
    );
    const future = await post("/promotions", {
      storeId: "shop",
      sku: "SKU",
      demo: false,
    });
    assert.equal(
      (
        await post(`/promotions/${future.body.id}/approve`, {
          baseVersion: 1,
          actor: "Reviewer",
        })
      ).status,
      200,
    );
    const outside = await post("/redemptions", {
      ...receipt,
      promotionId: future.body.id,
      externalId: "outside-period",
    });
    assert.equal(outside.status, 400);
    assert.match(outside.body.error, /期间/);
    assert.equal(
      (
        await post("/redemptions", {
          ...receipt,
          promotionId: "foreign",
          externalId: "cross-brand",
        })
      ).status,
      400,
    );
    assert.equal(original.version, 1);
    assert.equal(
      store.read().retail!.promotions[0].history.filter((x) => x.action === "approved").length,
      2,
    );
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
