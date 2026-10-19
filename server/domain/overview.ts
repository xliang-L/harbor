import type { Fact, State, Task } from "../types.ts";
import { reviewQueue } from "../routes/console.ts";
import { onboardingSteps } from "./campaigns.ts";
import { receiptFactIssues } from "./deliveries.ts";
import {
  applicableFacts,
  factConflicts,
  factStatus,
  normalizeFactAttribute,
  normalizeFactValue,
} from "./facts.ts";

const taskNames: Record<Task["kind"], string> = {
  fetch: "公开资料抓取",
  suggest: "生成营销建议",
  content: "生成内容",
  render: "视频渲染",
  sync: "同步监测来源",
};

function hasActiveReconfirmation(
  state: State,
  fact: Fact,
  now: number,
  visited = new Set<string>(),
): boolean {
  if (visited.has(fact.id)) return false;
  visited.add(fact.id);
  return state.facts
    .filter(
      (next) =>
        next.reconfirmsFactId === fact.id &&
        !next.withdrawnAt &&
        next.text === fact.text &&
        next.quote === fact.quote &&
        next.evidenceId === fact.evidenceId &&
        (!fact.scope ||
          (next.scope === fact.scope &&
            next.productId === fact.productId &&
            normalizeFactAttribute(next.attribute || "") ===
              normalizeFactAttribute(fact.attribute || "") &&
            normalizeFactValue(next.value || "") === normalizeFactValue(fact.value || ""))),
    )
    .some((next) => {
      const context = state.brand ? { ...state.brand, activeProductId: next.productId } : null;
      return (
        (factStatus(next, state.facts, now).status === "active" &&
          applicableFacts(state, context, now).some((item) => item.id === next.id)) ||
        hasActiveReconfirmation(state, next, now, visited)
      );
    });
}

