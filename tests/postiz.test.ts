import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { listPostizPosts, type PostizConfig } from "../server/connectors/postiz.ts";

const range = { startDate: "2026-10-01T08:00:00+08:00", endDate: "2026-10-02T08:00:00+08:00" };
const channel = {
  id: "channel-a",
  name: "Brand A",
  identifier: "linkedin",
  disabled: false,
  profile: "brand-a",
};
const post = {
  id: "post-a",
  content: "Approved local copy",
  publishDate: "2026-10-01T02:00:00Z",
  state: "PUBLISHED",
  releaseURL: "https://www.linkedin.com/feed/update/example",
  releaseId: "external-a",
  error: null,
  integration: { id: channel.id, name: channel.name, providerIdentifier: channel.identifier },
};
const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: {
    method: string | undefined;
    path: string;
    authorization: string | undefined;
  }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      path: req.url || "",
      authorization: req.headers.authorization,
    });
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    config: {
      baseUrl: `http://127.0.0.1:${port}/api/public/v1`,
      apiKey: "mock-postiz-secret",
      integrationId: channel.id,
    } satisfies PostizConfig,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("Postiz validates the selected organization channel, uses two GETs with raw auth, and filters dates and brands", async () => {
  const f = await fixture((req, res) => {
    if (req.url?.endsWith("/integrations"))
      return json(res, [channel, { ...channel, id: "channel-b" }]);
    return json(res, {
      posts: [
        post,
        { ...post, id: "recurring", intervalInDays: 1, actualDate: "2026-09-20T02:00:00Z" },
        {
          ...post,
          id: "recurring",
          intervalInDays: 1,
          actualDate: "2026-09-20T02:00:00Z",
          publishDate: "2026-10-01T12:00:00Z",
        },
        { ...post, id: "before", publishDate: "2026-09-30T00:00:00Z" },
        { ...post, id: "other-brand", integration: { ...post.integration, id: "channel-b" } },
      ],
    });
  });
  try {
    const result = await listPostizPosts(f.config, range);
    assert.deepEqual(
      result.posts.map((p) => p.id),
      ["post-a", "recurring", "recurring"],
    );
    assert.equal(result.integration.id, channel.id);
    assert.equal(result.posts[0].publishDate, "2026-10-01T02:00:00.000Z");
    assert.match(result.note, /计划时间/);
    assert.match(result.note, /未生成 Harbor 交付回执/);
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
      assert.equal(request.method, "GET");
      assert.equal(request.authorization, f.config.apiKey);
    }
    const query = new URL(f.requests[1].path, "http://localhost");
    assert.equal(query.pathname, "/api/public/v1/posts");
    assert.equal(query.searchParams.get("startDate"), "2026-10-01T00:00:00.000Z");
    assert.equal(query.searchParams.get("endDate"), "2026-10-02T00:00:00.000Z");
    assert.equal(query.searchParams.size, 2);
  } finally {
    await f.close();
  }
});

test("Postiz rejects an absent or ambiguous channel before querying any posts", async () => {
  for (const channels of [[], [channel, channel]]) {
    const f = await fixture((_req, res) => json(res, channels));
    try {
      await assert.rejects(listPostizPosts(f.config, range), /绑定渠道不存在或不唯一/);
      assert.equal(f.requests.length, 1);
    } finally {
      await f.close();
    }
  }
});

