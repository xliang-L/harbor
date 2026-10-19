import { recordApproval } from "./console.ts";
import { checkModel } from "../providers/model.ts";
import { brandIssues } from "../domain/campaigns.ts";
import {
  normalizeFactAttribute,
  normalizeFactValue,
  scheduledFactIssues,
} from "../domain/facts.ts";
import type { Express } from "express";
import { randomUUID, createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Store } from "../storage/store.ts";
import { publicUrl } from "../security.ts";
import { channels, validateChannel, utmUrl } from "../domain/channels.ts";
import { connectorCatalog } from "../connectors/sources.ts";
import { ga4Report } from "../connectors/ga4.ts";
import { recap, opportunities, attribution, metricAttribution } from "../domain/insights.ts";
import { metricIdentity, metricQuality, sameMetricTotals } from "../domain/metrics.ts";
import type { Metric, State } from "../types.ts";
const str = z.string().trim().min(1);
const optionalFactDate = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value).toISOString())
    .optional(),
);
const optionalFactText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    z.string().trim().min(1).max(max).optional(),
  );
const url = str.refine((x) => {
  try {
    publicUrl(x);
    return true;
  } catch {
    return false;
  }
}, "需要公开 HTTP(S) URL");
const metricSchema = z
  .object({
    contentId: str,
    revisionId: str,
    campaignId: z.string().trim().optional(),
    channel: z.string().trim().max(100).optional(),
    url,
    date: str
      .refine(
        (x) =>
          z.iso.datetime({ offset: true }).safeParse(x).success ||
          z.iso.date().safeParse(x).success,
        "数据读取时间需为带时区的 ISO 时间或 UTC 日期",
      )
      .refine(
        (x) => Number.isFinite(Date.parse(x)) && Date.parse(x) <= Date.now(),
        "时间无效或在未来",
      )
      .transform((x) => new Date(x).toISOString()),
    windowStart: optionalFactDate,
    windowEnd: optionalFactDate,
    impressions: z.coerce.number().int().nonnegative().finite(),
    clicks: z.coerce.number().int().nonnegative().finite(),
    conversions: z.coerce.number().int().nonnegative().finite(),
    spend: z.coerce.number().nonnegative().finite(),
    notes: z.string().max(2000).default(""),
    currency: z.string().regex(/^[A-Z]{3}$/),
    timezone: str.refine((x) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: x });
        return true;
      } catch {
        return false;
      }
    }, "IANA 时区无效"),
  })
  .refine((m) => !!m.windowStart === !!m.windowEnd, "统计窗口起止时间需成对填写")
  .refine(
    (m) => !m.windowStart || !m.windowEnd || Date.parse(m.windowStart) < Date.parse(m.windowEnd),
    "统计窗口起始必须早于截止",
  )
  .refine(
    (m) => !m.windowEnd || Date.parse(m.windowEnd) <= Date.parse(m.date),
    "统计窗口截止不能晚于数据读取时间",
  );
