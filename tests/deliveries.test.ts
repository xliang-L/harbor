import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { createWorkspaceApp } from "../server/storage/workspaces.ts";
import { overview } from "../server/domain/overview.ts";
import { deliveryIssues } from "../server/domain/deliveries.ts";

function seed(store: Store) {
  const at = new Date(Date.now() - 86400000).toISOString();
  store.change((s) => {
    s.brand = {
      name: "DEMO",
      url: "https://example.com",
      product: "Product",
      parameters: "Test",
      audience: "Teams",
      market: "US",
      competitors: [],
      image: "",
      updatedAt: at,
    };
    s.evidence = [
      {
        id: "e",
        title: "DEMO source",
        url: "https://example.com",
        text: "Our company publishes an annual plan for its teams.",
        hash: "existing",
        demo: true,
        kind: "manual",
        capturedAt: at,
        publishedAt: at,
      },
    ];
    s.facts = [
      {
        id: "f",
        text: "Company publishes an annual plan",
        quote: "publishes an annual plan",
        evidenceId: "e",
        scope: "brand",
        confirmedBy: "Demo reviewer",
        confirmedAt: at,
      },
    ];
    s.contents = [
      {
        id: "c",
        suggestion: {
          id: "s",
          title: "Annual plan",
          reason: "Test",
          angle: "Test",
          quotes: [],
          evidenceIds: ["e"],
          mode: "demo-template",
        },
        revisions: [
          {
            id: "r",
            number: 1,
            createdAt: at,
            approvedAt: at,
            copy: "Our company publishes an annual plan.",
            scenes: [],
            mode: "demo-template",
            brand: s.brand,
            evidence: s.evidence,
            facts: structuredClone(s.facts),
          },
        ],
      },
    ];
    s.calendar = [
      {
        id: "cal",
        contentId: "c",
        revisionId: "r",
        channel: "x",
        account: "demo-account",
        copy: "Our company publishes an annual plan.",
        headline: "Annual plan",
        targetUrl: "https://example.com",
        campaign: "Demo",
        createdAt: at,
        approvedAt: at,
        scheduledAt: new Date(Date.now() - 3600000).toISOString(),
      },
    ];
  });
}

