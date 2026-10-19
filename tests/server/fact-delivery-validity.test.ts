import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/storage/store.ts";
import { createApp } from "../../server/app.ts";
import { campaignCheck } from "../../server/domain/campaigns.ts";
import { deliverySummary } from "../../server/domain/deliveries.ts";
import { overview } from "../../server/domain/overview.ts";
import { scheduledFactIssues } from "../../server/domain/facts.ts";
import type { State } from "../../server/types.ts";

function seed(store: Store, now: number) {
  const at = (hours: number) => new Date(now + hours * 3600000).toISOString();
  store.change((s) => {
    s.brand = {
      name: "DEMO",
      url: "https://example.com",
      product: "DEMO product",
      parameters: "Provided facts",
      audience: "Teams",
      market: "US",
      competitors: [],
      image: "",
      updatedAt: at(-2),
    };
    s.evidence = [
      {
        id: "source",
        title: "DEMO source",
        url: "https://example.com",
        text: "Demo documentation says the warranty period is one year.",
        hash: "fixture",
        kind: "manual",
        demo: true,
        capturedAt: at(-2),
        publishedAt: at(-2),
      },
    ];
    s.facts = [
      {
        id: "fact",
        text: "Warranty period is one year.",
        quote: "warranty period is one year",
        evidenceId: "source",
        scope: "brand",
        confirmedAt: at(-2),
        confirmedBy: "Reviewer",
        validFrom: at(-1),
        validUntil: at(1),
        attribute: "Warranty",
        value: "one year",
      },
    ];
    s.contents = [
      {
        id: "content",
        suggestion: {
          id: "s",
          title: "Warranty message",
          reason: "DEMO",
          angle: "DEMO",
          evidenceIds: ["source"],
          quotes: [],
          mode: "demo-template",
        },
        revisions: [
          {
            id: "revision",
            number: 1,
            copy: "Review the warranty information.",
            scenes: [0, 1, 2].map((i) => ({
              start: i * 10,
              end: (i + 1) * 10,
              text: "Review information",
              visual: "Product",
            })),
            brand: s.brand,
            facts: structuredClone(s.facts),
            evidence: structuredClone(s.evidence),
            createdAt: at(-0.5),
            approvedAt: at(-0.4),
            mode: "demo-template",
          },
        ],
      },
    ];
    s.calendar = [
      {
        id: "calendar",
        contentId: "content",
        revisionId: "revision",
        channel: "x",
        account: "demo-account",
        copy: "Review the warranty information.",
        headline: "Warranty message",
        targetUrl: "https://example.com",
        scheduledAt: at(0.5),
        campaign: "demo",
        campaignId: "campaign",
        createdAt: at(-0.4),
        approvedAt: at(-0.3),
      },
    ];
    s.campaigns = [
      {
        id: "campaign",
        name: "Demo campaign",
        objective: "Check facts",
        audience: "Demo audience",
        primaryMetric: "clicks",
        target: 1,
        budget: 0,
        currency: "USD",
        startsAt: at(-1),
        endsAt: at(4),
        channels: ["x"],
        productIds: [],
        assetIds: [],
        contentIds: ["content"],
        version: 1,
        createdAt: at(-1),
        updatedAt: at(-1),
      },
    ];
    s.campaigns[0].approvedFingerprint = campaignCheck(s, s.campaigns[0], now).fingerprint;
    s.deliveries = [
      {
        id: "receipt",
        calendarId: "calendar",
        contentId: "content",
        revisionId: "revision",
        channel: "x",
        account: "demo-account",
        source: "manual",
        snapshot: structuredClone(s.calendar[0]),
        contentApprovedAt: at(-0.4),
        factIds: ["fact"],
        deliveredAt: at(-0.2),
        recordedAt: at(-0.1),
        actor: "Demo operator",
        notes: "Manual test",
        externalId: "demo-post",
        destinationUrl: "https://example.com/post",
      },
    ];
  });
}

test("the same evaluation time controls expiry, future plans, review queues and historic delivery warnings without mutation", () => {
  const now = Date.parse("2026-10-18T04:00:00Z"),
    store = new Store(":memory:");
  seed(store, now);
  try {
    const state = store.read(),
      revision = state.contents[0].revisions[0],
      before = JSON.stringify(state);
    assert.equal(campaignCheck(state, state.campaigns[0], now).approved, true);
    assert.equal(overview(state, now).counts.reviews, 0);
    assert.equal(deliverySummary(state, now).entries[0].receipts[0].factIssues.length, 0);
    const boundary = now + 3600000;
    assert.equal(campaignCheck(state, state.campaigns[0], boundary).approved, false);
    assert.equal(overview(state, boundary).counts.reviews, 3);
    assert.equal(overview(state, boundary).deliveryAlerts.length, 1);
    assert.equal(overview(state, boundary).factChecks[0].label, "事实已到期");
    assert.match(
      deliverySummary(state, boundary).entries[0].receipts[0].factIssues.join(),
      /已过期/,
    );
    assert.equal(JSON.stringify(state), before);
    assert.match(
      scheduledFactIssues(state, revision, new Date(now + 7200000).toISOString(), now).join(),
      /排期时间.*过期/,
    );
    assert.deepEqual(
      scheduledFactIssues(state, revision, new Date(now - 7200000).toISOString(), now),
      [],
      "past schedules are checked against current facts",
    );
    state.calendar[0].scheduledAt = new Date(now + 7200000).toISOString();
    assert.match(campaignCheck(state, state.campaigns[0], now).issues.join(), /排期时间.*过期/);
  } finally {
    store.close();
  }
});