export function previewMetrics(raw: unknown, state: State) {
  const input = z
    .object({
      csv: z.string().max(300000).optional(),
      rows: z.array(z.unknown()).max(100).optional(),
    })
    .parse(raw);
  const rows: unknown[] = input.csv
    ? parse(input.csv, { columns: true, skip_empty_lines: true, bom: true })
    : input.rows || [];
  if (!rows.length || rows.length > 100) throw new Error("每次导入 1–100 行指标");
  const parsed = rows.map((row, i) => {
    try {
      if (
        typeof row === "object" &&
        row &&
        ["impressions", "clicks", "conversions", "spend"].some((k) => {
          const value = (row as Record<string, unknown>)[k];
          return value == null || (typeof value === "string" && !value.trim());
        })
      )
        throw new Error("指标数值不能为空");
      const m = metricSchema.parse(row);
      if (
        !state.contents
          .find((c) => c.id === m.contentId)
          ?.revisions.some((r) => r.id === m.revisionId && r.approvedAt)
      )
        throw new Error("内容具体版本未曾批准");
      if (
        m.campaignId &&
        !state.campaigns.some((c) => c.id === m.campaignId && c.contentIds.includes(m.contentId))
      )
        throw new Error("活动不属于当前品牌或未包含该内容");
      const id = randomUUID();
      const importKey = createHash("sha512")
        .update(metricIdentity({ ...m, id }))
        .digest("hex");
      const attributionInfo = metricAttribution(state, { ...m, id });
      return {
        row: i + 1,
        valid: true,
        duplicate: false,
        metric: { ...m, importKey, id } as Metric,
        warnings: attributionInfo.status === "unknown" ? [attributionInfo.explanation] : [],
        attribution: attributionInfo,
      };
    } catch (e) {
      return {
        row: i + 1,
        valid: false,
        duplicate: false,
        error:
          e instanceof z.ZodError
            ? e.issues.map((x) => `${x.path}: ${x.message}`).join("; ")
            : (e as Error).message,
      };
    }
  });
  const candidates = parsed.flatMap((row) => (row.metric ? [row.metric] : []));
  const quality = metricQuality([...state.metrics, ...candidates]);
  const checks = new Map(quality.rows.map((row) => [row.metric?.id, row]));
  const prior = state.metrics.filter((m) => m && !m.voidedAt);
  const rowNames = new Map(
    parsed.flatMap((row) => (row.metric ? [[row.metric.id, `本批第 ${row.row} 行`] as const] : [])),
  );
  return parsed.map((row) => {
    if (!row.metric) return row;
    const m = row.metric,
      check = checks.get(m.id)!;
    const matches = prior.filter((previous) => {
      try {
        return metricIdentity(previous) === metricIdentity(m);
      } catch {
        return false;
      }
    });
    prior.push(m);
    if (check.status === "conflict" || matches.some((previous) => !sameMetricTotals(previous, m))) {
      const conflicts = [
        ...new Set([
          ...check.relatedIds,
          ...matches
            .filter((previous) => !sameMetricTotals(previous, m))
            .map((previous) => previous.id),
        ]),
      ];
      return {
        ...row,
        valid: false,
        error: `统计窗口重叠或同窗口数值冲突：${conflicts.map((id) => rowNames.get(id) || `已有记录 ${id}`).join("、")}。请核对口径；错误记录需先填写原因撤销后重录。`,
        conflicts,
      };
    }
    if (check.status === "invalid-window")
      return { ...row, valid: false, error: check.issues.join("；") };
    return {
      ...row,
      duplicate: matches.some((previous) => sameMetricTotals(previous, m)),
      warnings: [
        ...(row.warnings || []),
        ...(check.status === "missing-window" ? check.issues : []),
      ],
    };
  });
}
export function workflowRoutes(app: Express, store: Store) {
  app.post("/api/model/check", async (_req, res) => {
    res.json(await checkModel());
  });
  app.get("/api/workflows", (_req, res) =>
    res.json({
      sources: store.read().sources,
      facts: store.read().facts,
      calendar: store.read().calendar,
      channels,
      connectors: connectorCatalog,
      opportunities: opportunities(store.read()),
      recap: recap(store.read()),
      attribution: attribution(store.read()),
      provider: {
        enabled: process.env.MODEL_ENABLED === "true",
        configured: !!(process.env.MODEL_BASE_URL && process.env.MODEL_NAME),
        name: process.env.MODEL_NAME || null,
        liveVerified: false,
      },
    }),
  );
  app.get("/api/sources/:id/diff", (req, res) => {
    const s = store.read(),
      source = s.sources.find((x) => x.id === req.params.id);
    if (!source) throw new Error("来源不存在");
    const previous = source.history.at(-2),
      latest = source.history.at(-1);
    const before = s.evidence.filter((e) => previous?.evidenceIds.includes(e.id)),
      after = s.evidence.filter((e) => latest?.evidenceIds.includes(e.id));
    res.json({
      previousAt: previous?.at,
      latestAt: latest?.at,
      added: after.filter((e) => !before.some((b) => b.url === e.url && b.text === e.text)),
      removed: before.filter((e) => !after.some((a) => a.url === e.url && a.text === e.text)),
    });
  });
  app.post("/api/sources", (req, res) => {
    const data = z
      .object({
        label: str.max(100),
        url,
        connector: z.enum(["web", "rss", "github"]),
        category: z.enum(["brand", "competitor", "market"]),
        intervalHours: z.number().int().min(1).max(720),
        enabled: z.boolean().default(false),
      })
      .parse(req.body);
    const id = store.change((s) => {
      const prior = s.sources.find((x) => x.url === data.url && x.connector === data.connector);
      if (prior) return prior.id;
      if (s.sources.length >= 50) throw new Error("每品牌最多 50 个来源");
      const id = randomUUID();
      s.sources.push({
        ...data,
        id,
        nextRunAt: new Date().toISOString(),
        history: [],
      });
      return id;
    });
    res.json({ id });
  });
  app.post("/api/sources/:id/toggle", (req, res) => {
    const enabled = z.boolean().parse(req.body.enabled);
    store.change((s) => {
      const source = s.sources.find((x) => x.id === req.params.id);
      if (!source) throw new Error("来源不存在");
      source.enabled = enabled;
      source.nextRunAt = new Date().toISOString();
    });
    res.json({ ok: true });
  });
  app.post("/api/facts", (req, res) => {
    const data = z
      .object({
        evidenceId: str,
        quote: str.min(5).max(3000),
        text: str.max(1000),
        scope: z.enum(["brand", "product"]),
        productId: str.optional(),
        actor: str.max(120),
        reconfirmsFactId: str.optional(),
        validFrom: optionalFactDate,
        validUntil: optionalFactDate,
        attribute: optionalFactText(120),
        value: optionalFactText(1000).transform((value) =>
          value === undefined ? undefined : normalizeFactValue(value),
        ),
      })
      .refine((fact) => !!fact.attribute === !!fact.value, "属性名与属性值必须成对填写")
      .refine(
        (fact) =>
          !fact.validFrom ||
          !fact.validUntil ||
          Date.parse(fact.validFrom) < Date.parse(fact.validUntil),
        "有效截止时间必须晚于有效起始时间",
      )
      .parse(req.body);
    const result = store.change((s) => {
      const e = s.evidence.find((x) => x.id === data.evidenceId);
      if (!e || !e.text.includes(data.quote)) throw new Error("事实引用必须是证据原文的连续子串");
      if (
        data.scope === "product" &&
        (!data.productId || !s.products.some((p) => p.id === data.productId))
      )
        throw new Error("商品事实必须关联当前品牌的有效商品");
      if (data.scope === "brand" && data.productId)
        throw new Error("品牌通用事实不能同时绑定单个商品");
      if (data.reconfirmsFactId) {
        const prior = s.facts.find((f) => f.id === data.reconfirmsFactId);
        if (!prior || prior.withdrawnAt)
          throw new Error("历史事实不存在或已撤回，不能通过重新确认恢复");
        if (
          prior.evidenceId !== data.evidenceId ||
          prior.quote !== data.quote ||
          prior.text !== data.text ||
          (prior.scope &&
            (prior.scope !== data.scope ||
              prior.productId !== data.productId ||
              normalizeFactAttribute(prior.attribute || "") !==
                normalizeFactAttribute(data.attribute || "") ||
              normalizeFactValue(prior.value || "") !== normalizeFactValue(data.value || "")))
        )
          throw new Error("重新确认需保留原事实、引用、范围和属性值；修改内容请创建独立事实");
      }
      const existing = s.facts.find(
        (f) =>
          !f.withdrawnAt &&
          f.scope === data.scope &&
          f.productId === data.productId &&
          f.evidenceId === data.evidenceId &&
          f.quote === data.quote &&
          f.text === data.text &&
          (f.validFrom || "") === (data.validFrom || "") &&
          (f.validUntil || "") === (data.validUntil || "") &&
          normalizeFactAttribute(f.attribute || "") ===
            normalizeFactAttribute(data.attribute || "") &&
          normalizeFactValue(f.value || "") === normalizeFactValue(data.value || "") &&
          f.reconfirmsFactId === data.reconfirmsFactId,
      );
      if (existing) return { id: existing.id, duplicate: true };
      const { actor, ...fact } = data;
      const id = randomUUID();
      s.facts.push({ ...fact, id, confirmedBy: actor, confirmedAt: new Date().toISOString() });
      return { id, duplicate: false };
    });
    res.json({ ok: true, ...result });
  });
  app.get("/api/facts/:id/impact", (req, res) => {
    const state = store.read();
    const factId = String(req.params.id);
    const fact = state.facts.find((f) => f.id === factId);
    if (!fact) throw new Error("事实不存在");
    const affected = (contentId: string, revisionId: string) =>
      state.contents
        .find((c) => c.id === contentId)
        ?.revisions.find((r) => r.id === revisionId)
        ?.facts?.some((f) => f.id === factId);
    const contents = state.contents.flatMap((c) => {
      const r = c.revisions.at(-1);
      return r?.facts?.some((f) => f.id === factId)
        ? [{ id: c.id, title: c.suggestion.title, revisionId: r.id, number: r.number }]
        : [];
    });
    res.json({
      factId,
      scope: {
        contents: "current-revisions",
        calendar: "all-saved-entries",
        campaigns: "current-associated-content",
        deliveries: "all-recorded-receipts",
      },
      note: "内容与活动按当前版本检查；排期包含旧版本及归档项；交付回执包含历史和已撤销记录。撤回事实不会抹去已发生的交付，请人工检查渠道。",
      contents,
      calendar: state.calendar
        .filter((e) => affected(e.contentId, e.revisionId))
        .map((e) => ({
          id: e.id,
          headline: e.headline,
          archivedAt: e.archivedAt,
          revisionId: e.revisionId,
        })),
      campaigns: state.campaigns
        .filter((c) => c.contentIds.some((id) => contents.some((x) => x.id === id)))
        .map((c) => ({ id: c.id, name: c.name })),
      deliveries: (state.deliveries || [])
        .filter((d) => d.factIds.includes(factId) || affected(d.contentId, d.revisionId))
        .map((d) => ({
          id: d.id,
          calendarId: d.calendarId,
          deliveredAt: d.deliveredAt,
          destinationUrl: d.destinationUrl,
          voidedAt: d.voidedAt,
        })),
    });
  });
  app.post("/api/facts/:id/withdraw", (req, res) => {
    const data = z.object({ actor: str.max(120), reason: str.min(5).max(1000) }).parse(req.body);
    const result = store.change((s) => {
      const fact = s.facts.find((f) => f.id === req.params.id);
      if (!fact) throw new Error("事实不存在");
      if (fact.withdrawnAt) return { duplicate: true };
      fact.withdrawnAt = new Date().toISOString();
      fact.withdrawnBy = data.actor;
      fact.withdrawalReason = data.reason;
      return { duplicate: false };
    });
    res.json({ ok: true, ...result });
  });
  app.post("/api/calendar", (req, res) => {
    const data = z
      .object({
        contentId: str,
        revisionId: str,
        channel: str,
        account: str.max(100),
        scheduledAt: str.refine((x) => Number.isFinite(Date.parse(x)), "排期时间无效"),
        copy: str.max(5000),
        headline: str.max(150),
        targetUrl: url,
        campaign: str.max(100),
        campaignId: str.optional(),
      })
      .parse(req.body);
    validateChannel(data.channel, data.copy, data.headline);
    if (data.campaignId) {
      const c = store.read().campaigns.find((c) => c.id === data.campaignId);
      if (!c || !c.contentIds.includes(data.contentId) || !c.channels.includes(data.channel))
        throw new Error("排期不属于该活动的内容/渠道范围");
    }
    const r = store
      .read()
      .contents.find((c) => c.id === data.contentId)
      ?.revisions.at(-1);
    if (!r || r.id !== data.revisionId) throw new Error("只能安排当前具体版本");
    const entry = {
      ...data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    store.change((s) => s.calendar.push(entry));
    res.json({ id: entry.id });
  });
  app.post("/api/calendar/:id/approve", (req, res) => {
    store.change((s) => {
      const e = s.calendar.find((x) => x.id === req.params.id);
      if (!e) throw new Error("排期不存在");
      const r = s.contents.find((c) => c.id === e.contentId)?.revisions.at(-1);
      if (
        !r ||
        r.id !== e.revisionId ||
        !r.approvedAt ||
        (r.approvalGuidelinesAt || "") !== (s.guidelines?.updatedAt || "")
      )
        throw new Error("需先批准当前内容版本；旧排期需重新创建");
      validateChannel(e.channel, e.copy, e.headline);
      if (e.archivedAt) throw new Error("排期已归档");
      const issues = [
        ...scheduledFactIssues(s, r, e.scheduledAt),
        ...brandIssues(s, e.copy + "\n" + e.headline),
      ];
      if (issues.length) throw new Error(issues.join("；"));
      e.approvedAt = new Date().toISOString();
      recordApproval(s, "calendar", e.id);
      e.approvalGuidelinesAt = s.guidelines?.updatedAt || "";
    });
    res.json({ ok: true });
  });
  app.get("/api/calendar/:id/export", (req, res) => {
    const s = store.read(),
      e = s.calendar.find((x) => x.id === req.params.id);
    if (!e) throw new Error("排期不存在");
    const r = s.contents.find((c) => c.id === e.contentId)?.revisions.at(-1);
    if (
      !e.approvedAt ||
      e.archivedAt ||
      (e.approvalGuidelinesAt || "") !== (s.guidelines?.updatedAt || "") ||
      !r?.approvedAt ||
      (r.approvalGuidelinesAt || "") !== (s.guidelines?.updatedAt || "") ||
      r.id !== e.revisionId
    )
      throw new Error("该排期尚未批准或版本已失效");
    const issues = scheduledFactIssues(s, r, e.scheduledAt);
    if (issues.length) throw new Error(issues.join("；"));
    res.attachment(`harbor-${e.channel}-${e.id}.json`).json({
      ...e,
      targetUrl: utmUrl(e.targetUrl, e.channel, e.campaign, e.revisionId),
      evidence: r.evidence,
      facts: r.facts,
      claims: r.claims,
      brand: r.brand,
      mode: r.mode,
      publishing: "manual-only",
      note: "人工交付包，未发布到第三方；审批绑定版本、渠道、账号与当前文案",
    });
  });
  app.post("/api/metrics/preview", (req, res) =>
    res.json({ rows: previewMetrics(req.body, store.read()) }),
  );
  app.post("/api/metrics/import", (req, res) => {
    let rejected: ReturnType<typeof previewMetrics> | undefined;
    try {
      const result = store.change((s) => {
        const rows = previewMetrics(req.body, s);
        if (rows.some((x) => !x.valid)) {
          rejected = rows;
          throw new Error("存在错误行，未导入任何数据");
        }
        const items = rows.filter((x) => !x.duplicate && x.metric).map((x) => x.metric!);
        s.metrics.push(...items);
        return { count: items.length, duplicates: rows.length - items.length };
      });
      res.json(result);
    } catch (error) {
      if (rejected)
        return res.status(400).json({ error: "存在错误行，未导入任何数据", rows: rejected });
      throw error;
    }
  });
  app.post("/api/metrics/:id/void", (req, res) => {
    const data = z.object({ actor: str.max(120), reason: str.max(2000) }).parse(req.body);
    store.change((s) => {
      const record = s.metrics.find((m) => m?.id === req.params.id);
      if (!record) throw new Error("当前品牌下效果记录不存在");
      if (record.voidedAt) throw new Error("这条效果记录已经撤销，历史记录保持不变");
      record.voidedAt = new Date().toISOString();
      record.voidedBy = data.actor;
      record.voidReason = data.reason;
    });
    res.json({ ok: true });
  });
  app.post("/api/connectors/ga4/report", async (req, res) =>
    res.json(await ga4Report(req.body.startDate, req.body.endDate)),
  );
}
