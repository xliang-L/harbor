import type { Express } from "express";
import type { Store } from "../storage/store.ts";
import { z } from "zod";
import { listPostizPosts, type PostizConfig } from "../connectors/postiz.ts";

export function postizConfig(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): PostizConfig | null {
  const prefix =
    projectId === "default" ? "POSTIZ" : `POSTIZ_${projectId.toUpperCase().replaceAll("-", "_")}`;
  const baseUrl = env[`${prefix}_BASE_URL`]?.trim(),
    apiKey = env[`${prefix}_API_KEY`]?.trim(),
    integrationId = env[`${prefix}_INTEGRATION_ID`]?.trim();
  return baseUrl && apiKey && integrationId ? { baseUrl, apiKey, integrationId } : null;
}

export function postizRoutes(app: Express, _store: Store, projectId: string) {
  app.get("/api/postiz/status", (_req, res) => {
    const config = postizConfig(projectId);
    res.json({
      configured: !!config,
      integrationId: config?.integrationId || null,
      mode: "read-only",
      note: "仅查询当前品牌绑定的 Postiz 账号与帖子状态。不会发布、修改或删除内容。API 密钥只留在服务端。",
    });
  });
  app.post("/api/postiz/check", async (req, res) => {
    const config = postizConfig(projectId);
    if (!config)
      return res.status(400).json({ error: "当前品牌尚未配置 Postiz API 地址、密钥和绑定账号" });
    const range = z
      .object({
        startDate: z.iso.datetime({ offset: true }),
        endDate: z.iso.datetime({ offset: true }),
      })
      .parse(req.body);
    res.json(await listPostizPosts(config, range));
  });
}
