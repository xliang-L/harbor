import { useState, useEffect, useRef } from "react";
import type { State, CalendarEntry, DeliveryReceipt } from "../../../server/types";
import type { Act } from "../../shared/types.ts";
type DeliveryAvailability = {
  calendarId: string;
  canRecord: boolean;
  issues: string[];
  receipts: (DeliveryReceipt & { factIssues: string[] })[];
};
export function useDeliveryEntries(data: State, enabled: boolean) {
  const [entries, setEntries] = useState<DeliveryAvailability[]>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!enabled) {
      request.current?.abort();
      request.current = null;
      return;
    }
    if (request.current) return;
    const abort = new AbortController();
    request.current = abort;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, 10000);
    void fetch("/api/deliveries", { signal: abort.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (!Array.isArray(body.entries)) throw new Error("交付记录格式不完整");
        if (!abort.signal.aborted) {
          setEntries(body.entries);
          setError("");
        }
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted || timedOut) setError(timedOut ? "请求超时" : error.message);
      })
      .finally(() => {
        clearTimeout(timer);
        if (request.current === abort) request.current = null;
      });
  }, [data, enabled, retry]);
  return { entries, error, retry: () => setRetry((value) => value + 1) };
}
export function DeliveryLoadNotice({
  delivery,
}: {
  delivery: ReturnType<typeof useDeliveryEntries>;
}) {
  return delivery.error ? (
    <p className="notice error" role="alert">
      交付记录暂时无法更新：{delivery.error}。{delivery.entries && "下方保留上次记录。"}
      <button type="button" onClick={delivery.retry}>
        重试交付记录
      </button>
    </p>
  ) : null;
}
export function DeliveryReceipts({
  entry,
  availability,
  act,
  busy,
}: {
  entry: CalendarEntry;
  availability?: DeliveryAvailability;
  act: Act;
  busy: boolean;
}) {
  const [draft, setDraft] = useState({
    deliveredAt: "",
    destinationUrl: "",
    externalId: "",
    actor: "",
    notes: "",
  });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "设备本地时区";
  return (
    <section aria-label={`交付记录：${entry.account}`}>
      <h4>人工交付记录</h4>
      <p className="muted">
        排期 {new Date(entry.scheduledAt).toLocaleString()} · {entry.channel} / {entry.account} ·
        内容修订 {entry.revisionId}
      </p>
      <p>用于记录人工已经完成的发布或交付。Harbor 不会执行发布，也未通过平台核验这些记录。</p>
      {!availability ? (
        <p>
          {entry.archivedAt
            ? "此排期已归档，没有人工交付记录。"
            : "正在检查这项排期的交付资格与记录…"}
        </p>
      ) : (
        <>
          {!availability.canRecord && availability.issues.length > 0 && (
            <ul>
              {availability.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          {availability.canRecord && (
            <details>
              <summary>记录已完成的人工交付</summary>
              <form
                data-draft-scope={`delivery-new:${entry.id}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(`calendar/${entry.id}/deliveries`, {
                    ...draft,
                    revisionId: entry.revisionId,
                    deliveredAt: new Date(draft.deliveredAt).toISOString(),
                  });
                }}
              >
                <p>此记录绑定上面的具体排期、内容修订、渠道与账号。</p>
                <div className="grid">
                  <label>
                    实际发生时间（{timezone}）
                    <input
                      aria-label="实际发生时间"
                      required
                      type="datetime-local"
                      step="0.001"
                      value={draft.deliveredAt}
                      onChange={(event) => setDraft({ ...draft, deliveredAt: event.target.value })}
                    />
                  </label>
                  <label>
                    记录人（自报）
                    <input
                      required
                      maxLength={120}
                      value={draft.actor}
                      onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="secondary"
                  data-draft-change
                  onClick={() => {
                    const now = new Date();
                    setDraft({
                      ...draft,
                      deliveredAt: new Date(now.getTime() - now.getTimezoneOffset() * 60000)
                        .toISOString()
                        .slice(0, 23),
                    });
                  }}
                >
                  填入当前时间
                </button>
                <label>
                  外部发布或交付链接
                  <input
                    type="url"
                    required={!draft.externalId.trim()}
                    placeholder="https://…"
                    value={draft.destinationUrl}
                    onChange={(event) => setDraft({ ...draft, destinationUrl: event.target.value })}
                  />
                </label>
                <label>
                  外部凭证编号
                  <input
                    required={!draft.destinationUrl.trim()}
                    maxLength={300}
                    placeholder="发布记录、发送回执或其他可追查凭证的编号"
                    value={draft.externalId}
                    onChange={(event) => setDraft({ ...draft, externalId: event.target.value })}
                  />
                </label>
                <p className="muted">链接与凭证编号至少填写一项；请提供实际发生后的证据。</p>
                <p className="muted">
                  发生时间必须在内容和渠道审批之后，且不能是未来时间。可精确填写到秒。
                </p>
                <label>
                  交付备注
                  <textarea
                    maxLength={2000}
                    value={draft.notes}
                    onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                  />
                </label>
                <button className="primary" disabled={busy}>
                  保存人工交付记录
                </button>
              </form>
            </details>
          )}
          {!availability.receipts.length && (
            <p className="muted">尚无人工交付记录；已批准计划或已下载交付包都不代表已发布。</p>
          )}
          {availability.receipts.map((receipt) => (
            <ReceiptCard key={receipt.id} receipt={receipt} act={act} busy={busy} />
          ))}
        </>
      )}
    </section>
  );
}
function ReceiptCard({
  receipt,
  act,
  busy,
}: {
  receipt: DeliveryReceipt & { factIssues: string[] };
  act: Act;
  busy: boolean;
}) {
  const [voiding, setVoiding] = useState({ actor: "", reason: "" });
  return (
    <article>
      <p className="badge">
        {receipt.voidedAt ? "已撤销的人工记录" : "人工交付已记录 · 平台未验证"}
      </p>
      <p>
        实际发生：{new Date(receipt.deliveredAt).toLocaleString()} · {receipt.channel} /{" "}
        {receipt.account}
      </p>
      <p>
        记录：{receipt.actor}（自报）· {new Date(receipt.recordedAt).toLocaleString()}
      </p>
      {receipt.destinationUrl && (
        <p>
          <a href={receipt.destinationUrl} target="_blank" rel="noreferrer">
            查看外部链接 ↗
          </a>
        </p>
      )}
      {receipt.externalId && <p>凭证编号：{receipt.externalId}</p>}
      {receipt.notes && <p>备注：{receipt.notes}</p>}
      <p>
        <a
          href={`/api/deliveries/${receipt.id}/export?project=${encodeURIComponent(new URLSearchParams(location.search).get("project") || "default")}`}
        >
          下载人工交付记录 JSON
        </a>
      </p>
      {receipt.factIssues.length > 0 && (
        <div className="notice error">
          <div>
            关联事实需要复核，已发生的交付仍保留：
            <ul>
              {receipt.factIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <details>
        <summary>查看交付时的渠道文案</summary>
        <strong>{receipt.snapshot.headline}</strong>
        <p style={{ whiteSpace: "pre-wrap" }}>{receipt.snapshot.copy}</p>
        <small>
          内容修订 {receipt.revisionId} · 内容批准于{" "}
          {new Date(receipt.contentApprovedAt).toLocaleString()}
        </small>
      </details>
      {receipt.voidedAt ? (
        <p>
          撤销人：{receipt.voidedBy}（自报）· {new Date(receipt.voidedAt).toLocaleString()}
          <br />
          撤销原因：{receipt.voidReason}。历史记录保留，未操作外部平台。
        </p>
      ) : (
        <details>
          <summary>撤销这条人工记录</summary>
          <form
            data-draft-scope={`delivery-void:${receipt.id}`}
            onSubmit={(event) => {
              event.preventDefault();
              void act(`deliveries/${receipt.id}/void`, voiding);
            }}
          >
            <p>只撤销 Harbor 中的记录，不会删除外部帖子或撤回已发送内容。</p>
            <label>
              撤销人（自报）
              <input
                required
                maxLength={120}
                value={voiding.actor}
                onChange={(event) => setVoiding({ ...voiding, actor: event.target.value })}
              />
            </label>
            <label>
              撤销原因
              <textarea
                required
                maxLength={2000}
                value={voiding.reason}
                onChange={(event) => setVoiding({ ...voiding, reason: event.target.value })}
              />
            </label>
            <button className="secondary" disabled={busy}>
              确认撤销记录，保留历史
            </button>
          </form>
        </details>
      )}
    </article>
  );
}
