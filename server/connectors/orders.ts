import { z } from "zod";
import { parse } from "csv-parse/sync";
import type { State } from "../types.ts";
import { importSales } from "../domain/retail.ts";
export const orderFields = [
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
] as const;
export type OrderField = (typeof orderFields)[number];
export const orderMapping = Object.fromEntries(
  orderFields.map((field) => [field, field]),
) as Record<OrderField, string>;
const inputSchema = z.object({
  text: z.string().min(1).max(1000000),
  sourceName: z.string().trim().min(1).max(100),
  demo: z.boolean().default(false),
  mapping: z.record(z.enum(orderFields), z.string().trim().max(100)).optional(),
});
export type OrderRow = {
  externalId: string;
  storeId: string;
  sku: string;
  date: string;
  quantity: number;
  revenue: number;
  currency: string;
  kind: "sale" | "return";
  originalId?: string;
  campaignId?: string;
  channel?: string;
  sourceName: string;
  demo: boolean;
};
export function parseOrders(input: unknown) {
  const data = inputSchema.parse(input);
  const mapping = data.mapping || orderMapping;
  if (
    /^(total|subtotal|lineitem price|unit[_ ]?price|order[_ ]?total|order[_ ]?subtotal)$/i.test(
      mapping.revenue,
    )
  )
    throw new Error(
      "不能将订单总额、Subtotal 或单价映射为 revenue；请先计算每个订单行折后、不含税运的净商品金额并放入独立列",
    );
  let headers: string[] = [];
  let records: Record<string, string>[];
  try {
    records = parse(data.text, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 20000,
      columns: (columns: string[]) => {
        headers = columns;
        if (new Set(columns).size !== columns.length || columns.some((x) => !x))
          throw new Error("CSV 表头必须唯一且非空");
        return columns;
      },
    });
  } catch (error) {
    throw new Error(`CSV 格式无效：${error instanceof Error ? error.message : "无法解析"}`);
  }
  if (!records.length || records.length > 500)
    throw new Error("每次导入 1–500 个订单行/退款事件，最多 1MB");
  const required: OrderField[] = [
    "externalId",
    "storeId",
    "sku",
    "date",
    "quantity",
    "revenue",
    "currency",
    "kind",
  ];
  const missing = required.filter((field) => !mapping[field] || !headers.includes(mapping[field]));
  if (missing.length) throw new Error(`缺少必填映射列：${missing.join(", ")}`);
  const rows = records.map((record, index) => {
    const errors: string[] = [];
    const val = (field: OrderField) =>
      mapping[field] && Object.hasOwn(record, mapping[field]) ? record[mapping[field]].trim() : "";
    const quantityText = val("quantity"),
      revenueText = val("revenue");
    if (
      !/^-?\d+$/.test(quantityText) ||
      !Number.isSafeInteger(Number(quantityText)) ||
      Number(quantityText) === 0
    )
      errors.push("quantity 必须是非零安全整数；销售正数、退货负数");
    if (
      !/^-?\d+(\.\d{1,2})?$/.test(revenueText) ||
      !Number.isFinite(Number(revenueText)) ||
      Math.abs(Number(revenueText)) > 1e10
    )
      errors.push("revenue 必须是明确数字，最多两位小数；不接受空值、货币符号、科学计数法或超大值");
    const date = val("date");
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(date) ||
      !z.iso.datetime({ offset: true }).safeParse(date).success
    )
      errors.push("date 必须是含时区的 ISO 时间，例如 2026-10-01T10:00:00Z");
    const kind = val("kind");
    if (kind !== "sale" && kind !== "return") errors.push("kind 仅支持 sale 或 return");
    const quantity = Number(quantityText),
      revenue = Number(revenueText);
    if (kind === "sale" && (quantity <= 0 || revenue < 0))
      errors.push("销售 quantity 必须为正，revenue 不能为负");
    if (kind === "return" && (quantity >= 0 || revenue > 0 || !val("originalId")))
      errors.push("退货必须有 originalId、负 quantity 和非正 revenue");
    if (kind === "sale" && val("originalId")) errors.push("销售行不应设置 originalId");
    if (!/^[A-Z]{3}$/.test(val("currency"))) errors.push("currency 必须是大写三字母币种");
    for (const field of ["externalId", "storeId", "sku"] as const)
      if (!val(field)) errors.push(`${field} 不能为空`);
    const row: OrderRow = {
      externalId: val("externalId"),
      storeId: val("storeId"),
      sku: val("sku"),
      date,
      quantity,
      revenue,
      currency: val("currency"),
      kind: kind as "sale" | "return",
      sourceName: data.sourceName,
      demo: data.demo,
    };
    for (const field of ["originalId", "campaignId", "channel"] as const)
      if (val(field)) row[field] = val(field);
    return {
      line: index + 2,
      row,
      valid: !errors.length,
      errors,
      duplicate: false,
    };
  });
  return { rows, mapping, sourceName: data.sourceName, demo: data.demo };
}
export function previewOrders(input: unknown, state: State) {
  const parsed = parseOrders(input);
  let working = structuredClone(state);
  let count = 0,
    duplicates = 0;
  // Validate sales before returns, retaining original CSV row numbers for display.
  for (const item of [...parsed.rows].sort(
    (a, b) => Number(a.row.kind === "return") - Number(b.row.kind === "return"),
  )) {
    if (!item.valid) continue;
    const next = structuredClone(working);
    try {
      const result = importSales(next, [item.row]);
      count += result.count;
      duplicates += result.duplicates;
      item.duplicate = result.duplicates > 0;
      working = next;
    } catch (error) {
      item.valid = false;
      item.errors.push(error instanceof Error ? error.message : "账本校验失败");
    }
  }
  return {
    ...parsed,
    count,
    duplicates,
    valid: parsed.rows.every((item) => item.valid),
    dryRun: true,
    mode: "offline-csv",
    externalActions: "none",
  };
}
