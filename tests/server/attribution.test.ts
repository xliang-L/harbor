import { test } from "node:test";
import assert from "node:assert/strict";
import type { State, Metric } from "../../server/types.ts";
import { attribution, recap } from "../../server/domain/insights.ts";
import { previewMetrics } from "../../server/routes/operations.ts";

const row = {
  id: "m1",
  contentId: "c1",
  revisionId: "r1",
  url: "https://example.com/p",
  date: "2026-01-02",
  windowStart: "2026-01-01T00:00:00Z",
  windowEnd: "2026-01-02T00:00:00Z",
  currency: "USD",
  timezone: "UTC",
  impressions: 100,
  clicks: 10,
  conversions: 2,
  spend: 20,
  notes: "aggregate daily window",
};
function fixture(): State {
  return {
    contents: [
      {
        id: "c1",
        suggestion: { title: "Shared content" },
        revisions: [
          { id: "r1", approvedAt: "2026-01-01", copy: "Demo", scenes: [], brand: { image: "" } },
        ],
      },
    ],
    campaigns: [
      { id: "a", name: "Alpha", contentIds: ["c1"] },
      { id: "b", name: "Beta", contentIds: ["c1"] },
    ],
    metrics: [],
  } as unknown as State;
}
test("shared content is attributed once only with explicit campaign or unique UTM; missing/ambiguous attribution stays unknown", () => {
  const s = fixture();
  s.metrics = [
    row,
    { ...row, id: "m2", url: "https://example.com/email", campaignId: "a", channel: "email" },
    {
      ...row,
      id: "m3",
      url: "https://example.com/p?utm_campaign=Beta&utm_source=linkedin&utm_medium=social",
    },
  ];
  const report = attribution(s);
  assert.equal(report.unknownSamples, 1);
  assert.deepEqual(
    report.groups.map((g) => [g.campaignId, g.clicks]),
    [
      [null, 10],
      ["a", 10],
      ["b", 10],
    ],
  );
  assert.equal(report.rows[2].attribution.utm.medium, "social");
  s.campaigns[0].name = "Beta";
  assert.equal(attribution(s).unknownSamples, 2);
});
test("import identity ignores URL order, observation time and timezone labels; changed totals conflict and explicit channel/campaign dimensions remain separate", () => {
  const s = fixture();
  const original = {
    ...row,
    url: "https://example.com/p?b=2&a=1#top",
    campaignId: "a",
    channel: "email",
  };
  const first = previewMetrics({ rows: [original] }, s)[0];
  assert.equal(first.valid, true);
  s.metrics.push(first.metric!);
  const duplicate = {
    ...original,
    url: "https://example.com/p?a=1&b=2",
    date: "2026-01-03T00:00:00Z",
    timezone: "Asia/Shanghai",
  };
  assert.equal(previewMetrics({ rows: [duplicate] }, s)[0].duplicate, true);
  assert.equal(previewMetrics({ rows: [{ ...duplicate, clicks: 15 }] }, s)[0].valid, false);
  assert.equal(
    previewMetrics({ rows: [{ ...duplicate, channel: "linkedin" }] }, s)[0].duplicate,
    false,
  );
  assert.equal(
    previewMetrics({ rows: [{ ...duplicate, campaignId: "b" }] }, s)[0].duplicate,
    false,
  );
  s.metrics.push({ ...duplicate, id: "old-without-key" });
  assert.equal(attribution(s).duplicatesExcluded, 1);
  assert.equal(recap(s)[0].groups[0].clicks, 10);
});
test("unknown attribution warns, cross-brand campaign references and blank/null measurements fail", () => {
  const s = fixture();
  assert.equal(previewMetrics({ rows: [row] }, s)[0].warnings?.length, 1);
  assert.equal(previewMetrics({ rows: [{ ...row, campaignId: "foreign" }] }, s)[0].valid, false);
  for (const clicks of [null, "", "  ", undefined]) {
    assert.equal(previewMetrics({ rows: [{ ...row, clicks }] }, s)[0].valid, false);
  }
  const missingContent = { ...row, campaignId: "a", contentId: "foreign-content" };
  assert.equal(previewMetrics({ rows: [missingContent] }, s)[0].valid, false);
});
test("currency and UTM dimensions remain separate and zero denominators stay unavailable", () => {
  const s = fixture();
  s.metrics = [
    row,
    { ...row, id: "eur", url: "https://example.com/eur-post", currency: "EUR" },
    {
      ...row,
      id: "zero",
      url: "https://example.com/gbp-post",
      impressions: 0,
      clicks: 0,
      conversions: 0,
      currency: "GBP",
    },
  ] as Metric[];
  assert.equal(attribution(s).groups.length, 3);
  assert.equal(recap(s)[0].groups[2].cpa, null);
});

test("planning API excludes unknown/shared records and import is persisted idempotently", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: express } = await import("express");
  const { Store } = await import("../../server/storage/store.ts");
  const { campaignRoutes } = await import("../../server/routes/campaigns.ts");
  const { workflowRoutes } = await import("../../server/routes/operations.ts");
  const dir = mkdtempSync(join(tmpdir(), "harbor-attribution-"));
  const store = new Store(join(dir, "test.sqlite"));
  const app = express();
  app.use(express.json());
  campaignRoutes(app, store);
  workflowRoutes(app, store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/`;
  try {
    const s = fixture();
    store.change((state) => {
      state.contents = s.contents;
      state.campaigns = s.campaigns.map((c) => ({
        ...c,
        primaryMetric: "clicks",
        channels: [],
        assetIds: [],
        productIds: [],
        target: 100,
        startsAt: "2026-01-01",
        endsAt: "2026-12-31",
      }));
    });
    const body = {
      rows: [row, { ...row, url: "https://example.com/campaign-a", campaignId: "a" }],
    };
    const post = () =>
      fetch(base + "metrics/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    assert.equal((await post()).count, 2);
    assert.equal((await post()).count, 0);
    const planning = await fetch(base + "planning").then((r) => r.json());
    assert.deepEqual(
      planning.campaigns.map((c: { feedback: { observed: number } }) => c.feedback.observed),
      [10, 0],
    );
    assert.equal(planning.campaigns[1].feedback.unknownSamples, 1);
    const reloaded = new Store(join(dir, "test.sqlite"));
    assert.equal(reloaded.read().metrics.length, 2);
    assert.equal(reloaded.read().metrics[1].campaignId, "a");
    reloaded.close();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
