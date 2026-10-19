import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { State } from "../types.ts";
import { brandIssues } from "./campaigns.ts";
export type Shop = {
  id: string;
  name: string;
  region: string;
  address: string;
  updatedAt: string;
};
export type Sale = {
  id: string;
  externalId: string;
  storeId: string;
  sku: string;
  date: string;
  quantity: number;
  revenue: number;
  currency: string;
  kind: "sale" | "return";
  originalId: string;
  campaignId: string;
  channel: string;
  sourceName: string;
  demo: boolean;
  importedAt: string;
};
export type Inventory = {
  id: string;
  storeId: string;
  sku: string;
  asOf: string;
  quantity: number;
  sourceName: string;
  demo: boolean;
  importedAt: string;
};
export type Promotion = {
  id: string;
  storeId: string;
  sku: string;
  title: string;
  copy: string;
  discountPercent: number;
  startsAt: string;
  endsAt: string;
  maxRedemptions: number;
  code: string;
  version: number;
  demo: boolean;
  evidence: ReturnType<typeof retailInsights>[number];
  createdAt: string;
  evidenceFingerprint: string;
  approvedFingerprint?: string;
  approvedAt?: string;
  reviewer?: string;
  history: {
    at: string;
    action: string;
    actor: string;
    version: number;
    fingerprint?: string;
  }[];
};
export type Redemption = {
  id: string;
  externalId: string;
  promotionId: string;
  saleId: string;
  actor: string;
  recordedAt: string;
  promotionVersion: number;
  approvedFingerprint: string;
  voidedAt?: string;
  voidReason?: string;
  voidActor?: string;
};
export type Retail = {
  stores: Shop[];
  inventory: Inventory[];
  sales: Sale[];
  promotions: Promotion[];
  redemptions: Redemption[];
};
export const emptyRetail = (): Retail => ({
  stores: [],
  inventory: [],
  sales: [],
  promotions: [],
  redemptions: [],
});
const str = z.string().trim().min(1).max(160);
const optional = z.string().trim().max(160).default("");
export const retailDate = str
  .pipe(z.union([z.iso.datetime({ offset: true }), z.iso.date()]))
  .transform((x) => new Date(x).toISOString());
const pastDate = retailDate.refine((x) => Date.parse(x) <= Date.now(), "时间不能在未来");
const number = z.preprocess(
  (x) => (typeof x === "string" && /^-?\d+(?:\.\d+)?$/.test(x.trim()) ? Number(x) : x),
  z.number().finite(),
);
const integer = z.preprocess(
  (x) => (typeof x === "string" && /^-?\d+(?:\.\d+)?$/.test(x.trim()) ? Number(x) : x),
  z.number().int().safe(),
);
const money = number.refine(
  (x) => Math.abs(x) <= 1e10 && Math.abs(x * 100 - Math.round(x * 100)) < 0.0001,
  "金额最多两位小数，绝对值不超过100亿",
);
const saleSchema = z.object({
  externalId: str,
  storeId: str,
  sku: str,
  date: pastDate,
  quantity: integer.refine((x) => x !== 0 && Math.abs(x) <= 1e7, "数量需非零整数"),
  revenue: money,
  currency: z.string().regex(/^[A-Z]{3}$/),
  kind: z.enum(["sale", "return"]),
  originalId: optional,
  campaignId: optional,
  channel: optional,
  sourceName: str,
  demo: z.boolean().default(false),
});
const inventorySchema = z.object({
  storeId: str,
  sku: str,
  asOf: pastDate,
  quantity: integer.refine((x) => x >= 0 && x <= 1e7, "库存需非负整数"),
  sourceName: str,
  demo: z.boolean().default(false),
});
export const salesKey = (x: Pick<Sale, "sourceName" | "externalId">) =>
  JSON.stringify([x.sourceName, x.externalId]);
