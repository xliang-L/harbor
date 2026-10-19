import { promotionCheck } from "../domain/retail.ts";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.ts";
import type { State } from "../types.ts";
import { campaignCheck } from "../domain/campaigns.ts";
import { revisionFactIssues, scheduledFactIssues } from "../domain/facts.ts";

export type ReviewItem = {
  kind: "content" | "calendar" | "campaign" | "promotion";
  targetId: string;
  owner: string;
  priority: "low" | "normal" | "high";
  dueAt: string;
  version: number;
};
export type ReviewEvent = {
  id: string;
  kind: ReviewItem["kind"];
  targetId: string;
  actor: string;
  at: string;
  action: "assignment" | "comment" | "approved";
  revisionId?: string;
  targetVersion?: number;
  approvedFingerprint?: string;
  comment: string;
  before: ReviewItem;
  after: ReviewItem;
  requestKey: string;
  signature: string;
};
export type ReviewState = { reviewItems?: ReviewItem[]; reviewEvents?: ReviewEvent[] };
type ConsoleState = State & ReviewState;
export type QueueItem = ReviewItem & {
  project: string;
  brand: string;
  title: string;
  reason: string;
  page: number;
  overdue: boolean;
  events: ReviewEvent[];
};
function metadata(
  s: ConsoleState,
  kind: ReviewItem["kind"],
  targetId: string,
  dueAt = "",
): ReviewItem {
  return (
    s.reviewItems?.find((x) => x.kind === kind && x.targetId === targetId) || {
      kind,
      targetId,
      dueAt,
      owner: "",
      priority: "normal",
      version: 0,
    }
  );
}
// Invoke only inside the same Store.change transaction after a genuine approval succeeds.
export function recordApproval(
  s: ConsoleState,
  kind: ReviewItem["kind"],
  targetId: string,
  actor = "本机操作者（未认证）",
) {
  const item = metadata(s, kind, targetId);
  const id = randomUUID();
  const revision =
    kind === "content" ? s.contents.find((c) => c.id === targetId)?.revisions.at(-1) : undefined;
  const entry = kind === "calendar" ? s.calendar.find((e) => e.id === targetId) : undefined;
  const campaign = kind === "campaign" ? s.campaigns.find((c) => c.id === targetId) : undefined;
  const promotion =
    kind === "promotion" ? s.retail?.promotions.find((p) => p.id === targetId) : undefined;
  (s.reviewEvents ||= []).push({
    id,
    kind,
    targetId,
    actor: String(actor).trim().slice(0, 120) || "本机操作者（未认证）",
    at: new Date().toISOString(),
    action: "approved",
    comment: "通过原有审批校验并批准；后续数据变化仍可使审批失效",
    revisionId: revision?.id || entry?.revisionId,
    targetVersion: revision?.number ?? campaign?.version ?? promotion?.version,
    approvedFingerprint: campaign?.approvedFingerprint ?? promotion?.approvedFingerprint,
    before: { ...item },
    after: { ...item },
    requestKey: `approval:${id}`,
    signature: "",
  });
}
export function reviewQueue(project: string, s: ConsoleState, now = Date.now()): QueueItem[] {
  const rows: QueueItem[] = [];
  function add(
    kind: ReviewItem["kind"],
    targetId: string,
    title: string,
    reason: string,
    page: number,
    dueAt = "",
  ) {
    const meta = metadata(s, kind, targetId, dueAt);
    rows.push({
      ...meta,
      project,
      brand: s.brand?.name || project,
      title,
      reason,
      page,
      overdue: !!meta.dueAt && Date.parse(meta.dueAt) <= now,
      events: (s.reviewEvents || []).filter((e) => e.kind === kind && e.targetId === targetId),
    });
  }
  const guidelinesAt = s.guidelines?.updatedAt || "";
  for (const c of s.contents) {
    const r = c.revisions.at(-1);
    const issues = r ? revisionFactIssues(s, r, now) : [];
    if (r && (!r.approvedAt || (r.approvalGuidelinesAt || "") !== guidelinesAt || issues.length))
      add(
        "content",
        c.id,
        c.suggestion.title,
        issues.join("；") || `内容 v${r.number} 待审批或规范已更新`,
        2,
      );
  }
  for (const e of s.calendar.filter((x) => !x.archivedAt)) {
    const r = s.contents.find((c) => c.id === e.contentId)?.revisions.at(-1);
    const issues = r ? scheduledFactIssues(s, r, e.scheduledAt, now) : [];
    if (
      !r ||
      r.id !== e.revisionId ||
      !r.approvedAt ||
      (r.approvalGuidelinesAt || "") !== guidelinesAt ||
      !e.approvedAt ||
      (e.approvalGuidelinesAt || "") !== guidelinesAt ||
      issues.length
    )
      add(
        "calendar",
        e.id,
        e.headline || e.channel,
        r?.id !== e.revisionId
          ? "内容版本失效，需重建排期"
          : issues.join("；") || "排期或关联内容待审批",
        4,
        e.scheduledAt,
      );
  }
  for (const c of s.campaigns) {
    const check = campaignCheck(s, c, now);
    if (!check.approved)
      add(
        "campaign",
        c.id,
        c.name,
        check.issues.join("；") || "活动尚未批准或关联数据已变化",
        5,
        c.startsAt,
      );
  }
  for (const p of s.retail?.promotions || []) {
    const check = promotionCheck(s, p);
    if (!check.approved)
      add("promotion", p.id, p.title, check.issues.join("；") || "门店促销待审核", 9, p.startsAt);
  }
  return rows;
}
const short = z.string().trim().min(1).max(120);
const input = z.object({
  project: short,
  kind: z.enum(["content", "calendar", "campaign", "promotion"]),
  targetId: short,
  actor: short,
  baseVersion: z.number().int().nonnegative(),
  owner: z.string().trim().max(120),
  priority: z.enum(["low", "normal", "high"]),
  dueAt: z
    .string()
    .max(50)
    .refine((v) => !v || Number.isFinite(Date.parse(v)), "到期时间无效"),
  comment: z.string().trim().max(2000).default(""),
});
export function consoleRoutes(
  app: Express,
  listStores: () => Array<{ project: string; store: Store }>,
) {
  app.get("/api/console", (req, res) => {
    const stores = listStores();
    const all = stores.flatMap(({ project, store }) => reviewQueue(project, store.read()));
    const rows = all.filter(
      (x) =>
        (!req.query.brand || x.project === req.query.brand) &&
        (!req.query.priority || x.priority === req.query.priority) &&
        (!req.query.owner || x.owner === req.query.owner) &&
        (req.query.due !== "overdue" || x.overdue) &&
        (req.query.due !== "unscheduled" || !x.dueAt) &&
        (req.query.due !== "upcoming" || (!!x.dueAt && !x.overdue)),
    );
    const rank = { high: 0, normal: 1, low: 2 };
    rows.sort(
      (a, b) =>
        rank[a.priority] - rank[b.priority] ||
        (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity),
    );
    res.json({
      projects: stores.map(({ project, store }) => ({
        project,
        brand: store.read().brand?.name || project,
      })),
      rows,
      events: stores
        .flatMap(({ project, store }) =>
          ((store.read() as ConsoleState).reviewEvents || []).map((e) => ({ ...e, project })),
        )
        .filter((e) => !req.query.brand || e.project === req.query.brand)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 100),
      identity: "本地自报姓名，仅用于协作记录；没有认证或安全 RBAC。实际审批请打开对应品牌。",
    });
  });
  app.post("/api/console/review", (req, res) => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "请填写品牌、任务、操作人及有效分配信息" });
    const data = parsed.data;
    if (
      (req.get("X-Harbor-Project") && req.get("X-Harbor-Project") !== data.project) ||
      (req.query.project && req.query.project !== data.project)
    )
      return res.status(400).json({ error: "品牌上下文冲突，未写入" });
    const store = listStores().find((x) => x.project === data.project)?.store;
    if (!store) return res.status(404).json({ error: "品牌不存在" });
    const requestKey = req.get("Idempotency-Key");
    if (!requestKey || requestKey.length > 200)
      return res.status(400).json({ error: "需要独立幂等键" });
    const signature = JSON.stringify(data);
    const previous = (store.read() as ConsoleState).reviewEvents?.find(
      (e) => e.requestKey === requestKey,
    );
    if (previous)
      return previous.signature === signature
        ? res.json({ ok: true, event: previous, duplicate: true })
        : res.status(409).json({ error: "幂等键已用于其他操作" });
    const row = reviewQueue(data.project, store.read()).find(
      (x) => x.kind === data.kind && x.targetId === data.targetId,
    );
    if (!row) return res.status(404).json({ error: "待审核对象不属于该品牌或状态已变化，请刷新" });
    if (row.version !== data.baseVersion)
      return res.status(409).json({ error: "分配记录已更新，请刷新后重试" });
    const event = store.change((state) => {
      const s = state as ConsoleState;
      const before = metadata(s, data.kind, data.targetId, row.dueAt);
      const after: ReviewItem = {
        kind: data.kind,
        targetId: data.targetId,
        owner: data.owner,
        priority: data.priority,
        dueAt: data.dueAt,
        version: before.version + 1,
      };
      s.reviewItems = [
        ...(s.reviewItems || []).filter(
          (x) => x.kind !== data.kind || x.targetId !== data.targetId,
        ),
        after,
      ];
      const event: ReviewEvent = {
        id: randomUUID(),
        kind: data.kind,
        targetId: data.targetId,
        actor: data.actor,
        at: new Date().toISOString(),
        action: data.comment ? "comment" : "assignment",
        comment: data.comment,
        before,
        after,
        requestKey,
        signature,
      };
      (s.reviewEvents ||= []).push(event);
      return event;
    });
    res.json({ ok: true, event });
  });
}
