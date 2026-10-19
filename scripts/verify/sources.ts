// Explicit network integration check. Never runs during npm test; no credentials or publishing.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/storage/store.ts";
import { createApp } from "../../server/app.ts";
const liveModel = process.argv.includes("--model");
if (liveModel && process.env.MODEL_ENABLED !== "true")
  throw new Error("--model requires MODEL_ENABLED=true; refusing template fallback");
if (!liveModel) process.env.MODEL_ENABLED = "false";
const dir = mkdtempSync(join(tmpdir(), "harbor-public-check-"));
const store = new Store(join(dir, "db.sqlite"));
const app = createApp(store, join(dir, "artifacts"));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
};
const wait = async (id: string) => {
  for (let n = 0; n < 200; n++) {
    const t = store.read().tasks.find((x) => x.id === id)!;
    if (t.status === "failed") throw new Error(t.error);
    if (t.status === "succeeded") return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timeout");
};
const results: unknown[] = [];
try {
  for (const item of [
    { connector: "web", url: "https://example.com" },
    { connector: "rss", url: "https://hnrss.org/frontpage" },
    { connector: "github", url: "https://github.com/nodejs/node" },
  ].filter((item) => !(process.argv.includes("--skip-github") && item.connector === "github"))) {
    const start = Date.now();
    try {
      const source = await post("sources", {
        ...item,
        label: `Public check ${item.connector}`,
        category: "market",
        intervalHours: 24,
        enabled: false,
      });
      await wait(
        (
          await post("tasks", {
            kind: "sync",
            payload: { sourceId: source.id },
          })
        ).id,
      );
      const before = store.read().evidence.length;
      await wait(
        (
          await post("tasks", {
            kind: "sync",
            payload: { sourceId: source.id },
          })
        ).id,
      );
      const sourceState = store.read().sources.find((x) => x.id === source.id)!;
      results.push({
        ...item,
        status: "passed",
        items: sourceState.history[0].evidenceIds.length,
        secondAdded: store.read().evidence.length - before,
        history: sourceState.history.length,
        milliseconds: Date.now() - start,
      });
    } catch (e) {
      results.push({ ...item, status: "failed", error: (e as Error).message });
    }
  }
  if (!store.read().evidence.length)
    throw new Error("公开来源全部被网络安全检查阻止；未执行后续生成");
  await post("brand", {
    name: "PUBLIC CHECK DEMO",
    url: "https://example.com",
    product: "DEMO research workflow",
    parameters: "Test brand only",
    audience: "Test",
    market: "US",
    competitors: [],
    image: "",
  });
  await wait((await post("tasks", { kind: "suggest" })).id);
  await wait(
    (
      await post("tasks", {
        kind: "content",
        payload: { suggestionId: store.read().suggestions[0].id },
      })
    ).id,
  );
  const c = store.read().contents[0],
    r = c.revisions[0];
  if (liveModel) {
    if (store.read().suggestions.some((s) => s.mode !== "model") || r.mode !== "model")
      throw new Error("真实模型检查中出现模板结果");
    results.push({
      workflow: "public evidence → model suggestions → unapproved draft",
      status: "passed",
      suggestions: store.read().suggestions,
      draft: r,
      contentId: c.id,
    });
  } else {
    await post(`contents/${c.id}/approve`, { revisionId: r.id });
    const calendar = await post("calendar", {
      contentId: c.id,
      revisionId: r.id,
      channel: "linkedin",
      account: "DEMO no publishing",
      scheduledAt: new Date().toISOString(),
      copy: r.copy,
      headline: "DEMO workflow",
      targetUrl: "https://example.com",
      campaign: "verification",
    });
    await post(`calendar/${calendar.id}/approve`, {});
    const out = await fetch(base + `calendar/${calendar.id}/export`).then((r) => r.json());
    results.push({
      workflow:
        "sources → suggestions → content → revision approval → channel approval → UTM export",
      status: out.publishing === "manual-only" ? "passed" : "failed",
      evidence: out.evidence?.length,
    });
  }
} catch (e) {
  results.push({
    workflow: "end-to-end",
    status: "blocked",
    error: (e as Error).message,
  });
} finally {
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    liveModel ? "artifacts/public-model-check.json" : "artifacts/public-sources-v2.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        hostname: process.env.HOST || "langdeMac-Mini",
        isolatedDatabase: dir,
        model: liveModel
          ? "live model requested; inspect workflow result"
          : "disabled; template demonstration",
        githubSkipped: process.argv.includes("--skip-github"),
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results, null, 2));
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
}
if (results.some((x) => (x as { status: string }).status !== "passed")) process.exitCode = 1;
