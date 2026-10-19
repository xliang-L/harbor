import React, { useState, useEffect, useRef } from "react";
import type { State } from "../../../server/types";
import type { channels } from "../../../server/domain/channels";
import type { opportunities, recap } from "../../../server/domain/insights";
import type { Act } from "../../shared/types.ts";
import { scheduledFactIssues } from "../../../server/domain/facts";
import {
  type FactScopeChoice,
  emptyFactConditions,
  factConditionPayload,
  FactConditionsFields,
  FactScopeFields,
  FactCard,
} from "./Facts";
import { DeliveryReceipts, DeliveryLoadNotice, useDeliveryEntries } from "./DeliveryReceipts";
type Details = {
  channels: typeof channels;
  opportunities: ReturnType<typeof opportunities>;
  recap: ReturnType<typeof recap>;
  connectors: {
    id: string;
    name: string;
    status: string;
    permission: string;
  }[];
  provider: {
    enabled: boolean;
    configured: boolean;
    name: string | null;
    liveVerified: boolean;
  };
};
export function Workflows({
  data,
  act,
  busy,
  section: requestedSection,
  target,
  navigate,
}: {
  data: State;
  act: Act;
  busy: boolean;
  section?: string;
  target?: string;
  navigate?: (page: number, section?: string, target?: string) => void;
}) {
  const [modelCheck, setModelCheck] = useState<{ message: string }>();
  const [info, setInfo] = useState<Details>();
  const validSection = (value?: string) =>
    ["sources", "actions", "calendar", "metrics", "connections"].includes(value || "")
      ? value!
      : "sources";
  const [section, setSection] = useState(() => validSection(requestedSection));
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [diffError, setDiffError] = useState("");
  const [diffBusy, setDiffBusy] = useState(false);
  const loadingRequest = useRef<AbortController | null>(null);
  const [source, setSource] = useState({
    label: "",
    url: "",
    connector: "web",
    category: "competitor",
    intervalHours: 24,
    enabled: false,
  });
  const [fact, setFact] = useState({
    evidenceId: "",
    quote: "",
    text: "",
    scope: "" as FactScopeChoice,
    productId: "",
    actor: "",
    ...emptyFactConditions(),
  });
  const [entry, setEntry] = useState({
    contentId: "",
    revisionId: "",
    channel: "linkedin",
    account: "",
    scheduledAt: "",
    copy: "",
    headline: "",
    targetUrl: "",
    campaign: "",
  });
  const [diff, setDiff] = useState<any>();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<any>();
  const [metricImportMessage, setMetricImportMessage] = useState("");
  const metricFileRead = useRef(0);
  const metricPreviewRequest = useRef<
    { version: number; text: string; payload: { rows: unknown } | { csv: string } } | undefined
  >(undefined);
  const [dates, setDates] = useState({ startDate: "", endDate: "" });
  const [report, setReport] = useState<any>();
  const delivery = useDeliveryEntries(data, section === "calendar");
  const scrolledTarget = useRef("");
  useEffect(() => {
    if (!info || !target || scrolledTarget.current === target) return;
    const card =
      document.getElementById(`${section === "calendar" ? "calendar" : "source"}-${target}`) ||
      document.getElementById(`fact-${target}`);
    if (card) {
      card.scrollIntoView({ block: "center" });
      scrolledTarget.current = target;
    }
  }, [info, target, section]);
  useEffect(() => {
    setSection(validSection(requestedSection));
  }, [requestedSection]);
  useEffect(() => {
    return () => loadingRequest.current?.abort();
  }, []);
  useEffect(() => {
    if (loadingRequest.current) return;
    const abort = new AbortController();
    loadingRequest.current = abort;
    void fetch("/api/workflows", { signal: abort.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `服务返回 HTTP ${response.status}`);
        if (
          !body ||
          !Array.isArray(body.opportunities) ||
          !Array.isArray(body.recap) ||
          !Array.isArray(body.connectors) ||
          !body.provider
        )
          throw new Error("工作流数据不完整，请重试");
        if (!abort.signal.aborted) {
          setInfo(body);
          setLoadError("");
        }
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted) setLoadError(error.message || "网络连接失败");
      })
      .finally(() => {
        if (loadingRequest.current === abort) loadingRequest.current = null;
      });
  }, [data, retry]);
  const errorNotice = loadError && (
    <div className="notice error" role="alert">
      暂时无法更新运营流程：{loadError}。
      {info ? "当前保留上次成功加载的信息和未保存的输入。" : "请重试加载。"}
      <button type="button" onClick={() => setRetry((value) => value + 1)}>
        重试加载运营流程
      </button>
    </div>
  );
  if (!info) return errorNotice || <p role="status">加载工作流…</p>;
  const input = (label: string, value: string, change: (v: string) => void, type = "text") => (
    <label>
      {label}
      <input required type={type} value={value} onChange={(e) => change(e.target.value)} />
    </label>
  );
  return (
    <>
      {errorNotice}
      <div className="tabs">
        {[
          ["sources", "来源与事实"],
          ["actions", "优先行动"],
          ["calendar", "渠道日历"],
          ["metrics", "批量指标与复盘"],
          ["connections", "连接器状态"],
        ].map(([id, name]) => (
          <button
            key={id}
            className={section === id ? "selected" : ""}
            onClick={() => {
              setSection(id);
              navigate?.(4, id);
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {section === "sources" && (
        <>
          <form
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              void act("sources", source);
            }}
          >
            <h2>订阅公开来源</h2>
            <p>
              开启定期检查后，仅在本地服务运行期间执行；每个品牌独立保存来源。抓取失败保留时间、原因和历史。
            </p>
            <div className="grid">
              {input("来源名称", source.label, (v) => setSource({ ...source, label: v }))}
              {input("来源地址", source.url, (v) => setSource({ ...source, url: v }), "url")}
            </div>
            <div className="grid">
              <label>
                采集渠道
                <select
                  value={source.connector}
                  onChange={(e) => setSource({ ...source, connector: e.target.value })}
                >
                  <option value="web">公开网页 / 文本</option>
                  <option value="rss">RSS / Atom feed</option>
                  <option value="github">GitHub 仓库 Releases</option>
                </select>
              </label>
              <label>
                来源用途
                <select
                  value={source.category}
                  onChange={(e) => setSource({ ...source, category: e.target.value })}
                >
                  <option value="competitor">竞品监测</option>
                  <option value="brand">品牌事实</option>
                  <option value="market">市场资料</option>
                </select>
              </label>
            </div>
            <label>
              检查间隔（小时，1–720）
              <input
                type="number"
                min="1"
                max="720"
                value={source.intervalHours}
                onChange={(e) =>
                  setSource({
                    ...source,
                    intervalHours: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={source.enabled}
                onChange={(e) => setSource({ ...source, enabled: e.target.checked })}
              />
              启用定期只读检查
            </label>
            <button disabled={busy} className="primary">
              保存来源
            </button>
          </form>
          {data.sources.map((x) => (
            <div className="card" key={x.id} id={`source-${x.id}`}>
              <h3>
                {x.label} · {x.connector} · {x.category}
              </h3>
              <a href={x.url} target="_blank" rel="noreferrer">
                {x.url}
              </a>
              <p>
                上次尝试：{x.lastAttemptAt || "未检查"} · 上次成功：
                {x.lastSuccessAt || "无"}
              </p>
              <p>
                下次：{x.enabled ? x.nextRunAt : "已暂停"} · 每 {x.intervalHours} 小时
              </p>
              {x.lastError && <p className="notice error">{x.lastError}</p>}
              <div className="actions">
                <button
                  disabled={busy}
                  onClick={() => act("tasks", { kind: "sync", payload: { sourceId: x.id } })}
                >
                  立即同步
                </button>
                <button
                  disabled={busy}
                  onClick={() => act(`sources/${x.id}/toggle`, { enabled: !x.enabled })}
                >
                  {x.enabled ? "暂停定期检查" : "启用定期检查"}
                </button>
              </div>
              <button
                disabled={diffBusy}
                onClick={async () => {
                  setDiffBusy(true);
                  setDiffError("");
                  setDiff(undefined);
                  try {
                    const response = await fetch(`/api/sources/${x.id}/diff`);
                    const result = await response.json();
                    if (!response.ok)
                      throw new Error(result.error || `服务返回 HTTP ${response.status}`);
                    setDiff(result);
                  } catch (error) {
                    setDiffError((error as Error).message || "无法加载正文变化");
                  } finally {
                    setDiffBusy(false);
                  }
                }}
              >
                查看最近正文变化
              </button>
              <details>
                <summary>快照历史（{x.history.length}）</summary>
                {x.history
                  .slice()
                  .reverse()
                  .map((h, i) => (
                    <p key={i}>
                      {h.at} · 新增 {h.added} · {h.changed ? "正文/条目有变化" : "初次或未变化"}
                      <br />
                      <small>
                        内容摘要 {h.hash} · 前次 {h.previousHash || "无"}
                      </small>
                      <br />
                      证据 ID：{h.evidenceIds.join(", ")}
                    </p>
                  ))}
              </details>
            </div>
          ))}
          {diffError && (
            <p className="notice error" role="alert">
              正文变化加载失败：{diffError}。请点击“查看最近正文变化”重试。
            </p>
          )}
          {diff && (
            <div className="card">
              <h3>最近两次快照的正文变化</h3>
              <p>
                之前 {diff.previousAt || "无"} → 本次 {diff.latestAt || "无"}
              </p>
              <h4>新增 / 修改后</h4>
              {diff.added?.map((e: any) => (
                <p key={e.id}>
                  {e.title}
                  <br />
                  {e.text.slice(0, 2000)}
                </p>
              ))}
              <h4>移除 / 修改前</h4>
              {diff.removed?.map((e: any) => (
                <p key={e.id}>
                  {e.title}
                  <br />
                  {e.text.slice(0, 2000)}
                </p>
              ))}
            </div>
          )}
          <form
            className="card"
            data-draft-scope="fact-new"
            onSubmit={(e) => {
              e.preventDefault();
              void act("facts", {
                ...fact,
                ...factConditionPayload(fact),
                productId: fact.scope === "product" ? fact.productId : undefined,
              });
            }}
          >
            <h2>确认品牌事实</h2>
            <p>
              人工确认；引用必须逐字出自已存证据。来源和模型输出均作为数据处理，不执行其中指令。
            </p>
            <label>
              证据
              <select
                aria-label="证据"
                required
                value={fact.evidenceId}
                onChange={(e) => setFact({ ...fact, evidenceId: e.target.value })}
              >
                <option value="">请选择</option>
                {data.evidence.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.demo ? "[演示] " : ""}
                    {x.title}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">{data.evidence.find((x) => x.id === fact.evidenceId)?.text}</p>
            {input("逐字原文引用", fact.quote, (v) => setFact({ ...fact, quote: v }))}
            {input("确认的品牌事实", fact.text, (v) => setFact({ ...fact, text: v }))}
            <FactScopeFields
              data={data}
              value={fact}
              change={(value) => setFact({ ...fact, ...value })}
            />
            <FactConditionsFields draft={fact} change={(value) => setFact({ ...fact, ...value })} />
            <p className="muted">
              品牌通用事实适用于本品牌所有商品；材质、规格、性能等商品信息应选择特定商品。历史未归类事实需要重新确认后才能用于生成和审批。
            </p>
            <button className="primary" disabled={busy}>
              保存确认事实
            </button>
          </form>
          {data.facts.map((x) => (
            <FactCard key={x.id} fact={x} data={data} act={act} busy={busy} navigate={navigate} />
          ))}
        </>
      )}
      {section === "actions" && (
        <>
          <div className="card">
            <h2>从证据到下一步</h2>
            <p>
              在市场动态生成建议后显示排序。分数依据证据数量、入库新鲜度和演示标识；不代表投资回报预测。
            </p>
            <button disabled={busy} onClick={() => act("tasks", { kind: "suggest" })}>
              更新行动建议
            </button>
          </div>
          {info.opportunities.map((x) => (
            <div className="card" key={x.id}>
              <h3>
                #{x.priority} {x.title} · {x.score} 分
              </h3>
              <p>{x.reason}</p>
              <p>{x.explanation}</p>
              <p>{x.nextAction}</p>
              {x.quotes.map((q, i) => (
                <blockquote key={i}>{q.quote}</blockquote>
              ))}
              <button
                disabled={busy}
                onClick={() =>
                  act("tasks", {
                    kind: "content",
                    payload: { suggestionId: x.id },
                  })
                }
              >
                生成实验文案与分镜
              </button>
            </div>
          ))}
        </>
      )}
      {section === "calendar" && (
        <>
          <DeliveryLoadNotice delivery={delivery} />
          <form
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              void act("calendar", {
                ...entry,
                scheduledAt: new Date(entry.scheduledAt).toISOString(),
              });
            }}
          >
            <h2>建立渠道交付计划</h2>
            <p>
              内容审批后还需批准具体渠道、账号及文案。排期仅提醒和导出，不自动发布；编辑生成新条目重新审核。
            </p>
            <label>
              内容版本
              <select
                aria-label="内容版本"
                required
                value={entry.contentId}
                onChange={(e) => {
                  const c = data.contents.find((x) => x.id === e.target.value);
                  const r = c?.revisions.at(-1);
                  if (r)
                    setEntry({
                      ...entry,
                      contentId: c!.id,
                      revisionId: r.id,
                      copy: r.copy,
                      headline: c!.suggestion.title,
                      targetUrl: r.brand.url,
                    });
                }}
              >
                <option value="">请选择当前内容</option>
                {data.contents.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.suggestion.title} · v{c.revisions.at(-1)?.number}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid">
              <label>
                输出渠道
                <select
                  value={entry.channel}
                  onChange={(e) => setEntry({ ...entry, channel: e.target.value })}
                >
                  {info.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {input("目标账号（手动交付标识）", entry.account, (v) =>
                setEntry({ ...entry, account: v }),
              )}
            </div>
            <p>
              {info.channels.find((x) => x.id === entry.channel)?.note} · 正文{" "}
              {Array.from(entry.copy).length}/
              {info.channels.find((x) => x.id === entry.channel)?.max}
            </p>
            {input("渠道标题", entry.headline, (v) => setEntry({ ...entry, headline: v }))}
            <label>
              渠道文案
              <textarea
                required
                value={entry.copy}
                onChange={(e) => setEntry({ ...entry, copy: e.target.value })}
              />
            </label>
            <div className="grid">
              {input("Campaign 名称 / UTM", entry.campaign, (v) =>
                setEntry({ ...entry, campaign: v }),
              )}
              {input(
                "排期（浏览器本地时区）",
                entry.scheduledAt,
                (v) => setEntry({ ...entry, scheduledAt: v }),
                "datetime-local",
              )}
            </div>
            {input(
              "目标落地页",
              entry.targetUrl,
              (v) => setEntry({ ...entry, targetUrl: v }),
              "url",
            )}
            <button className="primary" disabled={busy}>
              保存待审批排期
            </button>
          </form>
          {data.calendar
            .filter(
              (x) =>
                !x.archivedAt ||
                x.id === target ||
                data.deliveries?.some((receipt) => receipt.calendarId === x.id),
            )
            .slice()
            .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
            .map((x) => {
              const revision = data.contents
                .find((content) => content.id === x.contentId)
                ?.revisions.find((item) => item.id === x.revisionId);
              const factIssues = revision
                ? scheduledFactIssues(data, revision, x.scheduledAt)
                : ["内容版本不存在"];
              const stale =
                data.contents.find((c) => c.id === x.contentId)?.revisions.at(-1)?.id !==
                x.revisionId;
              const approved =
                !!x.approvedAt &&
                !factIssues.length &&
                (x.approvalGuidelinesAt || "") === (data.guidelines?.updatedAt || "");
              return (
                <div className="card" key={x.id} id={`calendar-${x.id}`}>
                  <h3>
                    {x.campaign} · {x.channel} · {x.account}
                  </h3>
                  <p>
                    {new Date(x.scheduledAt).toLocaleString()} ·{" "}
                    {factIssues.length
                      ? "需复核事实后重新审批"
                      : stale
                        ? "版本已失效，请重新安排"
                        : approved
                          ? "交付已批准"
                          : "待审批"}
                  </p>
                  {x.archivedAt && <p className="badge">已归档 · 保留历史交付记录</p>}
                  <strong>{x.headline}</strong>
                  <p style={{ whiteSpace: "pre-wrap" }}>{x.copy}</p>
                  {factIssues.length > 0 && (
                    <ul>
                      {factIssues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  {!x.archivedAt && !stale && !approved && (
                    <button
                      disabled={busy || factIssues.length > 0}
                      onClick={() => act(`calendar/${x.id}/approve`, {})}
                    >
                      批准此渠道 / 账号 / 文案
                    </button>
                  )}
                  {!x.archivedAt && !stale && approved && (
                    <a
                      className="primary"
                      href={`/api/calendar/${x.id}/export?project=${encodeURIComponent(new URLSearchParams(location.search).get("project") || "default")}`}
                    >
                      下载含 UTM 的交付包
                    </a>
                  )}
                  <DeliveryReceipts
                    entry={x}
                    availability={delivery.entries?.find((item) => item.calendarId === x.id)}
                    act={act}
                    busy={busy}
                  />
                </div>
              );
            })}
        </>
      )}
      {section === "metrics" && (
        <>
          <div className="card" data-draft-scope="workflow-metrics">
            <h2>批量指标：预览后导入</h2>
            <p>
              表头：contentId,revisionId,url,windowStart,windowEnd,date,impressions,clicks,conversions,spend,notes,currency,timezone；可选
              campaignId、channel。
            </p>
            <p>
              windowStart / windowEnd 是实际统计窗口，开始计入、结束不计入，需填写带时区的 ISO
              时间。date 是采样或导出时间，不早于窗口结束。currency 使用 USD / CNY
              等三字母代码；timezone 使用 UTC / Asia/Shanghai 等 IANA 标签。
            </p>
            <p>
              同一版本、链接及活动/渠道口径下，窗口和四项数值完全相同的记录跳过；相交窗口或同窗口数值不一致需先核对。仅更换币种不能区分重叠窗口。历史缺窗口数据可以保留，但不计入汇总，不会从备注猜测窗口。
            </p>
            <label>
              CSV / JSON 文件
              <input
                type="file"
                accept=".csv,.json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const read = ++metricFileRead.current;
                  metricPreviewRequest.current = undefined;
                  setCsv("");
                  setPreview(undefined);
                  setMetricImportMessage("");
                  if (f.size > 300000) {
                    setPreview({ error: "文件超过 300KB" });
                    return;
                  }
                  try {
                    const text = await f.text();
                    if (read === metricFileRead.current) setCsv(text);
                  } catch {
                    if (read === metricFileRead.current)
                      setPreview({ error: "无法读取指标文件，请重新选择" });
                  }
                }}
              />
            </label>
            <label>
              指标数据
              <textarea
                aria-label="指标数据"
                value={csv}
                onChange={(e) => {
                  metricFileRead.current += 1;
                  metricPreviewRequest.current = undefined;
                  setCsv(e.target.value);
                  setPreview(undefined);
                  setMetricImportMessage("");
                }}
              />
            </label>
            <button
              disabled={busy || !csv.trim()}
              onClick={async () => {
                const version = metricFileRead.current;
                let payload: { rows: unknown } | { csv: string };
                if (csv.trim().startsWith("[")) {
                  try {
                    payload = { rows: JSON.parse(csv) };
                  } catch {
                    setPreview({ error: "JSON 格式无效，请检查括号、逗号和引号" });
                    return;
                  }
                } else payload = { csv };
                setMetricImportMessage("");
                setPreview(undefined);
                metricPreviewRequest.current = undefined;
                const result = await act("metrics/preview", payload);
                if (result && version === metricFileRead.current) {
                  metricPreviewRequest.current = { version, text: csv, payload };
                  setPreview(result);
                } else if (result) setMetricImportMessage("输入已变化，请重新校验当前数据。");
              }}
            >
              校验预览
            </button>
            {metricImportMessage && <p role="status">{metricImportMessage}</p>}
            {preview?.error && (
              <p className="notice error" role="alert">
                {preview.error}
              </p>
            )}
            {preview?.rows && (
              <>
                <p>
                  预览 {preview.rows.length} 行 · 可新增{" "}
                  {preview.rows.filter((row: any) => row.valid && !row.duplicate).length} 行 ·
                  完全重复 {preview.rows.filter((row: any) => row.valid && row.duplicate).length} 行
                  · 错误 {preview.rows.filter((row: any) => !row.valid).length}{" "}
                  行。存在错误时整批不导入。
                </p>
                <div className="table-scroll">
                  <table aria-label="指标导入预览">
                    <thead>
                      <tr>
                        <th>行</th>
                        <th>处理状态</th>
                        <th>统计窗口 / 采样</th>
                        <th>核对结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row: any) => (
                        <tr key={row.row}>
                          <td>{row.row}</td>
                          <td>
                            {!row.valid
                              ? "需修正"
                              : row.duplicate
                                ? "完全重复 · 将跳过"
                                : !row.metric?.windowStart || !row.metric?.windowEnd
                                  ? "可保留 · 不计汇总"
                                  : "可新增"}
                          </td>
                          <td>
                            {row.metric?.windowStart && row.metric?.windowEnd ? (
                              <>
                                <small>{row.metric.windowStart}</small>
                                <small>至 {row.metric.windowEnd}（不含）</small>
                              </>
                            ) : (
                              "未提供完整统计窗口"
                            )}
                            {row.metric?.date && <small>采样：{row.metric.date}</small>}
                          </td>
                          <td>
                            {row.error && <p>{row.error}</p>}
                            {row.warnings?.length > 0 ? (
                              <ul>
                                {row.warnings.map((warning: string) => (
                                  <li key={warning}>{warning}</li>
                                ))}
                              </ul>
                            ) : row.valid && !row.duplicate ? (
                              "格式与关联检查通过"
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details>
                  <summary>查看完整校验数据</summary>
                  <pre className="json-preview">{JSON.stringify(preview, null, 2)}</pre>
                </details>
                {preview.rows.every((x: any) => x.valid) &&
                  preview.rows.some((x: any) => !x.duplicate) && (
                    <button
                      disabled={
                        busy ||
                        !metricPreviewRequest.current ||
                        metricPreviewRequest.current.version !== metricFileRead.current ||
                        metricPreviewRequest.current.text !== csv
                      }
                      className="primary"
                      onClick={async () => {
                        const checked = metricPreviewRequest.current;
                        if (
                          !checked ||
                          checked.version !== metricFileRead.current ||
                          checked.text !== csv
                        ) {
                          setPreview(undefined);
                          setMetricImportMessage("输入已变化，请重新校验当前数据。");
                          return;
                        }
                        const result = await act("metrics/import", checked.payload);
                        if (result) {
                          setMetricImportMessage("");
                          setPreview(undefined);
                          metricPreviewRequest.current = undefined;
                        } else setMetricImportMessage("导入未完成，请重新校验预览以查看最新结果。");
                      }}
                    >
                      确认导入有效新行
                    </button>
                  )}
                {preview.rows.length > 0 &&
                  preview.rows.every((row: any) => row.valid && row.duplicate) && (
                    <p>全部是已保存的相同记录，无需再次导入。</p>
                  )}
              </>
            )}
          </div>
          {info.recap.map((x) => (
            <div key={x.contentId} className="card">
              <h3>
                {x.title} · {x.samples} 条计入汇总
              </h3>
              {x.excludedSamples > 0 && (
                <p className="notice error">
                  另有 {x.excludedSamples} 条原始记录未计入汇总：{x.issues.join("；")}
                </p>
              )}
              {x.groups.map((g) => (
                <p key={g.currency}>
                  {g.currency} · 曝光 {g.impressions} · 点击 {g.clicks} · CTR{" "}
                  {g.ctr === null ? "无数据" : (g.ctr * 100).toFixed(2) + "%"} · CPC{" "}
                  {g.cpc?.toFixed(2) ?? "无数据"} · CPA {g.cpa?.toFixed(2) ?? "无数据"}
                  <br />
                  {g.nextAction}
                </p>
              ))}
            </div>
          ))}
        </>
      )}
      {section === "connections" && (
        <>
          <div className="card">
            <h2>模型 Provider</h2>
            <button
              disabled={busy}
              onClick={async () => {
                setModelCheck(undefined);
                const result = await act("model/check", {});
                if (result) setModelCheck(result);
              }}
            >
              检查模型连接（不生成）
            </button>
            {modelCheck && <p>{modelCheck.message}</p>}
            <p>
              {info.provider.enabled
                ? info.provider.configured
                  ? "适配器已配置；真实服务需用户验收"
                  : "已启用但配置不完整"
                : "模板模式：不会调用模型"}{" "}
              · {info.provider.name || "未指定模型"}
            </p>
            <p>
              OpenAI Chat Completions 兼容端点；凭据仅由本项目 .env
              提供，不返回浏览器。配置不等于真实调用已验证。
            </p>
          </div>
          {info.connectors.map((c) => (
            <div className="card" key={c.id}>
              <h3>
                {c.name} ·{" "}
                {c.status === "available"
                  ? "可用（本地读取/导入）"
                  : c.status === "implemented"
                    ? "已实现 · 待网络实测"
                    : "待用户授权"}
              </h3>
              <p>{c.permission}</p>
            </div>
          ))}
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault();
              setReport(await act("connectors/ga4/report", dates));
            }}
          >
            <h3>手动请求 GA4 只读报表</h3>
            <p>
              需要用户自行授权并配置 analytics.readonly token 与 property
              ID。仅返回报表，不自动映射广告指标，不存储密钥。
            </p>
            <div className="grid">
              {input(
                "开始日期",
                dates.startDate,
                (v) => setDates({ ...dates, startDate: v }),
                "date",
              )}
              {input("结束日期", dates.endDate, (v) => setDates({ ...dates, endDate: v }), "date")}
            </div>
            <button disabled={busy}>读取已授权报表</button>
            {report && <pre className="json-preview">{JSON.stringify(report, null, 2)}</pre>}
          </form>
        </>
      )}
    </>
  );
}
