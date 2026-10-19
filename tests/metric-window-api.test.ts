import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { createWorkspaceApp } from "../server/storage/workspaces.ts";
import { previewMetrics } from "../server/workflows/routes.ts";
import { attribution, recap } from "../server/workflows/insights.ts";
import type { Metric } from "../server/types.ts";

const row = {
  contentId: "content",
  revisionId: "revision",
  campaignId: "campaign",
  channel: "email",
  url: "https://example.com/post",
  date: "2026-01-15T00:00:00Z",
  windowStart: "2026-01-01T00:00:00Z",
  windowEnd: "2026-01-08T00:00:00Z",
  impressions: 100,
  clicks: 10,
  conversions: 1,
  spend: 20,
  currency: "USD",
  timezone: "UTC",
  notes: "Synthetic report",
};
function seed(store: Store) {
  store.change((s) => {
    s.brand = {
      name: "DEMO",
      url: "https://example.com",
      product: "Demo product",
      parameters: "Provided",
      audience: "Teams",
      market: "US",
      competitors: [],
      image: "",
      updatedAt: row.date,
    };
    s.contents = [
      {
        id: "content",
        suggestion: {
          id: "suggestion",
          title: "Demo",
          reason: "Test",
          angle: "Test",
          evidenceIds: [],
          quotes: [],
          mode: "demo-template",
        },
        revisions: [
          {
            id: "revision",
            number: 1,
            copy: "Demo",
            scenes: [],
            brand: s.brand,
            evidence: [],
            createdAt: row.date,
            approvedAt: row.date,
            mode: "demo-template",
          },
        ],
      },
    ];
    s.campaigns = [
      {
        id: "campaign",
        name: "Demo",
        objective: "Observe",
        audience: "Teams",
        primaryMetric: "clicks",
        target: 100,
        budget: 0,
        currency: "USD",
        startsAt: row.windowStart,
        endsAt: row.date,
        channels: ["email"],
        productIds: [],
        assetIds: [],
        contentIds: ["content"],
        version: 1,
        createdAt: row.date,
        updatedAt: row.date,
      },
    ];
  });
}

test("preview detects cumulative and same-window conflicts on both batch rows, accepts adjacency and never mutates input", () => {
  const store = new Store(":memory:");
  seed(store);
  try {
    const state = store.read(),
      before = JSON.stringify(state);
    const cumulative = { ...row, windowEnd: "2026-01-15T00:00:00Z", impressions: 150 };
    for (const input of [
      [row, cumulative],
      [cumulative, row],
      [row, { ...row, clicks: 11 }],
    ]) {
      const result = previewMetrics({ rows: input }, state);
      assert.deepEqual(
        result.map((r) => r.valid),
        [false, false],
      );
      assert.match(result[0].error || "", /本批第 2 行/);
      assert.match(result[1].error || "", /本批第 1 行/);
    }
    const adjacent = { ...row, windowStart: row.windowEnd, windowEnd: "2026-01-15T00:00:00Z" };
    assert.deepEqual(
      previewMetrics({ rows: [row, adjacent] }, state).map((r) => r.valid),
      [true, true],
    );
    const fields = Object.keys(row) as (keyof typeof row)[];
    const csv = [
      fields.join(","),
      ...[row, cumulative].map((item) => fields.map((field) => item[field]).join(",")),
    ].join("\n");
    const csvResult = previewMetrics({ csv }, state);
    assert.deepEqual(
      csvResult.map((r) => r.valid),
      [false, false],
      "CSV must use the same overlap check",
    );
    assert.equal(csvResult[0].metric?.windowStart, "2026-01-01T00:00:00.000Z");
    const repeated = previewMetrics(
      {
        rows: [
          row,
          {
            ...row,
            date: "2026-01-16T00:00:00Z",
            timezone: "Asia/Shanghai",
            windowStart: "2026-01-01T08:00:00+08:00",
            windowEnd: "2026-01-08T08:00:00+08:00",
          },
        ],
      },
      state,
    );
    assert.deepEqual(
      repeated.map((r) => r.duplicate),
      [false, true],
    );
    assert.equal(JSON.stringify(state), before);
  } finally {
    store.close();
  }
});

