import type { Express } from "express";
import type { Store } from "../storage/store.ts";
import { overview } from "../domain/overview.ts";

export function overviewRoutes(app: Express, store: Store) {
  app.get("/api/overview", (_req, res) => res.json(overview(store.read())));
}
