import { retailRoutes } from "./workflows/retail-routes.ts";
import { orderRoutes } from "./workflows/order-routes.ts";
import { recordApproval } from "./workflows/console-routes.ts";
import { inboundRoutes } from "./workflows/inbound-routes.ts";
import { crmRoutes } from "./workflows/crm-routes.ts";
import { campaignRoutes } from "./workflows/campaign-routes.ts";
import { overviewRoutes } from "./workflows/overview-routes.ts";
import { deliveryRoutes } from "./workflows/delivery-routes.ts";
import { postizRoutes } from "./workflows/postiz-routes.ts";
import { brandIssues } from "./domain/campaigns.ts";
import { applicableFacts, revisionFactIssues } from "./domain/facts.ts";
import { previewMetrics, workflowRoutes } from "./workflows/routes.ts";
import { syncSource } from "./jobs/sources.ts";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { Store } from "./store.ts";
import { fetchPublic, publicUrl } from "./security.ts";
import { suggestions, content } from "./generate.ts";
import { renderVideo, previewHtml } from "./video.ts";
import type { Evidence, Revision, Task } from "./types.ts";
const stamp = () => new Date().toISOString();
const str = z.string().trim().min(1);
const url = str.refine((s) => {
  try {
    publicUrl(s);
    return true;
  } catch {
    return false;
  }
}, "需要合法公开 HTTP(S) URL");
const date = str.refine(
  (s) => Number.isFinite(Date.parse(s)) && Date.parse(s) <= Date.now() + 60000,
  "时间无效或在未来",
);
const image = z
  .string()
  .max(2800000)
  .refine(
    (s) => s === "" || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s),
    "只支持 PNG/JPEG/WebP 图片",
  );
const brandSchema = z.object({
  name: str.max(100),
  url,
  product: str.max(200),
  parameters: str.max(3000),
  audience: str.max(300),
  market: str.max(100),
  competitors: z.array(url).max(3),
  image,
});
const evidenceSchema = z.object({
  title: str.max(200),
  url,
  publishedAt: date,
  text: str.min(20).max(30000),
  demo: z.boolean().default(false),
});
const revisionSchema = z
  .object({
    baseRevisionId: str,
    renderer: z.enum(["hyperframes", "remotion"]).optional(),
    factReview: z
      .object({
        confirmed: z.literal(true),
        actor: str.max(120),
        reason: str.min(5).max(1000),
        factIds: z.array(str).max(100),
      })
      .optional(),
    copy: str.max(5000),
    scenes: z
      .array(
        z.object({
          start: z.number(),
          end: z.number(),
          text: str.max(350),
          visual: str.max(500),
        }),
      )
      .length(3),
  })
  .refine(
    (x) => x.scenes.every((s, i) => s.start === i * 10 && s.end === (i + 1) * 10),
    "分镜必须连续覆盖 0–30 秒，每段 10 秒",
  );