// Read-only projection: the dashboard uses the same approval rules as the review queue.
export function overview(state: State, now = Date.now()) {
  const factChecks = factConflicts(state.facts, now).map((group) => ({
    key: `conflict:${group.key}`,
    factId: group.factIds[0],
    title: `属性「${group.attribute}」存在不同值`,
    label: "潜在事实冲突",
    detail: `${group.scope === "brand" ? "品牌通用" : state.products.find((product) => product.id === group.productId)?.title || "商品事实"}：${group.values.join(" / ")}。请核对来源；系统不做单位换算或语义判断。`,
  }));
  for (const fact of state.facts) {
    const status = factStatus(fact, state.facts, now);
    if (
      (status.status === "expired" || status.status === "invalid") &&
      !hasActiveReconfirmation(state, fact, now)
    )
      factChecks.push({
        key: `fact:${fact.id}`,
        factId: fact.id,
        title: fact.text,
        label: status.status === "expired" ? "事实已到期" : "事实需重新确认",
        detail: status.issues.join("；"),
      });
  }
  const active = state.tasks.filter((t) => t.status === "queued" || t.status === "running");
  const sources = state.sources.map((source) => {
    const running = active.some((t) => t.kind === "sync" && t.payload?.sourceId === source.id);
    const status = running
      ? "running"
      : source.lastError
        ? "failed"
        : !source.enabled
          ? "paused"
          : !source.lastSuccessAt
            ? "never"
            : Date.parse(source.nextRunAt) <= now
              ? "overdue"
              : "current";
    return {
      id: source.id,
      label: source.label,
      status,
      schedulerPaused: !source.enabled,
      lastSuccessAt: source.lastSuccessAt || null,
      nextRunAt: source.enabled ? source.nextRunAt : null,
      detail:
        status === "paused"
          ? "定期检查已暂停"
          : status === "running"
            ? "任务正在排队或同步"
            : source.lastError
              ? `${source.lastError}${!source.enabled ? "（定期检查已暂停）" : ""}`
              : status === "never"
                ? "还没有成功检查记录"
                : status === "overdue"
                  ? "已到检查时间，等待服务调度"
                  : "最近一次检查成功",
    };
  });
  // A successful replacement supersedes an older failed attempt for the same operation.
  const latest = new Map<string, Task>();
  for (const task of state.tasks) {
    const key =
      task.kind +
      JSON.stringify(Object.entries(task.payload || {}).sort(([a], [b]) => a.localeCompare(b)));
    const previous = latest.get(key);
    if (!previous || Date.parse(task.updatedAt) >= Date.parse(previous.updatedAt))
      latest.set(key, task);
  }
  const failures = [...latest.values()]
    .filter(
      (t) =>
        t.status === "failed" &&
        !(t.kind === "sync" && state.sources.some((s) => s.id === t.payload?.sourceId)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((t) => ({
      id: t.id,
      label: taskNames[t.kind],
      error: t.error || "任务失败，请查看任务记录",
      updatedAt: t.updatedAt,
      attempt: t.attempt,
    }));
  const reviews = reviewQueue("", state, now)
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        { high: 0, normal: 1, low: 2 }[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority] ||
        (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity),
    )
    .map(({ kind, targetId, title, reason, page, dueAt, overdue, owner }) => ({
      kind,
      targetId,
      title,
      reason,
      page,
      dueAt,
      overdue,
      owner,
    }));
  const followups = (state.crm?.followups || [])
    .filter((t) => !t.doneAt && Date.parse(t.dueAt) <= now)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .map((t) => {
      const lead = state.crm?.leads.find((l) => l.id === t.leadId);
      const account = state.crm?.accounts.find((a) => a.id === lead?.accountId);
      const contact = state.crm?.contacts.find((c) => c.id === lead?.contactId);
      return {
        id: t.id,
        leadId: t.leadId,
        title: t.title,
        owner: t.owner,
        dueAt: t.dueAt,
        company: account?.company || "未关联公司",
        contact: contact?.name || "",
      };
    });
  const deliveries = (state.deliveries || []).filter((receipt) => !receipt.voidedAt);
  const delivered = new Set(deliveries.map((receipt) => receipt.calendarId));
  const deliveryAlerts = deliveries
    .map((receipt) => ({
      id: receipt.id,
      calendarId: receipt.calendarId,
      title: receipt.snapshot.headline || receipt.channel,
      deliveredAt: receipt.deliveredAt,
      issues: receiptFactIssues(state, receipt, now),
    }))
    .filter((receipt) => receipt.issues.length > 0);
  const upcoming = state.calendar
    .filter(
      (e) =>
        !e.archivedAt &&
        !delivered.has(e.id) &&
        Date.parse(e.scheduledAt) >= now &&
        Date.parse(e.scheduledAt) <= now + 7 * 86400000,
    )
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
    .map((e) => ({
      id: e.id,
      title: e.headline || e.channel,
      channel: e.channel,
      account: e.account,
      scheduledAt: e.scheduledAt,
      needsReview: reviews.some((r) => r.kind === "calendar" && r.targetId === e.id),
    }));
  const recentDue = state.calendar
    .filter(
      (e) =>
        !e.archivedAt &&
        !delivered.has(e.id) &&
        Date.parse(e.scheduledAt) < now &&
        Date.parse(e.scheduledAt) >= now - 7 * 86400000,
    )
    .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt))
    .map((e) => ({
      id: e.id,
      title: e.headline || e.channel,
      channel: e.channel,
      scheduledAt: e.scheduledAt,
    }));
  const needsSetup = onboardingSteps(state, now).some((step) => !step.done);
  return {
    generatedAt: new Date(now).toISOString(),
    needsSetup,
    counts: {
      reviews: reviews.length,
      followups: followups.length,
      upcoming: upcoming.length,
      recentDue: recentDue.length,
      problems:
        failures.length +
        sources.filter((s) => s.status === "failed").length +
        deliveryAlerts.length +
        factChecks.length,
      activeTasks: active.length,
      factsToCheck: factChecks.length,
    },
    // Counts refer to all records; lists are bounded for large local workspaces.
    reviews: reviews.slice(0, 12),
    followups: followups.slice(0, 12),
    upcoming: upcoming.slice(0, 8),
    failures: failures.slice(0, 8),
    sources,
    recentDue: recentDue.slice(0, 8),
    deliveryAlerts: deliveryAlerts.slice(0, 8),
    factChecks: factChecks.slice(0, 12),
    recentDeliveries: deliveries
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, 5)
      .map((receipt) => ({
        id: receipt.id,
        calendarId: receipt.calendarId,
        title: receipt.snapshot.headline || receipt.channel,
        channel: receipt.channel,
        deliveredAt: receipt.deliveredAt,
        actor: receipt.actor,
      })),
    evidence: {
      real: state.evidence.filter((e) => !e.demo).length,
      demo: state.evidence.filter((e) => e.demo).length,
    },
  };
}
export type OverviewData = ReturnType<typeof overview>;
