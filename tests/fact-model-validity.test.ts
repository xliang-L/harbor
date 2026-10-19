import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import type { Fact } from "../server/types.ts";

type PendingGeneration = {
  store: Store;
  taskId: string;
  advanceTime: (milliseconds: number) => void;
  post: (path: string, body: object) => Promise<{ status: number; [key: string]: any }>;
};
async function blockedGeneration(
  t: TestContext,
  expire: boolean,
  changeWhileWaiting: (context: PendingGeneration) => Promise<void>,
  expectedError: RegExp,
) {
  const dir = mkdtempSync(join(tmpdir(), "harbor-fact-model-validity-"));
  const store = new Store(join(dir, "db.sqlite"));
  const saved = Object.fromEntries(
    ["MODEL_ENABLED", "MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const quote = "The provided power is 500 W and requires human confirmation.";
  store.change((s) => {
    s.brand = {
      name: "Async fact demo",
      product: "Product A",
      parameters: "Provided specification",
      url: "https://example.com",
      market: "US",
      audience: "Teams",
      competitors: [],
      image: "",
      updatedAt: new Date(clock).toISOString(),
      activeProductId: "product-a",
    };
    s.evidence.push({
      id: "source",
      title: "Provided specification",
      url: "https://example.com/specification",
      text: quote,
      publishedAt: "2026-01-01T00:00:00Z",
      capturedAt: "2026-01-01T00:00:00Z",
      kind: "manual",
      demo: true,
      hash: "test",
    });
    s.products.push({
      id: "product-a",
      sku: "a",
      title: "Product A",
      description: "Provided product",
      price: 10,
      currency: "USD",
      url: "https://example.com/product",
      evidenceId: "source",
      sourceName: "test",
      importedAt: "2026-01-01T00:00:00Z",
      demo: true,
    });
    s.facts.push({
      id: "fact-original",
      text: "Power is 500 W.",
      evidenceId: "source",
      quote,
      confirmedAt: new Date(clock).toISOString(),
      confirmedBy: "Reviewer",
      scope: "product",
      productId: "product-a",
      attribute: "power",
      value: "500 W",
      ...(expire ? { validUntil: new Date(clock + 1000).toISOString() } : {}),
    });
    s.suggestions.push({
      id: "suggestion",
      title: "Product introduction",
      reason: "Hypothesis",
      angle: "Neutral introduction",
      evidenceIds: ["source"],
      quotes: [{ evidenceId: "source", quote }],
      mode: "demo-template",
    });
  });
  process.env.MODEL_ENABLED = "true";
  process.env.MODEL_BASE_URL = "http://127.0.0.1:1/fact-validity-mock";
  process.env.MODEL_NAME = "in-memory-test";
  delete process.env.MODEL_API_KEY;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  let modelCalls = 0;
  let submittedFacts: Fact[] = [];
  const originalFetch = globalThis.fetch;
  const app = createApp(store, join(dir, "output"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url === "http://127.0.0.1:1/fact-validity-mock/chat/completions") {
        modelCalls++;
        submittedFacts = JSON.parse(
          JSON.parse(String(init?.body)).messages[1].content,
        ).confirmedFacts;
        started = true;
        await gate;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  copy: "Power is 500 W.",
                  claims: [{ text: "Power is 500 W.", factId: "fact-original", quote }],
                }),
              },
            },
          ],
        });
      }
      assert.ok(url.startsWith(base), "Only this temporary API may receive real HTTP requests");
      return originalFetch(input, init);
    },
  );
  const post = async (path: string, body: object) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  };
  async function waitUntilSettled() {
    for (
      let i = 0;
      i < 100 && store.read().tasks.some((task) => ["queued", "running"].includes(task.status));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
  }
  try {
    const task = await post("tasks", { kind: "content", payload: { suggestionId: "suggestion" } });
    assert.equal(task.status, 200);
    for (let i = 0; i < 100 && !started; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(started, "The model request must be waiting before the fact changes");
    assert.deepEqual(
      submittedFacts.map((fact) => fact.id),
      ["fact-original"],
      "Generation initially receives a valid fact",
    );
    assert.equal(store.read().tasks.find((item) => item.id === task.id)?.status, "running");
    assert.equal(store.read().contents.length, 0);
    await changeWhileWaiting({
      store,
      taskId: task.id,
      advanceTime: (milliseconds) => {
        clock += milliseconds;
      },
      post,
    });
    assert.equal(
      store.read().tasks.find((item) => item.id === task.id)?.status,
      "running",
      "Validation change happens while the response is still blocked",
    );
    release();
    await waitUntilSettled();
    const final = store.read().tasks.find((item) => item.id === task.id)!;
    assert.equal(final.status, "failed");
    assert.match(final.error || "", expectedError);
    assert.equal(final.result, undefined);
    assert.equal(final.attempt, 1);
    assert.equal(modelCalls, 1, "There must be no automatic model retry");
    assert.equal(
      store.read().contents.length,
      0,
      "A model response with invalidated facts must never be persisted",
    );
  } finally {
    release();
    await waitUntilSettled();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    t.mock.restoreAll();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a fact expiring while the model is waiting prevents the generated content from being saved", async (t) => {
  await blockedGeneration(
    t,
    true,
    async ({ store, advanceTime }) => {
      const before = JSON.stringify(store.read().facts);
      advanceTime(1000);
      assert.equal(
        JSON.stringify(store.read().facts),
        before,
        "Expiry must result from elapsed time, not modifying the fact",
      );
    },
    /已过期/,
  );
});

test("a new conflicting fact while the model is waiting prevents the generated content from being saved", async (t) => {
  await blockedGeneration(
    t,
    false,
    async ({ store, post }) => {
      const original = store.read().facts[0];
      const conflict = await post("facts", {
        text: "A competing human-provided power rating",
        evidenceId: original.evidenceId,
        quote: original.quote,
        scope: original.scope,
        productId: original.productId,
        attribute: " POWER ",
        value: "600 W",
        actor: "Second reviewer",
      });
      assert.equal(conflict.status, 200);
      assert.notEqual(conflict.id, original.id);
      assert.equal(
        store.read().facts.length,
        2,
        "Both records remain available for human conflict review",
      );
      assert.deepEqual(
        store.read().facts.find((fact) => fact.id === original.id),
        original,
      );
    },
    /潜在冲突/,
  );
});
