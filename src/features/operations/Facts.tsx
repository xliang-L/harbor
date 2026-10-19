import { useState } from "react";
import type { State, Fact } from "../../../server/types";
import type { Act } from "../../shared/types.ts";
import { factStatus } from "../../../server/domain/facts";
export type FactScopeChoice = "" | "brand" | "product";
type FactConditions = { validFrom: string; validUntil: string; attribute: string; value: string };
export const emptyFactConditions = (): FactConditions => ({
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
export const factConditionPayload = (draft: FactConditions) => ({
  validFrom: draft.validFrom ? new Date(draft.validFrom).toISOString() : undefined,
  validUntil: draft.validUntil ? new Date(draft.validUntil).toISOString() : undefined,
  attribute: draft.attribute.trim() || undefined,
  value: draft.value.trim() || undefined,
});
export function FactConditionsFields({
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
export function FactScopeFields({
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

export function FactCard({
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
