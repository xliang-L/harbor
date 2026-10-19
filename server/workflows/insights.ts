import type { Metric, State } from "../types.ts";
import { metricQuality } from "../domain/metrics.ts";
export { metricIdentity } from "../domain/metrics.ts";
export function opportunities(s: State) {
  return s.suggestions
    .map((x, i) => {
      const evidence = s.evidence.filter((e) => x.evidenceIds.includes(e.id));
      const age = evidence.length
        ? Math.max(
            0,
            (Date.now() - Math.max(...evidence.map((e) => Date.parse(e.capturedAt)))) / 86400000,
          )
        : 100;
      const demo = evidence.some((e) => e.demo);
      const score = Math.max(
        0,
        Math.round(40 + Math.min(evidence.length, 5) * 8 + Math.max(0, 30 - age) - (demo ? 30 : 0)),
      );
      return {
        ...x,
        score,
        priority: i + 1,
        explanation: `证据 ${evidence.length} 条；最新入库 ${Math.floor(age)} 天前${demo ? "；含演示证据减 30 分" : ""}。规则评分，不是预测 ROI。`,
        nextAction: "人工核对证据后创建小规模内容实验",
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((x, i) => ({ ...x, priority: i + 1 }));
}
export function recap(s: State) {
  const quality = metricQuality(s.metrics);
  return s.contents.map((c) => {
    const rows = quality.included.filter((m) => m.contentId === c.id);
    const excluded = quality.rows.filter(
      (row) => row.metric?.contentId === c.id && row.status !== "included",
    );
    // Currency groups prevent meaningless aggregation of mixed currencies.
    const currencies = [...new Set(rows.map((m) => m.currency || "UNSPECIFIED"))];
    return {
      contentId: c.id,
      title: c.suggestion.title,
      samples: rows.length,
      excludedSamples: excluded.length,
      issues: [...new Set(excluded.flatMap((row) => row.issues))],
      groups: currencies.map((currency) => {
        const ms = rows.filter((m) => (m.currency || "UNSPECIFIED") === currency);
        const total = ms.reduce(
          (a, m) => ({
            impressions: a.impressions + m.impressions,
            clicks: a.clicks + m.clicks,
            conversions: a.conversions + m.conversions,
            spend: a.spend + m.spend,
          }),
          { impressions: 0, clicks: 0, conversions: 0, spend: 0 },
        );
        return {
          currency,
          ...total,
          ctr: total.impressions ? total.clicks / total.impressions : null,
          cpc: total.clicks ? total.spend / total.clicks : null,
          cpa: total.conversions ? total.spend / total.conversions : null,
          nextAction: !total.impressions
            ? "先补充有效曝光数据"
            : !total.clicks
              ? "检查渠道、受众与开头文案，再做受控实验"
              : !total.conversions
                ? "检查落地页与转化追踪，不能从相关性推断原因"
                : "记录成功假设并用下一轮实验复验",
        };
      }),
    };
  });
}

// Every aggregate consumer uses the same window eligibility projection.
export function uniqueMetrics(metrics: Metric[]) {
  return metricQuality(metrics).included;
}
export function metricAttribution(s: State, m: Metric) {
  const params = new URL(m.url).searchParams;
  const utm = Object.fromEntries(
    ["source", "medium", "campaign", "content", "term"].map((key) => [
      key,
      params.get(`utm_${key}`) || "",
    ]),
  );
  const candidates = s.campaigns.filter((c) =>
    m.campaignId
      ? c.id === m.campaignId
      : !!utm.campaign && (c.id === utm.campaign || c.name === utm.campaign),
  );
  const campaign =
    candidates.length === 1 && candidates[0].contentIds.includes(m.contentId)
      ? candidates[0]
      : undefined;
  return {
    metricId: m.id,
    contentId: m.contentId,
    revisionId: m.revisionId,
    campaignId: campaign?.id || null,
    channel: m.channel || utm.source || "unknown",
    utm,
    status: campaign ? "attributed" : "unknown",
    explanation: campaign
      ? m.campaignId
        ? "用户明确指定当前品牌活动"
        : "UTM 活动唯一匹配当前品牌活动且包含该内容"
      : candidates.length > 1
        ? "UTM 活动名称有歧义，请导入 campaignId"
        : "缺少有效活动标识；不会根据内容复用关系分摊或重复统计",
  };
}
export function attribution(s: State) {
  const quality = metricQuality(s.metrics);
  const metrics = quality.included;
  const rows = metrics.map((m) => ({ ...m, attribution: metricAttribution(s, m) }));
  const groups = new Map<
    string,
    {
      campaignId: string | null;
      channel: string;
      currency: string;
      utm: Record<string, string>;
      samples: number;
      impressions: number;
      clicks: number;
      conversions: number;
      spend: number;
    }
  >();
  for (const row of rows) {
    const { campaignId, channel, utm } = row.attribution;
    const currency = row.currency || "UNSPECIFIED";
    const key = JSON.stringify([campaignId, channel, currency, utm]);
    const group = groups.get(key) || {
      campaignId,
      channel,
      currency,
      utm,
      samples: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      spend: 0,
    };
    group.samples++;
    for (const field of ["impressions", "clicks", "conversions", "spend"] as const)
      group[field] += row[field];
    groups.set(key, group);
  }
  return {
    rows,
    groups: [...groups.values()],
    unknownSamples: rows.filter((r) => r.attribution.status === "unknown").length,
    duplicatesExcluded: quality.counts.duplicate,
    quality,
    note: "仅汇总明确且互不重叠的统计窗口；缺窗口、冲突、损坏和已撤销记录保留但不计入。窗口含起始、不含截止；缺失记录不代表零效果，不推断购买意向、ROAS 或因果。",
  };
}