function evidence(raw: unknown, kind: "manual" | "fetch"): Evidence {
  const e = evidenceSchema.parse(raw);
  return {
    ...e,
    id: randomUUID(),
    kind,
    capturedAt: stamp(),
    hash: createHash("sha512").update(e.text).digest("hex"),
  };
}
export function createApp(store: Store, outputDir: string, projectId = "default") {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return res.status(403).json({ error: "仅允许本机访问" });
    if (req.headers.origin && req.headers.origin !== `http://${host}`)
      return res.status(403).json({ error: "跨域请求已阻止" });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "4mb" }));
  store.change((s) => {
    s.tasks
      .filter((t) => ["running", "queued"].includes(t.status))
      .forEach((t) => {
        t.status = "failed";
        t.error = "服务重启导致任务中断，请重试";
        t.updatedAt = stamp();
      });
  });
  const active = new Set<string>();
  async function run(id: string) {
    if (active.has(id) || active.size >= 3) return;
    const task = store.change((s) => {
      const t = s.tasks.find((t) => t.id === id);
      // Multiple completions can schedule the same next job before it starts.
      // Claim only queued work so a later callback cannot replay a finished job.
      if (!t || t.status !== "queued") return;
      t.status = "running";
      t.updatedAt = stamp();
      return structuredClone(t);
    });
    if (!task) return;
    active.add(id);
    try {
      const s = store.read();
      let result = "";
      if (task.kind === "sync") result = await syncSource(store, task.payload.sourceId);
      if (task.kind === "fetch") {
        const data = await fetchPublic(task.payload.url);
        const e = evidence(
          {
            ...data,
            url: task.payload.url,
            publishedAt: task.payload.publishedAt,
            demo: false,
          },
          "fetch",
        );
        store.change((s) => {
          if (!s.evidence.some((x) => x.url === e.url && x.text === e.text)) s.evidence.push(e);
        });
        result = e.id;
      }
      if (task.kind === "suggest") {
        if (!s.brand) throw new Error("请先保存品牌档案");
        const inputs = JSON.stringify([s.brand, s.evidence, s.guidelines]);
        const data = await suggestions(s.brand, s.evidence, s.guidelines);
        store.change((s) => {
          if (JSON.stringify([s.brand, s.evidence, s.guidelines]) !== inputs)
            throw new Error("品牌、来源或规范已更新，请重新生成建议");
          s.suggestions = data;
        });
        result = "已生成 3 条建议";
      }
      if (task.kind === "content") {
        if (!s.brand) throw new Error("请先保存品牌档案");
        const suggestion = s.suggestions.find((x) => x.id === task.payload.suggestionId);
        if (!suggestion) throw new Error("建议不存在，请重新选择");
        const facts = applicableFacts(s);
        const generated = await content(s.brand, suggestion, facts, s.guidelines);
        const id = randomUUID();
        const revision: Revision = {
          ...generated,
          id: randomUUID(),
          number: 1,
          createdAt: stamp(),
          brand: structuredClone(s.brand),
          facts: structuredClone(facts),
          guidelines: structuredClone(s.guidelines),
          evidence: s.evidence.filter(
            (e) =>
              suggestion.evidenceIds.includes(e.id) || facts.some((f) => f.evidenceId === e.id),
          ),
        };
        store.change((s) => {
          const issues = revisionFactIssues(s, revision);
          if (issues.length) throw new Error(issues.join("；"));
          s.contents.push({ id, suggestion, revisions: [revision] });
        });
        result = id;
      }
      if (task.kind === "render") {
        const c = s.contents.find((c) => c.id === task.payload.contentId);
        const r = c?.revisions.find((r) => r.id === task.payload.revisionId);
        if (!r) throw new Error("内容版本不存在");
        const file = await renderVideo(r, outputDir);
        store.change((s) => {
          const target = s.contents
            .find((c) => c.id === task.payload.contentId)
            ?.revisions.find((r) => r.id === task.payload.revisionId);
          if (target) target.video = file;
        });
        result = file;
      }
      store.change((s) => {
        const t = s.tasks.find((t) => t.id === id)!;
        t.status = "succeeded";
        t.result = result;
        t.error = undefined;
        t.updatedAt = stamp();
      });
    } catch (e) {
      store.change((s) => {
        const t = s.tasks.find((t) => t.id === id)!;
        t.status = "failed";
        t.error = e instanceof Error ? e.message : "任务失败";
        t.updatedAt = stamp();
      });
    } finally {
      active.delete(id);
      const next = store.read().tasks.find((t) => t.status === "queued");
      if (next) setImmediate(() => void run(next.id));
    }
  }
  app.get("/api/state", (_req, res) => {
    const state = store.read();
    res.json({
      ...state,
      assets: state.assets.map((a) => ({ ...a, image: "" })),
      mode: process.env.MODEL_ENABLED === "true" ? "model" : "demo-template",
    });
  });
  app.use("/api", (req, res, next) => {
    if (req.method === "GET") return next();
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length > 100)
      return res.status(400).json({ error: "缺少幂等请求标识" });
    const signature = createHash("sha512")
      .update(req.path + JSON.stringify(req.body))
      .digest("hex");
    const cached = store.db
      .prepare("SELECT signature,response FROM requests WHERE key=?")
      .get(key) as { signature: string; response: string } | undefined;
    if (cached) {
      if (cached.signature !== signature) return res.status(409).json({ error: "请求标识冲突" });
      return res.json(JSON.parse(cached.response));
    }
    const original = res.json.bind(res);
    res.json = (body: any) => {
      if (res.statusCode < 300)
        store.db
          .prepare("INSERT OR IGNORE INTO requests VALUES (?,?,?)")
          .run(key, signature, JSON.stringify(body));
      return original(body);
    };
    next();
  });
  retailRoutes(app, store);
  orderRoutes(app, store);
  crmRoutes(app, store);
  inboundRoutes(app, store);
  workflowRoutes(app, store);
  campaignRoutes(app, store);
  overviewRoutes(app, store);
  deliveryRoutes(app, store);
  postizRoutes(app, store, projectId);
  app.post("/api/brand", (req, res) => {
    const b = brandSchema.parse(req.body);
    store.change((s) => {
      const activeProductId =
        s.brand?.product === b.product &&
        s.brand.parameters === b.parameters &&
        s.products.some((product) => product.id === s.brand?.activeProductId)
          ? s.brand.activeProductId
          : undefined;
      s.brand = { ...b, activeProductId, updatedAt: stamp() };
      s.suggestions = [];
    });
    res.json({ ok: true });
  });
  app.post("/api/evidence", (req, res) => {
    let rows: unknown[];
    if (req.body.csv) {
      const csv = z.string().max(300000).parse(req.body.csv);
      rows = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
      }).map((r: any) => ({ ...r, demo: r.demo === "true" }));
    } else rows = req.body.rows ? z.array(z.unknown()).max(100).parse(req.body.rows) : [req.body];
    if (rows.length > 100 || rows.length === 0) throw new Error("每次导入 1–100 条资料");
    const items = rows.map((r) => evidence(r, "manual"));
    let count = 0;
    store.change((s) => {
      for (const e of items) {
        if (!s.evidence.some((x) => x.text === e.text && x.url === e.url)) {
          s.evidence.push(e);
          count++;
        }
      }
      s.suggestions = [];
    });
    res.json({ ok: true, count });
  });
  app.post("/api/tasks", (req, res) => {
    const kind = z.enum(["fetch", "suggest", "content", "render", "sync"]).parse(req.body.kind);
    const payload = req.body.payload || {};
    if (kind === "fetch") {
      url.parse(payload.url);
      date.parse(payload.publishedAt);
    }
    if (kind === "sync") str.parse(payload.sourceId);
    if (kind === "content") str.parse(payload.suggestionId);
    if (kind === "render") {
      str.parse(payload.contentId);
      str.parse(payload.revisionId);
    }
    const prior = store
      .read()
      .tasks.find(
        (t) =>
          t.kind === kind &&
          JSON.stringify(t.payload) === JSON.stringify(payload) &&
          ["running", "queued"].includes(t.status),
      );
    if (prior) return res.json({ id: prior.id });
    const t: Task = {
      id: randomUUID(),
      kind,
      payload,
      status: "queued",
      attempt: 1,
      createdAt: stamp(),
      updatedAt: stamp(),
    };
    store.change((s) => s.tasks.push(t));
    res.json({ id: t.id });
    setImmediate(() => void run(t.id));
  });
  app.post("/api/tasks/:id/retry", (req, res) => {
    const id = String(req.params.id);
    store.change((s) => {
      const t = s.tasks.find((t) => t.id === id);
      if (!t || t.status !== "failed") throw new Error("仅失败任务可重试");
      t.status = "queued";
      t.attempt++;
      t.updatedAt = stamp();
    });
    res.json({ id });
    setImmediate(() => void run(id));
  });
  app.post("/api/contents/:id/revise", (req, res) => {
    const data = revisionSchema.parse(req.body);
    store.change((s) => {
      const c = s.contents.find((c) => c.id === req.params.id);
      if (!c) throw new Error("内容不存在");
      const latest = c.revisions.at(-1)!;
      if (latest.id !== data.baseRevisionId) throw new Error("版本已更新，请刷新后编辑");
      const { copy, scenes } = data;
      const reviewed = data.factReview;
      let facts = latest.facts;
      let evidence = latest.evidence;
      if (reviewed) {
        const available = applicableFacts(s, latest.brand);
        if (reviewed.factIds.some((id) => !available.some((fact) => fact.id === id)))
          throw new Error("所选事实已撤回、未确认范围或不适用于此内容商品");
        facts = available.filter((fact) => reviewed.factIds.includes(fact.id));
        const priorSources = new Set((latest.facts || []).map((fact) => fact.evidenceId));
        const retained = latest.evidence.filter(
          (e) => !priorSources.has(e.id) || c.suggestion.evidenceIds.includes(e.id),
        );
        evidence = [
          ...retained,
          ...s.evidence.filter(
            (e) =>
              facts!.some((fact) => fact.evidenceId === e.id) &&
              !retained.some((old) => old.id === e.id),
          ),
        ];
      }
      c.revisions.push({
        ...latest,
        id: randomUUID(),
        number: latest.number + 1,
        renderer: data.renderer || latest.renderer || "hyperframes",
        copy,
        scenes,
        facts,
        evidence,
        factReview: reviewed
          ? {
              reviewedAt: stamp(),
              actor: reviewed.actor,
              reason: reviewed.reason,
              previousFactIds: (latest.facts || []).map((fact) => fact.id),
              factIds: facts!.map((fact) => fact.id),
            }
          : undefined,
        createdAt: stamp(),
        claims: [], // Manual edits require a fresh human review; old model claim mapping no longer describes the copy.
        approvedAt: undefined,
        video: undefined,
      });
    });
    res.json({ ok: true });
  });
  app.post("/api/contents/:id/approve", (req, res) => {
    store.change((s) => {
      const c = s.contents.find((c) => c.id === req.params.id);
      const r = c?.revisions.at(-1);
      if (!r || r.id !== req.body.revisionId) throw new Error("只能批准当前具体版本");
      const issues = [
        ...revisionFactIssues(s, r),
        ...brandIssues(s, r.copy + "\n" + r.scenes.map((x) => x.text).join("\n")),
      ];
      if (issues.length) throw new Error(issues.join("；"));
      r.approvedAt = stamp();
      recordApproval(s, "content", String(req.params.id));
      r.approvalGuidelinesAt = s.guidelines?.updatedAt || "";
    });
    res.json({ ok: true });
  });
  const current = (id: string, revisionId: string, approval: boolean) => {
    const state = store.read();
    const c = state.contents.find((c) => c.id === id);
    const r = c?.revisions.at(-1);
    if (!r || r.id !== revisionId) throw new Error("该版本已失效，请使用当前版本");
    if (
      approval &&
      (!r.approvedAt || (r.approvalGuidelinesAt || "") !== (state.guidelines?.updatedAt || ""))
    )
      throw new Error("当前版本尚未批准");
    const issues = approval ? revisionFactIssues(state, r) : [];
    if (issues.length) throw new Error(issues.join("；"));
    return r;
  };
  app.get("/api/contents/:id/:revision/preview", (req, res) => {
    const r = current(String(req.params.id), String(req.params.revision), false);
    res.type("html").send(previewHtml(r));
  });
  app.get("/api/contents/:id/:revision/download", (req, res) => {
    const r = current(String(req.params.id), String(req.params.revision), true);
    res.attachment(`harbor-v${r.number}.json`).json(r);
  });
  app.get("/api/contents/:id/:revision/video-preview", (req, res) => {
    const r = current(String(req.params.id), String(req.params.revision), false);
    if (!r.video) throw new Error("MP4 尚未生成");
    res.sendFile(r.video);
  });
  app.get("/api/contents/:id/:revision/video", (req, res) => {
    const r = current(String(req.params.id), String(req.params.revision), true);
    if (!r.video) throw new Error("MP4 尚未生成");
    res.download(r.video, `harbor-v${r.number}.mp4`);
  });
  app.post("/api/metrics", (req, res) => {
    const result = store.change((s) => {
      const row = previewMetrics({ rows: [req.body] }, s)[0];
      if (!row.valid || !row.metric) throw new Error(row.error || "指标无效");
      if (!row.duplicate) s.metrics.push(row.metric);
      return { count: row.duplicate ? 0 : 1, duplicates: row.duplicate ? 1 : 0 };
    });
    res.json({ ok: true, ...result });
  });
  app.locals.tickSources = () => {
    for (const source of store
      .read()
      .sources.filter((x) => x.enabled && Date.parse(x.nextRunAt) <= Date.now())) {
      if (
        store
          .read()
          .tasks.some(
            (t) =>
              t.kind === "sync" &&
              t.payload.sourceId === source.id &&
              ["running", "queued"].includes(t.status),
          )
      )
        continue;
      const t: Task = {
        id: randomUUID(),
        kind: "sync",
        payload: { sourceId: source.id },
        status: "queued",
        attempt: 1,
        createdAt: stamp(),
        updatedAt: stamp(),
      };
      store.change((s) => s.tasks.push(t));
      void run(t.id);
    }
  };
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    void _next;
    res.status(400).json({
      error:
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；")
          : err.message || "请求失败",
    });
  });
  return app;
}
