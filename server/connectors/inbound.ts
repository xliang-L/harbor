import { z } from "zod";
import { publicUrl } from "../security.ts";

export const inboundFields = [
  "company",
  "domain",
  "name",
  "email",
  "industry",
  "region",
  "owner",
  "sourceUrl",
] as const;
export type InboundField = (typeof inboundFields)[number];
export type LeadRow = Record<InboundField, string>;
export const defaultMapping: Record<InboundField, string> = {
  company: "company",
  domain: "website",
  name: "firstname",
  email: "email",
  industry: "industry",
  region: "country",
  owner: "hubspot_owner_id",
  sourceUrl: "sourceUrl",
};
export const inboundSchema = z.object({
  text: z.string().min(1).max(1000000),
  mapping: z.record(z.enum(inboundFields), z.string().trim().max(100)).optional(),
});
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function previewInbound(input: unknown) {
  const parsed = inboundSchema.parse(input);
  let payload: unknown;
  try {
    payload = JSON.parse(parsed.text);
  } catch {
    throw new Error("JSON 格式无效，请粘贴联系人数组或含 results 数组的导出结果");
  }
  const records = Array.isArray(payload) ? payload : object(payload) ? payload.results : null;
  if (!Array.isArray(records) || records.length < 1 || records.length > 500)
    throw new Error("需要 1–500 条联系人数组，或 {results:[…]}；不接受只有事件 ID 的 webhook 通知");
  const mapping = parsed.mapping || defaultMapping;
  const rows = records.map((record: unknown, index: number) => {
    const errors: string[] = [];
    const row = Object.fromEntries(inboundFields.map((field) => [field, ""])) as LeadRow;
    if (!object(record))
      return { line: index + 1, valid: false, skipped: false, errors: ["记录必须是对象"], row };
    if (record.archived === true)
      return { line: index + 1, valid: true, skipped: true, errors: [], row };
    const properties = object(record.properties) ? record.properties : record;
    for (const field of inboundFields) {
      const key = mapping[field];
      const value = key && Object.hasOwn(properties, key) ? properties[key] : "";
      if (
        value !== null &&
        value !== undefined &&
        typeof value !== "string" &&
        typeof value !== "number"
      )
        errors.push(`${field} 必须是文本`);
      else row[field] = String(value ?? "").trim();
      const limit = ["industry", "region", "owner"].includes(field)
        ? 100
        : field === "domain"
          ? 200
          : 300;
      if (row[field].length > limit) errors.push(`${field} 不能超过 ${limit} 字符`);
    }
    if (mapping.name === "firstname" && typeof properties.lastname === "string")
      row.name = `${row.name} ${properties.lastname}`.trim();
    row.email = row.email.toLowerCase();
    if (!row.name) errors.push("缺少 name/firstname：请补充联系人姓名");
    if (row.name.length > 300) errors.push("完整姓名不能超过 300 字符");
    if (!row.sourceUrl) errors.push("缺少 sourceUrl：请补充可追溯来源链接或修改映射");
    if (!row.company) errors.push("缺少 company：请补充公司或修改映射");
    if (!row.email || !z.email().safeParse(row.email).success) errors.push("email 必须是有效邮箱");
    if (row.domain) {
      try {
        const u = new URL(row.domain.includes("://") ? row.domain : `https://${row.domain}`);
        if (
          !["https:", "http:"].includes(u.protocol) ||
          u.username ||
          u.password ||
          !u.hostname.includes(".")
        )
          throw new Error();
        row.domain = u.hostname.toLowerCase();
      } catch {
        errors.push("domain/website 必须是有效域名或 HTTP(S) 网址");
      }
    }
    if (row.sourceUrl) {
      try {
        publicUrl(row.sourceUrl);
      } catch {
        errors.push("sourceUrl 仅支持 HTTP(S) 来源链接");
      }
    }
    return { line: index + 1, valid: errors.length === 0, skipped: false, errors, row };
  });
  return {
    rows,
    mapping,
    valid: rows.every((row) => row.valid),
    skipped: rows.filter((row) => row.skipped).length,
  };
}
export const inboundStatus = {
  hubspot: "not-connected",
  shopify: "file-import-only",
  email: "not-connected",
  webhook: "not-connected",
  mode: "local-json-import",
  externalActions: "none",
  note: "仅导入用户提交的联系人 JSON；未授权 HubSpot、邮箱或 webhook，未进行远程同步。导入记录不代表购买意向。",
};
