import React, { useEffect, useState } from "react";
import type { State } from "../../../server/types";
import type {
  Retail as RetailState,
  Promotion,
  retailInsights,
  retailSummary,
  promotionCheck,
} from "../../../server/domain/retail";
type Act = (path: string, body: unknown) => Promise<any>;
type View = Omit<RetailState, "promotions"> & {
  insights: ReturnType<typeof retailInsights>;
  summary: ReturnType<typeof retailSummary>;
  promotions: (Promotion & { check: ReturnType<typeof promotionCheck> })[];
  note: string;
};
const inputFields = {
  inventory: ["storeId", "sku", "asOf", "quantity"],
  sales: [
    "externalId",
    "storeId",
    "sku",
    "date",
    "quantity",
    "revenue",
    "currency",
    "kind",
    "originalId",
    "campaignId",
    "channel",
  ],
};
function Form({
  children,
  label,
  busy,
  save,
}: {
  children: React.ReactNode;
  label: string;
  busy: boolean;
  save: (x: Record<string, string>) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>);
      }}
    >
      {children}
      <button disabled={busy}>{label}</button>
    </form>
  );
}
export function Retail({ data, act, busy }: { data: State; act: Act; busy: boolean }) {
  const [view, setView] = useState<View>(),
    [error, setError] = useState(""),
    [kind, setKind] = useState<"inventory" | "sales">("inventory"),
    [csv, setCsv] = useState(""),
    [sourceName, setSource] = useState("local-export"),
    [demo, setDemo] = useState(false),
    [mapping, setMapping] = useState<Record<string, string>>(
      Object.fromEntries(inputFields.inventory.map((x) => [x, x])),
    ),
    [preview, setPreview] = useState<{
      count: number;
      duplicates: number;
      rows: unknown[];
    }>();
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const target = new URLSearchParams(location.search).get("target");
    if (!focused && view && target) {
      document.getElementById(`promotion-${target}`)?.scrollIntoView({ block: "center" });
      setFocused(true);
    }
  }, [view, focused]);
  useEffect(() => {
    let active = true;
    fetch("/api/retail")
      .then(async (r) => {
        const x = await r.json();
        if (!r.ok) throw new Error(x.error);
        if (active) {
          setView(x);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [data]);
  const project = new URLSearchParams(location.search).get("project") || "default";
  const payload = { kind, csv, sourceName, demo, mapping };
  return (
    <section className="operations-extension retail">
      <h2>门店、销售与促销</h2>
      <p className="notice">
        离线导入 · 无地图／POS／实时库存连接。库存为快照；销售与核销不会自动扣库存。
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="grid">
        <article className="card">
          <h3>门店档案</h3>
          <Form label="保存新门店" busy={busy} save={(d) => void act("retail/stores", d)}>
            <label>
              门店代码
              <input name="id" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}" />
            </label>
            <label>
              门店名称
              <input name="name" required />
            </label>
            <label>
              区域（自定义标签）
              <input name="region" required />
            </label>
            <label>
              地址备注
              <input name="address" />
            </label>
          </Form>
          {view?.stores.map((s) => (
            <p key={s.id}>
              {s.name} · {s.id} · {s.region} · {s.address}
            </p>
          ))}
        </article>
        <article className="card">
          <h3>导入准备</h3>
          <p>
            先保存门店，并在“活动与商品”导入本品牌SKU。区域仅是用户标签，不代表地图或区域市场数据。
          </p>
          <p>当前商品：{data.products.map((p) => p.sku).join("、") || "尚无商品"}</p>
          <a href={`?project=${encodeURIComponent(project)}&page=5`}>打开本品牌商品导入</a>
          <p>
            外部订单行请使用“平台导入”的订单 CSV
            映射；这里也可导入相同标准销售流水。来源名必须稳定，相同事件换来源名会被视为不同事件。
          </p>
        </article>
      </div>
      <article className="card" data-draft-scope="retail-import">
        <h3>库存／销量 CSV 导入</h3>
        <label>
          数据类型
          <select
            aria-label="零售数据类型"
            value={kind}
            onChange={(e) => {
              const k = e.target.value as "inventory" | "sales";
              setKind(k);
              setMapping(Object.fromEntries(inputFields[k].map((x) => [x, x])));
              setCsv("");
              setPreview(undefined);
            }}
          >
            <option value="inventory">库存快照</option>
            <option value="sales">销售／退货流水</option>
          </select>
        </label>
        <label>
          稳定来源名
          <input
            value={sourceName}
            onChange={(e) => {
              setSource(e.target.value);
              setPreview(undefined);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={demo}
            onChange={(e) => {
              setDemo(e.target.checked);
              setPreview(undefined);
            }}
          />
          演示数据（与真实数据分组）
        </label>
        <label>
          选择零售 CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setPreview(undefined);
              if (f.size > 1000000) {
                setError("文件超过1MB");
                return;
              }
              setCsv(await f.text());
            }}
          />
        </label>
        <button
          disabled={!view?.stores.length || !data.products.length}
          onClick={() => {
            const shop = view!.stores[0].id,
              sku = data.products[0].sku,
              now = new Date().toISOString();
            setDemo(true);
            setSource("DEMO-local");
            setMapping(Object.fromEntries(inputFields[kind].map((x) => [x, x])));
            setCsv(
              kind === "inventory"
                ? `storeId,sku,asOf,quantity\n${shop},${sku},${now},40`
                : `externalId,storeId,sku,date,quantity,revenue,currency,kind,originalId,campaignId,channel\nDEMO-SALE-1,${shop},${sku},${now},2,20,USD,sale,,,offline`,
            );
            setPreview(undefined);
          }}
        >
          载入零售演示 CSV
        </button>
        <details>
          <summary>零售字段映射</summary>
          <div className="grid">
            {inputFields[kind].map((k) => (
              <label key={k}>
                {k}
                <input
                  value={mapping[k] || ""}
                  onChange={(e) => {
                    setMapping({ ...mapping, [k]: e.target.value });
                    setPreview(undefined);
                  }}
                />
              </label>
            ))}
          </div>
        </details>
        <p>
          {kind === "inventory"
            ? "数量为非负整数。相同门店/SKU/时间重复跳过，冲突拒绝；新盘点使用新时间。保留全部快照，仅最新快照参与建议。"
            : "销售quantity为正、revenue为非负；退货quantity为负、revenue为非正，originalId关联同来源原销售externalId。金额为折后净商品行金额（不含税运），最多两位小数。缺campaignId为未知归因，不猜测。"}
        </p>
        <textarea
          aria-label="零售CSV内容"
          value={csv}
          rows={7}
          onChange={(e) => {
            setCsv(e.target.value);
            setPreview(undefined);
          }}
        />
        <button
          disabled={busy || !csv}
          onClick={async () => {
            setPreview(undefined);
            const out = await act("retail/import/preview", payload);
            if (out) setPreview(out);
          }}
        >
          预览零售导入
        </button>
        <button
          disabled={busy || !preview}
          onClick={async () => {
            const out = await act("retail/import", payload);
            if (out) setPreview(undefined);
          }}
        >
          确认零售导入
        </button>
        {preview && (
          <p>
            预览新增 {preview.count} 条，重复 {preview.duplicates} 条；尚未写入。
          </p>
        )}
      </article>
      <article className="card">
        <h3>门店需求证据与促销候选</h3>
        <p>
          规则：库存快照不超过7天、库存至少20件、最近30天存在销售记录且观察净销量0–5件。只是人工评估候选，不推断未观测销量、区域需求或利润。
        </p>
        {view?.insights.length ? (
          view.insights.map((x) => (
            <div className="retail-evidence" key={x.inventoryId}>
              <h4>
                {x.storeId} / {x.sku} · {x.region} {x.demo ? "[演示]" : "[用户导入]"}
              </h4>
              <p>{x.explanation}</p>
              <p>{x.suggestion}</p>
              <button
                disabled={busy || !x.eligible}
                onClick={() =>
                  void act("retail/promotions", {
                    storeId: x.storeId,
                    sku: x.sku,
                    demo: x.demo,
                  })
                }
              >
                生成待审核促销草稿
              </button>
            </div>
          ))
        ) : (
          <p>尚无库存快照，无法产生促销建议。</p>
        )}
      </article>
      <h3>促销草稿与核销</h3>
      {view?.promotions.map((p) => (
        <PromotionCard
          key={p.id + ":" + p.version + ":" + (p.approvedAt || "")}
          p={p}
          view={view}
          act={act}
          busy={busy}
          project={project}
        />
      ))}
      <article className="card">
        <h3>销售与核销效果汇总</h3>
        <p>{view?.summary.note}</p>
        <p>未知活动归因流水：{view?.summary.unknownAttribution ?? 0} 条</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {["门店/区域", "SKU", "数据", "活动/渠道", "记录数", "净销量", "净商品金额"].map(
                  (x) => (
                    <th key={x}>{x}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {view?.summary.groups.map((g, i) => (
                <tr key={i}>
                  <td>
                    {g.storeId} / {g.region}
                  </td>
                  <td>{g.sku}</td>
                  <td>{g.demo ? "演示" : "用户导入"}</td>
                  <td>
                    {g.campaignId || "未知归因"} / {g.channel || "未知渠道"}
                  </td>
                  <td>{g.records}</td>
                  <td>{g.netUnits}</td>
                  <td>
                    {g.netRevenue.toFixed(2)} {g.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {view?.summary.promotions.map((g) => (
          <div key={g.promotionId}>
            <p>
              {view.promotions.find((p) => p.id === g.promotionId)?.code}
              ：有效核销记录 {g.recorded}，撤销 {g.voided}
            </p>
            {g.groups.map((x) => (
              <p key={x.currency}>
                扣除关联退货后：保留销售行 {x.retainedLines}、净件数 {x.netUnits}、净商品金额{" "}
                {x.netRevenue.toFixed(2)} {x.currency}
                。不能据此宣称促销带来这些收入。
              </p>
            ))}
          </div>
        ))}
      </article>
    </section>
  );
}
function PromotionCard({
  p,
  view,
  act,
  busy,
  project,
}: {
  p: View["promotions"][number];
  view: View;
  act: Act;
  busy: boolean;
  project: string;
}) {
  const [actor, setActor] = useState("");
  return (
    <article className="card" id={`promotion-${p.id}`}>
      <h3>
        {p.title} · V{p.version} {p.demo ? "[演示]" : ""}
      </h3>
      <p>
        {p.code} · {p.check.approved ? "已审核具体版本" : "待审核 / 已失效"} ·{" "}
        {p.check.issues.join("；")}
      </p>
      <p>证据快照：{p.evidence.explanation}</p>
      <Form
        busy={busy}
        label="保存促销修订并刷新依据"
        save={(d) =>
          void act(`retail/promotions/${p.id}/update`, {
            ...d,
            actor: actor || "本机操作者（未认证）",
            baseVersion: p.version,
            discountPercent: Number(d.discountPercent),
            maxRedemptions: Number(d.maxRedemptions),
            startsAt: new Date(d.startsAt + "Z").toISOString(),
            endsAt: new Date(d.endsAt + "Z").toISOString(),
          })
        }
      >
        <label>
          促销标题
          <input name="title" defaultValue={p.title} required />
        </label>
        <label>
          促销文案
          <textarea aria-label="促销文案" name="copy" defaultValue={p.copy} required rows={3} />
        </label>
        <label>
          折扣百分比（人工评估成本后填写）
          <input
            name="discountPercent"
            type="number"
            min="0"
            max="50"
            step="0.1"
            defaultValue={p.discountPercent}
            required
          />
        </label>
        <label>
          核销次数上限
          <input
            name="maxRedemptions"
            type="number"
            min="1"
            max="10000"
            defaultValue={p.maxRedemptions}
            required
          />
        </label>
        <label>
          开始时间（UTC）
          <input
            name="startsAt"
            type="datetime-local"
            defaultValue={p.startsAt.slice(0, 16)}
            required
          />
        </label>
        <label>
          结束时间（UTC）
          <input
            name="endsAt"
            type="datetime-local"
            defaultValue={p.endsAt.slice(0, 16)}
            required
          />
        </label>
      </Form>
      <div data-draft-scope={`promotion-review:${p.id}`}>
        <label>
          审核／记录人（自报）
          <input value={actor} onChange={(e) => setActor(e.target.value)} />
        </label>
        <button
          disabled={busy || !actor || !!p.check.issues.length}
          onClick={() =>
            void act(`retail/promotions/${p.id}/approve`, {
              baseVersion: p.version,
              actor,
            })
          }
        >
          批准已保存促销版本
        </button>
        {p.check.approved && (
          <a href={`/api/retail/promotions/${p.id}/export?project=${encodeURIComponent(project)}`}>
            导出已审核促销包
          </a>
        )}
      </div>
      <details>
        <summary>记录人工核销</summary>
        <p>
          仅关联已导入的销售行；系统不发券、不验证POS优惠、不扣减库存。销售时间须在活动期间。同销售行不得重复关联多个促销。导入新流水后请刷新依据、重新审核。
        </p>
        <Form
          busy={busy || !p.check.approved || !actor}
          label="保存核销记录"
          save={(d) => void act("retail/redemptions", { ...d, promotionId: p.id, actor })}
        >
          <label>
            实际销售行
            <select aria-label="实际销售行" name="saleId" required>
              <option value="">请选择销售行</option>
              {view.sales
                .filter(
                  (s) =>
                    s.kind === "sale" &&
                    s.storeId === p.storeId &&
                    s.sku === p.sku &&
                    s.demo === p.demo,
                )
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.externalId} · {s.date} · {s.quantity}件 / {s.revenue} {s.currency}
                  </option>
                ))}
            </select>
          </label>
          <label>
            核销凭证编号
            <input name="externalId" required />
          </label>
        </Form>
      </details>
      {view.redemptions
        .filter((r) => r.promotionId === p.id)
        .map((r) => (
          <div key={r.id}>
            <p>
              {r.externalId} · {r.actor} · {r.recordedAt} · 审批V
              {r.promotionVersion} · {r.voidedAt ? `已撤销：${r.voidReason}` : "已记录"}
            </p>
            {!r.voidedAt && (
              <Form
                busy={busy || !actor}
                label="撤销此核销（保留审计）"
                save={(d) => void act(`retail/redemptions/${r.id}/void`, { ...d, actor })}
              >
                <label>
                  撤销原因
                  <input name="reason" required />
                </label>
              </Form>
            )}
          </div>
        ))}
      <details>
        <summary>促销审核记录</summary>
        {p.history.map((h, i) => (
          <p key={i}>
            {h.at} · {h.actor} · {h.action} · V{h.version}
          </p>
        ))}
      </details>
    </article>
  );
}
