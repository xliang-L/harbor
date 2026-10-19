import dns from "node:dns/promises";
import https from "node:https";
import http from "node:http";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
export function publicUrl(input: string) {
  const u = new URL(input);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port))
  )
    throw new Error("仅支持无认证的公开 HTTP(S) 标准端口网址");
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (h === "localhost" || !h.includes(".") || h.endsWith(".local") || h.endsWith(".internal"))
    throw new Error("禁止访问本地或内部地址");
  if (ipaddr.isValid(h) && !isPublic(h)) throw new Error("禁止访问私有、保留或回环 IP");
  return u;
}
export function isPublic(ip: string) {
  try {
    const parsed = ipaddr.process(ip);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
export function pinnedLookup(address: { address: string; family: number }) {
  return (_hostname: any, options: any, callback: any) =>
    options.all ? callback(null, [address]) : callback(null, address.address, address.family);
}
export async function fetchDocument(input: string) {
  const u = publicUrl(input);
  const addresses = await dns.lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublic(a.address)))
    throw new Error("DNS 指向非公开网络，已阻止");
  const address = addresses[0];
  return new Promise<{ body: string; type: string }>((resolve, reject) => {
    const request = (u.protocol === "https:" ? https : http).request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "HarborResearch/0.1 (user-requested public source)",
          Accept: "text/html,text/plain,application/rss+xml,application/atom+xml,application/json",
        },
        lookup: pinnedLookup(address) as any,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(
              `来源返回 HTTP ${res.statusCode}；不跟随跳转、不绕过登录，请使用最终公开地址`,
            ),
          );
          return;
        }
        const type = String(res.headers["content-type"]);
        if (!/^(text\/(html|plain|xml)|application\/(rss\+xml|atom\+xml|xml|json))/i.test(type)) {
          res.resume();
          reject(new Error("只支持公开 HTML / 文本 / RSS / JSON；不支持 PDF"));
          return;
        }
        let body = "";
        let size = 0;
        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          size += Buffer.byteLength(part);
          if (size > 1024 * 1024) {
            request.destroy(new Error("来源超过 1MB 限制"));
            return;
          }
          body += part;
        });
        res.on("end", () => {
          resolve({ body, type });
        });
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => request.destroy(new Error("抓取超过 30 秒总时限")), 30000);
    request.on("close", () => clearTimeout(timer));
    request.setTimeout(12000, () => request.destroy(new Error("抓取超时，可重试或粘贴资料")));
    request.on("error", reject);
    request.end();
  });
}

export async function fetchPublic(input: string) {
  const { body, type } = await fetchDocument(input);
  if (!/text\/(html|plain)/i.test(type)) throw new Error("该渠道仅支持 HTML / 文本");
  const $ = load(body);
  $("script,style,nav,footer,header,noscript").remove();
  const text = type.includes("html") ? $("body").text().replace(/\s+/g, " ").trim() : body.trim();
  if (text.length < 20) throw new Error("未取得有效公开正文，请手动导入");
  return {
    title: $("title").text().slice(0, 200) || new URL(input).hostname,
    text: text.slice(0, 30000),
  };
}
