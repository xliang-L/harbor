import { parseOrders } from "../connectors/orders.ts";
import { recordApproval } from "./console-routes.ts";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Store } from "../store.ts";
import {
  emptyRetail,
  importInventory,
  importSales,
  retailInsights,
  retailSummary,
  promotionCheck,
  evidenceFingerprint,
  retailDate,
} from "../domain/retail.ts";
const str = z.string().trim().min(1).max(160);
const inventoryFields = ["storeId", "sku", "asOf", "quantity"];
const saleFields = [
  "externalId",
  "storeId",
  "sku",
  "date",
  "quantity",
  "revenue",
  "currency",
  "kind",
  "originalId",
  "campaignId",
  "channel",
];
const inputSchema = z.object({
  kind: z.enum(["inventory", "sales"]),
  csv: z.string().min(1).max(1000000),
  mapping: z.record(z.string(), z.string().max(160)).optional(),
  sourceName: str,
  demo: z.boolean().default(false),
});
export function retailRows(raw: unknown) {
  const input = inputSchema.parse(raw),
    fields = input.kind === "inventory" ? inventoryFields : saleFields;
  if (input.kind === "sales") {
    const parsed = parseOrders({
      text: input.csv,
      sourceName: input.sourceName,
      demo: input.demo,
      mapping: input.mapping,
    });
    const invalid = parsed.rows.find((row) => !row.valid);
    if (invalid) throw new Error(`CSV第${invalid.line}行：${invalid.errors.join("；")}`);
    return { ...input, rows: parsed.rows.map((row) => row.row) };
  }
  const rows: Record<string, string>[] = parse(input.csv, {
    columns: (headers: string[]) => {
      if (new Set(headers).size !== headers.length || headers.some((x) => !x.trim()))
        throw new Error("CSV列名不能为空或重复");
      return headers;
    },
    skip_empty_lines: true,
    bom: true,
  });
  if (!rows.length || rows.length > 500) throw new Error("每次导入1–500行");
  const mapping = input.mapping ?? Object.fromEntries(fields.map((k) => [k, k]));
  for (const field of fields.filter((k) => !["originalId", "campaignId", "channel"].includes(k))) {
    if (!mapping[field] || !Object.hasOwn(rows[0], mapping[field]))
      throw new Error(`缺少字段映射/源列：${field}`);
  }
  return {
    ...input,
    rows: rows.map((row) => ({
      ...Object.fromEntries(fields.map((k) => [k, mapping[k] ? (row[mapping[k]] ?? "") : ""])),
      sourceName: input.sourceName,
      demo: input.demo,
    })),
  };
}
const editSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    title: str,
    copy: z.string().trim().min(1).max(3000),
    discountPercent: z.number().min(0).max(50),
    startsAt: retailDate,
    endsAt: retailDate,
    maxRedemptions: z.number().int().min(1).max(10000),
    actor: str.default("本机操作者（未认证）"),
  })
  .refine((x) => Date.parse(x.endsAt) > Date.parse(x.startsAt), "结束时间需晚于开始时间");
