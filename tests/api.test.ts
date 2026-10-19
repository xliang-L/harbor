import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { isPublic, publicUrl, pinnedLookup } from "../server/security.ts";
import type { State } from "../server/types.ts";
const brand = {
  name: "Demo Coast",
  url: "https://example.com",
  product: "Demo bottle",
  parameters: "DEMO ONLY: 500ml sample specification",
  audience: "commuters",
  market: "US",
  competitors: [],
  image: "",
};
test("SSRF blocks private/reserved/obfuscated targets and credentials", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "192.0.2.1",
    "224.0.0.1",
  ])
    assert.equal(isPublic(ip), false, ip);
  assert.equal(isPublic("8.8.8.8"), true);
  for (const url of [
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://[::1]",
    "http://localhost",
    "http://internal.local",
    "http://a:b@example.com",
    "file:///etc/passwd",
    "http://example.com:8080",
  ])
    assert.throws(() => publicUrl(url), url);
});
test("real database persistence, evidence, approval, stale versions, idempotency, retries and downloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-test-"));
  const path = join(dir, "db.sqlite");
  const store = new Store(path);
  const app = createApp(store, join(dir, "artifacts"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, body: unknown, key = crypto.randomUUID()) => {
    const response = await fetch(base + "/api/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const state = async (): Promise<State> => fetch(base + "/api/state").then((r) => r.json());
  const wait = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const t = (await state()).tasks.find((t) => t.id === id)!;
      if (["failed", "succeeded"].includes(t.status)) return t;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("task timeout");
  };
  try {
    assert.equal(
      (
        await post("brand", {
          ...brand,
          competitors: Array(4).fill("https://example.com"),
        })
      ).status,
      400,
    );
    const failed = await post("tasks", { kind: "suggest" });
    assert.equal((await wait(failed.data.id)).status, "failed");
    assert.equal((await post("brand", brand)).status, 200);
    assert.equal(
      (
        await post("evidence", {
          title: "Bad",
          url: "http://127.0.0.1",
          publishedAt: "2026-01-01",
          text: "a".repeat(30),
        })
      ).status,
      400,
    );
    const csv =
      'title,url,publishedAt,text,demo\nDemo evidence,https://example.com,2026-01-01,"This is explicitly demonstration evidence, not a real market claim.",true';
    const key = crypto.randomUUID();
    assert.equal((await post("evidence", { csv }, key)).data.count, 1);
    assert.equal((await post("evidence", { csv }, key)).data.count, 1);
    assert.equal((await state()).evidence.length, 1);
    assert.equal((await post("evidence", { csv: csv + "bad" }, key)).status, 409);
    await post(`tasks/${failed.data.id}/retry`, {});
    const retried = await wait(failed.data.id);
    assert.equal(retried.status, "succeeded");
    assert.equal(retried.attempt, 2);
    const s = await state();
    assert.equal(s.suggestions.length, 3);
    assert.ok(
      s.suggestions.every((x) =>
        x.quotes.every((q) =>
          s.evidence.find((e) => e.id === q.evidenceId)?.text.includes(q.quote),
        ),
      ),
    );
    const job = await post("tasks", {
      kind: "content",
      payload: { suggestionId: s.suggestions[0].id },
    });
    await wait(job.data.id);
    let c = (await state()).contents[0];
    const v1 = c.revisions[0];
    assert.equal((await fetch(`${base}/api/contents/${c.id}/${v1.id}/download`)).status, 400);
    await post(`contents/${c.id}/approve`, { revisionId: v1.id });
    const download = await fetch(`${base}/api/contents/${c.id}/${v1.id}/download`);
    assert.equal(download.status, 200);
    assert.equal((await download.json()).evidence[0].hash, s.evidence[0].hash);
    await post(`contents/${c.id}/revise`, {
      baseRevisionId: v1.id,
      copy: v1.copy + "\nReviewed.",
      renderer: "remotion",
      scenes: v1.scenes,
    });
    c = (await state()).contents[0];
    const v2 = c.revisions[1];
    assert.equal(v2.approvedAt, undefined);
    assert.equal(v2.renderer, "remotion");
    assert.equal((await fetch(`${base}/api/contents/${c.id}/${v1.id}/download`)).status, 400);
    assert.equal((await post(`contents/${c.id}/approve`, { revisionId: v1.id })).status, 400);
    assert.equal(
      (
        await post(`contents/${c.id}/revise`, {
          baseRevisionId: v1.id,
          copy: "stale",
          scenes: v1.scenes,
        })
      ).status,
      400,
    );
    await post(`contents/${c.id}/approve`, { revisionId: v2.id });
    assert.equal(
      (
        await post("metrics", {
          contentId: c.id,
          revisionId: v2.id,
          url: "https://example.com/post",
          date: "2026-01-02",
          impressions: 100,
          clicks: 10,
          conversions: 1,
          spend: 5,
          notes: "test",
          currency: "USD",
          timezone: "UTC",
        })
      ).status,
      200,
    );
    const other = new Store(path);
    assert.equal(other.read().metrics.length, 1);
    assert.equal(other.read().contents[0].revisions.length, 2);
    other.close();
    const csrf = await fetch(base + "/api/brand", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(brand),
    });
    assert.equal(csrf.status, 403);
    store.change((s) =>
      s.tasks.push({
        id: "interrupted",
        kind: "suggest",
        status: "running",
        payload: {},
        attempt: 1,
        createdAt: "",
        updatedAt: "",
      }),
    );
    createApp(store, dir);
    assert.equal(store.read().tasks.find((t) => t.id === "interrupted")?.status, "failed");
  } finally {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned DNS supports Node 22 all-address and single-address callbacks", () => {
  const address = { address: "8.8.8.8", family: 4 };
  pinnedLookup(address)("example.com", { all: true }, (error: unknown, result: unknown) => {
    assert.equal(error, null);
    assert.deepEqual(result, [address]);
  });
  pinnedLookup(address)("example.com", {}, (error: unknown, result: unknown, family: number) => {
    assert.equal(error, null);
    assert.equal(result, "8.8.8.8");
    assert.equal(family, 4);
  });
});

