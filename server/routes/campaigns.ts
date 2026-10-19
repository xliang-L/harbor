import { recordApproval } from "./console.ts";
import type { Express } from "express";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Store } from "../storage/store.ts";
import { previewProducts, productImportSchema } from "../connectors/products.ts";
import { campaignCheck, brandIssues, onboardingSteps } from "../domain/campaigns.ts";
import { revisionFactIssues } from "../domain/facts.ts";
import { channels, utmUrl } from "../domain/channels.ts";
import { attribution } from "../domain/insights.ts";
const str = z.string().trim().min(1);
const metric = z.enum(["impressions", "clicks", "conversions"]);
const iso = str.refine((x) => Number.isFinite(Date.parse(x)), "时间格式无效");
const campaignSchema = z
  .object({
    name: str.max(120),
    objective: str.max(1000),
    audience: str.max(300),
    primaryMetric: metric,
    target: z.number().positive().finite(),
    budget: z.number().nonnegative().finite(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    startsAt: iso,
    endsAt: iso,
    channels: z
      .array(z.string().refine((x) => channels.some((c) => c.id === x)))
      .min(1)
      .max(5),
    productIds: z.array(str).max(100),
    assetIds: z.array(str).max(20),
    contentIds: z.array(str).max(100),
    suggestionId: str.optional(),
  })
  .refine((x) => Date.parse(x.endsAt) >= Date.parse(x.startsAt), "活动结束时间不能早于开始时间");
export function campaignRoutes(app: Express, store: Store) {
  app.get("/api/planning", (_req, res) => {
    const s = store.read();
    const report = attribution(s);
    res.json({
      onboarding: onboardingSteps(s),
      channels,
      campaigns: s.campaigns.map((c) => ({
        ...c,
        check: campaignCheck(s, c),
        feedback: {
          samples: report.rows.filter((m) => m.attribution.campaignId === c.id).length,
          observed: report.rows
            .filter((m) => m.attribution.campaignId === c.id)
            .reduce((a, m) => a + m[c.primaryMetric], 0),
          target: c.target,
          metric: c.primaryMetric,
          unknownSamples: report.rows.filter(
            (m) => !m.attribution.campaignId && c.contentIds.includes(m.contentId),
          ).length,
          excludedSamples: report.quality.rows.filter(
            (row) => row.status !== "included" && c.contentIds.includes(row.metric?.contentId),
          ).length,
          note: "仅统计窗口明确、无冲突且有明确活动 ID 或唯一 UTM 匹配的记录；未知归因不计入活动。排除数量指关联内容的记录；零条可汇总记录表示缺少可用数据，不代表零效果或因果归因。",
        },
      })),
      assets: s.assets.map((a) => ({
        ...a,
        image: undefined,
        url: `/api/assets/${a.id}/image`,
      })),
      library: s.contents.map((c) => {
        const r = c.revisions.at(-1)!;
        return {
          contentId: c.id,
          revisionId: r.id,
          title: c.suggestion.title,
          version: r.number,
          copy: r.copy,
          approved:
            !!r.approvedAt &&
            (r.approvalGuidelinesAt || "") === (s.guidelines?.updatedAt || "") &&
            !revisionFactIssues(s, r).length,
          renderer: r.renderer || "hyperframes",
          videoReady: !!r.video && existsSync(r.video),
          imageReady: !!r.brand.image,
          issues: [...brandIssues(s, r.copy), ...revisionFactIssues(s, r)],
        };
      }),
      connectionCheck: {
        network: "未发起请求；保留 SSRF，fake-IP 问题待授权处理",
        model:
          process.env.MODEL_ENABLED === "true"
            ? process.env.MODEL_BASE_URL && process.env.MODEL_NAME
              ? "configured-unverified"
              : "missing-configuration"
            : "disabled",
        ga4:
          process.env.GA4_PROPERTY_ID && process.env.GA4_ACCESS_TOKEN
            ? "configured-unverified"
            : "not-connected",
        shopify: "file-import-only",
        publishing: "disabled",
      },
    });
  });
  app.post("/api/guidelines", (req, res) => {
    const data = z
      .object({
        goal: str.max(1000),
        tone: str.max(300),
        valueProposition: str.max(1000),
        forbiddenClaims: z.array(str.max(100)).max(30),
        primaryMetric: metric,
        target: z.number().positive().finite(),
      })
      .parse(req.body);
    store.change((s) => {
      s.guidelines = {
        ...data,
        updatedAt: new Date(
          Math.max(Date.now(), (Date.parse(s.guidelines?.updatedAt || "") || 0) + 1),
        ).toISOString(),
      };
      s.suggestions = [];
    });
    res.json({ ok: true });
  });
  app.post("/api/products/preview", (req, res) =>
    res.json({ rows: previewProducts(req.body, store.read()) }),
  );
  app.post("/api/products/import", (req, res) => {
    const input = productImportSchema.parse(req.body);
    const rows = previewProducts(input, store.read());
    if (rows.some((x) => !x.valid))
      return res.status(400).json({ error: "存在错误行，未导入任何商品", rows });
    const items = rows.filter((x) => x.product && !x.duplicate && !x.skipped);
    store.change((s) => {
      for (const item of items) {
        const p = item.product!;
        const at = new Date().toISOString();
        const text = JSON.stringify({
          sku: p.sku,
          title: p.title,
          description: p.description,
          price: p.price,
          currency: p.currency,
        });
        const evidenceId = randomUUID();
        s.evidence.push({
          id: evidenceId,
          title: `商品导入：${p.title}`,
          url: p.url,
          publishedAt: at,
          capturedAt: at,
          text,
          hash: createHash("sha512").update(text).digest("hex"),
          kind: "manual",
          demo: input.demo,
        });
        s.products.push({
          ...p,
          id: randomUUID(),
          evidenceId,
          sourceName: input.sourceName,
          importedAt: at,
          demo: input.demo,
        });
      }
      s.suggestions = [];
    });
    res.json({
      count: items.length,
      duplicates: rows.filter((x) => x.duplicate).length,
      skipped: rows.filter((x) => x.skipped).length,
    });
  });
  app.post("/api/products/:id/use", (req, res) => {
    store.change((s) => {
      const p = s.products.find((x) => x.id === req.params.id);
      if (!p) throw new Error("商品不存在");
      if (!s.brand) throw new Error("请先保存品牌档案");
      s.brand = {
        ...s.brand,
        activeProductId: p.id,
        product: p.title,
        parameters: `${p.description}\n标价：${p.price} ${p.currency}\n来源：${p.url}（用户导入，未独立核实）`,
        updatedAt: new Date().toISOString(),
      };
      s.suggestions = [];
    });
    res.json({ ok: true });
  });
  app.post("/api/assets", (req, res) => {
    const data = z
      .object({
        name: str.max(120),
        alt: str.max(300),
        rights: str.max(300),
        demo: z.boolean().default(false),
        image: z
          .string()
          .max(2800000)
          .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
      })
      .parse(req.body);
    const buf = Buffer.from(data.image.split(",")[1], "base64");
    if (buf.length > 2000000) throw new Error("图片不能超过2MB");
    const mime = data.image.slice(5, data.image.indexOf(";"));
    if (!(
      (mime === "image/png" &&
        buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (mime === "image/jpeg" && buf[0] === 255 && buf[1] === 216) ||
      (mime === "image/webp" &&
        buf.subarray(0, 4).toString() === "RIFF" &&
        buf.subarray(8, 12).toString() === "WEBP")
    ))
      throw new Error("图片格式与文件内容不符");
    const id = store.change((s) => {
      const existing = s.assets.find((x) => x.image === data.image);
      if (existing) return existing.id;
      if (s.assets.length >= 50) throw new Error("每品牌最多50张图片素材");
      const id = randomUUID();
      s.assets.push({ ...data, id, createdAt: new Date().toISOString() });
      return id;
    });
    res.json({ id });
  });
  app.get("/api/assets/:id/image", (req, res) => {
    const a = store.read().assets.find((x) => x.id === req.params.id);
    if (!a) throw new Error("素材不存在");
    res
      .type(a.image.slice(5, a.image.indexOf(";")))
      .send(Buffer.from(a.image.split(",")[1], "base64"));
  });
  app.post("/api/assets/:id/use", (req, res) => {
    store.change((s) => {
      const a = s.assets.find((x) => x.id === req.params.id);
      if (!a || !s.brand) throw new Error("需已有素材和品牌");
      s.brand = {
        ...s.brand,
        image: a.image,
        updatedAt: new Date().toISOString(),
      };
    });
    res.json({ ok: true });
  });
  app.post("/api/campaigns", (req, res) => {
    const data = campaignSchema.parse(req.body);
    const at = new Date().toISOString();
    const id = randomUUID();
    store.change((s) => {
      if (!s.brand) throw new Error("请先保存品牌档案");
      if (
        data.productIds.some((id) => !s.products.some((p) => p.id === id)) ||
        data.assetIds.some((id) => !s.assets.some((a) => a.id === id)) ||
        data.contentIds.some((id) => !s.contents.some((c) => c.id === id)) ||
        (data.suggestionId && !s.suggestions.some((x) => x.id === data.suggestionId))
      )
        throw new Error("活动引用不属于当前品牌");
      s.campaigns.push({
        ...data,
        opportunity: s.suggestions.find((x) => x.id === data.suggestionId),
        id,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
    });
    res.json({ id });
  });
  app.post("/api/campaigns/:id/revise", (req, res) => {
    const data = campaignSchema.parse(req.body);
    store.change((s) => {
      const c = s.campaigns.find((x) => x.id === req.params.id);
      if (!c || c.version !== req.body.baseVersion) throw new Error("活动已更新，请刷新后编辑");
      if (
        data.productIds.some((id) => !s.products.some((p) => p.id === id)) ||
        data.assetIds.some((id) => !s.assets.some((a) => a.id === id)) ||
        data.contentIds.some((id) => !s.contents.some((c) => c.id === id))
      )
        throw new Error("活动引用不属于当前品牌");
      if (
        data.suggestionId !== c.suggestionId &&
        data.suggestionId &&
        !s.suggestions.some((x) => x.id === data.suggestionId)
      )
        throw new Error("机会已更新，请重新选择");
      Object.assign(c, data, {
        opportunity:
          data.suggestionId === c.suggestionId
            ? c.opportunity
            : s.suggestions.find((x) => x.id === data.suggestionId),
        version: c.version + 1,
        updatedAt: new Date().toISOString(),
        approvedAt: undefined,
        approvedFingerprint: undefined,
      });
    });
    res.json({ ok: true });
  });
  app.post("/api/campaigns/:id/approve", (req, res) => {
    store.change((s) => {
      const c = s.campaigns.find((x) => x.id === req.params.id);
      if (!c || c.version !== req.body.baseVersion) throw new Error("活动版本已更新");
      const check = campaignCheck(s, c);
      if (!check.ready) throw new Error(check.issues.join("；"));
      c.approvedFingerprint = check.fingerprint;
      c.approvedAt = new Date().toISOString();
      recordApproval(s, "campaign", c.id);
    });
    res.json({ ok: true });
  });
  app.get("/api/campaigns/:id/export", (req, res) => {
    const s = store.read(),
      c = s.campaigns.find((x) => x.id === req.params.id);
    if (!c) throw new Error("活动不存在");
    const check = campaignCheck(s, c);
    if (!check.approved)
      throw new Error(
        check.issues.length
          ? check.issues.join("；")
          : "活动未批准或关联内容/规范/排期已变化，请重新检查审批",
      );
    res.attachment(`harbor-campaign-${c.id}-v${c.version}.json`).json({
      campaign: c,
      brand: s.brand,
      guidelines: s.guidelines,
      products: s.products.filter((p) => c.productIds.includes(p.id)),
      assets: s.assets.filter((a) => c.assetIds.includes(a.id)),
      contents: s.contents
        .filter((x) => c.contentIds.includes(x.id))
        .map((x) => ({ ...x, revisions: [x.revisions.at(-1)] })),
      calendar: s.calendar
        .filter((e) => e.campaignId === c.id && !e.archivedAt)
        .map((e) => ({
          ...e,
          targetUrl: utmUrl(e.targetUrl, e.channel, c.name, e.revisionId),
        })),
      externalActions: "none",
      manualChecklist: [
        "核对目标账号和素材版权",
        "在平台预览最终格式",
        "如需付费投放，另行确认预算和账户授权",
        "人工发布后导入具体版本的统计窗口",
      ],
    });
  });
  app.post("/api/calendar/:id/archive", (req, res) => {
    store.change((s) => {
      const e = s.calendar.find((x) => x.id === req.params.id);
      if (!e) throw new Error("排期不存在");
      e.archivedAt = req.body.restore === true ? undefined : new Date().toISOString();
    });
    res.json({ ok: true });
  });
}
