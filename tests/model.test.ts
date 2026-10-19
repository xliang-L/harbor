import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { suggestions } from "../server/generate.ts";
import type { Brand, Evidence } from "../server/types.ts";
test("configurable model adapter rejects fabricated citations and accepts exact quotes", async () => {
  let valid = false;
  const evidence: Evidence = {
    id: "e1",
    title: "test",
    text: "Verified exact quotation for a mock adapter test.",
    url: "https://example.com",
    publishedAt: "2026-01-01",
    capturedAt: "2026-01-01",
    hash: "test",
    kind: "manual",
    demo: true,
  };
  const brand: Brand = {
    name: "Demo",
    url: "https://example.com",
    product: "Demo",
    parameters: "Demo",
    audience: "Demo",
    market: "US",
    competitors: [],
    image: "",
    updatedAt: "",
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  Array.from({ length: 3 }, () => ({
                    title: "hypothesis",
                    reason: "mock output",
                    angle: "angle",
                    evidenceIds: ["e1"],
                    quotes: [
                      {
                        evidenceId: "e1",
                        quote: valid ? evidence.text : "Invented evidence without source",
                      },
                    ],
                  })),
                ),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const saved = {
    enabled: process.env.MODEL_ENABLED,
    url: process.env.MODEL_BASE_URL,
    name: process.env.MODEL_NAME,
  };
  try {
    process.env.MODEL_ENABLED = "true";
    process.env.MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.MODEL_NAME = "mock-only";
    await assert.rejects(suggestions(brand, [evidence]), /证据校验失败/);
    valid = true;
    const result = await suggestions(brand, [evidence]);
    assert.equal(result.length, 3);
    assert.equal(result[0].mode, "model");
  } finally {
    for (const [key, value] of Object.entries({
      MODEL_ENABLED: saved.enabled,
      MODEL_BASE_URL: saved.url,
      MODEL_NAME: saved.name,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.close();
  }
});

test("content provider rejects invented fact references and unsupported numbers", async () => {
  const { content } = await import("../server/generate.ts");
  let payload: unknown = { copy: "Capacity 999 ml", claims: [] };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const saved = {
    enabled: process.env.MODEL_ENABLED,
    url: process.env.MODEL_BASE_URL,
    name: process.env.MODEL_NAME,
  };
  const b: Brand = {
    name: "DEMO",
    url: "https://example.com",
    product: "sample",
    parameters: "sample",
    audience: "test",
    market: "US",
    competitors: [],
    image: "",
    updatedAt: "",
  };
  const suggestion = {
    id: "s",
    title: "test",
    angle: "test",
    reason: "hypothesis",
    evidenceIds: [],
    quotes: [],
    mode: "model",
  };
  const fact = {
    id: "f",
    text: "Capacity 500 ml",
    evidenceId: "e",
    quote: "capacity of 500 ml",
    confirmedAt: "",
    scope: "brand" as const,
  };
  try {
    process.env.MODEL_ENABLED = "true";
    process.env.MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.MODEL_NAME = "mock";
    await assert.rejects(content(b, suggestion, [fact]), /无来源数字/);
    payload = {
      copy: "Capacity 500 ml",
      claims: [{ text: "Capacity 500 ml", factId: "forged", quote: fact.quote }],
    };
    await assert.rejects(content(b, suggestion, [fact]), /事实引用校验失败/);
    payload = {
      copy: "Capacity 500 ml",
      claims: [{ text: "Capacity 500 ml", factId: "f", quote: fact.quote }],
    };
    assert.equal((await content(b, suggestion, [fact])).claims.length, 1);
  } finally {
    for (const [key, value] of Object.entries({
      MODEL_ENABLED: saved.enabled,
      MODEL_BASE_URL: saved.url,
      MODEL_NAME: saved.name,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.close();
  }
});

test("model discovery and failures stay explicit without retries or secret leakage", async () => {
  const { checkModel, model } = await import("../server/providers/model.ts");
  const keys = ["MODEL_ENABLED", "MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let code = 200;
  let response = JSON.stringify({ data: [{ id: "mock" }] });
  let hang = false;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, "/v1/models");
    assert.equal(req.method, "GET");
    req.resume();
    if (hang) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"data":');
      return;
    }
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    process.env.MODEL_ENABLED = "false";
    assert.equal((await checkModel()).status, "disabled");
    assert.equal(requests, 0);
    process.env.MODEL_ENABLED = "true";
    process.env.MODEL_NAME = "mock";
    process.env.MODEL_API_KEY = "test-only-secret";
    process.env.MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`;
    assert.deepEqual(await checkModel(), {
      status: "reachable",
      liveVerified: false,
      message: "服务可达且模型已列出；尚未验证生成、上游授权或额度",
    });
    response = JSON.stringify({ data: [] });
    assert.equal((await checkModel()).status, "model-not-found");
    for (const status of [401, 403, 404, 429, 500]) {
      code = status;
      response = "test-only-secret";
      const before: number = requests;
      await assert.rejects(checkModel(), (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.ok(!error.message.includes("test-only-secret"));
        return true;
      });
      assert.equal(requests, before + 1);
    }
    code = 200;
    response = "not json";
    await assert.rejects(checkModel(), /有效 JSON/);
    response = JSON.stringify({ data: [null] });
    await assert.rejects(checkModel(), /列表格式/);
    response = "x".repeat(1024 * 1024 + 1);
    await assert.rejects(checkModel(), /超过 1MB/);
    hang = true;
    await assert.rejects(checkModel(25), /超时/);
    for (const url of [
      "invalid",
      "http://remote.example/v1",
      "https://user:secret@example.com/v1",
      "https://example.com/v1?key=secret",
    ]) {
      process.env.MODEL_BASE_URL = url;
      await assert.rejects(model("test", {}), /地址无效|HTTPS/);
    }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