test("queue claims each job once when parallel completions wake the same pending job", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-queue-test-"));
  const store = new Store(join(dir, "db.sqlite"));
  const app = createApp(store, join(dir, "output"));
  store.change((s) => {
    s.brand = { ...brand, updatedAt: "2026-01-01T00:00:00Z" };
    s.suggestions = Array.from({ length: 5 }, (_, i) => ({
      id: `suggestion-${i}`,
      title: `Test ${i}`,
      reason: "Local queue test",
      angle: "Neutral introduction",
      evidenceIds: [],
      quotes: [],
      mode: "demo-template",
    }));
  });
  const saved = {
    MODEL_ENABLED: process.env.MODEL_ENABLED,
    MODEL_BASE_URL: process.env.MODEL_BASE_URL,
    MODEL_NAME: process.env.MODEL_NAME,
    MODEL_API_KEY: process.env.MODEL_API_KEY,
  };
  process.env.MODEL_ENABLED = "true";
  process.env.MODEL_BASE_URL = "http://127.0.0.1:1/offline-queue-test";
  process.env.MODEL_NAME = "in-memory-test";
  delete process.env.MODEL_API_KEY;
  const originalFetch = globalThis.fetch;
  const waiting: (() => void)[] = [];
  let modelCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      if (String(input) === "http://127.0.0.1:1/offline-queue-test/chat/completions") {
        modelCalls++;
        if (modelCalls <= 3) await new Promise<void>((resolve) => waiting.push(resolve));
        return Response.json({
          choices: [
            { message: { content: JSON.stringify({ copy: "Local mock copy", claims: [] }) } },
          ],
        });
      }
      return originalFetch(input, init);
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetch(`${base}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ kind: "content", payload: { suggestionId: `suggestion-${i}` } }),
        }).then(async (r) => {
          assert.equal(r.status, 200);
          return r.json();
        }),
      ),
    );
    for (let i = 0; i < 100 && waiting.length < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(waiting.length, 3, "Only three model calls may run at once");
    assert.equal(store.read().tasks.filter((job) => job.status === "queued").length, 2);
    for (const release of waiting) release();
    for (
      let i = 0;
      i < 100 && store.read().tasks.some((job) => ["queued", "running"].includes(job.status));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    // Let already-scheduled queue wakeups run, including any duplicate callbacks.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const state = store.read();
    assert.equal(state.tasks.length, 5);
    assert.ok(state.tasks.every((job) => job.status === "succeeded" && job.attempt === 1));
    assert.equal(modelCalls, 5, "Finished tasks must not consume the model again");
    assert.equal(state.contents.length, 5, "One content record per task");
    assert.equal(new Set(state.contents.map((c) => c.suggestion.id)).size, 5);
    assert.ok(
      responses.every(({ id }) =>
        state.contents.some((c) => c.id === state.tasks.find((job) => job.id === id)?.result),
      ),
    );
  } finally {
    for (const release of waiting) release();
    t.mock.restoreAll();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual metrics preserve dimensions and share validation and deduplication with imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-metrics-test-"));
  const store = new Store(join(dir, "db.sqlite"));
  const app = createApp(store, join(dir, "output"));
  store.change((s) => {
    s.contents.push({
      id: "content",
      suggestion: {
        id: "suggestion",
        title: "Sample",
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
          createdAt: "2026-01-01T00:00:00Z",
          copy: "Sample",
          scenes: [],
          evidence: [],
          mode: "demo-template",
          brand: { ...brand, updatedAt: "2026-01-01T00:00:00Z" },
          approvedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    s.campaigns.push({
      id: "campaign",
      name: "Sample",
      objective: "Test",
      audience: "Test",
      primaryMetric: "clicks",
      target: 1,
      budget: 0,
      currency: "EUR",
      startsAt: "2026-01-01T00:00:00Z",
      endsAt: "2026-01-03T00:00:00Z",
      channels: ["linkedin"],
      contentIds: ["content"],
      productIds: [],
      assetIds: [],
      version: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: object) => {
    const r = await fetch(`${base}/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const metric = {
    contentId: "content",
    revisionId: "revision",
    campaignId: "campaign",
    channel: "linkedin",
    url: "https://example.com/post?b=2&a=1",
    date: "2026-01-02T10:00:00+08:00",
    impressions: 100,
    clicks: 10,
    conversions: 1,
    spend: 5,
    notes: "Test",
    currency: "EUR",
    timezone: "Asia/Shanghai",
  };
  try {
    for (const invalid of [
      { currency: undefined },
      { timezone: undefined },
      { currency: "invalid" },
      { timezone: "invalid" },
      { campaignId: "other-brand" },
      { revisionId: "unapproved" },
      { spend: "" },
    ])
      assert.equal((await post("metrics", { ...metric, ...invalid })).status, 400);
    assert.equal(store.read().metrics.length, 0);
    const first = await post("metrics", metric);
    assert.equal(first.status, 200);
    assert.equal(first.body.count, 1);
    const saved = store.read().metrics[0];
    assert.equal(saved.currency, "EUR");
    assert.equal(saved.timezone, "Asia/Shanghai");
    assert.equal(saved.campaignId, "campaign");
    assert.equal(saved.channel, "linkedin");
    const repeated = await post("metrics", metric);
    assert.equal(repeated.body.count, 0);
    assert.equal(repeated.body.duplicates, 1);
    const imported = await post("metrics/import", {
      rows: [{ ...metric, url: "https://example.com/post?a=1&b=2", date: "2026-01-02T02:00:00Z" }],
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.count, 0);
    assert.equal(imported.body.duplicates, 1);
    assert.equal(store.read().metrics.length, 1);
    const another = { ...metric, date: "2026-01-03T02:00:00Z" };
    assert.equal((await post("metrics/import", { rows: [another] })).body.count, 1);
    assert.equal((await post("metrics", another)).body.count, 0);
    assert.equal(store.read().metrics.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("suggestions generated from changed brand inputs cannot overwrite current work", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-stale-generation-"));
  const store = new Store(join(dir, "db.sqlite"));
  const app = createApp(store, join(dir, "output"));
  const evidence = {
    id: "evidence",
    title: "Sample",
    url: "https://example.com/source",
    text: "A local demonstration source with an exact quotation.",
    publishedAt: "2026-01-01",
    capturedAt: "2026-01-01",
    hash: "test",
    kind: "manual" as const,
    demo: true,
  };
  store.change((s) => {
    s.brand = { ...brand, updatedAt: "2026-01-01" };
    s.evidence.push(evidence);
  });
  const saved = {
    MODEL_ENABLED: process.env.MODEL_ENABLED,
    MODEL_BASE_URL: process.env.MODEL_BASE_URL,
    MODEL_NAME: process.env.MODEL_NAME,
    MODEL_API_KEY: process.env.MODEL_API_KEY,
  };
  process.env.MODEL_ENABLED = "true";
  process.env.MODEL_BASE_URL = "http://127.0.0.1:1/offline-stale-test";
  process.env.MODEL_NAME = "in-memory-test";
  delete process.env.MODEL_API_KEY;
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const originalFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      if (String(input) === "http://127.0.0.1:1/offline-stale-test/chat/completions") {
        started = true;
        await blocked;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  Array.from({ length: 3 }, () => ({
                    title: "Old brand suggestion",
                    reason: "Local test",
                    angle: "Neutral introduction",
                    evidenceIds: [evidence.id],
                    quotes: [{ evidenceId: evidence.id, quote: evidence.text }],
                  })),
                ),
              },
            },
          ],
        });
      }
      return originalFetch(input, init);
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: object) =>
    fetch(`${base}/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  try {
    const task = await (await post("tasks", { kind: "suggest" })).json();
    for (let i = 0; i < 100 && !started; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(started);
    assert.equal(
      (await post("brand", { ...brand, name: "Updated brand", audience: "New audience" })).status,
      200,
    );
    release();
    for (
      let i = 0;
      i < 100 && store.read().tasks.find((job) => job.id === task.id)?.status === "running";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const state = store.read();
    assert.equal(state.brand?.name, "Updated brand");
    assert.equal(state.suggestions.length, 0);
    assert.equal(state.tasks.find((job) => job.id === task.id)?.status, "failed");
    assert.match(state.tasks.find((job) => job.id === task.id)?.error || "", /已更新/);
  } finally {
    release();
    t.mock.restoreAll();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