const signature = (x: object) => {
  const { id: _id, importedAt: _at, ...fields } = x as Sale;
  void _id;
  void _at;
  return JSON.stringify(fields);
};
function references(s: State, storeId: string, sku: string) {
  if (!s.retail?.stores.some((x) => x.id === storeId))
    throw new Error("门店不属于当前品牌，请先保存门店");
  if (!s.products.some((x) => x.sku === sku)) throw new Error("SKU不属于当前品牌，请先导入商品");
}
export function importSales(s: State, rows: unknown[]) {
  if (!rows.length || rows.length > 500) throw new Error("每批1–500条销售/退货记录");
  const parsed = rows.map((x) => saleSchema.parse(x));
  const retail = (s.retail ??= emptyRetail());
  const next = [...retail.sales];
  let duplicates = 0;
  // Resolve originals across the whole batch, independent of CSV ordering.
  for (const row of parsed) {
    references(s, row.storeId, row.sku);
    if (row.campaignId && !s.campaigns.some((x) => x.id === row.campaignId))
      throw new Error("活动不属于当前品牌");
    if (row.kind === "sale" && (row.quantity <= 0 || row.revenue < 0 || row.originalId))
      throw new Error("销售数量为正、行金额非负且不填originalId");
    if (row.kind === "return" && (row.quantity >= 0 || row.revenue > 0 || !row.originalId))
      throw new Error("退货数量为负、行金额非正且必须关联originalId");
    const prior = next.find((x) => salesKey(x) === salesKey(row));
    if (prior) {
      if (signature(prior) !== signature(row))
        throw new Error(`来源行ID冲突：${row.externalId}；不可覆盖历史，请提供独立更正记录`);
      duplicates++;
      continue;
    }
    next.push({
      ...row,
      id: randomUUID(),
      importedAt: new Date().toISOString(),
    });
  }
  for (const row of next.filter((x) => x.kind === "return")) {
    const original = next.find(
      (x) =>
        x.kind === "sale" && x.sourceName === row.sourceName && x.externalId === row.originalId,
    );
    if (
      !original ||
      original.storeId !== row.storeId ||
      original.sku !== row.sku ||
      original.currency !== row.currency ||
      original.demo !== row.demo ||
      original.campaignId !== row.campaignId ||
      original.channel !== row.channel
    )
      throw new Error("退货须关联同来源、门店、SKU、币种、演示标识及归因维度的原销售");
    if (Date.parse(row.date) < Date.parse(original.date)) throw new Error("退货时间不能早于原销售");
    const returns = next.filter(
      (x) =>
        x.kind === "return" &&
        x.sourceName === original.sourceName &&
        x.originalId === original.externalId,
    );
    if (
      -returns.reduce((n, x) => n + x.quantity, 0) > original.quantity ||
      -returns.reduce((n, x) => n + Math.round(x.revenue * 100), 0) >
        Math.round(original.revenue * 100)
    )
      throw new Error("累计退货数量或退款金额超过原销售");
  }
  const count = next.length - retail.sales.length;
  retail.sales = next;
  return { count, duplicates };
}
export function importInventory(s: State, rows: unknown[]) {
  if (!rows.length || rows.length > 500) throw new Error("每批1–500条库存快照");
  const parsed = rows.map((x) => inventorySchema.parse(x));
  const retail = (s.retail ??= emptyRetail()),
    next = [...retail.inventory];
  let duplicates = 0;
  for (const row of parsed) {
    references(s, row.storeId, row.sku);
    const prior = next.find(
      (x) =>
        x.storeId === row.storeId &&
        x.sku === row.sku &&
        x.asOf === row.asOf &&
        x.demo === row.demo,
    );
    if (prior) {
      if (signature(prior) !== signature(row))
        throw new Error("同门店/SKU/快照时间存在冲突；新盘点请用新时间");
      duplicates++;
      continue;
    }
    next.push({
      ...row,
      id: randomUUID(),
      importedAt: new Date().toISOString(),
    });
  }
  const count = next.length - retail.inventory.length;
  retail.inventory = next;
  return { count, duplicates };
}
export function retailInsights(s: State, now = Date.now()) {
  const retail = s.retail ?? emptyRetail(),
    latest = new Map<string, Inventory>();
  for (const item of retail.inventory) {
    const key = JSON.stringify([item.storeId, item.sku, item.demo]);
    if (!latest.has(key) || latest.get(key)!.asOf < item.asOf) latest.set(key, item);
  }
  return [...latest.values()].map((stock) => {
    const sales = retail.sales.filter(
      (x) =>
        x.storeId === stock.storeId &&
        x.sku === stock.sku &&
        x.demo === stock.demo &&
        Date.parse(x.date) >= now - 30 * 86400000 &&
        Date.parse(x.date) <= now,
    );
    const netUnits = sales.reduce((n, x) => n + x.quantity, 0),
      ageDays = Math.floor((now - Date.parse(stock.asOf)) / 86400000);
    const eligible =
      ageDays <= 7 &&
      stock.quantity >= 20 &&
      sales.some((x) => x.kind === "sale") &&
      netUnits >= 0 &&
      netUnits <= 5;
    return {
      storeId: stock.storeId,
      sku: stock.sku,
      demo: stock.demo,
      inventoryId: stock.id,
      asOf: stock.asOf,
      onHand: stock.quantity,
      ageDays,
      netUnits,
      observations: sales.length,
      saleIds: sales.map((x) => x.id),
      region: retail.stores.find((x) => x.id === stock.storeId)?.region || "未提供",
      eligible,
      explanation: `${stock.sourceName}库存快照 ${stock.asOf}：${stock.quantity}件；近30天导入${sales.length}条销售/退货，净${netUnits}件。来源仅本店导入，不代表区域总体需求；缺失日期不代表零销量。`,
      suggestion:
        ageDays > 7
          ? "库存超过7天，请先刷新盘点"
          : !sales.length
            ? "缺少销量证据，请先补充流水"
            : stock.quantity === 0
              ? "库存为0，先核实补货"
              : eligible
                ? "库存至少20且近期观察净销量不超过5，可人工评估小范围促销；未提供成本，不建议直接确定折扣"
                : "当前规则未发现促销候选；请结合利润、完整销量与补货计划人工判断",
    };
  });
}
export function evidenceFingerprint(s: State, storeId: string, sku: string, demo: boolean) {
  const insight = retailInsights(s).find(
    (x) => x.storeId === storeId && x.sku === sku && x.demo === demo,
  );
  return createHash("sha512")
    .update(
      JSON.stringify({
        insight,
        product: s.products.find((x) => x.sku === sku),
        store: s.retail?.stores.find((x) => x.id === storeId),
        guidelines: s.guidelines,
        brand: s.brand,
      }),
    )
    .digest("hex");
}
export function promotionCheck(s: State, p: Promotion) {
  const issues: string[] = [];
  const insight = retailInsights(s).find(
    (x) => x.storeId === p.storeId && x.sku === p.sku && x.demo === p.demo,
  );
  if (!insight?.eligible) issues.push("当前库存/销量证据不满足候选规则，请刷新数据再评估");
  if (p.evidenceFingerprint !== evidenceFingerprint(s, p.storeId, p.sku, p.demo))
    issues.push("证据或品牌信息已更新，请保存草稿以刷新依据后重新审核");
  issues.push(...brandIssues(s, p.title + "\n" + p.copy));
  if (Date.parse(p.endsAt) < Date.now()) issues.push("促销已过结束时间");
  const fingerprint = createHash("sha512")
    .update(
      JSON.stringify({
        id: p.id,
        version: p.version,
        storeId: p.storeId,
        sku: p.sku,
        title: p.title,
        copy: p.copy,
        discountPercent: p.discountPercent,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        maxRedemptions: p.maxRedemptions,
        code: p.code,
        demo: p.demo,
        evidenceFingerprint: p.evidenceFingerprint,
      }),
    )
    .digest("hex");
  return {
    issues,
    fingerprint,
    approved: !issues.length && p.approvedFingerprint === fingerprint,
  };
}
export function retailSummary(s: State) {
  const retail = s.retail ?? emptyRetail();
  const groups = new Map<
    string,
    {
      storeId: string;
      region: string;
      sku: string;
      currency: string;
      campaignId: string;
      channel: string;
      demo: boolean;
      records: number;
      netUnits: number;
      netRevenue: number;
    }
  >();
  for (const x of retail.sales) {
    const key = JSON.stringify([x.storeId, x.sku, x.currency, x.campaignId, x.channel, x.demo]);
    const g = groups.get(key) ?? {
      storeId: x.storeId,
      region: retail.stores.find((t) => t.id === x.storeId)?.region || "未提供",
      sku: x.sku,
      currency: x.currency,
      campaignId: x.campaignId,
      channel: x.channel,
      demo: x.demo,
      records: 0,
      netUnits: 0,
      netRevenue: 0,
    };
    g.records++;
    g.netUnits += x.quantity;
    g.netRevenue = Math.round((g.netRevenue + x.revenue) * 100) / 100;
    groups.set(key, g);
  }
  const promotions = retail.promotions.map((p) => {
    const receipts = retail.redemptions.filter((x) => x.promotionId === p.id && !x.voidedAt);
    const currencies = new Map<
      string,
      {
        currency: string;
        netRevenue: number;
        netUnits: number;
        retainedLines: number;
      }
    >();
    for (const receipt of receipts) {
      const sale = retail.sales.find((x) => x.id === receipt.saleId)!;
      const returns = retail.sales.filter(
        (x) =>
          x.kind === "return" &&
          x.sourceName === sale.sourceName &&
          x.originalId === sale.externalId,
      );
      const qty = sale.quantity + returns.reduce((n, x) => n + x.quantity, 0);
      const amount =
        Math.round((sale.revenue + returns.reduce((n, x) => n + x.revenue, 0)) * 100) / 100;
      const g = currencies.get(sale.currency) ?? {
        currency: sale.currency,
        netRevenue: 0,
        netUnits: 0,
        retainedLines: 0,
      };
      g.netUnits += qty;
      g.netRevenue = Math.round((g.netRevenue + amount) * 100) / 100;
      if (qty > 0) g.retainedLines++;
      currencies.set(sale.currency, g);
    }
    return {
      promotionId: p.id,
      recorded: receipts.length,
      voided: retail.redemptions.filter((x) => x.promotionId === p.id && x.voidedAt).length,
      groups: [...currencies.values()],
    };
  });
  return {
    groups: [...groups.values()],
    promotions,
    unknownAttribution: retail.sales.filter((x) => !x.campaignId).length,
    note: "净商品金额来自用户导入，销售减退货；币种及演示数据分开。核销是人工关联记录，不证明实际优惠生效或增量因果。未自动写入内容指标，避免重复统计。",
  };
}