export function retailRoutes(app: Express, store: Store) {
  app.get("/api/retail", (_req, res) => {
    const s = store.read();
    res.json({
      ...(s.retail ?? emptyRetail()),
      products: s.products.map((p) => ({
        sku: p.sku,
        title: p.title,
        demo: p.demo,
      })),
      insights: retailInsights(s),
      summary: retailSummary(s),
      promotions: (s.retail?.promotions ?? []).map((p) => ({
        ...p,
        check: promotionCheck(s, p),
      })),
      mode: "offline-import",
      note: "无地图、POS或实时库存连接；库存为盘点快照，销量/核销不自动扣减库存。自报姓名不是认证。",
    });
  });
  app.post("/api/retail/stores", (req, res) => {
    const data = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/),
        name: str,
        region: str,
        address: z.string().trim().max(500).default(""),
      })
      .parse(req.body);
    store.change((s) => {
      const r = (s.retail ??= emptyRetail());
      const prior = r.stores.find((x) => x.id === data.id);
      if (prior) throw new Error("门店代码已存在，不能覆盖；请使用新代码");
      r.stores.push({ ...data, updatedAt: new Date().toISOString() });
    });
    res.json({ ok: true });
  });
  for (const mode of ["preview", "import"])
    app.post(`/api/retail/${mode === "preview" ? "import/preview" : "import"}`, (req, res) => {
      const input = retailRows(req.body),
        fn = input.kind === "inventory" ? importInventory : importSales;
      const result = fn(structuredClone(store.read()), input.rows);
      res.json(
        mode === "preview"
          ? { ...result, dryRun: true, rows: input.rows }
          : store.change((s) => fn(s, input.rows)),
      );
    });
  app.post("/api/retail/promotions", (req, res) => {
    const d = z
      .object({ storeId: str, sku: str, demo: z.boolean().default(false) })
      .parse(req.body);
    const id = store.change((s) => {
      const r = (s.retail ??= emptyRetail()),
        e = retailInsights(s).find(
          (x) => x.storeId === d.storeId && x.sku === d.sku && x.demo === d.demo,
        );
      if (!e?.eligible) throw new Error("无符合条件的库存/销量证据，先补充或刷新数据");
      const id = randomUUID(),
        now = new Date().toISOString();
      const shop = r.stores.find((x) => x.id === d.storeId)!,
        product = s.products.find((x) => x.sku === d.sku)!;
      r.promotions.push({
        ...d,
        id,
        title: `${shop.name} · ${product.title} 小范围促销草稿`,
        copy: `${product.title}门店促销方案待确认。适用门店：${shop.name}。折扣、活动期限与数量需负责人审核后，以导出条款为准。未发布。`,
        discountPercent: 0,
        startsAt: now,
        endsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        maxRedemptions: Math.min(e.onHand, 20),
        code: "LOCAL-" + id.slice(0, 8).toUpperCase(),
        version: 1,
        evidence: e,
        evidenceFingerprint: evidenceFingerprint(s, d.storeId, d.sku, d.demo),
        createdAt: now,
        history: [
          {
            at: now,
            action: "created-template",
            actor: "本地规则模板",
            version: 1,
          },
        ],
      });
      return id;
    });
    res.json({ id });
  });
  app.post("/api/retail/promotions/:id/update", (req, res) => {
    const d = editSchema.parse(req.body);
    store.change((s) => {
      const p = s.retail?.promotions.find((x) => x.id === req.params.id);
      if (!p) throw new Error("促销不属于当前品牌");
      if (p.version !== d.baseVersion) throw new Error("草稿版本已变化，请刷新");
      const e = retailInsights(s).find(
        (x) => x.storeId === p.storeId && x.sku === p.sku && x.demo === p.demo,
      );
      if (!e) throw new Error("促销依据不存在");
      const { baseVersion: _v, actor, ...fields } = d;
      void _v;
      Object.assign(p, fields);
      p.version++;
      p.evidence = e;
      p.evidenceFingerprint = evidenceFingerprint(s, p.storeId, p.sku, p.demo);
      delete p.approvedAt;
      delete p.approvedFingerprint;
      delete p.reviewer;
      p.history.push({
        at: new Date().toISOString(),
        action: "revised",
        actor,
        version: p.version,
      });
    });
    res.json({ ok: true });
  });
  app.post("/api/retail/promotions/:id/approve", (req, res) => {
    const d = z.object({ baseVersion: z.number().int().positive(), actor: str }).parse(req.body);
    store.change((s) => {
      const p = s.retail?.promotions.find((x) => x.id === req.params.id);
      if (!p) throw new Error("促销不属于当前品牌");
      if (p.version !== d.baseVersion) throw new Error("草稿版本已变化，请刷新");
      const check = promotionCheck(s, p);
      if (check.issues.length) throw new Error(check.issues.join("；"));
      p.approvedAt = new Date().toISOString();
      p.approvedFingerprint = check.fingerprint;
      p.reviewer = d.actor;
      recordApproval(s, "promotion", p.id, d.actor);
      p.history.push({
        at: p.approvedAt,
        action: "approved",
        actor: d.actor,
        version: p.version,
        fingerprint: check.fingerprint,
      });
    });
    res.json({ ok: true });
  });
  app.get("/api/retail/promotions/:id/export", (req, res) => {
    const s = store.read(),
      p = s.retail?.promotions.find((x) => x.id === req.params.id);
    if (!p || !promotionCheck(s, p).approved) throw new Error("促销未批准或依据/版本已失效");
    res.attachment(`harbor-promotion-${p.code}.json`).json({
      ...p,
      publishing: "manual-only",
      terms: {
        store: s.retail!.stores.find((x) => x.id === p.storeId),
        sku: p.sku,
        discountPercent: p.discountPercent,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        maxRedemptions: p.maxRedemptions,
      },
      note: "仅本地人工交付，未发布、未发券、未修改POS。净商品金额不代表利润或增量效果。",
    });
  });
  app.post("/api/retail/redemptions", (req, res) => {
    const d = z
      .object({ promotionId: str, saleId: str, externalId: str, actor: str })
      .parse(req.body);
    const result = store.change((s) => {
      const r = (s.retail ??= emptyRetail());
      const prior = r.redemptions.find((x) => x.externalId === d.externalId);
      if (prior) {
        if (prior.promotionId === d.promotionId && prior.saleId === d.saleId && !prior.voidedAt)
          return { id: prior.id, duplicate: true };
        throw new Error("核销事件ID已使用，不能覆盖历史");
      }
      const p = r.promotions.find((x) => x.id === d.promotionId),
        sale = r.sales.find((x) => x.id === d.saleId);
      if (!p || !promotionCheck(s, p).approved) throw new Error("当前品牌促销尚未批准或已失效");
      if (
        !sale ||
        sale.kind !== "sale" ||
        sale.storeId !== p.storeId ||
        sale.sku !== p.sku ||
        sale.demo !== p.demo
      )
        throw new Error("核销须关联同品牌、门店、SKU与演示标识的实际销售行");
      if (
        Date.parse(sale.date) < Date.parse(p.startsAt) ||
        Date.parse(sale.date) > Date.parse(p.endsAt)
      )
        throw new Error("销售发生时间不在促销期间");
      if (r.redemptions.some((x) => x.saleId === sale.id && !x.voidedAt))
        throw new Error("该销售行已核销，不可重复计入其他促销");
      if (
        r.redemptions.filter((x) => x.promotionId === p.id && !x.voidedAt).length >=
        p.maxRedemptions
      )
        throw new Error("核销次数已达到审核上限");
      const returned = r.sales
        .filter(
          (x) =>
            x.kind === "return" &&
            x.sourceName === sale.sourceName &&
            x.originalId === sale.externalId,
        )
        .reduce((n, x) => n + x.quantity, 0);
      if (sale.quantity + returned <= 0) throw new Error("销售已全额退货，不能新建有效核销");
      const id = randomUUID();
      r.redemptions.push({
        ...d,
        id,
        recordedAt: new Date().toISOString(),
        promotionVersion: p.version,
        approvedFingerprint: p.approvedFingerprint!,
      });
      return { id, duplicate: false };
    });
    res.json(result);
  });
  app.post("/api/retail/redemptions/:id/void", (req, res) => {
    const d = z.object({ reason: z.string().trim().min(1).max(500), actor: str }).parse(req.body);
    store.change((s) => {
      const r = s.retail?.redemptions.find((x) => x.id === req.params.id);
      if (!r) throw new Error("核销不属于当前品牌");
      if (r.voidedAt) throw new Error("核销已撤销");
      r.voidedAt = new Date().toISOString();
      r.voidReason = d.reason;
      r.voidActor = d.actor;
    });
    res.json({ ok: true });
  });
}
