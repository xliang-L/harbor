import React, { useEffect, useRef, useState } from "react";
import type { State, Campaign, Guidelines } from "../../../server/types";
import type { campaignCheck } from "../../../server/domain/campaigns";
import { channels } from "../../../server/domain/channels";
import {
  DeliveryReceipts,
  DeliveryLoadNotice,
  useDeliveryEntries,
} from "../operations/DeliveryReceipts";
import { scheduledFactIssues } from "../../../server/domain/facts";
type Act = (path: string, body: unknown) => Promise<any>;
type PlanData = {
  onboarding: { label: string; done: boolean; page: number }[];
  campaigns: (Campaign & {
    check: ReturnType<typeof campaignCheck>;
    feedback: {
      samples: number;
      excludedSamples: number;
      observed: number;
      target: number;
      metric: string;
      note: string;
    };
  })[];
  library: {
    contentId: string;
    revisionId: string;
    title: string;
    version: number;
    copy: string;
    approved: boolean;
    renderer: string;
    videoReady: boolean;
    imageReady: boolean;
    issues: string[];
  }[];
  assets: {
    id: string;
    name: string;
    alt: string;
    rights: string;
    url: string;
    demo: boolean;
  }[];
  connectionCheck: {
    network: string;
    model: string;
    ga4: string;
    shopify: string;
    publishing: string;
  };
};
const href = (path: string) =>
  path +
  (path.includes("?") ? "&" : "?") +
  "project=" +
  encodeURIComponent(new URLSearchParams(location.search).get("project") || "default");
