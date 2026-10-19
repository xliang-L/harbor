import { load } from "cheerio";
import { z } from "zod";
import { fetchDocument, fetchPublic, publicUrl } from "../security.ts";
import type { Source } from "../types.ts";
export type SourceItem = {
  title: string;
  url: string;
  text: string;
  publishedAt: string;
};
export function parseFeed(body: string, feedUrl: string): SourceItem[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new Error("RSS 不允许 DTD / ENTITY");
  const $ = load(body, { xmlMode: true });
  const entries = $("item,entry").toArray().slice(0, 50);
  if (!entries.length) throw new Error("未找到 RSS / Atom 条目");
  return entries
    .map((el) => {
      const item = $(el);
      const link = item.find("link[href]").attr("href") || item.find("link").first().text();
      const url = publicUrl(new URL(link || feedUrl, feedUrl).href).href;
      const title = item.find("title").first().text().trim().slice(0, 200) || "RSS item";
      const raw = item.find("description,summary,content,content\\:encoded").first().text();
      const plain = load(raw).text().replace(/\s+/g, " ").trim();
      const published = item.find("pubDate,published,updated").first().text();
      return {
        title,
        url,
        text: `${title}\n${plain}`.slice(0, 30000),
        publishedAt:
          Number.isFinite(Date.parse(published)) && Date.parse(published) <= Date.now()
            ? new Date(published).toISOString()
            : new Date().toISOString(),
      };
    })
    .filter((x) => x.text.length >= 20);
}
export async function collectSource(source: Source): Promise<SourceItem[]> {
  if (source.connector === "web")
    return [
      {
        ...(await fetchPublic(source.url)),
        url: source.url,
        publishedAt: new Date().toISOString(),
      },
    ];
  if (source.connector === "rss")
    return parseFeed((await fetchDocument(source.url)).body, source.url);
  const u = publicUrl(source.url);
  const match = u.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (u.hostname !== "github.com" || !match)
    throw new Error("GitHub 来源需为 https://github.com/owner/repo");
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/releases?per_page=20`;
  const data = z
    .array(
      z.object({
        name: z.string().nullable(),
        tag_name: z.string(),
        html_url: z.string(),
        body: z.string().nullable(),
        published_at: z.string().nullable(),
        draft: z.boolean(),
      }),
    )
    .parse(JSON.parse((await fetchDocument(endpoint)).body));
  return data
    .filter((x) => !x.draft)
    .map((x) => ({
      title: (x.name || x.tag_name).slice(0, 200),
      url: publicUrl(x.html_url).href,
      text: `${x.name || x.tag_name}\n${x.body || "Release published"}`.slice(0, 30000),
      publishedAt: x.published_at || new Date().toISOString(),
    }))
    .filter((x) => x.text.length >= 20);
}
export const connectorCatalog = [
  {
    id: "web",
    name: "公开网页 / 文本",
    status: "implemented",
    permission: "只读；固定公开 IP；不跟随重定向",
  },
  {
    id: "rss",
    name: "RSS / Atom",
    status: "implemented",
    permission: "只读；最多 50 条；不执行来源指令",
  },
  {
    id: "github",
    name: "GitHub Releases",
    status: "implemented",
    permission: "官方公开 API；无 token；可能限流",
  },
  {
    id: "imports",
    name: "CSV / JSON 证据及指标",
    status: "available",
    permission: "本地导入；先校验；去重",
  },
  {
    id: "ga4",
    name: "Google Analytics 4",
    status: "awaiting-authorization",
    permission: "只读适配器已测试；用户配置 access token + property ID 后手动调用",
  },
];
