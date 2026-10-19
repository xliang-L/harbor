import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../server/types.ts";
import { Store } from "../server/store.ts";
import { emptyRetail } from "../server/domain/retail.ts";
import { parseOrders, previewOrders, orderMapping } from "../server/connectors/orders.ts";
import { orderRoutes } from "../server/workflows/order-routes.ts";
const text = readFileSync(new URL("../fixtures/orders-demo.csv", import.meta.url), "utf8");
const input = { text, sourceName: "demo-orders", demo: true };
function seed(state: State) {
  state.retail = emptyRetail();
  state.retail.stores.push({
    id: "DEMO-STORE",
    name: "Demo",
    region: "Test",
    address: "Test",
    updatedAt: new Date().toISOString(),
  });
  state.products.push({
    id: "demo-product",
    sku: "DEMO-SKU",
    title: "Demo",
    description: "Demo only",
    price: 20,
    currency: "USD",
    url: "https://example.com",
    evidenceId: "demo-evidence",
    sourceName: "demo",
    importedAt: new Date().toISOString(),
    demo: true,
  });
}
test("orders parser enforces line net amount, explicit values, mapping and timestamps", () => {
  assert.equal(parseOrders(input).rows.length, 2);
  assert.throws(
    () => parseOrders({ ...input, mapping: { ...orderMapping, revenue: "Total" } }),
    /订单总额/,
  );
  assert.throws(
    () =>
      parseOrders({
        ...input,
        text: text.replace("externalId,storeId", "externalId,externalId"),
      }),
    /表头/,
  );
  assert.equal(
    parseOrders({ ...input, text: text.replace(",2,40,", ",2,,") }).rows[0].valid,
    false,
  );
  assert.equal(
    parseOrders({ ...input, text: text.replace(",2,40,", ",2,40.999,") }).rows[0].valid,
    false,
  );
  assert.equal(
    parseOrders({ ...input, text: text.replace(",2,40,", ",2,-40,") }).rows[0].valid,
    false,
  );
  assert.equal(
    parseOrders({
      ...input,
      text: text.replace("2026-10-01T10:00:00Z", "2026-10-01"),
    }).rows[0].valid,
    false,
  );
  assert.equal(
    parseOrders({
      ...input,
      text: text.replace("2026-10-01T10:00:00Z", "2026-02-30T10:00:00Z"),
    }).rows[0].valid,
    false,
  );
  assert.equal(
    parseOrders({
      ...input,
      text: text.replace("externalId", "Line ID"),
      mapping: { ...orderMapping, externalId: "Line ID" },
    }).rows[0].row.externalId,
    "demo-order-001-line-1",
  );
});
test("orders API: preview immutable, reversed returns, duplicates, conflicts, refund boundaries and brand isolation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-orders-"));
  const store = new Store(join(dir, "one.sqlite")),
    other = new Store(join(dir, "two.sqlite"));
  store.change(seed);
  const app = express();
  app.use(express.json());
  orderRoutes(app, store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/orders/`;
  const post = async (path: string, body = input) => {
    const r = await fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const before = JSON.stringify(store.read()),
      otherBefore = JSON.stringify(other.read());
    const reversed = text.trim().split("\n");
    const reverseText = [reversed[0], reversed[2], reversed[1]].join("\n");
    assert.equal((await post("preview", { ...input, text: reverseText })).valid, true);
    assert.equal(JSON.stringify(store.read()), before);
    assert.equal(previewOrders(input, other.read()).valid, false);
    const invalid = await post("import", {
      ...input,
      text: text.replace(",-1,-20,", ",-3,-60,"),
    });
    assert.equal(invalid.status, 400);
    assert.equal(JSON.stringify(store.read()), before);
    const result = await post("import", { ...input, text: reverseText });
    assert.equal(result.count, 2);
    const after = JSON.stringify(store.read());
    const repeat = await post("import");
    assert.equal(repeat.count, 0);
    assert.equal(repeat.duplicates, 2);
    const conflict = await post("import", {
      ...input,
      text: text.replace(",2,40,", ",2,41,"),
    });
    assert.equal(conflict.status, 400);
    assert.equal(JSON.stringify(store.read()), after);
    const badReturn = [
      reversed[0],
      reversed[2].replace("demo-return-001", "demo-return-002").replace(",-1,-20,", ",-2,-40,"),
    ].join("\n");
    assert.equal((await post("import", { ...input, text: badReturn })).status, 400);
    const early = [
      reversed[0],
      reversed[2].replace("demo-return-001", "demo-return-003").replace("2026-10-02", "2026-09-30"),
    ].join("\n");
    assert.equal((await post("import", { ...input, text: early })).status, 400);
    assert.equal(JSON.stringify(other.read()), otherBefore);
    assert.equal(store.read().metrics.length, 0);
    assert.equal(
      store.read().retail!.sales.reduce((sum, row) => sum + row.revenue, 0),
      20,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
