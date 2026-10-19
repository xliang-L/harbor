export const channels = [
  {
    id: "linkedin",
    name: "LinkedIn 帖子",
    max: 3000,
    headlineMax: 150,
    note: "本地保守限制；纯文本 + 链接交付",
  },
  {
    id: "instagram",
    name: "Instagram 图文说明",
    max: 2200,
    headlineMax: 150,
    note: "需自行配图发布；链接通常不可点击",
  },
  {
    id: "x",
    name: "X 标准帖子",
    max: 280,
    headlineMax: 100,
    note: "保守 Unicode 字符计数，发布前需平台最终校验",
  },
  {
    id: "google-search",
    name: "Google Search 广告草稿",
    max: 90,
    headlineMax: 30,
    note: "单条标题 ≤30 / 描述 ≤90；不是完整广告上传包",
  },
  {
    id: "email",
    name: "邮件草稿",
    max: 5000,
    headlineMax: 100,
    note: "仅导出；不发送、不读取邮箱",
  },
];
export function validateChannel(channel: string, copy: string, headline: string) {
  const rule = channels.find((c) => c.id === channel);
  if (!rule) throw new Error("未知渠道");
  if (!copy.trim() || Array.from(copy).length > rule.max)
    throw new Error(`${rule.name} 正文需为 1–${rule.max} 字符`);
  if (!headline.trim() || Array.from(headline).length > rule.headlineMax)
    throw new Error(`${rule.name} 标题需为 1–${rule.headlineMax} 字符`);
  if (channel === "instagram" && (copy.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30)
    throw new Error("Instagram 标签最多 30 个");
}
export function utmUrl(url: string, channel: string, campaign: string, revision: string) {
  const u = new URL(url);
  u.searchParams.set("utm_source", channel);
  u.searchParams.set(
    "utm_medium",
    channel === "email" ? "email" : channel === "google-search" ? "cpc" : "social",
  );
  u.searchParams.set("utm_campaign", campaign);
  u.searchParams.set("utm_content", revision);
  return u.href;
}