test("Postiz never follows a redirect or exposes an upstream error body", async () => {
  for (const status of [302, 401, 403, 429, 500]) {
    const f = await fixture((_req, res) => {
      res.writeHead(status, { Location: "/do-not-request", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mock-postiz-secret and private upstream details" }));
    });
    try {
      await assert.rejects(listPostizPosts(f.config, range), (error) => {
        assert.match((error as Error).message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(
          (error as Error).message,
          /mock-postiz-secret|private upstream details|127\.0\.0\.1/,
        );
        return true;
      });
      assert.equal(f.requests.length, 1);
    } finally {
      await f.close();
    }
  }
});

test("Postiz rejects invalid URLs and date ranges before sending credentials", async () => {
  const f = await fixture((_req, res) => json(res, []));
  try {
    for (const baseUrl of [
      "http://example.com/public/v1",
      "https://127.0.0.2/public/v1",
      "https://10.0.0.1/public/v1",
      "https://169.254.169.254/public/v1",
      "https://example.com:8443/public/v1",
      "https://name:password@example.com/public/v1",
      "https://example.com/public/v1?key=secret",
      "https://example.com/public/v1#token",
      "file:///public/v1",
      "https://example.com/unknown",
    ])
      await assert.rejects(listPostizPosts({ ...f.config, baseUrl }, range));
    for (const invalid of [
      { startDate: "", endDate: range.endDate },
      { startDate: "2026-02-30T00:00:00Z", endDate: range.endDate },
      { startDate: "2026-10-01", endDate: "2026-10-02" },
      { startDate: range.endDate, endDate: range.startDate },
      { startDate: "2026-10-01T00:00:00Z", endDate: "2026-11-01T00:00:01Z" },
    ])
      await assert.rejects(listPostizPosts(f.config, invalid));
    await assert.rejects(
      listPostizPosts({ ...f.config, apiKey: "secret\r\nInjected: bad" }, range),
    );
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("Postiz rejects private or mixed DNS answers before opening a remote socket", async (t) => {
  const lookup = t.mock.method(dns, "lookup", async () => [
    { address: "1.1.1.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await assert.rejects(
    listPostizPosts(
      {
        baseUrl: "https://postiz.example.com/public/v1",
        apiKey: "test-only",
        integrationId: channel.id,
      },
      range,
    ),
    /DNS 指向非公开网络/,
  );
  assert.equal(lookup.mock.callCount(), 1);
});

test("Postiz validates status, channel type, public release URLs, response size and row limits", async () => {
  for (const body of [
    { posts: [{ ...post, state: "UNKNOWN_NEW_STATE" }] },
    { posts: [{ ...post, integration: { ...post.integration, providerIdentifier: "x" } }] },
    { posts: [{ ...post, releaseURL: "javascript:alert(1)" }] },
    { posts: [{ ...post, releaseURL: "http://127.0.0.1/secret" }] },
    { posts: [{ ...post, releaseURL: "https://name:password@example.com/post" }] },
    { posts: [{ ...post, publishDate: "" }] },
    { posts: [{ ...post, publishDate: "2026-02-30T00:00:00Z" }] },
    { posts: Array.from({ length: 501 }, (_, i) => ({ ...post, id: String(i) })) },
  ]) {
    const f = await fixture((req, res) =>
      json(res, req.url?.endsWith("/integrations") ? [channel] : body),
    );
    try {
      await assert.rejects(listPostizPosts(f.config, range));
    } finally {
      await f.close();
    }
  }
  const f = await fixture((req, res) => {
    if (req.url?.endsWith("/integrations")) return json(res, [channel]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write(" ".repeat(1024 * 1024));
    res.write(" ".repeat(1024 * 1024));
    res.end("{}");
  });
  try {
    await assert.rejects(listPostizPosts(f.config, range), /2MB/);
  } finally {
    await f.close();
  }
});

test("Postiz keeps disabled accounts and empty publication URLs explicit without claiming publication", async () => {
  const f = await fixture((req, res) =>
    json(
      res,
      req.url?.endsWith("/integrations")
        ? [channel]
        : {
            posts: [
              { ...post, state: "ERROR", releaseURL: null, error: "Provider rejected the post" },
            ],
          },
    ),
  );
  try {
    const result = await listPostizPosts(f.config, range);
    assert.equal(result.posts[0].releaseURL, null);
    assert.equal(result.posts[0].state, "ERROR");
    assert.equal(result.posts[0].error, "Provider rejected the post");
  } finally {
    await f.close();
  }
  const disabled = await fixture((req, res) =>
    json(
      res,
      req.url?.endsWith("/integrations") ? [{ ...channel, disabled: true }] : { posts: [post] },
    ),
  );
  try {
    const result = await listPostizPosts(disabled.config, range);
    assert.equal(result.integration.disabled, true);
    assert.match(result.note, /已禁用/);
    assert.match(result.note, /不代表账号可发布/);
  } finally {
    await disabled.close();
  }
});

test("Postiz fails closed if any successful response field reflects the API credential", async () => {
  for (const field of ["content", "releaseURL", "error", "integration.name", "unknown-field"]) {
    const f = await fixture((req, res) => {
      if (req.url?.endsWith("/integrations"))
        return json(res, [
          { ...channel, ...(field === "integration.name" ? { name: "mock-postiz-secret" } : {}) },
        ]);
      json(res, { posts: [{ ...post, [field]: "mock-postiz-secret" }] });
    });
    try {
      await assert.rejects(listPostizPosts(f.config, range), (error) => {
        assert.match((error as Error).message, /敏感凭证/);
        assert.doesNotMatch((error as Error).message, /mock-postiz-secret/);
        return true;
      });
    } finally {
      await f.close();
    }
  }
});

test("Postiz enforces the total request deadline while an upstream body is stalled", async (t) => {
  let received!: () => void;
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("[");
    received();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const result = listPostizPosts(f.config, range);
    const rejected = assert.rejects(result, /超时/);
    await started;
    t.mock.timers.tick(10000);
    await rejected;
    assert.equal(f.requests.length, 1);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
