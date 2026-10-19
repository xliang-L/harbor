import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { applicableFacts, factsForBrand, revisionFactIssues } from "../server/domain/facts.ts";
import { content } from "../server/generate.ts";
import type { Fact, Revision, State } from "../server/types.ts";

function seed(store: Store) {
  store.change((s) => {
    s.brand = {
      name: "Fact test",
      product: "Product A",
      parameters: "User-provided",
      url: "https://example.com",
      market: "US",
      audience: "Teams",
      competitors: [],
      image: "",
      updatedAt: "2026-01-01T00:00:00Z",
      activeProductId: "product-a",
    };
    s.evidence = ["brand", "a", "b"].map((id) => ({
      id: `source-${id}`,
      title: id,
      url: `https://example.com/${id}`,
      text: `Exact source quotation for ${id} with sufficient detail.`,
      publishedAt: "2026-01-01T00:00:00Z",
      capturedAt: "2026-01-01T00:00:00Z",
      kind: "manual",
      demo: true,
      hash: "test",
    }));
    s.products = ["a", "b"].map((id) => ({
      id: `product-${id}`,
      sku: id.toUpperCase(),
      title: `Product ${id.toUpperCase()}`,
      description: "User-provided product",
      price: 10,
      currency: "USD",
      url: `https://example.com/${id}`,
      evidenceId: `source-${id}`,
      sourceName: "test",
      importedAt: "2026-01-01T00:00:00Z",
      demo: true,
    }));
    s.facts = ["brand", "a", "b"].map((id) => ({
      id: `fact-${id}`,
      text: `Confirmed fact ${id}`,
      evidenceId: `source-${id}`,
      quote: s.evidence.find((e) => e.id === `source-${id}`)!.text,
      confirmedAt: "2026-01-01T00:00:00Z",
      confirmedBy: "Tester",
      scope: id === "brand" ? "brand" : "product",
      ...(id === "brand" ? {} : { productId: `product-${id}` }),
    }));
    s.facts.push({ ...s.facts[0], id: "legacy", scope: undefined, confirmedBy: undefined });
    s.suggestions = [
      {
        id: "suggestion",
        title: "Fact test",
        reason: "Hypothesis",
        angle: "Neutral introduction",
        evidenceIds: ["source-brand"],
        quotes: [{ evidenceId: "source-brand", quote: s.evidence[0].text }],
        mode: "demo-template",
      },
    ];
  });
}
function revision(s: State, facts: Fact[]): Revision {
  return {
    id: "revision-a",
    number: 1,
    copy: "Reviewed product introduction",
    scenes: [0, 1, 2].map((i) => ({
      start: i * 10,
      end: (i + 1) * 10,
      text: "Reviewed introduction",
      visual: "Product photo",
    })),
    createdAt: "2026-01-01T00:00:00Z",
    brand: structuredClone(s.brand!),
    evidence: structuredClone(s.evidence),
    facts: structuredClone(facts),
    claims: [],
    mode: "demo-template",
  };
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "harbor-facts-"));
  const store = new Store(join(dir, "db.sqlite"));
  seed(store);
  const app = createApp(store, join(dir, "output"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  const post = async (path: string, body: object) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  };
  const get = async (path: string) => {
    const response = await fetch(base + path);
    return { status: response.status, ...(await response.json()) };
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const task = store.read().tasks.find((job) => job.id === id)!;
      if (task.status === "succeeded" || task.status === "failed") return task;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Task did not finish");
  };
  return {
    store,
    post,
    get,
    wait,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("fact applicability fails closed for legacy, withdrawn, missing-source and other-product facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-fact-scope-"));
  const store = new Store(join(dir, "db.sqlite"));
  try {
    seed(store);
    const s = store.read();
    assert.deepEqual(
      applicableFacts(s).map((f) => f.id),
      ["fact-brand", "fact-a"],
    );
    assert.deepEqual(
      factsForBrand(s.facts, { ...s.brand!, activeProductId: undefined }).map((f) => f.id),
      ["fact-brand"],
    );
    assert.deepEqual(revisionFactIssues(s, revision(s, [s.facts[1]])), []);
    const old = revision(s, [s.facts[1]]);
    s.brand!.activeProductId = "product-b";
    assert.deepEqual(
      revisionFactIssues(s, old),
      [],
      "Old product A content remains valid when selecting B",
    );
    assert.match(revisionFactIssues(s, revision(s, [s.facts[1]])).join(""), /不适用/);
    assert.match(revisionFactIssues(s, revision(s, [s.facts[3]])).join(""), /确认适用范围/);
    s.facts[0].withdrawnAt = "2026-01-02T00:00:00Z";
    assert.deepEqual(
      applicableFacts(s).map((f) => f.id),
      ["fact-b"],
    );
    s.evidence = s.evidence.filter((e) => e.id !== "source-b");
    assert.deepEqual(applicableFacts(s), []);
    const malformed = revision(s, []);
    malformed.claims = [{ factId: "missing", text: "Claim", quote: "Unknown quote" }];
    assert.match(revisionFactIssues(s, malformed).join(""), /缺少对应事实快照/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("content model receives only applicable confirmed facts without calling an external model", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-fact-prompt-"));
  const store = new Store(join(dir, "db.sqlite"));
  seed(store);
  const saved = Object.fromEntries(
    ["MODEL_ENABLED", "MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.MODEL_ENABLED = "true";
  process.env.MODEL_BASE_URL = "http://127.0.0.1:1/fact-mock";
  process.env.MODEL_NAME = "offline-test";
  delete process.env.MODEL_API_KEY;
  let received: Fact[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      assert.equal(String(input), "http://127.0.0.1:1/fact-mock/chat/completions");
      received = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).confirmedFacts;
      return Response.json({
        choices: [
          { message: { content: JSON.stringify({ copy: "Meet Fact test.", claims: [] }) } },
        ],
      });
    },
  );
  try {
    const s = store.read();
    await content(s.brand!, s.suggestions[0], s.facts);
    assert.deepEqual(
      received.map((f) => f.id),
      ["fact-brand", "fact-a"],
    );
  } finally {
    t.mock.restoreAll();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("product selection and manual brand edits control generation scope; legacy reconfirmation creates a new record", async () => {
  const env = process.env.MODEL_ENABLED;
  process.env.MODEL_ENABLED = "false";
  const api = await setup();
  try {
    const first = await api.post("tasks", {
      kind: "content",
      payload: { suggestionId: "suggestion" },
    });
    assert.equal((await api.wait(first.id)).status, "succeeded");
    assert.deepEqual(
      api.store.read().contents[0].revisions[0].facts!.map((f) => f.id),
      ["fact-brand", "fact-a"],
    );
    assert.equal((await api.post("products/product-b/use", {})).status, 200);
    assert.equal(api.store.read().brand?.activeProductId, "product-b");
    await api.wait((await api.post("tasks", { kind: "suggest" })).id);
    const second = await api.post("tasks", {
      kind: "content",
      payload: { suggestionId: api.store.read().suggestions[0].id },
    });
    assert.equal((await api.wait(second.id)).status, "succeeded");
    assert.deepEqual(
      api.store.read().contents[1].revisions[0].facts!.map((f) => f.id),
      ["fact-brand", "fact-b"],
    );
    assert.equal(
      (
        await api.post("brand", {
          ...api.store.read().brand!,
          product: "Manual product",
          activeProductId: "product-a",
        })
      ).status,
      200,
    );
    assert.equal(api.store.read().brand?.activeProductId, undefined);
    await api.wait((await api.post("tasks", { kind: "suggest" })).id);
    const third = await api.post("tasks", {
      kind: "content",
      payload: { suggestionId: api.store.read().suggestions[0].id },
    });
    assert.equal((await api.wait(third.id)).status, "succeeded");
    assert.deepEqual(
      api.store.read().contents[2].revisions[0].facts!.map((f) => f.id),
      ["fact-brand"],
    );
    const legacy = api.store.read().facts.find((f) => f.id === "legacy")!;
    const input = {
      evidenceId: legacy.evidenceId,
      quote: legacy.quote,
      text: legacy.text,
      actor: "Reviewer",
    };
    assert.equal((await api.post("facts", input)).status, 400);
    assert.equal(
      (await api.post("facts", { ...input, scope: "product", productId: "another-brand" })).status,
      400,
    );
    assert.equal(
      (await api.post("facts", { ...input, scope: "brand", productId: "product-a" })).status,
      400,
    );
    const reconfirmed = await api.post("facts", {
      ...input,
      scope: "product",
      productId: "product-a",
      reconfirmsFactId: legacy.id,
    });
    assert.equal(reconfirmed.status, 200);
    assert.notEqual(reconfirmed.id, legacy.id);
    assert.equal(api.store.read().facts.find((f) => f.id === "legacy")?.scope, undefined);
    assert.equal(
      api.store.read().facts.find((f) => f.id === reconfirmed.id)?.reconfirmsFactId,
      legacy.id,
    );
    assert.equal(
      api.store.read().facts.find((f) => f.id === reconfirmed.id)?.confirmedBy,
      "Reviewer",
    );
  } finally {
    await api.close();
    if (env === undefined) delete process.env.MODEL_ENABLED;
    else process.env.MODEL_ENABLED = env;
  }
});

test("brand-only edits preserve a legitimate product binding without accepting a client-supplied binding", async () => {
  const api = await setup();
  try {
    const original = api.store.read().brand!;
    assert.equal(
      (
        await api.post("brand", {
          ...original,
          name: "Renamed brand",
          audience: "Updated audience",
          image: "data:image/png;base64,aGVsbG8=",
          activeProductId: "product-b",
        })
      ).status,
      200,
    );
    assert.equal(
      api.store.read().brand?.activeProductId,
      "product-a",
      "Ignore a forged client binding and preserve the saved one",
    );
    assert.deepEqual(
      applicableFacts(api.store.read()).map((f) => f.id),
      ["fact-brand", "fact-a"],
    );
    assert.equal(
      (
        await api.post("brand", {
          ...api.store.read().brand!,
          parameters: "Updated specification",
          activeProductId: "product-a",
        })
      ).status,
      200,
    );
    assert.equal(api.store.read().brand?.activeProductId, undefined);
    assert.equal(
      (
        await api.post("brand", {
          ...api.store.read().brand!,
          audience: "Another audience",
          activeProductId: "product-a",
        })
      ).status,
      200,
    );
    assert.equal(
      api.store.read().brand?.activeProductId,
      undefined,
      "An unbound brand cannot acquire a product through the profile endpoint",
    );
    assert.equal((await api.post("products/product-a/use", {})).status, 200);
    assert.equal(
      (await api.post("brand", { ...api.store.read().brand!, product: "Manually changed product" }))
        .status,
      200,
    );
    assert.equal(api.store.read().brand?.activeProductId, undefined);
    api.store.change((s) => {
      s.brand!.activeProductId = "missing-product";
    });
    assert.equal(
      (await api.post("brand", { ...api.store.read().brand!, name: "Another name" })).status,
      200,
    );
    assert.equal(
      api.store.read().brand?.activeProductId,
      undefined,
      "Do not retain a binding to a missing product",
    );
  } finally {
    await api.close();
  }
});

test("withdrawing facts blocks all current approvals and exports, keeps history, and needs an explicit new-revision review", async () => {
  const api = await setup();
  try {
    api.store.change((s) =>
      s.contents.push({
        id: "content-a",
        suggestion: s.suggestions[0],
        revisions: [revision(s, [s.facts[1]])],
      }),
    );
    assert.equal(
      (await api.post("contents/content-a/approve", { revisionId: "revision-a" })).status,
      200,
    );
    const campaign = await api.post("campaigns", {
      name: "Sample campaign",
      objective: "Introduce product",
      audience: "Teams",
      primaryMetric: "clicks",
      target: 10,
      budget: 0,
      currency: "USD",
      startsAt: "2026-01-01T00:00:00Z",
      endsAt: "2027-01-01T00:00:00Z",
      channels: ["x"],
      contentIds: ["content-a"],
      productIds: ["product-a"],
      assetIds: [],
    });
    assert.equal(campaign.status, 200);
    const calendar = await api.post("calendar", {
      contentId: "content-a",
      revisionId: "revision-a",
      channel: "x",
      account: "Demo account",
      scheduledAt: "2026-02-01T00:00:00Z",
      copy: "Reviewed product introduction",
      headline: "Product A",
      targetUrl: "https://example.com/a",
      campaign: "Sample campaign",
      campaignId: campaign.id,
    });
    assert.equal(calendar.status, 200);
    assert.equal((await api.post(`calendar/${calendar.id}/approve`, {})).status, 200);
    assert.equal(
      (await api.post(`campaigns/${campaign.id}/approve`, { baseVersion: 1 })).status,
      200,
    );
    for (const path of [
      "contents/content-a/revision-a/download",
      `calendar/${calendar.id}/export`,
      `campaigns/${campaign.id}/export`,
    ])
      assert.equal((await api.get(path)).status, 200);
    api.store.change((s) => {
      const entry = s.calendar[0];
      s.deliveries = [
        {
          id: "receipt",
          calendarId: entry.id,
          contentId: entry.contentId,
          revisionId: entry.revisionId,
          channel: entry.channel,
          account: entry.account,
          deliveredAt: "2026-02-01T00:00:00Z",
          destinationUrl: "https://example.com/published",
          externalId: "post-1",
          actor: "Reviewer",
          notes: "Recorded delivery",
          recordedAt: "2026-02-01T00:00:00Z",
          source: "manual",
          snapshot: structuredClone(entry),
          contentApprovedAt: s.contents[0].revisions[0].approvedAt!,
          factIds: ["fact-a"],
        },
      ];
    });
    const impact = await api.get("facts/fact-a/impact");
    assert.equal(impact.scope.contents, "current-revisions");
    assert.deepEqual(
      impact.contents.map((x: { id: string }) => x.id),
      ["content-a"],
    );
    assert.deepEqual(
      impact.calendar.map((x: { id: string }) => x.id),
      [calendar.id],
    );
    assert.deepEqual(
      impact.campaigns.map((x: { id: string }) => x.id),
      [campaign.id],
    );
    assert.deepEqual(
      impact.deliveries.map((x: { id: string }) => x.id),
      ["receipt"],
    );
    assert.equal(
      (
        await api.post("facts/fact-a/withdraw", {
          actor: "Reviewer",
          reason: "Product specification is no longer valid",
        })
      ).status,
      200,
    );
    const withdrawn = api.store.read().facts.find((f) => f.id === "fact-a")!;
    assert.ok(withdrawn.withdrawnAt);
    assert.equal(withdrawn.withdrawnBy, "Reviewer");
    assert.match(withdrawn.withdrawalReason!, /no longer valid/);
    assert.equal(
      (
        await api.post("facts/fact-a/withdraw", {
          actor: "Other",
          reason: "Repeated withdrawal request",
        })
      ).duplicate,
      true,
    );
    assert.equal(api.store.read().facts.find((f) => f.id === "fact-a")?.withdrawnBy, "Reviewer");
    assert.ok(
      api.store.read().contents[0].revisions[0].approvedAt,
      "Keep historical approval for attribution",
    );
    assert.equal(
      api.store.read().deliveries?.[0].voidedAt,
      undefined,
      "Withdrawal cannot rewrite a completed delivery",
    );
    for (const path of [
      "contents/content-a/revision-a/download",
      "contents/content-a/revision-a/video",
      `calendar/${calendar.id}/export`,
      `campaigns/${campaign.id}/export`,
    ])
      assert.equal((await api.get(path)).status, 400);
    assert.equal(
      (await api.post("contents/content-a/approve", { revisionId: "revision-a" })).status,
      400,
    );
    assert.equal((await api.post(`calendar/${calendar.id}/approve`, {})).status, 400);
    assert.equal(
      (await api.post(`campaigns/${campaign.id}/approve`, { baseVersion: 1 })).status,
      400,
    );
    assert.equal(
      (
        await api.post("metrics", {
          contentId: "content-a",
          revisionId: "revision-a",
          url: "https://example.com/published",
          date: "2026-02-02T00:00:00Z",
          impressions: 10,
          clicks: 1,
          conversions: 0,
          spend: 0,
          notes: "Historical results",
          currency: "USD",
          timezone: "UTC",
        })
      ).status,
      200,
    );
    let current = api.store.read().contents[0].revisions.at(-1)!;
    assert.equal(
      (
        await api.post("contents/content-a/revise", {
          baseRevisionId: current.id,
          copy: "Edited text does not silently remove dependencies",
          scenes: current.scenes,
          facts: [],
        })
      ).status,
      200,
    );
    current = api.store.read().contents[0].revisions.at(-1)!;
    assert.deepEqual(
      current.facts?.map((f) => f.id),
      ["fact-a"],
    );
    assert.equal(
      (await api.post("contents/content-a/approve", { revisionId: current.id })).status,
      400,
    );
    const revised = {
      baseRevisionId: current.id,
      copy: "Neutral introduction with outdated claims removed.",
      scenes: current.scenes,
    };
    assert.equal(
      (
        await api.post("contents/content-a/revise", {
          ...revised,
          factReview: { actor: "Reviewer", reason: "Rechecked all copy and scenes", factIds: [] },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api.post("contents/content-a/revise", {
          ...revised,
          factReview: {
            confirmed: true,
            actor: "Reviewer",
            reason: "Rechecked all copy and scenes",
            factIds: ["fact-a"],
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api.post("contents/content-a/revise", {
          ...revised,
          factReview: {
            confirmed: true,
            actor: "Reviewer",
            reason: "Rechecked all copy and scenes and removed unsupported claims",
            factIds: [],
          },
        })
      ).status,
      200,
    );
    current = api.store.read().contents[0].revisions.at(-1)!;
    assert.deepEqual(current.facts, []);
    assert.deepEqual(current.factReview?.previousFactIds, ["fact-a"]);
    assert.equal(current.factReview?.actor, "Reviewer");
    assert.equal(current.approvedAt, undefined);
    assert.equal(
      (await api.post("contents/content-a/approve", { revisionId: current.id })).status,
      200,
    );
    assert.equal((await api.get(`contents/content-a/${current.id}/download`)).status, 200);
    assert.equal(
      (await api.get(`calendar/${calendar.id}/export`)).status,
      400,
      "Old channel copy must be rebuilt against the reviewed version",
    );
    assert.equal((await api.get("facts/fact-a/impact")).contents.length, 0);
    assert.equal(
      (await api.get("facts/fact-a/impact")).deliveries.length,
      1,
      "Keep old delivered-version impact visible",
    );
  } finally {
    await api.close();
  }
});
