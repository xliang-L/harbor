import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { z } from "zod";
import { isPublic, pinnedLookup, publicUrl } from "../security.ts";

export type PostizConfig = { baseUrl: string; apiKey: string; integrationId: string };
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 500;
const TIMEOUT_MS = 10000;
const text = z.string().max(200);
const integrationSchema = z.object({
  id: text.min(1),
  name: text,
  identifier: text.min(1),
  disabled: z.boolean(),
  profile: z.string().max(1000).nullable().optional(),
});
export type PostizIntegration = z.infer<typeof integrationSchema>;
const date = z.string().datetime({ offset: true });
const postSchema = z.object({
  id: text.min(1),
  content: z.string().max(100000),
  publishDate: date,
  state: z.enum(["QUEUE", "DRAFT", "PUBLISHED", "ERROR"]),
  releaseURL: z.string().max(4096).nullable().optional(),
  releaseId: z.string().max(1000).nullable().optional(),
  error: z.string().max(10000).nullable().optional(),
  intervalInDays: z.number().int().positive().nullable().optional(),
  // Postiz's recurrence expansion copies the original planned publishDate here.
  // Despite the name, this is not a platform-confirmed actual publication time.
  actualDate: date.optional(),
  integration: z.object({ id: text.min(1), providerIdentifier: text.min(1), name: text }),
});
export type PostizPost = z.infer<typeof postSchema>;

function containsCredential(value: unknown, credential: string) {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && item.includes(credential)) return true;
    if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item)) {
        pending.push(key, child);
      }
  }
  return false;
}

function endpoint(config: PostizConfig) {
  if (
    !config.apiKey ||
    config.apiKey.length > 4096 ||
    /[\r\n]/.test(config.apiKey) ||
    !config.integrationId?.trim() ||
    config.integrationId.length > 200
  )
    throw new Error("Postiz 配置无效：需要 API key 和明确的渠道 ID");
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error("Postiz API 地址无效");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("Postiz API 地址不能包含凭证、查询参数或片段");
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/public/v1"))
    throw new Error("Postiz baseUrl 需要包含完整的 /public/v1 API 路径");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!loopback) {
    if (url.protocol !== "https:") throw new Error("远程 Postiz 必须使用 HTTPS");
    try {
      publicUrl(url.href);
    } catch {
      throw new Error("Postiz 远程地址必须是标准 HTTPS 端口的公开地址");
    }
  }
  return { url, loopback };
}

async function waitForDns(hostname: string, signal: AbortSignal) {
  let cancel = () => {};
  try {
    return await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error("Postiz 请求超时，未自动重试"));
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function readJson(
  url: URL,
  apiKey: string,
  address: { address: string; family: number },
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error("Postiz 请求超时，未自动重试");
  return new Promise<unknown>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        signal,
        lookup: pinnedLookup(address) as any,
        // Postiz documents a raw API key here, without a Bearer prefix.
        headers: {
          Authorization: apiKey,
          Accept: "application/json",
          "Accept-Encoding": "identity",
        },
      },
      (response) => {
        const fail = (message: string) => {
          reject(new Error(message));
          response.destroy();
        };
        if (response.statusCode !== 200) {
          const status = response.statusCode || 0;
          const hint =
            status >= 300 && status < 400
              ? "不跟随重定向，请检查固定 API 地址"
              : status === 401 || status === 403
                ? "授权失败，请检查此实例的 API key 与账号权限"
                : status === 429
                  ? "请求频率受限，未自动重试"
                  : "只读查询失败，请检查服务状态";
          fail(`Postiz HTTP ${status}：${hint}`);
          return;
        }
        if (
          !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(
            String(response.headers["content-type"] || ""),
          )
        ) {
          fail("Postiz 响应不是 JSON");
          return;
        }
        if (Number(response.headers["content-length"]) > MAX_BYTES) {
          fail("Postiz 响应超过 2MB 限制，请缩小查询时间范围");
          return;
        }
        const parts: Buffer[] = [];
        let size = 0;
        response.on("data", (part: Buffer) => {
          size += part.length;
          if (size > MAX_BYTES) {
            fail("Postiz 响应超过 2MB 限制，请缩小查询时间范围");
            return;
          }
          parts.push(part);
        });
        response.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(parts).toString("utf8"));
          } catch {
            reject(new Error("Postiz 响应不是有效 JSON"));
            return;
          }
          if (containsCredential(body, apiKey)) {
            reject(new Error("Postiz 响应包含敏感凭证，已阻止返回"));
            return;
          }
          resolve(body);
        });
        response.on("error", () =>
          reject(
            new Error(
              signal.aborted ? "Postiz 请求超时，未自动重试" : "Postiz 响应中断，未自动重试",
            ),
          ),
        );
      },
    );
    request.on("error", () =>
      reject(
        new Error(
          signal.aborted
            ? "Postiz 请求超时，未自动重试"
            : "Postiz 连接失败，请检查服务与网络；未自动重试",
        ),
      ),
    );
    request.end();
  });
}

