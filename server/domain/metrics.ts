import type { Metric } from "../types.ts";

function normalizedUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("指标链接无效");
  url.hash = "";
  url.searchParams.sort();
  return url.href;
}

function windowTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!parts) return null;
  const [, yearText, monthText, dayText, hour, minute, second] = parts;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    !days ||
    day < 1 ||
    day > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second || "0") > 59
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

const present = (value: unknown) =>
  value !== undefined && value !== null && (typeof value !== "string" || !!value.trim());
const observationTime = (value: unknown) =>
  typeof value === "string" ? windowTime(value.length === 10 ? `${value}T00:00:00Z` : value) : null;

export function metricStreamKey(metric: Metric) {
  return JSON.stringify([
    metric.contentId,
    metric.revisionId,
    normalizedUrl(metric.url),
    metric.currency || "",
    metric.campaignId || "",
    metric.channel || "",
  ]);
}

function overlapBaseKey(metric: Metric) {
  // Currency changes the spend unit, not the identity of traffic observations.
  return JSON.stringify([metric.contentId, metric.revisionId, normalizedUrl(metric.url)]);
}

function overlappingDimensions(a: Metric, b: Metric) {
  const aChannel = a.channel || new URL(a.url).searchParams.get("utm_source") || "";
  const bChannel = b.channel || new URL(b.url).searchParams.get("utm_source") || "";
  return (
    !(a.campaignId && b.campaignId && a.campaignId !== b.campaignId) &&
    !(aChannel && bChannel && aChannel !== bChannel)
  );
}

export function metricIdentity(metric: Metric) {
  const hasStart = present(metric.windowStart),
    hasEnd = present(metric.windowEnd);
  if (hasStart || hasEnd) {
    const start = windowTime(metric.windowStart),
      end = windowTime(metric.windowEnd);
    if (start === null || end === null || start >= end) throw new Error("统计窗口无效");
    return JSON.stringify([
      metricStreamKey(metric),
      "window",
      new Date(start).toISOString(),
      new Date(end).toISOString(),
    ]);
  }
  const date = observationTime(metric.date);
  if (date === null) throw new Error("指标采集时间无效");
  return JSON.stringify([metricStreamKey(metric), "legacy-date", new Date(date).toISOString()]);
}

export function sameMetricTotals(a: Metric, b: Metric) {
  return (
    a.impressions === b.impressions &&
    a.clicks === b.clicks &&
    a.conversions === b.conversions &&
    a.spend === b.spend
  );
}

export type MetricQualityStatus =
  "included" | "duplicate" | "missing-window" | "invalid-window" | "conflict" | "voided";
export type MetricQualityRow = {
  metric: Metric;
  status: MetricQualityStatus;
  issues: string[];
  relatedIds: string[];
};
type WindowRow = { index: number; metric: Metric; start: number; end: number };

export function metricQuality(metrics: Metric[], now = Date.now()) {
  const streams = new Map<string, WindowRow[]>();
  const rows: MetricQualityRow[] = metrics.map((metric, index) => {
    const row: MetricQualityRow = { metric, status: "included", issues: [], relatedIds: [] };
    if (!metric || typeof metric !== "object")
      return { ...row, status: "invalid-window", issues: ["历史指标记录格式无效，不计入汇总"] };
    if (metric.voidedAt)
      return { ...row, status: "voided", issues: ["此记录已撤销，保留历史但不计入汇总"] };
    const hasStart = present(metric.windowStart),
      hasEnd = present(metric.windowEnd);
    if (!hasStart && !hasEnd)
      return {
        ...row,
        status: "missing-window",
        issues: ["未提供统计窗口，无法确认重叠，暂不计入汇总"],
      };
    const start = windowTime(metric.windowStart),
      end = windowTime(metric.windowEnd);
    const observed = observationTime(metric.date);
    if (start === null || end === null || start >= end)
      return {
        ...row,
        status: "invalid-window",
        issues: ["统计窗口需成对填写带时区的 ISO 时间，且开始早于结束"],
      };
    if (!Number.isFinite(now) || observed === null || end > observed || observed > now)
      return {
        ...row,
        status: "invalid-window",
        issues: ["统计结束时间不得晚于数据采集时间，采集时间不得晚于当前时间"],
      };
    if (
      [metric.contentId, metric.revisionId, metric.id].some(
        (value) => typeof value !== "string" || !value.trim(),
      ) ||
      [metric.currency, metric.campaignId, metric.channel].some(
        (value) => value !== undefined && typeof value !== "string",
      ) ||
      ![metric.impressions, metric.clicks, metric.conversions].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      ) ||
      typeof metric.spend !== "number" ||
      !Number.isFinite(metric.spend) ||
      metric.spend < 0
    )
      return { ...row, status: "invalid-window", issues: ["历史指标标识或数值无效，不计入汇总"] };
    try {
      const key = overlapBaseKey(metric);
      const stream = streams.get(key) || [];
      stream.push({ index, metric, start, end });
      streams.set(key, stream);
    } catch {
      return { ...row, status: "invalid-window", issues: ["历史指标链接或维度无效，不计入汇总"] };
    }
    return row;
  });

  function classify(component: WindowRow[]) {
    if (component.length < 2) return;
    const first = component[0];
    const identity = metricIdentity(first.metric);
    const exact = component.every(
      (entry) =>
        metricIdentity(entry.metric) === identity && sameMetricTotals(entry.metric, first.metric),
    );
    const representative = exact
      ? component.reduce((best, entry) => (entry.metric.id < best.metric.id ? entry : best))
      : undefined;
    for (const entry of component) {
      const row = rows[entry.index];
      row.relatedIds = component
        .filter((other) => other.index !== entry.index)
        .map((other) => other.metric.id);
      if (!exact) {
        row.status = "conflict";
        row.issues = [
          "统计窗口重叠、同窗口数值不一致或维度口径未明确；相关整组暂不汇总，请先撤销错误记录再重新录入",
        ];
      } else if (entry !== representative) {
        row.status = "duplicate";
        row.issues = ["窗口和四项指标数值完全相同，作为重复记录排除"];
      }
    }
  }

  for (const stream of streams.values()) {
    const sorted = [...stream].sort((a, b) => a.start - b.start || a.end - b.end);
    const parents = sorted.map((_, index) => index);
    function find(index: number): number {
      while (parents[index] !== index) {
        parents[index] = parents[parents[index]];
        index = parents[index];
      }
      return index;
    }
    for (let i = 0; i < sorted.length; i++) {
      // Equal end/start boundaries are adjacent half-open windows, not overlap.
      for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
        if (overlappingDimensions(sorted[i].metric, sorted[j].metric)) parents[find(j)] = find(i);
      }
    }
    const components = new Map<number, WindowRow[]>();
    sorted.forEach((entry, index) => {
      const key = find(index);
      const component = components.get(key) || [];
      component.push(entry);
      components.set(key, component);
    });
    for (const component of components.values()) classify(component);
  }
  const counts = {
    included: 0,
    duplicate: 0,
    missingWindow: 0,
    invalidWindow: 0,
    conflict: 0,
    voided: 0,
  };
  for (const row of rows) {
    const key =
      row.status === "missing-window"
        ? "missingWindow"
        : row.status === "invalid-window"
          ? "invalidWindow"
          : row.status;
    counts[key]++;
  }
  return {
    rows,
    included: rows.filter((row) => row.status === "included").map((row) => row.metric),
    counts,
  };
}
