import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { createWorkspaceApp } from "../server/storage/workspaces.ts";
import { postizConfig } from "../server/workflows/postiz-routes.ts";

test("Postiz config never falls back to a different brand's token or integration", () => {
  const env = {
    POSTIZ_BASE_URL: "https://example.com/public/v1",
    POSTIZ_API_KEY: "test-secret",
    POSTIZ_INTEGRATION_ID: "default-account",
  };
  assert.equal(postizConfig("default", env)?.integrationId, "default-account");
  assert.equal(postizConfig("brand-demo", env), null);
  assert.equal(
    postizConfig("brand-demo", {
      ...env,
      POSTIZ_BRAND_DEMO_BASE_URL: env.POSTIZ_BASE_URL,
      POSTIZ_BRAND_DEMO_INTEGRATION_ID: "brand-account",
    }),
    null,
  );
});

test("Postiz routes expose no secrets and perform only reads for the explicitly configured brand", async () => {
  const calls: { method: string; url: string; authorization: string | undefined }[] = [];
  const remote = http.createServer((req, res) => {
    calls.push({
      method: req.method || "",
      url: req.url || "",
      authorization: req.headers.authorization,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/public/v1/integrations"))
      res.end(
        JSON.stringify([
          { id: "account-default", name: "Demo default", identifier: "x", disabled: false },
          { id: "account-alpha", name: "Demo alpha", identifier: "x", disabled: false },
        ]),
      );
    else
      res.end(
        JSON.stringify({
          posts: ["default", "alpha"].map((name) => ({
            id: name,
            content: name,
            publishDate: "2026-10-18T00:00:00Z",
            state: "PUBLISHED",
            releaseURL: "https://example.com/" + name,
            integration: { id: `account-${name}`, name: `Demo ${name}`, providerIdentifier: "x" },
          })),
        }),
      );
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  const rootUrl = `http://127.0.0.1:${(remote.address() as { port: number }).port}/public/v1`;
  const keys = [
    "POSTIZ_BASE_URL",
    "POSTIZ_API_KEY",
    "POSTIZ_INTEGRATION_ID",
    "POSTIZ_ALPHA_BASE_URL",
    "POSTIZ_ALPHA_API_KEY",
    "POSTIZ_ALPHA_INTEGRATION_ID",
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.POSTIZ_BASE_URL = rootUrl;
  process.env.POSTIZ_API_KEY = "default-test-secret";
  process.env.POSTIZ_INTEGRATION_ID = "account-default";
  for (const key of keys.filter((key) => key.startsWith("POSTIZ_ALPHA_"))) delete process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "harbor-postiz-routes-"));
  const initial = new Store(join(dir, "projects", "alpha", "harbor.sqlite"));
  initial.close();
  const app = createWorkspaceApp(dir, join(dir, "output"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const check = (project: string) =>
    fetch(`${base}/api/postiz/check?project=${project}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ startDate: "2026-10-17T00:00:00Z", endDate: "2026-10-19T00:00:00Z" }),
    });
  try {
    const status = await fetch(`${base}/api/postiz/status`).then((r) => r.text());
    assert.equal(status.includes("default-test-secret"), false);
    assert.equal(JSON.parse(status).configured, true);
    assert.equal(
      (await fetch(`${base}/api/postiz/status?project=alpha`).then((r) => r.json())).configured,
      false,
    );
    assert.equal((await check("alpha")).status, 400);
    assert.equal(calls.length, 0, "unconfigured brand cannot issue any upstream request");
    const result = await check("default").then((r) => r.json());
    assert.deepEqual(
      result.posts.map((p: { id: string }) => p.id),
      ["default"],
    );
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every((call) => call.method === "GET" && call.authorization === "default-test-secret"),
    );
    process.env.POSTIZ_ALPHA_BASE_URL = rootUrl;
    process.env.POSTIZ_ALPHA_API_KEY = "alpha-test-secret";
    process.env.POSTIZ_ALPHA_INTEGRATION_ID = "account-alpha";
    const alpha = await check("alpha").then((r) => r.json());
    assert.deepEqual(
      alpha.posts.map((p: { id: string }) => p.id),
      ["alpha"],
    );
    assert.ok(
      calls
        .slice(2)
        .every((call) => call.method === "GET" && call.authorization === "alpha-test-secret"),
    );
    assert.equal(
      (
        await fetch(`${base}/api/postiz/status?project=alpha`, {
          headers: { "X-Harbor-Project": "default" },
        })
      ).status,
      400,
    );
    const state = await fetch(`${base}/api/state?project=alpha`).then((r) => r.json());
    assert.equal(
      state.deliveries,
      undefined,
      "read-only status cannot manufacture a delivery receipt",
    );
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    app.locals.stopScheduler();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
