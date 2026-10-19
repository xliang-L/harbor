import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { createWorkspaceApp } from "../server/storage/workspaces.ts";
import { parseFeed } from "../server/connectors/sources.ts";
import { saveCollection } from "../server/jobs/sources.ts";
import { validateChannel, utmUrl } from "../server/domain/channels.ts";
import { ga4Report } from "../server/connectors/ga4.ts";
import type { Revision } from "../server/types.ts";
const brand = {
  name: "DEMO",
  url: "https://example.com",
  product: "DEMO bottle",
  parameters: "500 ml demo",
  audience: "DEMO",
  market: "US",
  competitors: [],
  image: "",
  updatedAt: "",
};
test("RSS/Atom extraction and XML/private URL rejection", () => {
  const rows = parseFeed(
    "<rss><channel><item><title>DEMO release</title><link>https://example.com/news</link><description>This is sample public feed content.</description><pubDate>2026-01-01</pubDate></item></channel></rss>",
    "https://example.com/feed",
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /sample public/);
  const atom = parseFeed(
    '<feed><entry><title>Sample Atom update</title><link href="/update"/><summary>Useful sample source content</summary></entry></feed>',
    "https://example.com/feed",
  );
  assert.equal(atom[0].url, "https://example.com/update");
  assert.throws(() => parseFeed("<!DOCTYPE x><rss/>", "https://example.com"), /DTD/);
  assert.throws(() =>
    parseFeed(
      "<rss><item><link>http://127.0.0.1</link><description>malicious internal destination</description></item></rss>",
      "https://example.com",
    ),
  );
});
test("channel rules and UTM preserve existing query", () => {
  for (const [channel, max] of [
    ["x", 280],
    ["instagram", 2200],
    ["linkedin", 3000],
    ["google-search", 90],
  ] as const) {
    validateChannel(channel, "x".repeat(max), "title");
    assert.throws(() => validateChannel(channel, "x".repeat(max + 1), "title"));
  }
  assert.throws(() => validateChannel("google-search", "copy", "a".repeat(31)));
  const u = new URL(utmUrl("https://example.com/?lang=en", "linkedin", "demo", "v1"));
  assert.equal(u.searchParams.get("lang"), "en");
  assert.equal(u.searchParams.get("utm_content"), "v1");
});
test("GA4 missing authorization and mocked read-only official request", async () => {
  const old = {
    token: process.env.GA4_ACCESS_TOKEN,
    property: process.env.GA4_PROPERTY_ID,
  };
  delete process.env.GA4_ACCESS_TOKEN;
  delete process.env.GA4_PROPERTY_ID;
  try {
    await assert.rejects(ga4Report("2026-01-01", "2026-01-02"), /待授权/);
    process.env.GA4_ACCESS_TOKEN = "mock-not-real";
    process.env.GA4_PROPERTY_ID = "123";
    const mock: typeof fetch = async (input, init) => {
      assert.equal(
        String(input),
        "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport",
      );
      assert.equal(init?.method, "POST");
      assert.match(String(init?.body), /sessionSource/);
      return new Response(JSON.stringify({ rows: [], rowCount: 0 }), {
        status: 200,
      });
    };
    assert.equal((await ga4Report("2026-01-01", "2026-01-02", mock)).rowCount, 0);
    await assert.rejects(
      ga4Report("2026-01-01", "2026-01-02", async () => new Response("", { status: 403 })),
      /HTTP 403/,
    );
  } finally {
    if (old.token === undefined) delete process.env.GA4_ACCESS_TOKEN;
    else process.env.GA4_ACCESS_TOKEN = old.token;
    if (old.property === undefined) delete process.env.GA4_PROPERTY_ID;
    else process.env.GA4_PROPERTY_ID = old.property;
  }
});
test("persistent snapshots, facts, channel approval, stale rejection, atomic metrics preview/import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-workflows-")),
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
  try {
    const source = await post("sources", {
      label: "Demo snapshot",
      url: "https://example.com",
      connector: "web",
      category: "competitor",
      intervalHours: 24,
      enabled: false,
    });
    const item = {
      title: "Sample",
      url: "https://example.com",
      text: "A sample source contains the product capacity of 500 ml.",
      publishedAt: "2026-01-01",
    };
    saveCollection(store, source.id, [item]);
    saveCollection(store, source.id, [item]);
    saveCollection(store, source.id, [{ ...item, text: item.text + " Newly updated." }]);
    assert.equal(store.read().evidence.length, 2);
    assert.equal(store.read().sources[0].history[1].added, 0);
    assert.equal(store.read().sources[0].history[2].changed, true);
    const e = store.read().evidence[0];
    assert.equal(
      (
        await post("facts", {
          evidenceId: e.id,
          text: "500 ml",
          quote: "invented quote",
          scope: "brand",
          actor: "Local tester",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("facts", {
          evidenceId: e.id,
          text: "500 ml",
          quote: "capacity of 500 ml",
          scope: "brand",
          actor: "Local tester",
        })
      ).status,
      200,
    );
    const r: Revision = {
      id: "v1",
      number: 1,
      copy: "Sample restrained copy",
      scenes: [0, 1, 2].map((i) => ({
        start: i * 10,
        end: (i + 1) * 10,
        text: "Demo",
        visual: "Demo",
      })),
      createdAt: "2026-01-01",
      brand,
      evidence: [e],
      mode: "demo-template",
    };
    store.change((s) =>
      s.contents.push({
        id: "c1",
        suggestion: {
          id: "s1",
          title: "DEMO",
          reason: "sample",
          angle: "sample",
          evidenceIds: [e.id],
          quotes: [{ evidenceId: e.id, quote: e.text }],
          mode: "demo-template",
        },
        revisions: [r],
      }),
    );
    const entry = {
      contentId: "c1",
      revisionId: "v1",
      channel: "x",
      account: "demo-handle",
      scheduledAt: "2027-01-01T00:00:00Z",
      copy: "Sample restrained copy",
      headline: "DEMO",
      targetUrl: "https://example.com",
      campaign: "demo",
    };
    assert.equal((await post("calendar", { ...entry, copy: "a".repeat(281) })).status, 400);
    const created = await post("calendar", entry);
    assert.equal((await post(`calendar/${created.id}/approve`, {})).status, 400);
    await post("contents/c1/approve", { revisionId: "v1" });
    await post(`calendar/${created.id}/approve`, {});
    const exported = await fetch(base + `calendar/${created.id}/export`).then((r) => r.json());
    assert.match(exported.targetUrl, /utm_source=x/);
    assert.equal(exported.account, "demo-handle");
    const metric = {
      contentId: "c1",
      revisionId: "v1",
      url: "https://example.com/post",
      date: "2026-01-01",
      windowStart: "2025-12-31T00:00:00Z",
      windowEnd: "2026-01-01T00:00:00Z",
      impressions: 0,
      clicks: 0,
      conversions: 0,
      spend: 0,
      notes: "DEMO",
      currency: "USD",
      timezone: "UTC",
    };
    const preview = await post("metrics/preview", {
      rows: [metric, { ...metric, currency: "invalid" }],
    });
    assert.equal(preview.rows[1].valid, false);
    assert.equal(store.read().metrics.length, 0);
    assert.equal(
      (
        await post("metrics/import", {
          rows: [metric, { ...metric, currency: "invalid" }],
        })
      ).status,
      400,
    );
    assert.equal(store.read().metrics.length, 0);
    assert.equal((await post("metrics/import", { rows: [metric, metric] })).count, 1);
    assert.equal((await post("metrics/import", { rows: [metric] })).count, 0);
    const wf = await fetch(base + "workflows").then((r) => r.json());
    assert.equal(wf.recap[0].groups[0].ctr, null);
    await post("contents/c1/revise", {
      baseRevisionId: "v1",
      copy: r.copy + " change",
      scenes: r.scenes,
    });
    assert.equal((await fetch(base + `calendar/${created.id}/export`)).status, 400);
    const persisted = new Store(join(dir, "db.sqlite"));
    assert.equal(persisted.read().sources[0].history.length, 3);
    assert.equal(persisted.read().facts.length, 1);
    persisted.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("multi-brand databases isolate evidence, approvals and downloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-project-")),
    app = createWorkspaceApp(dir, join(dir, "artifacts")),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  const post = async (path: string, body: unknown, project = "default") =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-Harbor-Project": project,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("projects", { id: "brand-b" })).status, 200);
    await post("brand", brand);
    assert.equal((await fetch(base + "state?project=brand-b").then((r) => r.json())).brand, null);
    assert.equal((await fetch(base + "state").then((r) => r.json())).brand.name, "DEMO");
    assert.equal((await fetch(base + "state?project=../escape")).status, 400);
  } finally {
    app.locals.stopScheduler();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
