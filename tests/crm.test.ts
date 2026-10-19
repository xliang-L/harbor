import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { importLeads } from "../server/workflows/crm-routes.ts";
import { priority } from "../server/domain/crm.ts";
const row = {
  company: "DEMO",
  domain: "example.com",
  name: "Sample",
  email: "sample@example.com",
  industry: "Software",
  region: "US",
  owner: "Person",
  sourceUrl: "https://example.com",
};
test("CRM additive persistence, atomic import and deterministic intent scoring", () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-")),
    s = new Store(join(dir, "db"));
  try {
    assert.equal(s.read().crm, undefined);
    assert.throws(() =>
      s.change((x) => importLeads(x, [row, { ...row, sourceUrl: "http://127.0.0.1" }])),
    );
    assert.equal(s.read().crm, undefined);
    assert.equal(s.change((x) => importLeads(x, [row, row])).count, 1);
    s.change((x) => {
      const c = x.crm!;
      c.icp = { industries: ["Software"], regions: ["US"] };
      const l = c.leads[0];
      c.signals.push({
        id: "1",
        leadId: l.id,
        kind: "interest",
        quote: "Popular post",
        sourceUrl: "https://example.com",
        observedAt: new Date().toISOString(),
        verified: true,
      });
      assert.equal(priority(c, l).score, 30);
      c.signals.push({ ...c.signals[0], id: "2", kind: "request-quote", verified: false });
      assert.equal(priority(c, l).score, 30);
      c.signals[1].verified = true;
      assert.equal(priority(c, l).score, 80);
      c.signals[1].observedAt = "2020-01-01";
      assert.equal(priority(c, l).score, 30);
    });
    const reloaded = new Store(join(dir, "db"));
    assert.equal(reloaded.read().crm!.accounts.length, 1);
    assert.equal(reloaded.read().crm!.leads.length, 1);
    reloaded.close();
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("CRM API preview, follow-up, audit, unsent draft, CSV and invalid cross-brand IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-api-")),
    s = new Store(join(dir, "db")),
    server = createApp(s, dir).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    assert.equal((await post("crm/leads/preview", { rows: [row] })).count, 1);
    assert.equal(s.read().crm, undefined);
    assert.equal((await post("crm/leads", row)).count, 1);
    const id = s.read().crm!.leads[0].id;
    assert.equal((await post("crm/leads", row)).duplicates, 1);
    assert.equal(
      (
        await post(`crm/leads/${id}/update`, {
          stage: "contacted",
          owner: "Operator",
          actor: "Reviewer",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post(`crm/leads/${id}/tasks`, {
          title: "Call",
          owner: "Operator",
          dueAt: "2020-01-01",
        })
      ).status,
      200,
    );
    const state = await fetch(base + "crm").then((r) => r.json());
    assert.equal(state.due.length, 1);
    assert.equal(state.logs.length, 1);
    assert.equal(
      (
        await post("crm/leads/foreign/tasks", {
          title: "Call",
          owner: "Operator",
          dueAt: "2020-01-01",
        })
      ).status,
      400,
    );
    const draft = await post(`crm/leads/${id}/draft`, {});
    assert.equal(draft.status, "unsent");
    assert.equal(draft.mode, "template");
    await post(`crm/tasks/${state.due[0].id}/complete`, {});
    assert.equal((await fetch(base + "crm").then((r) => r.json())).due.length, 0);
    await post("crm/leads", { ...row, name: "=FORMULA", email: "other@example.com" });
    const csv = await fetch(base + "crm/export").then((r) => r.text());
    assert.match(csv, /'=FORMULA/);
    assert.equal(s.read().crm!.drafts.length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
