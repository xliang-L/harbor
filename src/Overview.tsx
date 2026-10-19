import React, { useEffect, useState } from "react";
import type { State } from "../server/types";
import type { OverviewData } from "../server/domain/overview";
import { StartChecklist } from "./Planning";
import { metricQuality } from "../server/domain/metrics";

const time = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const sourceLabels: Record<string, string> = {
  current: "检查成功",
  failed: "同步失败",
  paused: "已暂停",
  never: "尚未检查",
  overdue: "等待检查",
  running: "同步中",
};
const reviewLabels = {
  content: "内容",
  calendar: "渠道排期",
  campaign: "活动",
  promotion: "门店促销",
};
type Props = {
  data: State;
  busy: boolean;
  act: (path: string, body: unknown) => Promise<any>;
  navigate: (page: number, section?: string, target?: string) => void;
};

export function Overview({ data, busy, act, navigate }: Props) {
  const [summary, setSummary] = useState<OverviewData>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState<"all" | "reviews" | "followups">("all");
  const metricCounts = metricQuality(data.metrics).counts;
  const pendingMetrics =
    metricCounts.missingWindow + metricCounts.invalidWindow + metricCounts.conflict;
  useEffect(() => {
    let current = true;
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (controller) return;
      controller = new AbortController();
      timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch("/api/overview", { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result: OverviewData = await response.json();
        if (current) {
          setSummary(result);
          setError("");
        }
      } catch {
        if (current) setError("工作台状态暂时无法更新。请检查本机服务后重试。");
      } finally {
        clearTimeout(timeout);
        controller = undefined;
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => {
      current = false;
      clearInterval(interval);
      clearTimeout(timeout);
      controller?.abort();
    };
  }, [retry]);
  const goReview = (page: number, target: string) =>
    navigate(page, page === 4 ? "calendar" : page === 5 ? "campaigns" : undefined, target);
  return (
    <div className="overview">
      {error && (
        <div className="notice error" role="alert">
          <span>
            {error}
            {summary && " 下方保留上次状态。"}
          </span>
          <button onClick={() => setRetry((x) => x + 1)}>重试更新</button>
        </div>
      )}
      {!summary ? (
        !error && <p role="status">正在整理今日待办…</p>
      ) : (
        <>
          <section className="overview-intro">
            <div>
              <p className="eyebrow">YOUR NEXT MOVE</p>
              <h2>
                {data.brand
                  ? `${data.brand.name}，从最重要的一步开始。`
                  : "让每一天的营销，都有清楚的下一步。"}
              </h2>
              <p>集中处理异常、审核和跟进，再安排接下来一周的内容。</p>
            </div>
            <div className="overview-sync">
              <span className="green-dot" />
              {error ? "状态待更新" : "本机状态已同步"}
              <small>
                {time(summary.generatedAt)}
                {summary.counts.activeTasks > 0 && ` · ${summary.counts.activeTasks} 个任务处理中`}
              </small>
            </div>
          </section>
          <div className="overview-counts" aria-label="工作概况">
            {(
              [
                ["待审核", summary.counts.reviews, () => setFilter("reviews")],
                ["已到期跟进", summary.counts.followups, () => setFilter("followups")],
                [
                  "异常待处理",
                  summary.counts.problems,
                  () =>
                    document
                      .getElementById("overview-problems")
                      ?.scrollIntoView({ behavior: "smooth", block: "center" }),
                ],
                ["未来 7 天排期", summary.counts.upcoming, () => navigate(4, "calendar")],
              ] as const
            ).map(([label, count, onClick]) => (
              <button key={label} onClick={onClick}>
                <span>{label}</span>
                <strong>{count}</strong>
                <small>查看详情 ↗</small>
              </button>
            ))}
          </div>
          {summary.needsSetup && <StartChecklist data={data} navigate={navigate} />}
          <div className="overview-columns">
            <div>
              <section className="card" id="overview-problems">
                <div className="section-title">
                  <h2>需要先处理</h2>
                  <span>
                    {summary.counts.problems
                      ? `${summary.counts.problems} 项异常`
                      : "没有待处理异常"}
                  </span>
                </div>
                {summary.factChecks.map((item) => (
                  <div className="overview-row problem" key={item.key}>
                    <div>
                      <span className="badge amber">{item.label}</span>
                      <h3>{item.title}</h3>
                      <p>{item.detail}</p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => navigate(4, "sources", item.factId)}
                    >
                      核对事实
                    </button>
                  </div>
                ))}
                {summary.counts.factsToCheck > summary.factChecks.length && (
                  <p className="muted">首页显示前 12 项事实提醒；更多记录请到来源与事实查看。</p>
                )}
                {summary.sources
                  .filter((s) => s.status === "failed")
                  .map((source) => (
                    <div className="overview-row problem" key={source.id}>
                      <div>
                        <span className="badge amber">来源同步失败</span>
                        <h3>{source.label}</h3>
                        <p>{source.detail}</p>
                        <small>
                          最近成功：{source.lastSuccessAt ? time(source.lastSuccessAt) : "暂无记录"}
                        </small>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => navigate(4, "sources", source.id)}
                      >
                        检查来源
                      </button>
                    </div>
                  ))}
                {summary.failures.map((task) => (
                  <div className="overview-row problem" key={task.id}>
                    <div>
                      <span className="badge amber">任务失败</span>
                      <h3>{task.label}</h3>
                      <p>{task.error}</p>
                      <small>
                        {time(task.updatedAt)} · 已尝试 {task.attempt} 次
                      </small>
                    </div>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void act(`tasks/${task.id}/retry`, {})}
                    >
                      重试任务
                    </button>
                  </div>
                ))}
                {summary.deliveryAlerts.map((receipt) => (
                  <div className="overview-row problem" key={receipt.id}>
                    <div>
                      <span className="badge amber">已交付内容的事实依据有变化</span>
                      <h3>{receipt.title}</h3>
                      <p>{receipt.issues.join("；")}</p>
                      <small>
                        人工记录交付时间 {time(receipt.deliveredAt)}
                        。请核对渠道内容，历史回执仍保留。
                      </small>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => navigate(4, "calendar", receipt.calendarId)}
                    >
                      检查交付
                    </button>
                  </div>
                ))}
                {!summary.counts.problems && (
                  <p className="muted">
                    任务和已启用来源暂无失败记录。尚未检查的来源单独显示在监测状态中。
                  </p>
                )}
                {summary.failures.length > 0 && (
                  <p className="muted">
                    重试模型生成会再次调用你已配置的模型。自动轮询不会重试任务。
                  </p>
                )}
              </section>
              <section className="card">
                <div className="section-title">
                  <h2>待办与决策</h2>
                  <button className="secondary" onClick={() => navigate(7)}>
                    多品牌审核
                  </button>
                </div>
                <div className="tabs" aria-label="待办筛选">
                  {(
                    [
                      ["all", "全部"],
                      ["reviews", "审核"],
                      ["followups", "跟进"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      aria-pressed={filter === id}
                      className={filter === id ? "selected" : ""}
                      key={id}
                      onClick={() => setFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {filter !== "reviews" &&
                  summary.followups.map((task) => (
                    <div className="overview-row" key={task.id}>
                      <div>
                        <span className="badge amber">到期跟进</span>
                        <h3>{task.title}</h3>
                        <p>
                          {task.company} · {task.contact} · {task.owner || "未分配"}
                        </p>
                        <small>到期 {time(task.dueAt)}</small>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => navigate(6, undefined, task.leadId)}
                      >
                        查看线索
                      </button>
                    </div>
                  ))}
                {filter !== "followups" &&
                  summary.reviews.map((item) => (
                    <div className="overview-row" key={`${item.kind}-${item.targetId}`}>
                      <div>
                        <span className={`badge ${item.overdue ? "amber" : ""}`}>
                          {reviewLabels[item.kind]}
                          {item.overdue ? " · 已到期" : " · 待审核"}
                        </span>
                        <h3>{item.title}</h3>
                        <p>{item.reason}</p>
                        <small>
                          {item.owner || "未分配负责人"}
                          {item.dueAt && ` · ${time(item.dueAt)}`}
                        </small>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => goReview(item.page, item.targetId)}
                      >
                        前往审核
                      </button>
                    </div>
                  ))}
                {(filter === "reviews"
                  ? !summary.counts.reviews
                  : filter === "followups"
                    ? !summary.counts.followups
                    : !summary.counts.reviews && !summary.counts.followups) && (
                  <div className="empty">
                    <h3>当前筛选下没有审核或跟进事项</h3>
                    <p>
                      {summary.counts.recentDue
                        ? `另有 ${summary.counts.recentDue} 条近期排期已到时间，请在日历核对人工交付。`
                        : "创建内容或安排跟进后，需要你处理的事项会集中出现在这里。"}
                    </p>
                    <button className="secondary" onClick={() => navigate(1)}>
                      查看市场动态
                    </button>
                  </div>
                )}
                {(summary.counts.reviews > summary.reviews.length ||
                  summary.counts.followups > summary.followups.length) && (
                  <p className="muted">
                    首页分别显示最早到期的 12 项跟进和优先级最高的 12
                    项审核；完整列表请进入对应页面。
                  </p>
                )}
              </section>
            </div>
            <div>
              <section className="card">
                <div className="section-title">
                  <h2>未来 7 天</h2>
                  <button className="secondary" onClick={() => navigate(4, "calendar")}>
                    渠道日历
                  </button>
                </div>
                <p className="muted">本地交付计划，时间按当前设备时区显示；到点不会自动发布。</p>
                {summary.upcoming.map((item) => (
                  <div className="overview-schedule" key={item.id}>
                    <time>{time(item.scheduledAt)}</time>
                    <h3>{item.title}</h3>
                    <p>
                      {item.channel} · {item.account}
                    </p>
                    <span className={`badge ${item.needsReview ? "amber" : ""}`}>
                      {item.needsReview ? "需审核后交付" : "已批准 · 人工交付"}
                    </span>
                  </div>
                ))}
                {!summary.upcoming.length && <p className="empty">还没有未来 7 天的排期。</p>}
                {summary.counts.upcoming > summary.upcoming.length && (
                  <p className="muted">显示最近 8 条；其余排期请打开渠道日历。</p>
                )}
                {summary.recentDue.length > 0 && (
                  <>
                    <h3>近 7 天已到排期时间</h3>
                    <p className="muted">以下排期尚无有效交付回执，请核对并记录人工交付。</p>
                    {summary.recentDue.map((item) => (
                      <div className="overview-schedule" key={item.id}>
                        <time>{time(item.scheduledAt)}</time>
                        <h3>{item.title}</h3>
                        <p>{item.channel}</p>
                        <button
                          className="secondary"
                          onClick={() => navigate(4, "calendar", item.id)}
                        >
                          核对交付
                        </button>
                      </div>
                    ))}
                    {summary.counts.recentDue > summary.recentDue.length && (
                      <p className="muted">显示最近 8 条；更多历史排期请打开渠道日历。</p>
                    )}
                  </>
                )}
                {summary.recentDeliveries.length > 0 && (
                  <>
                    <h3>最近人工交付记录</h3>
                    <p className="muted">由操作者填报，尚未经平台核验。</p>
                    {summary.recentDeliveries.map((receipt) => (
                      <div className="overview-schedule" key={receipt.id}>
                        <time>{time(receipt.deliveredAt)}</time>
                        <h3>{receipt.title}</h3>
                        <p>
                          {receipt.channel} · {receipt.actor}
                        </p>
                        <button
                          className="secondary"
                          onClick={() => navigate(4, "calendar", receipt.calendarId)}
                        >
                          查看回执
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </section>
              <section className="card">
                <div className="section-title">
                  <h2>监测状态</h2>
                  <button className="secondary" onClick={() => navigate(4, "sources")}>
                    管理来源
                  </button>
                </div>
                {summary.sources.map((source) => (
                  <div className="overview-source" key={source.id}>
                    <div>
                      <strong>{source.label}</strong>
                      <span className={`badge ${source.status === "failed" ? "amber" : ""}`}>
                        {sourceLabels[source.status]}
                      </span>
                    </div>
                    <small>
                      {source.lastSuccessAt
                        ? `最近成功 ${time(source.lastSuccessAt)}`
                        : "暂无成功检查"}
                    </small>
                  </div>
                ))}
                {!summary.sources.length && (
                  <p className="empty">添加品牌或竞品来源后，在这里查看检查情况。</p>
                )}
                <p className="muted">
                  定期监测在本机服务运行时执行。暂停和从未检查的来源不计作健康来源。
                </p>
              </section>
              <section className="card overview-evidence">
                <h2>资料与效果</h2>
                <p>
                  非演示资料 <strong>{summary.evidence.real}</strong> 条 · 演示资料{" "}
                  <strong>{summary.evidence.demo}</strong> 条
                </p>
                <p className="muted">
                  非演示标记不代表内容已独立核实。
                  {data.metrics.length
                    ? `${metricCounts.included} 条指标可汇总，${pendingMetrics} 条待核查；原始记录保留，缺少可用记录不代表零效果。`
                    : "尚无效果记录；这表示缺少数据，不代表营销效果为零。"}
                </p>
                <button className="secondary" onClick={() => navigate(3)}>
                  {pendingMetrics ? "核对效果记录" : "查看效果记录"}
                </button>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