test("manual delivery is version-bound, idempotent, auditable after withdrawal, and removable from pending only by an active receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-deliveries-"));
  const store = new Store(join(dir, "harbor.sqlite"));
  seed(store);
  const app = createApp(store, join(dir, "output"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown, key = randomUUID()) => {
    const response = await fetch(base + "/api/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const input = {
    revisionId: "r",
    deliveredAt: new Date().toISOString(),
    destinationUrl: "https://example.com/post?b=2&a=1",
    externalId: "post-1",
    actor: "Demo operator",
    notes: "Manual test only",
  };
  try {
    assert.equal(overview(store.read()).counts.recentDue, 1);
    for (const invalid of [
      { ...input, revisionId: "other" },
      { ...input, actor: "" },
      { ...input, destinationUrl: "", externalId: "" },
      { ...input, deliveredAt: new Date(Date.now() + 3600000).toISOString() },
      { ...input, deliveredAt: "2026-02-30T12:00:00Z" },
      { ...input, deliveredAt: new Date(Date.now() - 172800000).toISOString() },
      { ...input, destinationUrl: "javascript:alert(1)" },
      { ...input, destinationUrl: "http://127.0.0.1/private" },
    ])
      assert.equal((await post("calendar/cal/deliveries", invalid)).status, 400);
    assert.equal(store.read().deliveries, undefined);
    const key = randomUUID(),
      created = await post("calendar/cal/deliveries", input, key);
    assert.equal(created.status, 200);
    assert.equal(created.body.source, "manual");
    assert.equal(created.body.snapshot.copy, store.read().calendar[0].copy);
    assert.deepEqual(created.body.factIds, ["f"]);
    assert.equal((await post("calendar/cal/deliveries", input, key)).body.id, created.body.id);
    assert.equal((await post("calendar/cal/deliveries", input)).status, 400);
    assert.equal(
      (await post("calendar/cal/deliveries", { ...input, notes: "different" }, key)).status,
      409,
    );
    assert.equal(store.read().deliveries?.length, 1);
    assert.equal(overview(store.read()).counts.recentDue, 0);
    assert.equal(overview(store.read()).recentDeliveries.length, 1);
    store.change((s) => s.calendar.push({ ...s.calendar[0], id: "cal-2" }));
    assert.equal(
      (
        await post("calendar/cal-2/deliveries", {
          ...input,
          externalId: "different",
          destinationUrl: "https://example.com/post?a=1&b=2#section",
        })
      ).status,
      400,
    );
    const immutableSnapshot = JSON.stringify(store.read().deliveries![0].snapshot);
    assert.equal(
      (await post("facts/f/withdraw", { actor: "Reviewer", reason: "Source no longer applies" }))
        .status,
      200,
    );
    assert.equal(overview(store.read()).deliveryAlerts.length, 1);
    assert.equal(
      overview(store.read()).recentDeliveries.length,
      1,
      "withdrawal cannot erase a recorded historical delivery",
    );
    const exported = await fetch(`${base}/api/deliveries/${created.body.id}/export`).then((r) =>
      r.json(),
    );
    assert.match(exported.currentFactIssues[0], /已撤回/);
    assert.equal(JSON.stringify(exported.snapshot), immutableSnapshot);
    assert.equal(
      (
        await post("calendar/cal-2/deliveries", {
          ...input,
          externalId: "other",
          destinationUrl: "https://example.com/other",
        })
      ).status,
      400,
    );
    const voided = await post(`deliveries/${created.body.id}/void`, {
      actor: "Operator",
      reason: "Entered the wrong external receipt",
    });
    assert.equal(voided.status, 200);
    assert.equal(store.read().deliveries![0].voidedBy, "Operator");
    assert.equal(JSON.stringify(store.read().deliveries![0].snapshot), immutableSnapshot);
    assert.equal(overview(store.read()).deliveryAlerts.length, 0);
    assert.equal(overview(store.read()).counts.recentDue, 2);
    assert.equal(
      (
        await post(`deliveries/${created.body.id}/void`, {
          actor: "Different",
          reason: "Overwrite",
        })
      ).status,
      400,
    );
    assert.equal(store.read().deliveries![0].voidedBy, "Operator");
    const reopened = new Store(join(dir, "harbor.sqlite"));
    assert.equal(reopened.read().deliveries![0].voidReason, "Entered the wrong external receipt");
    reopened.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delivery eligibility rejects stale, archived, unapproved, and withdrawn dependencies", () => {
  const store = new Store(":memory:");
  seed(store);
  try {
    const state = store.read(),
      entry = state.calendar[0];
    assert.deepEqual(deliveryIssues(state, entry), []);
    assert.match(
      deliveryIssues(state, { ...entry, archivedAt: new Date().toISOString() }).join(),
      /归档/,
    );
    assert.match(deliveryIssues(state, { ...entry, approvedAt: undefined }).join(), /渠道/);
    assert.match(deliveryIssues(state, { ...entry, revisionId: "stale" }).join(), /版本/);
    state.guidelines = {
      goal: "New",
      tone: "Clear",
      valueProposition: "Test",
      forbiddenClaims: [],
      primaryMetric: "clicks",
      target: 1,
      updatedAt: new Date().toISOString(),
    };
    assert.match(deliveryIssues(state, entry).join(), /尚未有效批准/);
  } finally {
    store.close();
  }
});

test("delivery endpoints reject cross-brand references and hide receipt exports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-delivery-isolation-"));
  const db = new Store(join(dir, "projects", "alpha", "harbor.sqlite"));
  seed(db);
  db.close();
  const app = createWorkspaceApp(dir, join(dir, "output"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const payload = {
    revisionId: "r",
    deliveredAt: new Date().toISOString(),
    externalId: "receipt",
    actor: "Demo",
  };
  const post = (project: string, path: string) =>
    fetch(`${base}/api/${path}?project=${project}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(payload),
    });
  try {
    const response = await post("alpha", "calendar/cal/deliveries");
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal((await post("default", "calendar/cal/deliveries")).status, 400);
    assert.equal((await fetch(`${base}/api/deliveries/${receipt.id}/export`)).status, 404);
    const other = await fetch(`${base}/api/deliveries`).then((r) => r.json());
    assert.deepEqual(other.entries, []);
    assert.equal(
      (
        await fetch(`${base}/api/deliveries?project=alpha`, {
          headers: { "X-Harbor-Project": "default" },
        })
      ).status,
      400,
    );
  } finally {
    app.locals.stopScheduler();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
