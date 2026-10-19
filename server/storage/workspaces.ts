import { consoleRoutes } from "../routes/console.ts";
import express from "express";
import { readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./store.ts";
import { createApp } from "../app.ts";
// Separate SQLite databases isolate brands and tasks without cross-project active-state races.
export function createWorkspaceApp(dataRoot: string, outputRoot: string) {
  const root = express();
  const projects = resolve(dataRoot, "projects");
  mkdirSync(projects, { recursive: true });
  const stores = new Map<string, Store>();
  const instances = new Map<string, ReturnType<typeof createApp>>();
  const valid = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
  const projectIds = () =>
    readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && valid(entry.name))
      .map((entry) => entry.name);
  const get = (id: string) => {
    if (!instances.has(id)) {
      const store = new Store(
        resolve(id === "default" ? dataRoot : resolve(projects, id), "harbor.sqlite"),
      );
      stores.set(id, store);
      instances.set(
        id,
        createApp(store, id === "default" ? outputRoot : resolve(outputRoot, id), id),
      );
    }
    return instances.get(id)!;
  };
  root.use((req, res, next) => {
    const host = req.headers.host || "";
    if (
      !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)
    )
      return res.status(403).json({ error: "仅允许本机同源请求" });
    next();
  });
  root.post("/api/projects", express.json({ limit: "1kb" }), (_req, res, next) => {
    res.locals.creatingProject = true;
    next();
  });
  // Validate context before any global route or workspace lookup. This must not
  // create/open a workspace for a client-supplied unknown project identifier.
  root.use((req, res, next) => {
    const header = req.headers["x-harbor-project"];
    const query = req.query.project;
    if (
      (header !== undefined && typeof header !== "string") ||
      (query !== undefined && typeof query !== "string")
    )
      return res.status(400).json({ error: "项目标识无效" });
    if (header !== undefined && query !== undefined && header !== query)
      return res.status(400).json({ error: "品牌上下文冲突，未写入" });
    const id = header ?? query ?? "default";
    if (!valid(id)) return res.status(400).json({ error: "项目标识无效" });
    const explicitCreation = res.locals.creatingProject === true && req.body?.id === id;
    if (id !== "default" && !projectIds().includes(id) && !explicitCreation)
      return res.status(404).json({ error: "项目不存在" });
    res.locals.projectId = id;
    next();
  });
  root.use("/api/console", express.json({ limit: "16kb" }));
  consoleRoutes(root, () => [...stores].map(([project, store]) => ({ project, store })));
  root.get("/api/projects", (_req, res) =>
    res.json({
      projects: ["default", ...projectIds()],
    }),
  );
  root.post("/api/projects", (req, res, next) => {
    const id = req.body?.id;
    if (typeof id !== "string" || !valid(id) || id === "default")
      return res.status(400).json({ error: "项目标识需为 1–40 位小写字母、数字、短横线" });
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key.trim() || key.length > 100)
      return res.status(400).json({ error: "缺少幂等请求标识" });
    const db = stores.get("default")!.db;
    const requestKey = `workspace:projects:${key}`;
    const signature = JSON.stringify(["POST", "/api/projects", id]);
    let status = 200;
    let body: { id: string } | { error: string };
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db
        .prepare("SELECT signature,response FROM requests WHERE key=?")
        .get(requestKey) as { signature: string; response: string } | undefined;
      if (previous) {
        if (previous.signature !== signature) {
          status = 409;
          body = { error: "请求标识已用于创建其他项目" };
        } else body = JSON.parse(previous.response);
      } else if (projectIds().length >= 20 && !projectIds().includes(id)) {
        status = 400;
        body = { error: "最多 20 个品牌项目" };
      } else {
        get(id);
        body = { id };
        db.prepare("INSERT INTO requests (key,signature,response) VALUES (?,?,?)").run(
          requestKey,
          signature,
          JSON.stringify(body),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      return next(error);
    }
    res.status(status).json(body);
  });
  root.use((req, res, next) => {
    get(res.locals.projectId)(req, res, next);
  });
  // Restore every project's persistent subscriptions when service starts.
  get("default");
  for (const x of readdirSync(projects, { withFileTypes: true }))
    if (x.isDirectory() && valid(x.name)) get(x.name);
  const timer = setInterval(() => {
    for (const app of instances.values()) app.locals.tickSources();
  }, 60000);
  timer.unref();
  root.locals.stopScheduler = () => clearInterval(timer);
  return root;
}
