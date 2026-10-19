import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewInbound, defaultMapping, inboundStatus } from "../../server/connectors/inbound.ts";
import { inboundRoutes } from "../../server/routes/inbound.ts";
import { Store } from "../../server/storage/store.ts";
const text = readFileSync(new URL("../../fixtures/hubspot-demo.json", import.meta.url), "utf8");
test("HubSpot mock contract: properties, mapping, archived and validation", () => {
  const preview = previewInbound({ text });
  assert.equal(preview.valid, true);
  assert.equal(preview.rows[0].row.name, "Demo Buyer");
  assert.equal(preview.rows[0].row.domain, "retail.example.com");
  assert.equal(previewInbound({ text: '[{"company":"A","email":"bad"}]' }).valid, false);
  assert.equal(previewInbound({ text: '[{"archived":true}]' }).skipped, 1);
  assert.equal(
    previewInbound({
      text: '[{"org":"A","email":"a@example.com"}]',
      mapping: { ...defaultMapping, company: "org" },
    }).rows[0].row.company,
    "A",
  );
  assert.throws(() => previewInbound({ text: '{"eventId":123}' }), /webhook/);
  assert.equal(
    previewInbound({
      text: '[{"company":"A","email":"a@example.com","sourceUrl":"javascript:alert(1)"}]',
    }).valid,
    false,
  );
  assert.equal(inboundStatus.hubspot, "not-connected");
});
test("local HubSpot routes: dry-run, atomic validation, idempotent import and store isolation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-inbound-"));
  const store = new Store(join(dir, "one.sqlite"));
  const other = new Store(join(dir, "two.sqlite"));
  const app = express();
  app.use(express.json());
  inboundRoutes(app, store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/integrations/hubspot/`;
  const post = async (path: string, text: string) => {
    const r = await fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const before = JSON.stringify(store.read()),
      untouched = JSON.stringify(other.read());
    const preview = await post("preview", text);
    assert.equal(preview.counts.count, 2);
    const archived = await post("preview", '[{"archived":true}]');
    assert.equal(archived.counts.count, 0);
    const skip = await post("import", '[{"archived":true}]');
    assert.equal(skip.skipped, 1);
    assert.equal(skip.count, 0);
    assert.equal(JSON.stringify(store.read()), before);
    const bad = await post(
      "import",
      '[{"company":"A","email":"good@example.com"},{"company":"B","email":"bad"}]',
    );
    assert.equal(bad.status, 400);
    assert.equal(JSON.stringify(store.read()), before);
    const result = await post("import", text);
    assert.equal(result.count, 2);
    const repeat = await post("import", text);
    assert.equal(repeat.count, 0);
    assert.equal(repeat.duplicates, 2);
    assert.equal(JSON.stringify(other.read()), untouched);
    assert.equal(result.externalActions, "none");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
