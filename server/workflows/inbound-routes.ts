import type { Express } from "express";
import type { Store } from "../store.ts";
import { defaultMapping, inboundStatus, previewInbound } from "../connectors/inbound.ts";
import { importLeads } from "./crm-routes.ts";
export function inboundRoutes(app: Express, store: Store) {
  app.get("/api/integrations", (_req, res) =>
    res.json({ ...inboundStatus, mapping: defaultMapping }),
  );
  app.post("/api/integrations/hubspot/preview", (req, res) => {
    const preview = previewInbound(req.body);
    const rows = preview.rows.filter((r) => !r.skipped).map((r) => r.row);
    const counts = preview.valid
      ? rows.length
        ? importLeads(structuredClone(store.read()), rows)
        : { count: 0, duplicates: 0 }
      : null;
    res.json({ ...preview, counts, dryRun: true, ...inboundStatus });
  });
  app.post("/api/integrations/hubspot/import", (req, res) => {
    const preview = previewInbound(req.body);
    if (!preview.valid)
      return res.status(400).json({ error: "存在错误行，未导入任何线索", rows: preview.rows });
    const rows = preview.rows.filter((r) => !r.skipped).map((r) => r.row);
    const result = rows.length
      ? store.change((state) => importLeads(state, rows))
      : { count: 0, duplicates: 0 };
    res.json({ ...result, skipped: preview.skipped, dryRun: false, ...inboundStatus });
  });
}
