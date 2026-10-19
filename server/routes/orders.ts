import type { Express } from "express";
import type { Store } from "../storage/store.ts";
import { orderMapping, previewOrders } from "../connectors/orders.ts";
import { importSales } from "../domain/retail.ts";
export function orderRoutes(app: Express, store: Store) {
  app.get("/api/orders/config", (_req, res) =>
    res.json({
      mapping: orderMapping,
      mode: "offline-csv",
      shopify: "not-connected",
      pos: "not-connected",
      note: "标准订单行 CSV 离线导入；不支持直接将 Shopify 原始订单总额转换为行收入；不创建营销 metrics。",
    }),
  );
  app.post("/api/orders/preview", (req, res) => res.json(previewOrders(req.body, store.read())));
  app.post("/api/orders/import", (req, res) => {
    const result = store.change((state) => {
      const preview = previewOrders(req.body, state);
      if (!preview.valid) return { error: "存在错误或冲突，未导入任何记录", ...preview };
      return {
        ...importSales(
          state,
          preview.rows.map((item) => item.row),
        ),
        dryRun: false,
        mode: "offline-csv",
        externalActions: "none",
      };
    });
    res.status("error" in result ? 400 : 200).json(result);
  });
}