function usePlan(data: State) {
  const [plan, setPlan] = useState<PlanData>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const loading = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loading.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (loading.current) return;
    const controller = new AbortController();
    loading.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    void fetch("/api/planning", { signal: controller.signal })
      .then(async (r) => {
        const x = await r.json();
        if (!r.ok) throw new Error(x.error);
        if (mounted.current) {
          setPlan(x);
          setError("");
        }
      })
      .catch((e) => {
        if (mounted.current) setError(e.name === "AbortError" ? "请求超时" : e.message);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (loading.current === controller) loading.current = null;
      });
  }, [data, retry]);
  return { plan, error, retry: () => setRetry((x) => x + 1) };
}
export function StartChecklist({
  data,
  navigate,
}: {
  data: State;
  navigate: (page: number) => void;
}) {
  const { plan, error, retry } = usePlan(data);
  if (error && !plan)
    return (
      <div className="notice error" role="alert">
        起步检查暂不可用：{error}
        <button onClick={retry}>重试起步检查</button>
      </div>
    );
  if (!plan) return null;
  const next = plan.onboarding.filter((x) => !x.done).slice(0, 3);
  return (
    <section className="card getting-started">
      <div className="section-title">
        <h2>{next.length ? "下一步，完成你的营销工作区" : "工作区已准备就绪"}</h2>
        <span>
          {plan.onboarding.filter((x) => x.done).length}/{plan.onboarding.length} 已完成
        </span>
      </div>
      <p>模板草稿、用户导入记录与真实账号数据分别标记。没有接通账号也能完成本地审核和交付。</p>
      <div className="next-steps">
        {next.map((x, i) => (
          <button key={x.label} className="secondary" onClick={() => navigate(x.page)}>
            {i + 1}. {x.label} →
          </button>
        ))}
      </div>
      {!next.length && (
        <button className="secondary" onClick={() => navigate(5)}>
          查看活动与交付检查
        </button>
      )}
    </section>
  );
}
const freshCampaign = () => ({
  name: "",
  objective: "",
  audience: "",
  primaryMetric: "clicks" as const,
  target: 100,
  budget: 0,
  currency: "USD",
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  channels: ["linkedin"],
  productIds: [] as string[],
  assetIds: [] as string[],
  contentIds: [] as string[],
  suggestionId: "",
});
export function Planning({
  data,
  act,
  busy,
  navigate,
  confirmDiscard,
  section,
  target,
}: {
  data: State;
  act: Act;
  busy: boolean;
  navigate: (page: number, section?: string) => void;
  confirmDiscard?: () => boolean;
  section?: string;
  target?: string;
}) {
  const { plan, error, retry } = usePlan(data);
  const [tab, setTab] = useState(() => {
    const value = new URLSearchParams(location.search).get("section") || "brief";
    return ["brief", "products", "campaigns", "library", "connections"].includes(value)
      ? value
      : "brief";
  });
  const [brief, setBrief] = useState<Omit<Guidelines, "updatedAt">>(
    () =>
      data.guidelines || {
        goal: "",
        tone: "",
        valueProposition: "",
        forbiddenClaims: [],
        primaryMetric: "clicks",
        target: 100,
      },
  );
  const [forbidden, setForbidden] = useState(data.guidelines?.forbiddenClaims.join("\n") || "");
  const [imp, setImp] = useState({
    format: "csv",
    text: "",
    sourceName: "",
    sourceUrl: data.brand?.url || "",
    currency: "USD",
    demo: false,
  });
  const [preview, setPreview] = useState<any>();
  const [fileError, setFileError] = useState("");
  const [draft, setDraft] = useState(freshCampaign);
  const [editing, setEditing] = useState<{ id: string; version: number }>();
  const [selected, setSelected] = useState(
    () => new URLSearchParams(location.search).get("target") || "",
  );
  const [entry, setEntry] = useState({
    contentId: "",
    channel: "linkedin",
    account: "",
    scheduledAt: "",
    headline: "",
    copy: "",
    targetUrl: data.brand?.url || "",
  });
  const [asset, setAsset] = useState({
    name: "",
    alt: "",
    rights: "",
    image: "",
    demo: false,
  });
  const [assetError, setAssetError] = useState("");
  const delivery = useDeliveryEntries(data, tab === "campaigns");
  const scrolledTarget = useRef("");
  useEffect(() => {
    if (section && ["brief", "products", "campaigns", "library", "connections"].includes(section))
      setTab(section);
  }, [section]);
  useEffect(() => {
    if (target) setSelected(target);
  }, [target]);
  useEffect(() => {
    if (!plan || !target || tab !== "campaigns" || scrolledTarget.current === target) return;
    const card = document.getElementById(`campaign-${target}`);
    if (card) {
      card.scrollIntoView({ block: "center" });
      scrolledTarget.current = target;
    }
  }, [plan, target, tab]);
  const errorNotice = error && (
    <div className="notice error" role="alert">
      活动信息暂时无法更新：{error}。{plan && "保留上次数据与当前输入。"}
      <button onClick={retry}>重试活动信息</button>
    </div>
  );
  if (!plan) return errorNotice || <p>正在检查当前品牌的活动与素材…</p>;
  const field = (label: string, value: string, change: (v: string) => void, type = "text") => (
    <label>
      {label}
      <input required type={type} value={value} onChange={(e) => change(e.target.value)} />
    </label>
  );
  const toggle = (key: "channels" | "productIds" | "assetIds" | "contentIds", id: string) =>
    setDraft({
      ...draft,
      [key]: draft[key].includes(id) ? draft[key].filter((x) => x !== id) : [...draft[key], id],
    });
  const current = plan.campaigns.find((c) => c.id === selected);
  return (
    <>
      {errorNotice}
      <div className="tabs">
        {[
          ["brief", "目标与规范"],
          ["products", "商品导入"],
          ["campaigns", "活动计划"],
          ["library", "素材库"],
          ["connections", "连接检查"],
        ].map(([id, label]) => (
          <button
            className={tab === id ? "selected" : ""}
            key={id}
            onClick={() => {
              setTab(id);
              navigate(5, id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "brief" && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void act("guidelines", {
              ...brief,
              forbiddenClaims: forbidden
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean),
            });
          }}
        >
          <h2>先定义这轮营销要达成什么</h2>
          <p>
            目标用于活动规划；品牌规范传入模型，并在服务端拦截禁用表述。修改规范后需要重新批准相关内容与交付计划。
          </p>
          {field("营销目标", brief.goal, (v) => setBrief({ ...brief, goal: v }))}
          {field("品牌语气", brief.tone, (v) => setBrief({ ...brief, tone: v }))}
          <label>
            品牌定位与价值主张
            <textarea
              required
              value={brief.valueProposition}
              onChange={(e) => setBrief({ ...brief, valueProposition: e.target.value })}
            />
          </label>
          <label>
            禁用表述（每行一个，最多30项）
            <textarea
              value={forbidden}
              onChange={(e) => setForbidden(e.target.value)}
              placeholder={"例如：100% guaranteed\n治愈"}
            />
          </label>
          <div className="grid">
            <label>
              主要衡量指标
              <select
                value={brief.primaryMetric}
                onChange={(e) =>
                  setBrief({
                    ...brief,
                    primaryMetric: e.target.value as Guidelines["primaryMetric"],
                  })
                }
              >
                <option value="impressions">曝光</option>
                <option value="clicks">点击</option>
                <option value="conversions">转化</option>
              </select>
            </label>
            <label>
              目标数值（计划，不是已发生效果）
              <input
                required
                type="number"
                min="1"
                value={brief.target}
                onChange={(e) => setBrief({ ...brief, target: Number(e.target.value) })}
              />
            </label>
          </div>
          <button className="primary" disabled={busy}>
            保存目标与品牌规范
          </button>
        </form>
      )}
      {tab === "products" && (
        <>
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault();
              setPreview(await act("products/preview", imp));
            }}
          >
            <h2>导入商品，保留可核对的来源</h2>
            <p>
              支持本地文件。Shopify 为商家导出的 CSV，不是已连接 Shopify
              API；不会读取订单、顾客或自动加载远程图片。
            </p>
            <label>
              商品数据格式
              <select
                value={imp.format}
                onChange={(e) => {
                  setImp({ ...imp, format: e.target.value });
                  setPreview(undefined);
                }}
              >
                <option value="csv">Harbor 标准 CSV</option>
                <option value="json">标准 JSON 数组</option>
                <option value="shopify-csv">Shopify 商品导出 CSV</option>
              </select>
            </label>
            <p className="muted">
              标准字段：sku,title,description,price,currency,url。Shopify 支持 Handle、Title、Body
              (HTML)、Variant SKU、Variant Price；必须有 SKU，最多100行。
            </p>
            <label>
              选择商品文件
              <input
                type="file"
                accept=".csv,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 300000) {
                    setFileError("文件超过300KB，请拆分导入");
                    return;
                  }
                  setFileError("");
                  void f.text().then((text) => {
                    setImp((previous) => ({
                      ...previous,
                      text,
                      sourceName: f.name,
                    }));
                    setPreview(undefined);
                  });
                }}
              />
            </label>
            <div className="grid">
              {field("导入来源名称", imp.sourceName, (v) => {
                setImp({ ...imp, sourceName: v });
                setPreview(undefined);
              })}
              {field(
                "商店或来源网址",
                imp.sourceUrl,
                (v) => {
                  setImp({ ...imp, sourceUrl: v });
                  setPreview(undefined);
                },
                "url",
              )}
            </div>
            {field("商品币种", imp.currency, (v) => {
              setImp({ ...imp, currency: v.toUpperCase() });
              setPreview(undefined);
            })}
            <label>
              商品原始数据
              <textarea
                required
                value={imp.text}
                onChange={(e) => {
                  setImp({ ...imp, text: e.target.value });
                  setPreview(undefined);
                }}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={imp.demo}
                onChange={(e) => {
                  setImp({ ...imp, demo: e.target.checked });
                  setPreview(undefined);
                }}
              />
              这是演示商品，不是真实库存或效果
            </label>
            {fileError && <p className="notice error">{fileError}</p>}
            <button className="primary" disabled={busy}>
              预览商品导入
            </button>
            {preview?.rows && (
              <div className="card">
                <h3>导入预览：不会覆盖同 SKU 的现有商品</h3>
                {preview.rows.map((r: any) => (
                  <p key={r.row}>
                    行 {r.row} ·{" "}
                    {!r.valid
                      ? r.error
                      : r.skipped
                        ? r.note
                        : r.duplicate
                          ? "重复SKU，跳过"
                          : `${r.product.sku} · ${r.product.title} · ${r.product.price} ${r.product.currency}`}
                  </p>
                ))}
                {preview.rows.every((r: any) => r.valid) && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={async () => {
                      const r = await act("products/import", imp);
                      if (r) setPreview(undefined);
                    }}
                  >
                    确认导入商品
                  </button>
                )}
              </div>
            )}
          </form>
          {data.products.map((p) => (
            <article className="card" key={p.id}>
              <h3>
                {p.demo ? "[演示] " : ""}
                {p.title}
              </h3>
              <p>
                {p.sku} · {p.price} {p.currency}
              </p>
              <p>{p.description}</p>
              <a href={p.url} rel="noreferrer" target="_blank">
                来源页面
              </a>
              <p className="muted">
                来源文件：{p.sourceName} · 证据 {p.evidenceId} · 用户导入，未独立核实
              </p>
              <button
                disabled={busy || !data.brand}
                className="secondary"
                onClick={() => act(`products/${p.id}/use`, {})}
              >
                用于当前品牌内容生成
              </button>
              <button className="secondary" onClick={() => navigate(4)}>
                前往引用与事实确认 →
              </button>
            </article>
          ))}
        </>
      )}
      {tab === "campaigns" && (
        <>
          <DeliveryLoadNotice delivery={delivery} />
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault();
              const payload = {
                ...draft,
                suggestionId: draft.suggestionId || undefined,
                ...(editing ? { baseVersion: editing.version } : {}),
              };
              const out = await act(
                editing ? `campaigns/${editing.id}/revise` : "campaigns",
                payload,
              );
              if (out) {
                setSelected(editing?.id || out.id);
                setEditing(undefined);
              }
            }}
          >
            <h2>{editing ? "修订活动计划" : "从一个机会建立活动计划"}</h2>
            <p>
              预算仅为计划，保存或审批都不会发生广告费用。将同一目标下的商品、内容、素材和渠道组成可审核交付包。
            </p>
            <div className="grid">
              {field("活动名称", draft.name, (v) => setDraft({ ...draft, name: v }))}
              {field("目标受众", draft.audience, (v) => setDraft({ ...draft, audience: v }))}
            </div>
            {field("活动目标与推荐理由", draft.objective, (v) =>
              setDraft({ ...draft, objective: v }),
            )}
            <label>
              关联机会（可选）
              <select
                value={draft.suggestionId}
                onChange={(e) => {
                  const x = data.suggestions.find((s) => s.id === e.target.value);
                  setDraft({
                    ...draft,
                    suggestionId: e.target.value,
                    objective: x?.reason || draft.objective,
                    audience: data.brand?.audience || draft.audience,
                  });
                }}
              >
                <option value="">自行规划</option>
                {data.suggestions.slice(0, 3).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid">
              <label>
                活动指标
                <select
                  value={draft.primaryMetric}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      primaryMetric: e.target.value as typeof draft.primaryMetric,
                    })
                  }
                >
                  <option value="clicks">点击</option>
                  <option value="impressions">曝光</option>
                  <option value="conversions">转化</option>
                </select>
              </label>
              <label>
                活动目标数值
                <input
                  required
                  type="number"
                  min="1"
                  value={draft.target}
                  onChange={(e) => setDraft({ ...draft, target: Number(e.target.value) })}
                />
              </label>
              <label>
                计划预算
                <input
                  required
                  type="number"
                  min="0"
                  value={draft.budget}
                  onChange={(e) => setDraft({ ...draft, budget: Number(e.target.value) })}
                />
              </label>
              {field("计划币种", draft.currency, (v) =>
                setDraft({ ...draft, currency: v.toUpperCase() }),
              )}
            </div>
            <div className="grid">
              {field(
                "活动开始日期",
                draft.startsAt.slice(0, 10),
                (v) => setDraft({ ...draft, startsAt: v + "T00:00:00.000Z" }),
                "date",
              )}
              {field(
                "活动结束日期",
                draft.endsAt.slice(0, 10),
                (v) => setDraft({ ...draft, endsAt: v + "T23:59:59.999Z" }),
                "date",
              )}
            </div>
            <p className="muted">活动日期按 UTC 保存；渠道具体排期按浏览器本地时间填写。</p>
            <fieldset>
              <legend>计划渠道</legend>
              {channels.map((c) => (
                <label className="check" key={c.id}>
                  <input
                    type="checkbox"
                    checked={draft.channels.includes(c.id)}
                    onChange={() => toggle("channels", c.id)}
                  />
                  {c.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>关联内容（先在内容工作台生成）</legend>
              {data.contents.length ? (
                data.contents.map((c) => (
                  <label className="check" key={c.id}>
                    <input
                      type="checkbox"
                      checked={draft.contentIds.includes(c.id)}
                      onChange={() => toggle("contentIds", c.id)}
                    />
                    {c.suggestion.title} · v{c.revisions.at(-1)?.number}
                  </label>
                ))
              ) : (
                <button type="button" className="secondary" onClick={() => navigate(1)}>
                  前往市场动态生成内容 →
                </button>
              )}
            </fieldset>
            <fieldset>
              <legend>关联商品与图片</legend>
              {data.products.map((p) => (
                <label className="check" key={p.id}>
                  <input
                    type="checkbox"
                    checked={draft.productIds.includes(p.id)}
                    onChange={() => toggle("productIds", p.id)}
                  />
                  商品：{p.title}
                </label>
              ))}
              {data.assets.map((a) => (
                <label className="check" key={a.id}>
                  <input
                    type="checkbox"
                    checked={draft.assetIds.includes(a.id)}
                    onChange={() => toggle("assetIds", a.id)}
                  />
                  图片：{a.name}
                </label>
              ))}
            </fieldset>
            <button className="primary" disabled={busy}>
              {editing ? "保存活动新修订" : "创建活动计划"}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  if (confirmDiscard && !confirmDiscard()) return;
                  setEditing(undefined);
                  setDraft(freshCampaign());
                }}
              >
                取消修订
              </button>
            )}
          </form>
          <div className="campaign-grid">
            {plan.campaigns.map((c) => (
              <article className="card" id={`campaign-${c.id}`} key={c.id}>
                <h3>
                  {c.name} · 计划 v{c.version}
                </h3>
                <p>{c.objective}</p>
                <p>
                  预算 {c.budget} {c.currency}（未花费） · 目标 {c.target} {c.primaryMetric}
                </p>
                <p>
                  {c.check.approved
                    ? "当前交付已批准"
                    : c.approvedAt
                      ? "审批已失效，关联资料发生变化"
                      : "待审核"}
                </p>
                {c.check.issues.length ? (
                  <ul>
                    {c.check.issues.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ) : (
                  <p>交付检查通过，可人工批准。</p>
                )}
                <div className="actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      if (confirmDiscard && !confirmDiscard()) return;
                      setSelected(c.id);
                      setEntry({ ...entry, channel: c.channels[0] });
                    }}
                  >
                    安排渠道交付
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      if (confirmDiscard && !confirmDiscard()) return;
                      setEditing({ id: c.id, version: c.version });
                      setDraft({
                        ...c,
                        suggestionId: c.suggestionId || "",
                        primaryMetric: c.primaryMetric as typeof draft.primaryMetric,
                      });
                    }}
                  >
                    修订计划
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !c.check.ready || c.check.approved}
                    onClick={() =>
                      act(`campaigns/${c.id}/approve`, {
                        baseVersion: c.version,
                      })
                    }
                  >
                    批准活动交付
                  </button>
                  {c.check.approved && (
                    <a href={href(`/api/campaigns/${c.id}/export`)}>下载活动交付包</a>
                  )}
                </div>
                <p>
                  {c.feedback.samples ? `已计入观察值 ${c.feedback.observed}` : "暂无可汇总观察值"}{" "}
                  / 计划目标 {c.feedback.target} · {c.feedback.samples} 条记录
                </p>
                {(c.feedback.excludedSamples || 0) > 0 && (
                  <p className="notice error">
                    关联内容中有 {c.feedback.excludedSamples}{" "}
                    条原始指标未计入汇总，请在效果记录中核对统计窗口、重复和撤销状态。
                  </p>
                )}
                <small>{c.feedback.note}</small>
              </article>
            ))}
          </div>
          {current && (
            <form
              className="card"
              onSubmit={(e) => {
                e.preventDefault();
                const r = data.contents.find((c) => c.id === entry.contentId)?.revisions.at(-1);
                if (r)
                  void act("calendar", {
                    ...entry,
                    revisionId: r.id,
                    scheduledAt: new Date(entry.scheduledAt).toISOString(),
                    campaign: current.name,
                    campaignId: current.id,
                  });
              }}
            >
              <h2>{current.name} · 新建渠道版本</h2>
              <label>
                活动内容
                <select
                  aria-label="活动内容"
                  required
                  value={entry.contentId}
                  onChange={(e) => {
                    const c = data.contents.find((c) => c.id === e.target.value);
                    const r = c?.revisions.at(-1);
                    setEntry({
                      ...entry,
                      contentId: e.target.value,
                      copy: r?.copy || "",
                      headline: c?.suggestion.title || "",
                      targetUrl: r?.brand.url || "",
                    });
                  }}
                >
                  <option value="">选择内容</option>
                  {data.contents
                    .filter((c) => current.contentIds.includes(c.id))
                    .map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.suggestion.title} · v{c.revisions.at(-1)?.number}
                      </option>
                    ))}
                </select>
              </label>
              <div className="grid">
                <label>
                  活动渠道
                  <select
                    value={entry.channel}
                    onChange={(e) => setEntry({ ...entry, channel: e.target.value })}
                  >
                    {channels
                      .filter((c) => current.channels.includes(c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
                {field("交付账号", entry.account, (v) => setEntry({ ...entry, account: v }))}
              </div>
              {field("渠道版本标题", entry.headline, (v) => setEntry({ ...entry, headline: v }))}
              <label>
                渠道版本文案
                <textarea
                  required
                  value={entry.copy}
                  onChange={(e) => setEntry({ ...entry, copy: e.target.value })}
                />
              </label>
              <p>
                {Array.from(entry.copy).length}/{channels.find((c) => c.id === entry.channel)?.max}{" "}
                字符 · {channels.find((c) => c.id === entry.channel)?.note}
              </p>
              {field(
                "交付时间",
                entry.scheduledAt,
                (v) => setEntry({ ...entry, scheduledAt: v }),
                "datetime-local",
              )}
              {field(
                "交付落地页",
                entry.targetUrl,
                (v) => setEntry({ ...entry, targetUrl: v }),
                "url",
              )}
              <button className="primary" disabled={busy}>
                保存活动渠道版本
              </button>
            </form>
          )}
          {data.calendar
            .filter((e) => e.campaignId)
            .map((e) => {
              const revision = data.contents
                .find((content) => content.id === e.contentId)
                ?.revisions.find((item) => item.id === e.revisionId);
              const factIssues = revision
                ? scheduledFactIssues(data, revision, e.scheduledAt)
                : ["内容版本不存在"];
              return (
                <div className="card" key={e.id}>
                  <h3>
                    {e.campaign} · {e.channel} · {e.account}
                  </h3>
                  <p>{e.headline}</p>
                  <p>{e.copy}</p>
                  {factIssues.length > 0 && (
                    <ul>
                      {factIssues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  <p>
                    {e.archivedAt
                      ? "已归档，不进入活动交付检查"
                      : e.approvedAt
                        ? "渠道已批准；以活动检查结果为准"
                        : "渠道待审批"}
                  </p>
                  {!e.archivedAt && (
                    <button
                      className="secondary"
                      disabled={busy || factIssues.length > 0}
                      onClick={() => act(`calendar/${e.id}/approve`, {})}
                    >
                      批准此渠道版本
                    </button>
                  )}
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => act(`calendar/${e.id}/archive`, { restore: !!e.archivedAt })}
                  >
                    {e.archivedAt ? "恢复排期" : "归档此排期（可恢复）"}
                  </button>
                  <DeliveryReceipts
                    entry={e}
                    availability={delivery.entries?.find((item) => item.calendarId === e.id)}
                    act={act}
                    busy={busy}
                  />
                </div>
              );
            })}
        </>
      )}
      {tab === "library" && (
        <>
          <form
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              void act("assets", asset);
            }}
          >
            <h2>上传可复用图片素材</h2>
            <p>PNG/JPEG/WebP，每张2MB，每品牌最多50张。登记来源/使用权，不自动下载远程商品图片。</p>
            <label>
              图片文件
              <input
                required
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 2000000) {
                    setAssetError("图片超过2MB");
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => {
                    setAsset((previous) => ({
                      ...previous,
                      image: String(reader.result),
                      name: f.name,
                    }));
                    setAssetError("");
                  };
                  reader.readAsDataURL(f);
                }}
              />
            </label>
            {field("素材名称", asset.name, (v) => setAsset({ ...asset, name: v }))}
            {field("图片描述", asset.alt, (v) => setAsset({ ...asset, alt: v }))}
            {field("来源与使用权说明", asset.rights, (v) => setAsset({ ...asset, rights: v }))}
            <label className="check">
              <input
                type="checkbox"
                checked={asset.demo}
                onChange={(e) => setAsset({ ...asset, demo: e.target.checked })}
              />
              演示素材
            </label>
            {assetError && <p className="notice error">{assetError}</p>}
            <button className="primary" disabled={busy || !asset.image}>
              保存素材
            </button>
          </form>
          <div className="asset-grid">
            {plan.assets.map((a) => (
              <article className="card" key={a.id}>
                <img src={href(a.url)} alt={a.alt} />
                <h3>
                  {a.demo ? "[演示] " : ""}
                  {a.name}
                </h3>
                <p>{a.rights}</p>
                <button
                  className="secondary"
                  disabled={busy || !data.brand}
                  onClick={() => act(`assets/${a.id}/use`, {})}
                >
                  用作品牌产品图
                </button>
              </article>
            ))}
          </div>
          <h2>当前文案与已有视频</h2>
          {plan.library.map((r) => (
            <article className="card" key={r.contentId}>
              <h3>
                {r.title} · v{r.version}
              </h3>
              <p>
                {r.approved ? "已批准（导出时再次校验）" : "待审核"} ·{" "}
                {r.videoReady
                  ? `${r.renderer} 视频可预览`
                  : "视频尚未生成或文件缺失，可去内容工作台重试"}
              </p>
              <p>{r.copy}</p>
              {r.issues.map((x) => (
                <p className="notice error" key={x}>
                  {x}
                </p>
              ))}
              {r.videoReady && (
                <video
                  controls
                  preload="metadata"
                  src={href(`/api/contents/${r.contentId}/${r.revisionId}/video-preview`)}
                  aria-label={`${r.title} 视频素材`}
                />
              )}
              <button className="secondary" onClick={() => navigate(2)}>
                前往编辑与版本审核 →
              </button>
            </article>
          ))}
        </>
      )}
      {tab === "connections" && (
        <div className="card">
          <h2>连接前检查：未执行外部请求</h2>
          <p>当前只检查本项目环境配置，不验证账号权限或计费。配置存在不等于已连接。</p>
          <dl>
            <dt>模型</dt>
            <dd>{plan.connectionCheck.model}</dd>
            <dt>GA4</dt>
            <dd>{plan.connectionCheck.ga4}</dd>
            <dt>Shopify</dt>
            <dd>仅商品导出文件导入，无账号连接、无订单/顾客权限</dd>
            <dt>网络</dt>
            <dd>{plan.connectionCheck.network}</dd>
            <dt>发布</dt>
            <dd>关闭；所有按钮均为本地草稿、批准或下载</dd>
          </dl>
          <p>
            最小后续接入：用户明确授权一个模型端点用于本项目，或提供已授权的 GA4
            只读配置。模型会接收品牌及证据；GA4仅返回报表。不要把密钥填进商品/品牌表单。
          </p>
          <button className="secondary" onClick={() => navigate(4)}>
            查看现有连接器与手动报表 →
          </button>
        </div>
      )}
    </>
  );
}