// Read-only adapter. Its API key may have wider permissions; only these two GETs are exposed.
// Official contract: https://docs.postiz.com/public-api/posts/list
export async function listPostizPosts(
  config: PostizConfig,
  range: { startDate: string; endDate: string },
): Promise<{
  posts: PostizPost[];
  integration: PostizIntegration;
  checkedAt: string;
  note: string;
}> {
  const { url, loopback } = endpoint(config);
  const { apiKey, integrationId } = config;
  const parsedRange = z.object({ startDate: date, endDate: date }).safeParse(range);
  if (!parsedRange.success) throw new Error("Postiz 日期需为带时区的有效 ISO 时间");
  const start = Date.parse(range.startDate),
    end = Date.parse(range.endDate);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    end - start > 31 * 86400000
  )
    throw new Error("Postiz 查询范围需按时间顺序且不超过 31 天");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let addresses: { address: string; family: number }[];
    if (loopback)
      addresses = [
        {
          address: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
          family: url.hostname === "[::1]" ? 6 : 4,
        },
      ];
    else {
      try {
        addresses = await waitForDns(url.hostname, controller.signal);
      } catch {
        throw new Error(
          controller.signal.aborted
            ? "Postiz 请求超时，未自动重试"
            : "Postiz DNS 查询失败，未自动重试",
        );
      }
      if (!addresses.length || addresses.some((item) => !isPublic(item.address)))
        throw new Error("Postiz DNS 指向非公开网络，已阻止");
    }
    const address = addresses[0]!;
    const integrationsUrl = new URL(url.href);
    integrationsUrl.pathname += "/integrations";
    const list = z
      .array(integrationSchema)
      .max(MAX_RECORDS)
      .safeParse(await readJson(integrationsUrl, apiKey, address, controller.signal));
    if (!list.success) throw new Error("Postiz 渠道响应格式无效或超过 500 条限制");
    const matches = list.data.filter((item) => item.id === integrationId);
    if (matches.length !== 1)
      throw new Error("Postiz 绑定渠道不存在或不唯一，请检查当前组织与渠道 ID");
    const integration = matches[0]!;
    const postsUrl = new URL(url.href);
    postsUrl.pathname += "/posts";
    postsUrl.searchParams.set("startDate", new Date(start).toISOString());
    postsUrl.searchParams.set("endDate", new Date(end).toISOString());
    const result = z
      .object({ posts: z.array(postSchema).max(MAX_RECORDS) })
      .safeParse(await readJson(postsUrl, apiKey, address, controller.signal));
    if (!result.success) throw new Error("Postiz 帖子响应格式无效、状态不受支持或超过 500 条限制");
    const posts = result.data.posts.filter(
      (post) =>
        post.integration.id === integration.id &&
        Date.parse(post.publishDate) >= start &&
        Date.parse(post.publishDate) <= end,
    );
    for (const post of posts) {
      if (post.integration.providerIdentifier !== integration.identifier)
        throw new Error("Postiz 帖子与绑定渠道类型不一致");
      if (post.releaseURL) {
        try {
          post.releaseURL = publicUrl(post.releaseURL).href;
        } catch {
          throw new Error("Postiz 帖子包含非公开或不安全的发布链接");
        }
      }
      post.publishDate = new Date(post.publishDate).toISOString();
      if (post.actualDate) post.actualDate = new Date(post.actualDate).toISOString();
    }
    return {
      posts,
      integration,
      checkedAt: new Date().toISOString(),
      note: `${integration.disabled ? "绑定渠道已禁用；仍可读取历史记录，不代表账号可发布。" : ""}只读查询 Postiz 报告的状态；publishDate 是计划时间，不是平台实际发布时间。循环贴文可能同 ID 多个日期，actualDate 仅是循环原始计划时间。未独立验证平台页面，未发送或发布，也未生成 Harbor 交付回执。`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
