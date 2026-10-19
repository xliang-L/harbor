import { useState } from "react";
import type { Act, Data } from "../../shared/types.ts";
import { Field } from "../../components/Field";
import { fmt } from "../../shared/format";
import type { Revision } from "../../../server/types";
import { metricQuality } from "../../../server/domain/metrics";
import { channels } from "../../../server/domain/channels";
export function Metrics({ data, busy, act }: { data: Data; busy: boolean; act: Act }) {
  const options = data.contents.flatMap((c) =>
    c.revisions.filter((r) => r.approvedAt).map((r) => ({ c, r })),
  );
  const [revision, setRevision] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [sampledAt, setSampledAt] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const chosen = options.find((x) => x.r.id === revision) || options[0];
  const campaigns = data.campaigns.filter((campaign) =>
    campaign.contentIds.includes(chosen?.c.id || ""),
  );
  const selectedCampaign = campaigns.some((campaign) => campaign.id === campaignId)
    ? campaignId
    : "";
  const quality = metricQuality(data.metrics);
  const statusLabels = {
    included: "已计入汇总",
    duplicate: "重复已排除",
    "missing-window": "统计窗口未确认",
    "invalid-window": "统计窗口无效",
    conflict: "窗口冲突 · 待核对",
    voided: "已撤销",
  };
  return (
    <>
      <div className="card">
        <h2>记录一次发布效果</h2>
        <p className="muted">手动录入，不连接广告账户。历史已批准版本仍可记录发布后的效果。</p>
        <form
          data-draft-scope="metric-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!chosen) return;
            const f = new FormData(e.currentTarget);
            void act("metrics", {
              contentId: chosen.c.id,
              revisionId: chosen.r.id,
              url: f.get("url"),
              date: new Date(sampledAt).toISOString(),
              windowStart: new Date(windowStart).toISOString(),
              windowEnd: new Date(windowEnd).toISOString(),
              impressions: Number(f.get("impressions")),
              clicks: Number(f.get("clicks")),
              conversions: Number(f.get("conversions")),
              spend: Number(f.get("spend")),
              notes: f.get("notes"),
              currency,
              timezone: f.get("timezone"),
              campaignId: selectedCampaign || undefined,
              channel: String(f.get("channel") || "").trim() || undefined,
            });
          }}
        >
          <label>
            已批准内容版本
            <select
              aria-label="已批准内容版本"
              required
              value={chosen?.r.id || ""}
              onChange={(e) => setRevision(e.target.value)}
            >
              <option value="" disabled>
                请先批准一个内容版本
              </option>
              {options.map(({ c, r }) => (
                <option key={r.id} value={r.id}>
                  {c.suggestion.title} · V{r.number}
                </option>
              ))}
            </select>
          </label>
          <div className="grid">
            <Field label="发布链接" name="url" required type="url" />
            <Field
              label="采样时间"
              name="date"
              required
              type="datetime-local"
              step="0.001"
              min={windowEnd || undefined}
              value={sampledAt}
              onChange={(event) => setSampledAt(event.target.value)}
            />
          </div>
          <div className="grid">
            <Field
              label="统计窗口开始"
              name="windowStart"
              required
              type="datetime-local"
              step="0.001"
              value={windowStart}
              onChange={(event) => setWindowStart(event.target.value)}
            />
            <Field
              label="统计窗口结束（不含）"
              name="windowEnd"
              required
              type="datetime-local"
              step="0.001"
              min={windowStart || undefined}
              value={windowEnd}
              onChange={(event) => setWindowEnd(event.target.value)}
            />
          </div>
          <p className="muted">
            窗口和采样时间按设备时区 {deviceTimezone}{" "}
            输入。填写数据实际覆盖的区间，起点计入、终点不计入；采样时间是读取或导出报表的时间，不能早于窗口结束。报表时区只记录统计口径。
          </p>
          <div className="grid">
            <label>
              关联活动（可选）
              <select
                aria-label="关联活动（可选）"
                value={selectedCampaign}
                onChange={(event) => setCampaignId(event.target.value)}
              >
                <option value="">未指定，尝试按唯一 UTM 归因</option>
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              效果渠道（可选）
              <input
                aria-label="效果渠道（可选）"
                name="channel"
                list="metric-channel-options"
                maxLength={100}
                placeholder="linkedin / email / x"
              />
              <datalist id="metric-channel-options">
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </datalist>
            </label>
          </div>
          <div className="grid">
            <Field
              label="花费币种"
              name="currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              pattern="[A-Z]{3}"
              maxLength={3}
              required
              placeholder="USD / CNY / EUR"
            />
            <Field
              label="报表时区（IANA）"
              name="timezone"
              defaultValue={deviceTimezone}
              required
              placeholder="Asia/Shanghai"
            />
          </div>
          <div className="grid four">
            {[
              ["impressions", "曝光"],
              ["clicks", "点击"],
              ["conversions", "转化"],
              ["spend", `花费（${currency || "未选币种"}）`],
            ].map(([n, l]) => (
              <Field
                key={n}
                label={l}
                name={n}
                type="number"
                min="0"
                step={n === "spend" ? "0.01" : "1"}
                defaultValue="0"
                required
              />
            ))}
          </div>
          <label>
            观察与复盘
            <textarea name="notes" placeholder="记录报表来源、统计口径及下一次实验方向…" />
          </label>
          <button className="primary" disabled={busy || !chosen}>
            保存效果记录 ↗
          </button>
        </form>
      </div>
      <div className="section-title spaced" id="metric-records">
        <h2>原始效果记录</h2>
        <span>
          {data.metrics.length} 条保留记录 · {quality.counts.included} 条计入汇总
        </span>
      </div>
      <div className="card table-wrap">
        <table style={{ minWidth: 1240 }}>
          <thead style={{ whiteSpace: "nowrap" }}>
            <tr>
              <th>发布 / 版本</th>
              <th>窗口 / 采样</th>
              <th>汇总状态</th>
              <th>曝光</th>
              <th>点击</th>
              <th>CTR</th>
              <th>转化</th>
              <th>花费</th>
              <th>复盘</th>
            </tr>
          </thead>
          <tbody>
            {quality.rows.map(({ metric: m, status, issues, relatedIds }, index) => {
              if (!m || typeof m !== "object")
                return (
                  <tr key={`invalid-${index}`}>
                    <td colSpan={9}>
                      历史指标记录格式无效，暂不计入汇总。原始数据保留，请核对导入来源。
                    </td>
                  </tr>
                );
              return (
                <tr key={m.id || `invalid-${index}`} id={m.id ? `metric-${m.id}` : undefined}>
                  <td>
                    <a href={m.url} target="_blank" rel="noreferrer">
                      发布链接 ↗
                    </a>
                    <small>
                      V
                      {
                        data.contents
                          .find((c) => c.id === m.contentId)
                          ?.revisions.find((r: Revision) => r.id === m.revisionId)?.number
                      }
                    </small>
                    <small>
                      {m.channel || "未指定渠道"} ·{" "}
                      {data.campaigns.find((campaign) => campaign.id === m.campaignId)?.name ||
                        "未直接指定活动"}
                    </small>
                  </td>
                  <td>
                    {m.windowStart && m.windowEnd ? (
                      <>
                        <small>开始：{fmt(m.windowStart)}</small>
                        <small>结束：{fmt(m.windowEnd)}（不含）</small>
                      </>
                    ) : (
                      <small>统计窗口未填写</small>
                    )}
                    <small>采样：{fmt(m.date)}</small>
                    <small>报表时区：{m.timezone || "未登记"}</small>
                  </td>
                  <td>
                    <span className={`badge${status === "included" ? "" : " amber"}`}>
                      {statusLabels[status]}
                    </span>
                    {issues.length > 0 && (
                      <ul>
                        {issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    )}
                    {relatedIds.length > 0 && (
                      <details>
                        <summary>查看关联记录（{relatedIds.length}）</summary>
                        {relatedIds.map((id) => (
                          <button
                            key={id}
                            type="button"
                            className="secondary"
                            onClick={() =>
                              document
                                .getElementById(`metric-${id}`)
                                ?.scrollIntoView({ block: "center" })
                            }
                          >
                            查看记录 {data.metrics.findIndex((metric) => metric?.id === id) + 1}
                          </button>
                        ))}
                      </details>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.impressions) ? m.impressions : "无效数值"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.clicks) ? m.clicks : "无效数值"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.impressions) &&
                    m.impressions > 0 &&
                    Number.isFinite(m.clicks)
                      ? ((m.clicks / m.impressions) * 100).toFixed(1) + "%"
                      : "—"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.conversions) ? m.conversions : "无效数值"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.spend) ? m.spend.toFixed(2) : "无效数值"}{" "}
                    {typeof m.currency === "string" ? m.currency : "未登记币种"}
                  </td>
                  <td>
                    {typeof m.notes === "string" ? m.notes : ""}
                    {m.voidedAt ? (
                      <p>
                        撤销：{m.voidedBy}（自报）· {fmt(m.voidedAt)}
                        <br />
                        原因：{m.voidReason}
                      </p>
                    ) : (
                      m.id && (
                        <details>
                          <summary>撤销需要更正的记录</summary>
                          <form
                            data-draft-scope={`metric-void:${m.id}`}
                            onSubmit={(event) => {
                              event.preventDefault();
                              const form = new FormData(event.currentTarget);
                              void act(`metrics/${m.id}/void`, {
                                actor: form.get("actor"),
                                reason: form.get("reason"),
                              });
                            }}
                          >
                            <p>
                              撤销后仍保留原始数值和原因，但不再计入汇总。核对正确窗口后可重新录入。
                            </p>
                            <label>
                              撤销人（自报）
                              <input name="actor" required maxLength={120} />
                            </label>
                            <label>
                              指标撤销原因
                              <textarea name="reason" required maxLength={2000} />
                            </label>
                            <button className="secondary" disabled={busy}>
                              确认撤销指标记录
                            </button>
                          </form>
                        </details>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!data.metrics.length && (
          <p className="empty">还没有效果记录。先批准并下载内容，再手动发布。</p>
        )}
      </div>
    </>
  );
}