test("a future competing value blocks the scheduled plan even if the revision only cites one fact", () => {
  const now = Date.now(),
    store = new Store(":memory:");
  seed(store, now);
  try {
    const s = store.read();
    s.facts[0].validUntil = new Date(now + 5 * 3600000).toISOString();
    s.contents[0].revisions[0].facts = structuredClone(s.facts);
    s.facts.push({
      ...s.facts[0],
      id: "competitor",
      value: "two years",
      validFrom: new Date(now + 3600000).toISOString(),
    });
    const r = s.contents[0].revisions[0];
    assert.deepEqual(scheduledFactIssues(s, r, new Date(now + 1800000).toISOString(), now), []);
    assert.match(
      scheduledFactIssues(s, r, new Date(now + 7200000).toISOString(), now).join(),
      /排期时间.*潜在冲突/,
    );
    assert.equal(overview(s, now).factChecks.length, 0);
    assert.equal(
      overview(s, now + 7200000).factChecks.filter((x) => x.label === "潜在事实冲突").length,
      1,
    );
  } finally {
    store.close();
  }
});

test("renewal chains suppress redundant historical expiry alerts but do not restore old content approvals", () => {
  const now = Date.now(),
    store = new Store(":memory:");
  seed(store, now);
  try {
    const s = store.read();
    s.facts[0].validUntil = new Date(now - 2 * 3600000).toISOString();
    s.facts[0].validFrom = undefined;
    s.contents[0].revisions[0].facts = structuredClone(s.facts);
    const middle = {
      ...s.facts[0],
      id: "middle",
      reconfirmsFactId: "fact",
      validUntil: new Date(now - 3600000).toISOString(),
    };
    const latest = {
      ...middle,
      id: "latest",
      reconfirmsFactId: "middle",
      validUntil: new Date(now + 3600000).toISOString(),
    };
    s.facts.push(middle, latest);
    assert.equal(overview(s, now).factChecks.length, 0);
    assert.equal(
      overview(s, now).reviews.some((item) => item.kind === "content"),
      true,
    );
    const broken = structuredClone(s);
    broken.facts[2].evidenceId = "missing";
    assert.equal(
      overview(broken, now).factChecks.length,
      2,
      "a broken renewal cannot hide original expiry alerts",
    );
    const cycle = structuredClone(s);
    cycle.facts[2].validUntil = new Date(now - 1000).toISOString();
    cycle.facts[0].reconfirmsFactId = "latest";
    assert.equal(
      overview(cycle, now).factChecks.length,
      3,
      "malformed cyclic history does not hang the overview",
    );
  } finally {
    store.close();
  }
});

test("API approval and export reject facts that expire before the scheduled delivery while current content remains reviewable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-fact-delivery-time-")),
    store = new Store(join(dir, "db.sqlite"));
  const now = Date.now();
  seed(store, now);
  store.change((s) => {
    s.calendar[0].scheduledAt = new Date(now + 7200000).toISOString();
  });
  const app = createApp(store, join(dir, "output")),
    server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("contents/content/approve", { revisionId: "revision" })).status, 200);
    for (const path of ["calendar/calendar/approve", "campaigns/campaign/approve"])
      assert.equal((await post(path, { baseVersion: 1 })).status, 400);
    for (const path of ["calendar/calendar/export", "campaigns/campaign/export"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /过期/);
    }
    const original = structuredClone(store.read());
    store.change((s) => {
      const fact = s.facts[0];
      fact.validUntil = new Date(now - 1000).toISOString();
      s.contents[0].revisions[0].facts = structuredClone(s.facts);
    });
    assert.equal((await post("contents/content/approve", { revisionId: "revision" })).status, 400);
    for (const path of ["contents/content/revision/download", "contents/content/revision/video"])
      assert.equal((await fetch(base + path)).status, 400);
    const state: State = store.read();
    assert.deepEqual(state.deliveries, original.deliveries);
    assert.ok(state.contents[0].revisions[0].approvedAt, "historical approval stamp is retained");
    assert.equal(
      (await fetch(base + "deliveries/receipt/export")).status,
      200,
      "audit export remains available",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a receipt must have usable facts at its actual delivery time even when the facts are usable now", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-fact-receipt-time-")),
    store = new Store(join(dir, "db.sqlite"));
  const now = Date.now();
  seed(store, now);
  store.change((s) => {
    s.deliveries = [];
    const approvedAt = new Date(now - 2 * 3600000).toISOString();
    s.contents[0].revisions[0].approvedAt = approvedAt;
    s.calendar[0].approvedAt = approvedAt;
  });
  const app = createApp(store, join(dir, "output")),
    server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/calendar/calendar/deliveries`;
  const post = (hours: number) =>
    fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        revisionId: "revision",
        deliveredAt: new Date(now + hours * 3600000).toISOString(),
        externalId: "receipt-time-proof",
        actor: "Reviewer",
      }),
    });
  try {
    const rejected = await post(-1.5);
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /实际交付时间.*尚未生效/);
    assert.deepEqual(store.read().deliveries, []);
    const accepted = await post(-0.5);
    assert.equal(accepted.status, 200);
    const receipts = store.read().deliveries || [];
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].deliveredAt, new Date(now - 1800000).toISOString());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
