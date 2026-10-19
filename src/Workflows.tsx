import React, { useState, useEffect, useRef } from "react";
import type { State, Fact, CalendarEntry, DeliveryReceipt } from "../server/types";
import type { channels } from "../server/domain/channels";
import type { opportunities, recap } from "../server/workflows/insights";
import { factStatus, scheduledFactIssues } from "../server/domain/facts";
type Act = (path: string, body: unknown) => Promise<any>;
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
type FactScopeChoice = "" | "brand" | "product";
type FactConditions = { validFrom: string; validUntil: string; attribute: string; value: string };
const emptyFactConditions = (): FactConditions => ({
  validFrom: "",
  validUntil: "",
  attribute: "",
  value: "",
});
const localDateTime = (value?: string) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
};
const factDateLabel = (value?: string) =>
  !value
    ? "未设置"
    : Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString()
      : "时间格式无效";
const factConditionPayload = (draft: FactConditions) => ({
  validFrom: draft.validFrom ? new Date(draft.validFrom).toISOString() : undefined,
  validUntil: draft.validUntil ? new Date(draft.validUntil).toISOString() : undefined,
  attribute: draft.attribute.trim() || undefined,
  value: draft.value.trim() || undefined,
});
function FactConditionsFields({
  draft,
  change,
  fixedAttribute = false,
}: {
  draft: FactConditions;
  change: (value: Partial<FactConditions>) => void;
  fixedAttribute?: boolean;
}) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "设备本地时区";
  return (
    <fieldset>
      <legend>有效期与可比较属性（选填）</legend>
      <p className="muted">
        时间按设备时区 {timezone} 输入；到截止时刻即失效。留空仅表示未设置，系统不会从正文猜测期限。
      </p>
      <div className="grid">
        <label>
          有效起始
          <input
            aria-label="有效起始"
            type="datetime-local"
            step="0.001"
            value={draft.validFrom}
            onChange={(event) => change({ validFrom: event.target.value })}
          />
        </label>
        <label>
          有效截止
          <input
            aria-label="有效截止"
            type="datetime-local"
            step="0.001"
            min={draft.validFrom || undefined}
            value={draft.validUntil}
            onChange={(event) => change({ validUntil: event.target.value })}
          />
        </label>
      </div>
      <div className="grid">
        <label>
          属性（成对选填）
          <input
            aria-label="属性"
            readOnly={fixedAttribute}
            required={!!draft.value.trim()}
            maxLength={120}
            value={draft.attribute}
            onChange={(event) => change({ attribute: event.target.value })}
            placeholder="例如：容量、认证编号"
          />
        </label>
        <label>
          属性值（成对选填）
          <input
            aria-label="属性值"
            readOnly={fixedAttribute}
            required={!!draft.attribute.trim()}
            maxLength={1000}
            value={draft.value}
            onChange={(event) => change({ value: event.target.value })}
            placeholder="填写来源中的明确值"
          />
        </label>
      </div>
      <p className="muted">
        同一适用范围、相同属性登记不同文字的值，且在同一时点有效时，会提示潜在冲突。这里只比较登记文字，是否矛盾仍需人工核实。
      </p>
      {fixedAttribute && (
        <p className="muted">
          续期保留原证据、事实、适用范围及属性值。需要修改这些内容时，请另外确认新事实并核对旧记录。
        </p>
      )}
    </fieldset>
  );
}
type FactImpact = {
  contents: { id: string; title: string; revisionId: string; number: number }[];
  calendar: { id: string; headline: string }[];
  campaigns: { id: string; name: string }[];
  deliveries: { id: string; calendarId: string; deliveredAt: string }[];
};
function FactScopeFields({
  data,
  value,
  change,
}: {
  data: State;
  value: { scope: FactScopeChoice; productId: string; actor: string };
  change: (value: Partial<{ scope: FactScopeChoice; productId: string; actor: string }>) => void;
}) {
  return (
    <>
      <div className="grid">
        <label>
          适用范围
          <select
            aria-label="适用范围"
            required
            value={value.scope}
            onChange={(event) =>
              change({ scope: event.target.value as FactScopeChoice, productId: "" })
            }
          >
            <option value="">请明确选择适用范围</option>
            <option value="brand">品牌通用</option>
            <option value="product" disabled={!data.products.length}>
              特定商品
            </option>
          </select>
        </label>
        <label>
          确认人（自报）
          <input
            required
            maxLength={120}
            value={value.actor}
            onChange={(event) => change({ actor: event.target.value })}
          />
        </label>
      </div>
      {value.scope === "product" && (
        <label>
          适用商品
          <select
            aria-label="适用商品"
            required
            value={value.productId}
            onChange={(event) => change({ productId: event.target.value })}
          >
            <option value="">选择一件已导入商品</option>
            {data.products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.title} · {product.sku}
              </option>
            ))}
          </select>
        </label>
      )}
      {!data.products.length && (
        <p className="muted">
          需要确认商品规格时，先在「活动与商品」导入商品，再选择特定商品范围。
        </p>
      )}
    </>
  );
}

