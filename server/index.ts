import { resolve } from "node:path";
import express from "express";

import { createWorkspaceApp } from "./storage/workspaces.ts";
const app = createWorkspaceApp(resolve(process.env.DATA_DIR || "data"), resolve("artifacts"));
if (process.env.NODE_ENV === "development") {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
}
const port = Number(process.env.PORT || 4317);
app.listen(port, "127.0.0.1", () => console.log(`Harbor ready: http://127.0.0.1:${port}`));
