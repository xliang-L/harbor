import { z } from "zod";
import { parse } from "csv-parse/sync";
import { load } from "cheerio";
import { publicUrl } from "../security.ts";
import type { State } from "../types.ts";
export const productImportSchema = z.object({
  format: z.enum(["csv", "json", "shopify-csv"]),
  text: z.string().min(1).max(300000),
  sourceName: z.string().trim().min(1).max(100),
  sourceUrl: z
    .string()
    .url()
    .refine((x) => {
      try {
        publicUrl(x);
        return true;
      } catch {
        return false;
      }
    }, "需要公开来源 URL"),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
  demo: z.boolean().default(false),
});
const productSchema = z.object({
  sku: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  price: z.coerce.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  url: z
    .string()
    .url()
    .refine((x) => {
      try {
        publicUrl(x);
        return true;
      } catch {
        return false;
      }
    }),
});
export function previewProducts(raw: unknown, s: State) {
  const input = productImportSchema.parse(raw);
  const rows: unknown[] =
    input.format === "json"
      ? z.array(z.unknown()).parse(JSON.parse(input.text))
      : parse(input.text, { columns: true, bom: true, skip_empty_lines: true });
  if (!rows.length || rows.length > 100) throw new Error("每次导入 1–100 行商品，最多 300KB");
  const seen = new Set(s.products.map((p) => p.sku));
  let inherited: Record<string, unknown> = {};
  return rows.map((rawRow, row) => {
    try {
      const r = z.record(z.string(), z.unknown()).parse(rawRow);
      let normalized: unknown = r;
      if (input.format === "shopify-csv") {
        if (r.Handle !== inherited.Handle) inherited = {};
        if (r.Title)
          inherited = {
            Handle: r.Handle,
            Title: r.Title,
            description: load(String(r["Body (HTML)"] || ""))
              .text()
              .trim(),
          };
        // Shopify media-only rows are not sellable variants.
        if (!r["Variant SKU"] && !r["Variant Price"])
          return {
            row: row + 1,
            valid: true,
            skipped: true,
            duplicate: false,
            note: "图片/辅助行，未作为商品导入",
          };
        if (!r.Handle || !inherited.Title)
          throw new Error("Shopify 行缺少 Handle/Title，或变体不在标题行之后");
        normalized = {
          sku: r["Variant SKU"],
          title: inherited.Title,
          description: inherited.description,
          price: r["Variant Price"],
          currency: input.currency,
          url: new URL("/products/" + encodeURIComponent(String(r.Handle)), input.sourceUrl).href,
        };
      }
      const n = normalized as Record<string, unknown>;
      if (n.price === "" || n.price === null || n.price === undefined)
        throw new Error("商品价格不能为空");
      const product = productSchema.parse({
        ...n,
        currency: n.currency || input.currency,
        url: n.url || input.sourceUrl,
      });
      const duplicate = seen.has(product.sku);
      seen.add(product.sku);
      return { row: row + 1, valid: true, skipped: false, duplicate, product };
    } catch (error) {
      return {
        row: row + 1,
        valid: false,
        skipped: false,
        duplicate: false,
        error:
          error instanceof z.ZodError
            ? error.issues.map((i) => `${i.path}: ${i.message}`).join("；")
            : (error as Error).message,
      };
    }
  });
}
