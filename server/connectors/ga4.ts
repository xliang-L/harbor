import { z } from "zod";
// Fixed official endpoint, read-only report; no OAuth flow or token creation.
export async function ga4Report(
  startDate: string,
  endDate: string,
  transport: typeof fetch = fetch,
) {
  const property = process.env.GA4_PROPERTY_ID;
  const token = process.env.GA4_ACCESS_TOKEN;
  if (!property || !/^\d+$/.test(property) || !token)
    throw new Error("GA4 待授权：请由用户配置本项目 GA4_PROPERTY_ID / GA4_ACCESS_TOKEN");
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  date.parse(startDate);
  date.parse(endDate);
  if (startDate > endDate) throw new Error("统计开始时间不能晚于结束时间");
  const response = await transport(
    `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "sessionSource" }, { name: "sessionCampaignName" }],
        metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }],
        limit: 100,
      }),
    },
  );
  if (!response.ok) throw new Error(`GA4 HTTP ${response.status}，请检查用户授权和 property 权限`);
  const report = z
    .object({
      rows: z
        .array(
          z.object({
            dimensionValues: z.array(z.object({ value: z.string() })),
            metricValues: z.array(z.object({ value: z.string() })),
          }),
        )
        .max(100)
        .default([]),
      rowCount: z.number().optional(),
    })
    .parse(await response.json());
  return {
    ...report,
    startDate,
    endDate,
    note: "GA4 会话/用户/key events；不是广告曝光/点击/归因转化，不自动映射到内容指标",
  };
}