test("API rejects invalid ranges and atomic batch conflicts, revalidates stale previews, and preserves voided originals for correction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-metric-window-api-")),
    store = new Store(join(dir, "db.sqlite"));
  seed(store);
  const app = createApp(store, join(dir, "output")),
    server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  const post = async (path: string, body: unknown, key = crypto.randomUUID()) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (const invalid of [
      { windowStart: undefined },
      { windowEnd: "" },
      { windowEnd: row.windowStart },
      { windowEnd: "2025-01-01T00:00:00Z" },
      { windowStart: "2026-02-30T00:00:00Z" },
      { windowStart: "2026-01-01T00:00:00" },
      { windowEnd: "2099-01-01T00:00:00Z" },
      { date: "2026-01-07T00:00:00Z" },
      { date: "2026-02-30T00:00:00Z" },
      { date: "2026-01-15T12:00:00" },
    ])
      assert.equal((await post("metrics", { ...row, ...invalid })).status, 400);
    assert.equal(store.read().metrics.length, 0);
    const firstPreview = await post("metrics/preview", { rows: [row] });
    assert.equal(firstPreview.body.rows[0].valid, true);
    const cumulative = { ...row, windowEnd: row.date, impressions: 150 };
    assert.equal((await post("metrics", cumulative)).status, 200);
    const staleImport = await post("metrics/import", {
      rows: [row, { ...row, url: "https://example.com/another" }],
    });
    assert.equal(staleImport.status, 400);
    assert.match(staleImport.body.rows[0].error, /已有记录/);
    assert.equal(
      store.read().metrics.length,
      1,
      "no independent row is written after any batch error",
    );
    assert.equal(
      (
        await post("metrics", {
          ...cumulative,
          timezone: "Asia/Shanghai",
          date: "2026-01-16T00:00:00Z",
        })
      ).body.count,
      0,
    );
    assert.equal((await post("metrics", { ...cumulative, impressions: 160 })).status, 400);
    assert.equal(
      (await post("metrics", { ...cumulative, currency: "EUR", spend: 18 })).status,
      400,
      "currency conversion cannot double-count the same traffic",
    );
    const original = structuredClone(store.read().metrics[0]),
      key = crypto.randomUUID();
    for (const input of [
      { actor: "", reason: "wrong total" },
      { actor: "Reviewer", reason: " " },
    ])
      assert.equal((await post(`metrics/${original.id}/void`, input)).status, 400);
    assert.equal(
      (
        await post(
          `metrics/${original.id}/void`,
          { actor: "Reviewer", reason: "Cumulative total imported by mistake" },
          key,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await post(
          `metrics/${original.id}/void`,
          { actor: "Reviewer", reason: "Cumulative total imported by mistake" },
          key,
        )
      ).status,
      200,
    );
    const voided = store.read().metrics[0];
    for (const field of Object.keys(original) as (keyof Metric)[])
      assert.deepEqual(voided[field], original[field]);
    assert.equal(voided.voidedBy, "Reviewer");
    assert.equal(
      (await post(`metrics/${original.id}/void`, { actor: "Other", reason: "Overwrite history" }))
        .status,
      400,
    );
    assert.equal(attribution(store.read()).rows.length, 0);
    assert.equal((await post("metrics/import", { rows: [row] })).body.count, 1);
    const report = await fetch(base + "planning").then((r) => r.json());
    assert.equal(report.campaigns[0].feedback.observed, 10);
    assert.equal(report.campaigns[0].feedback.samples, 1);
    assert.equal(report.campaigns[0].feedback.excludedSamples, 1);
    const reloaded = new Store(join(dir, "db.sqlite"));
    assert.equal(reloaded.read().metrics.length, 2);
    assert.equal(reloaded.read().metrics[0].voidReason, "Cumulative total imported by mistake");
    reloaded.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy and conflicting history is visible but excluded consistently from recap and attribution", () => {
  const store = new Store(":memory:");
  seed(store);
  try {
    const s = store.read();
    s.metrics = [
      { ...row, id: "old", windowStart: undefined, windowEnd: undefined },
      { ...row, id: "a" },
      { ...row, id: "b", windowEnd: row.date, impressions: 150 },
      { ...row, id: "safe", url: "https://example.com/safe" },
    ];
    const before = JSON.stringify(s),
      report = attribution(s),
      summary = recap(s)[0];
    assert.deepEqual(
      report.rows.map((m) => m.id),
      ["safe"],
    );
    assert.equal(report.quality.counts.missingWindow, 1);
    assert.equal(report.quality.counts.conflict, 2);
    assert.equal(summary.samples, 1);
    assert.equal(summary.excludedSamples, 3);
    assert.equal(summary.groups[0].impressions, 100);
    assert.equal(JSON.stringify(s), before);
    const legacy = previewMetrics(
      { rows: [{ ...row, windowStart: undefined, windowEnd: undefined }] },
      store.read(),
    )[0];
    assert.equal(legacy.valid, true);
    assert.match(legacy.warnings?.join() || "", /窗口/);
  } finally {
    store.close();
  }
});

test("metric correction cannot cross workspace boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-metric-window-isolation-"));
  const a = new Store(join(dir, "projects", "alpha", "harbor.sqlite"));
  seed(a);
  a.change((s) => s.metrics.push({ ...row, id: "alpha-metric" }));
  a.close();
  const b = new Store(join(dir, "projects", "beta", "harbor.sqlite"));
  seed(b);
  b.close();
  const app = createWorkspaceApp(dir, join(dir, "output")),
    server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  try {
    const response = await fetch(base + "metrics/alpha-metric/void?project=beta", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ actor: "Reviewer", reason: "Wrong brand" }),
    });
    assert.equal(response.status, 400);
    const aState = await fetch(base + "state?project=alpha").then((r) => r.json());
    assert.equal(aState.metrics[0].voidedAt, undefined);
  } finally {
    app.locals.stopScheduler();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