function FactCard({
  fact,
  data,
  act,
  busy,
  navigate,
}: {
  fact: Fact;
  data: State;
  act: Act;
  busy: boolean;
  navigate?: (page: number, section?: string, target?: string) => void;
}) {
  const [scope, setScope] = useState({
    scope: (fact.scope || "") as FactScopeChoice,
    productId: fact.productId || "",
    actor: "",
    validFrom: localDateTime(fact.validFrom),
    validUntil: localDateTime(fact.validUntil),
    attribute: fact.attribute || "",
    value: fact.value || "",
  });
  const [withdrawal, setWithdrawal] = useState({ actor: "", reason: "" });
  const [impact, setImpact] = useState<FactImpact>();
  const [impactError, setImpactError] = useState("");
  const [loading, setLoading] = useState(false);
  const replacement = data.facts.find(
    (item) => item.reconfirmsFactId === fact.id && !item.withdrawnAt,
  );
  const evidence = data.evidence.find((item) => item.id === fact.evidenceId);
  const product = data.products.find((item) => item.id === fact.productId);
  const status = factStatus(fact, data.facts);
  const conflictFacts = status.conflictIds
    .map((id) => data.facts.find((item) => item.id === id))
    .filter((item): item is Fact => !!item);
  const datesChanged =
    scope.validFrom !== localDateTime(fact.validFrom) ||
    scope.validUntil !== localDateTime(fact.validUntil);
  const loadImpact = async () => {
    if (loading) return;
    setLoading(true);
    setImpactError("");
    try {
      const response = await fetch(`/api/facts/${fact.id}/impact`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setImpact(body);
    } catch (error) {
      setImpactError((error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <article className="card" id={`fact-${fact.id}`}>
      <p className="badge">
        {fact.withdrawnAt
          ? "已撤回"
          : !fact.scope
            ? "历史未归类 · 需要重新确认"
            : fact.scope === "brand"
              ? "品牌通用"
              : `特定商品 · ${product?.title || "商品不可用"}`}
      </p>
      {status.status !== "legacy" && status.status !== "withdrawn" && (
        <p className="badge">
          {
            {
              active: fact.validFrom || fact.validUntil ? "有效期内" : "未设置有效期限制",
              upcoming: "尚未生效",
              expired: "已到期",
              invalid: "事实记录需要修正",
              conflict: "存在潜在冲突",
            }[status.status]
          }
        </p>
      )}
      <h3>{fact.text}</h3>
      <blockquote>{fact.quote}</blockquote>
      <p>
        有效起始：{factDateLabel(fact.validFrom)} · 有效截止：{factDateLabel(fact.validUntil)}
        （不含截止时刻）
      </p>
      {(fact.attribute || fact.value) && (
        <p>
          登记属性：{fact.attribute || "未填写"} · 值：{fact.value || "未填写"}
        </p>
      )}
      {status.issues.length > 0 && (
        <ul>
          {status.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {conflictFacts.length > 0 && (
        <div className="notice error">
          <div>
            以下记录在相同范围、相同属性下登记了不同文字的值，请核对原始证据与适用时点：
            <ul>
              {conflictFacts.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      document
                        .getElementById(`fact-${item.id}`)
                        ?.scrollIntoView({ block: "center" })
                    }
                  >
                    {item.value} · {item.text}
                  </button>
                </li>
              ))}
            </ul>
            <p>
              这是待核实的潜在冲突，不是语义判断。可展开下方影响检查，必要时撤回不再适用的记录。
            </p>
          </div>
        </div>
      )}
      <p>
        {evidence ? (
          <a href={evidence.url} target="_blank" rel="noreferrer">
            {evidence.title} ↗
          </a>
        ) : (
          `证据 ${fact.evidenceId}`
        )}
      </p>
      <small>
        人工确认：{new Date(fact.confirmedAt).toLocaleString()} ·{" "}
        {fact.confirmedBy || "历史记录未登记确认人"}
        {fact.confirmedBy && "（自报）"}
      </small>
      {fact.reconfirmsFactId && (
        <p className="muted">重新确认自历史事实 {fact.reconfirmsFactId}，原记录保留。</p>
      )}
      {fact.withdrawnAt ? (
        <div className="notice error">
          <div>
            已于 {new Date(fact.withdrawnAt).toLocaleString()} 撤回 · {fact.withdrawnBy}（自报）
            <p>原因：{fact.withdrawalReason}</p>
            <p>历史内容与人工交付记录仍保留；此事实不再可用于新生成或审批。</p>
          </div>
        </div>
      ) : (
        <>
          {replacement && (
            <p>
              {fact.scope ? "已新增有效期确认，关联记录：" : "已重新确认，当前记录："}
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  document
                    .getElementById(`fact-${replacement.id}`)
                    ?.scrollIntoView({ block: "center" })
                }
              >
                {replacement.text}
              </button>
              。{fact.scope ? "原记录的有效期与原审批保持不变。" : "此历史记录仍不可用于新生成。"}
            </p>
          )}
          {(fact.scope || !replacement) && (
            <details>
              <summary>
                {fact.scope ? "确认新的有效期，保留旧记录" : "明确适用范围并重新确认"}
              </summary>
              <form
                data-draft-scope={`fact-reconfirm:${fact.id}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void act("facts", {
                    evidenceId: fact.evidenceId,
                    quote: fact.quote,
                    text: fact.text,
                    ...scope,
                    ...factConditionPayload(scope),
                    productId: scope.scope === "product" ? scope.productId : undefined,
                    reconfirmsFactId: fact.id,
                  });
                }}
              >
                <p>
                  核对上面的原文与事实后再确认。本次生成新事实记录，不覆盖历史记录，也不会自动恢复旧内容的审批。
                </p>
                {fact.scope ? (
                  <label>
                    确认人（自报）
                    <input
                      required
                      maxLength={120}
                      value={scope.actor}
                      onChange={(event) => setScope({ ...scope, actor: event.target.value })}
                    />
                  </label>
                ) : (
                  <FactScopeFields
                    data={data}
                    value={scope}
                    change={(value) => setScope({ ...scope, ...value })}
                  />
                )}
                <FactConditionsFields
                  draft={scope}
                  change={(value) => setScope({ ...scope, ...value })}
                  fixedAttribute={!!fact.scope}
                />
                <button className="primary" disabled={busy || (!!fact.scope && !datesChanged)}>
                  {fact.scope ? "保存新的有效期确认" : "重新确认适用范围"}
                </button>
              </form>
            </details>
          )}
          <details
            onToggle={(event) => {
              if (event.currentTarget.open) void loadImpact();
            }}
          >
            <summary>撤回这条事实并检查影响</summary>
            {loading && <p role="status">正在核对引用此事实的内容…</p>}
            {impactError && (
              <p className="notice error" role="alert">
                无法检查影响：{impactError}
                <button type="button" onClick={() => void loadImpact()}>
                  重新检查影响
                </button>
              </p>
            )}
            {impact && (
              <div>
                <p>
                  关联 {impact.contents.length} 个内容版本、{impact.calendar.length} 个排期、
                  {impact.campaigns.length} 个活动、{impact.deliveries.length} 条人工交付记录。
                </p>
                {!!impact.contents.length && (
                  <ul>
                    {impact.contents.map((item) => (
                      <li key={`${item.id}:${item.revisionId}`}>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => navigate?.(2, undefined, item.id)}
                        >
                          {item.title} · V{item.number}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {!!impact.calendar.length && (
                  <ul>
                    {impact.calendar.map((item) => (
                      <li key={item.id}>{item.headline || item.id}</li>
                    ))}
                  </ul>
                )}
                {!!impact.campaigns.length && (
                  <ul>
                    {impact.campaigns.map((item) => (
                      <li key={item.id}>{item.name}</li>
                    ))}
                  </ul>
                )}
                {!!impact.deliveries.length && (
                  <p className="notice error">
                    已有人工交付记录，请检查外部已发布内容。撤回事实不会自动删除帖子、撤销发送或操作外部平台。
                  </p>
                )}
              </div>
            )}
            <form
              data-draft-scope={`fact-withdraw:${fact.id}`}
              onSubmit={(event) => {
                event.preventDefault();
                void act(`facts/${fact.id}/withdraw`, withdrawal);
              }}
            >
              <label>
                撤回人（自报）
                <input
                  required
                  maxLength={120}
                  value={withdrawal.actor}
                  onChange={(event) => setWithdrawal({ ...withdrawal, actor: event.target.value })}
                />
              </label>
              <label>
                撤回理由
                <textarea
                  required
                  minLength={5}
                  maxLength={1000}
                  value={withdrawal.reason}
                  onChange={(event) => setWithdrawal({ ...withdrawal, reason: event.target.value })}
                />
              </label>
              <button className="secondary" disabled={busy || loading || !impact || !!impactError}>
                确认撤回事实，保留历史
              </button>
            </form>
          </details>
        </>
      )}
    </article>
  );
}

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
