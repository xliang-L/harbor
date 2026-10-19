import { useEffect, useState } from "react";
import type { QueueItem, ReviewEvent } from "../server/workflows/console-routes.ts";
type Result = {
  projects: { project: string; brand: string }[];
  rows: QueueItem[];
  identity: string;
  events: (ReviewEvent & { project: string })[];
};
type DraftSaveStart = (element: HTMLElement) => () => void;
const labels = { content: "内容", calendar: "排期", campaign: "活动", promotion: "门店促销" };
function approvalVersion(e: ReviewEvent) {
  if (e.action !== "approved") return "";
  return [
    e.targetVersion !== undefined ? `v${e.targetVersion}` : "",
    e.revisionId ? `修订 ${e.revisionId}` : "",
    e.approvedFingerprint ? `指纹 ${e.approvedFingerprint}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export function Console({ onDraftSaveStart }: { onDraftSaveStart?: DraftSaveStart }) {
  const [data, setData] = useState<Result>();
  const [brand, setBrand] = useState("");
  const [priority, setPriority] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const url = new URL("/api/console", location.origin);
    if (brand) url.searchParams.set("brand", brand);
    if (priority) url.searchParams.set("priority", priority);
    if (due) url.searchParams.set("due", due);
    fetch(url, { signal: abort.signal })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || "队列加载失败");
        setData(body);
        setError("");
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, [brand, priority, due, refresh]);
  return (
    <div className="operations-extension">
      <p>跨品牌待审核队列 · 分配和评论保存在对应品牌，审批仍在原有品牌页面完成。</p>
      <p className="muted">
        {data?.identity || "本地自报姓名，不是认证或安全 RBAC；仅限本机使用。"}
      </p>
      <div className="actions">
        <label>
          品牌{" "}
          <select aria-label="队列品牌" value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">所有品牌</option>
            {data?.projects.map((p) => (
              <option key={p.project} value={p.project}>
                {p.brand} ({p.project})
              </option>
            ))}
          </select>
        </label>
        <label>
          优先级{" "}
          <select
            aria-label="队列优先级"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="">全部</option>
            <option value="high">高</option>
            <option value="normal">普通</option>
            <option value="low">低</option>
          </select>
        </label>
        <label>
          到期{" "}
          <select aria-label="队列到期" value={due} onChange={(e) => setDue(e.target.value)}>
            <option value="">全部</option>
            <option value="overdue">已到期</option>
            <option value="upcoming">未来到期</option>
            <option value="unscheduled">未设日期</option>
          </select>
        </label>
        <button onClick={() => setRefresh((x) => x + 1)}>刷新队列</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>正在加载…</p>}
      {data && <p>当前筛选 {data.rows.length} 项待审核</p>}
      {data?.rows.map((row) => (
        <ReviewCard
          key={`${row.project}:${row.kind}:${row.targetId}:${row.version}`}
          row={row}
          saved={() => setRefresh((x) => x + 1)}
          onDraftSaveStart={onDraftSaveStart}
        />
      ))}
      <details>
        <summary>最近协作事件（最多 100 条；按品牌筛选）</summary>
        {data?.events.length ? (
          data.events.map((e) => (
            <p key={`${e.project}:${e.id}`}>
              {e.at} · {e.project} · {e.actor}（自报）· {labels[e.kind]} {e.targetId} ·{" "}
              <span style={{ overflowWrap: "anywhere" }}>{approvalVersion(e)}</span> ·{" "}
              {e.action === "approved" ? "审批通过" : e.action === "comment" ? "评论" : "分配"}：
              {e.comment || `${e.before.owner || "未分配"} → ${e.after.owner || "未分配"}`} · 优先级{" "}
              {e.after.priority}
            </p>
          ))
        ) : (
          <p>尚无协作事件。原有审批结果以各品牌页面为准。</p>
        )}
      </details>
    </div>
  );
}
function ReviewCard({
  row,
  saved,
  onDraftSaveStart,
}: {
  row: QueueItem;
  saved: () => void;
  onDraftSaveStart?: DraftSaveStart;
}) {
  const [actor, setActor] = useState("");
  const [owner, setOwner] = useState(row.owner);
  const [priority, setPriority] = useState(row.priority);
  const [dueAt, setDueAt] = useState(
    row.dueAt ? new Date(row.dueAt).toISOString().slice(0, 16) : "",
  );
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reviewParams = new URLSearchParams({
    project: row.project,
    page: String(row.page),
    target: row.targetId,
  });
  if (row.kind === "calendar") reviewParams.set("section", "calendar");
  if (row.kind === "campaign") reviewParams.set("section", "campaigns");
  async function save(markSaved?: () => void) {
    setBusy(true);
    setError("");
    try {
      const url = new URL("/api/console/review", location.origin);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Harbor-Project": row.project,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          project: row.project,
          kind: row.kind,
          targetId: row.targetId,
          baseVersion: row.version,
          actor,
          owner,
          priority,
          dueAt: dueAt ? new Date(dueAt + "Z").toISOString() : "",
          comment,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "保存失败");
      markSaved?.();
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="card">
      <h3>
        {row.brand} · {labels[row.kind]} · {row.title}
      </h3>
      <p>{row.reason}</p>
      <p>
        {row.project} · {row.overdue ? "已到期" : row.dueAt ? "计划到期" : "未设日期"}{" "}
        {row.dueAt && new Date(row.dueAt).toLocaleString()} · 负责人：{row.owner || "未分配"}
      </p>
      <a href={`?${reviewParams}`}>打开此品牌{labels[row.kind]}审批页面</a>
      <form
        data-draft-scope={`review:${row.project}:${row.kind}:${row.targetId}`}
        onSubmit={(e) => {
          e.preventDefault();
          const markSaved = onDraftSaveStart?.(e.currentTarget);
          void save(markSaved);
        }}
      >
        <label>
          操作人（自报）
          <input
            required
            maxLength={120}
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        </label>
        <label>
          负责人（自报）
          <input maxLength={120} value={owner} onChange={(e) => setOwner(e.target.value)} />
        </label>
        <label>
          优先级
          <select
            aria-label="分配优先级"
            value={priority}
            onChange={(e) => setPriority(e.target.value as QueueItem["priority"])}
          >
            <option value="high">高</option>
            <option value="normal">普通</option>
            <option value="low">低</option>
          </select>
        </label>
        <label>
          到期时间（UTC）
          <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </label>
        <label>
          评论
          <textarea maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        <button disabled={busy}>{busy ? "保存中…" : "保存分配 / 评论"}</button>
        {error && <p role="alert">{error}</p>}
      </form>
      <details>
        <summary>协作记录（{row.events.length}）</summary>
        {row.events.map((e) => (
          <p key={e.id}>
            {new Date(e.at).toLocaleString()} · {e.actor}（自报）· {e.comment || "更新分配"} ·{" "}
            <span style={{ overflowWrap: "anywhere" }}>{approvalVersion(e)}</span> ·{" "}
            {e.after.owner || "未分配"} / {e.after.priority}
          </p>
        ))}
      </details>
    </article>
  );
}
