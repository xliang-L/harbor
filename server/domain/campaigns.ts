import { createHash } from "node:crypto";
import type { State, Campaign } from "../types.ts";
import { validateChannel } from "./channels.ts";
import { revisionFactIssues, scheduledFactIssues } from "./facts.ts";
export function brandIssues(state: State, copy: string) {
  return (state.guidelines?.forbiddenClaims || [])
    .filter((x) => copy.toLocaleLowerCase().includes(x.toLocaleLowerCase()))
    .map((x) => `包含品牌禁用表述：${x}`);
}
export function onboardingSteps(s: State, now = Date.now()) {
  return [
    { label: "建立品牌档案", done: !!s.brand, page: 0 },
    { label: "设置目标与品牌规范", done: !!s.guidelines, page: 5 },
    {
      label: "导入商品或来源资料",
      done: !!(s.products.length || s.evidence.length),
      page: s.evidence.length ? 1 : 5,
    },
    { label: "生成可追溯内容", done: !!s.contents.length, page: 1 },
    {
      label: "建立并审核活动交付计划",
      done: s.campaigns.some((c) => campaignCheck(s, c, now).approved),
      page: 5,
    },
  ];
}
export function campaignCheck(s: State, campaign: Campaign, now = Date.now()) {
  const issues: string[] = [];
  if (!s.brand) issues.push("请先保存品牌档案");
  if (!campaign.contentIds.length) issues.push("请关联至少一条内容");
  const contents = campaign.contentIds.map((id) => s.contents.find((c) => c.id === id));
  for (const c of contents) {
    const r = c?.revisions.at(-1);
    if (!r) {
      issues.push("关联内容不存在");
      continue;
    }
    if (!r.approvedAt || (r.approvalGuidelinesAt || "") !== (s.guidelines?.updatedAt || ""))
      issues.push(`内容 v${r.number} 尚未批准`);
    issues.push(
      ...revisionFactIssues(s, r, now),
      ...brandIssues(s, r.copy + "\n" + r.scenes.map((x) => x.text).join("\n")),
    );
  }
  const entries = s.calendar.filter((e) => e.campaignId === campaign.id && !e.archivedAt);
  for (const channel of campaign.channels) {
    if (!entries.some((e) => e.channel === channel)) issues.push(`${channel} 缺少渠道交付计划`);
  }
  for (const e of entries) {
    const r = s.contents.find((c) => c.id === e.contentId)?.revisions.at(-1);
    if (!campaign.contentIds.includes(e.contentId) || !campaign.channels.includes(e.channel))
      issues.push(`排期 ${e.headline} 不属于当前活动范围`);
    if (!r || r.id !== e.revisionId) issues.push(`排期 ${e.headline} 的内容版本已失效，请重建`);
    if (r)
      issues.push(
        ...scheduledFactIssues(s, r, e.scheduledAt, now).map(
          (issue) => `${e.headline || e.channel}：${issue}`,
        ),
      );
    if (!e.approvedAt || (e.approvalGuidelinesAt || "") !== (s.guidelines?.updatedAt || ""))
      issues.push(`排期 ${e.headline} 未批准具体渠道/账号/文案`);
    if (
      Date.parse(e.scheduledAt) < Date.parse(campaign.startsAt) ||
      Date.parse(e.scheduledAt) > Date.parse(campaign.endsAt)
    )
      issues.push(`排期 ${e.headline} 不在活动日期范围内`);
    issues.push(...brandIssues(s, e.copy + "\n" + e.headline));
    try {
      validateChannel(e.channel, e.copy, e.headline);
    } catch (error) {
      issues.push((error as Error).message);
    }
    if (
      e.channel === "instagram" &&
      !campaign.assetIds.some((id) => s.assets.some((a) => a.id === id)) &&
      !r?.brand.image
    )
      issues.push("Instagram 交付需要至少一张本地图片素材");
  }
  for (const id of campaign.productIds)
    if (!s.products.some((p) => p.id === id)) issues.push("关联商品已不存在");
  for (const id of campaign.assetIds)
    if (!s.assets.some((a) => a.id === id)) issues.push("关联素材已不存在");
  const fingerprint = createHash("sha512")
    .update(
      JSON.stringify({
        brief: {
          ...campaign,
          approvedAt: undefined,
          approvedFingerprint: undefined,
        },
        guidelines: s.guidelines,
        brandUpdated: s.brand?.updatedAt,
        products: s.products.filter((p) => campaign.productIds.includes(p.id)),
        contents: contents.map((c) => c?.revisions.at(-1)),
        entries,
        assets: s.assets.filter((a) => campaign.assetIds.includes(a.id)),
      }),
    )
    .digest("hex");
  const unique = [...new Set(issues)];
  return {
    ready: unique.length === 0,
    issues: unique,
    fingerprint,
    approved: campaign.approvedFingerprint === fingerprint && unique.length === 0,
    entries: entries.length,
    externalActions: "none; local export only",
  };
}
