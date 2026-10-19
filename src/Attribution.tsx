import React from "react";
import type { State } from "../server/types";
import { attribution } from "../server/workflows/insights";

export function Attribution({ data }: { data: State }) {
  const report = attribution(data);
  const counts = report.quality.counts;
  const pending = counts.missingWindow + counts.invalidWindow + counts.conflict;
  return (
    <article className="card" aria-label="效果汇总与数据质量">
      <h3>活动 / 渠道 / UTM 归因</h3>
      <p>{report.note}</p>
      <p>
        计入汇总 {counts.included} 条 · 缺少窗口 {counts.missingWindow} 条 · 窗口无效{" "}
        {counts.invalidWindow} 条 · 冲突待核查 {counts.conflict} 条 · 重复排除 {counts.duplicate} 条
        · 已撤销 {counts.voided} 条
      </p>
      {pending > 0 && (
        <div className="notice error" role="alert">
          <span>
            有 {pending} 条记录需要核查统计窗口或数值，暂不计入效果汇总。原始记录及数值仍保留。
          </span>
          <button
            type="button"
            onClick={() =>
              document.getElementById("metric-records")?.scrollIntoView({ block: "start" })
            }
          >
            查看待核查记录
          </button>
        </div>
      )}
      <p>
        已纳入汇总但未确定活动归因：{report.unknownSamples} 条。可在手工表单或 CSV 中填写
        campaignId、channel；也可使用唯一匹配的 utm_campaign。缺少活动标识不会按内容复用关系分摊。
      </p>
      {!report.groups.length ? (
        <p>
          {data.metrics.length
            ? `已有 ${data.metrics.length} 条原始记录，当前没有可汇总数据。${pending ? "请先核查缺失窗口或冲突记录。" : "排除或撤销的记录不会计入效果。"}`
            : "尚无指标记录，无法判断活动效果。"}
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {["活动", "渠道", "UTM", "计入记录", "曝光", "点击", "转化", "花费"].map(
                  (label) => (
                    <th key={label}>{label}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {report.groups.map((group, index) => (
                <tr key={index}>
                  <td>
                    {data.campaigns.find((campaign) => campaign.id === group.campaignId)?.name ||
                      "未知归因"}
                  </td>
                  <td>{group.channel}</td>
                  <td>
                    {Object.entries(group.utm)
                      .filter(([, value]) => value)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(" · ") || "未提供"}
                  </td>
                  <td>{group.samples}</td>
                  <td>{group.impressions}</td>
                  <td>{group.clicks}</td>
                  <td>{group.conversions}</td>
                  <td>
                    {group.spend} {group.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
