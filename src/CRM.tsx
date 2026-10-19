import React, { useState } from "react";
import type { State } from "../server/types";
import { emptyCRM, priority } from "../server/domain/crm";
type Props = {
  data: State;
  act: (path: string, body: unknown) => Promise<any>;
  busy: boolean;
  confirmDiscard?: () => boolean;
};
const stages = {
  new: "新线索",
  qualified: "已确认需求",
  contacted: "已联系",
  won: "已成交",
  lost: "已关闭",
};
const sample =
  "company,domain,name,email,industry,region,owner,sourceUrl\nDEMO 示例公司,example.com,示例联系人,person@example.com,软件,中国,示例负责人,https://example.com";
function Fields({
  children,
  onSave,
  label,
  busy,
}: {
  children: React.ReactNode;
  onSave: (d: Record<string, string>) => void;
  label: string;
  busy: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>);
      }}
    >
      {children}
      <button disabled={busy}>{label}</button>
    </form>
  );
}
export function CRM({ data, act, busy, confirmDiscard }: Props) {
  const c = data.crm ?? emptyCRM(),
    [selected, setSelected] = useState(
      () => new URLSearchParams(location.search).get("target") || "",
    ),
    [csv, setCsv] = useState(sample),
    [preview, setPreview] = useState(""),
    [filter, setFilter] = useState(""),
    [owner, setOwner] = useState("");
  const ranked = c.leads
      .map((l) => ({ ...l, ...priority(c, l) }))
      .sort((a, b) => b.score - a.score),
    l = c.leads.find((x) => x.id === selected),
    a = c.accounts.find((x) => x.id === l?.accountId),
    contact = c.contacts.find((x) => x.id === l?.contactId);
  const due = c.followups.filter((t) => !t.doneAt && Date.parse(t.dueAt) <= Date.now());
  const selectLead = (id: string) => {
    if (id === selected) return;
    if (confirmDiscard && !confirmDiscard()) return;
    setSelected(id);
  };
  return (
    <section className="crm operations-extension">
      <h2>B2B 线索与跟进</h2>
      <p>
        公司 → 联系人 → 线索 → 跟进。负责人是本机协作标签，不是安全 RBAC。草稿仅本地保存，不会发送。
      </p>
      <div className="grid">
        <article className="card">
          <h3>ICP 理想客户配置</h3>
          <Fields
            key={JSON.stringify(c.icp)}
            busy={busy}
            label="保存 ICP"
            onSave={(d) =>
              void act("crm/icp", {
                industries: d.industries
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
                regions: d.regions
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          >
            <label>
              行业（逗号分隔）
              <input name="industries" defaultValue={c.icp.industries.join(",")} />
            </label>
            <label>
              地区（逗号分隔）
              <input name="regions" defaultValue={c.icp.regions.join(",")} />
            </label>
          </Fields>
        </article>
        <article className="card">
          <h3>添加线索</h3>
          <Fields busy={busy} label="保存线索" onSave={(d) => void act("crm/leads", d)}>
            {[
              ["company", "公司"],
              ["domain", "域名"],
              ["name", "联系人"],
              ["email", "邮箱"],
              ["industry", "行业"],
              ["region", "地区"],
              ["owner", "负责人"],
              ["sourceUrl", "来源 URL"],
            ].map(([name, label]) => (
              <label key={name}>
                {label}
                <input
                  name={name}
                  required={["company", "name", "sourceUrl"].includes(name)}
                  type={name === "email" ? "email" : name === "sourceUrl" ? "url" : "text"}
                />
              </label>
            ))}
          </Fields>
        </article>
      </div>
      <details className="card" data-draft-scope="crm-import">
        <summary>CSV 导入／导出与演示样例</summary>
        <p>样例仅演示，不代表真实线索。来源URL必填；公司与联系人去重，已有线索不被覆盖。</p>
        <textarea
          aria-label="线索CSV"
          rows={6}
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setPreview("");
          }}
        />
        <button
          disabled={busy}
          onClick={async () => {
            const out = await act("crm/leads/preview", { csv });
            if (out) setPreview(`预览：新增 ${out.count}，重复 ${out.duplicates}。尚未写入。`);
          }}
        >
          预览线索导入
        </button>
        <button disabled={busy || !preview} onClick={() => void act("crm/leads/import", { csv })}>
          确认导入线索
        </button>
        <p>{preview}</p>
        <a
          href={
            "/api/crm/export?project=" +
            encodeURIComponent(new URLSearchParams(location.search).get("project") || "default")
          }
        >
          导出本品牌线索 CSV
        </a>
      </details>
      <article className="card">
        <h3>到期提醒队列 · {due.length}</h3>
        {due.length === 0 ? (
          <p>暂无到期任务。</p>
        ) : (
          due.map((t) => (
            <p key={t.id}>
              <button onClick={() => selectLead(t.leadId)}>{t.title}</button> · {t.owner} ·{" "}
              {new Date(t.dueAt).toLocaleString()}{" "}
              <button disabled={busy} onClick={() => void act(`crm/tasks/${t.id}/complete`, {})}>
                完成任务
              </button>
            </p>
          ))
        )}
      </article>
      <div className="grid">
        <article className="card">
          <h3>线索优先级</h3>
          <label>
            阶段筛选
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">全部</option>
              {Object.entries(stages).map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            负责人筛选
            <input value={owner} onChange={(e) => setOwner(e.target.value)} />
          </label>
          {ranked
            .filter((x) => (!filter || x.stage === filter) && (!owner || x.owner.includes(owner)))
            .map((x) => (
              <div key={x.id}>
                <button onClick={() => selectLead(x.id)}>
                  {c.accounts.find((a) => a.id === x.accountId)?.company} /{" "}
                  {c.contacts.find((a) => a.id === x.contactId)?.name}
                </button>
                <p>
                  {stages[x.stage]} · {x.owner || "未分配"} · {x.score} 分 ({x.level})
                </p>
                <small>{x.explanation}</small>
              </div>
            ))}
          {!ranked.length && <p>添加线索或导入 CSV 开始。</p>}
        </article>
        <article className="card" key={l?.id || "no-lead"}>
          {l ? (
            <>
              <h3>
                {a?.company} · {contact?.name}
              </h3>
              <p>
                {contact?.email || "邮箱未提供"} · {a?.industry} · {a?.region}
              </p>
              <a href={l.sourceUrl} target="_blank" rel="noreferrer">
                核实线索来源
              </a>
              <p>{priority(c, l).nextAction}</p>
              <Fields
                key={l.id + l.stage + l.owner}
                busy={busy}
                label="更新阶段与负责人"
                onSave={(d) => void act(`crm/leads/${l.id}/update`, d)}
              >
                <label>
                  阶段
                  <select name="stage" defaultValue={l.stage}>
                    {Object.entries(stages).map(([v, t]) => (
                      <option key={v} value={v}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  负责人
                  <input name="owner" defaultValue={l.owner} />
                </label>
                <label>
                  记录人（自报）
                  <input name="actor" required />
                </label>
              </Fields>
              <details>
                <summary>添加来源信号</summary>
                <Fields
                  busy={busy}
                  label="记录信号"
                  onSave={(d) =>
                    void act(`crm/leads/${l.id}/signals`, {
                      ...d,
                      observedAt: new Date(d.observedAt).toISOString(),
                      verified: d.verified === "on",
                    })
                  }
                >
                  <label>
                    信号类型
                    <select name="kind">
                      <option value="interest">一般关注（无购买意向分）</option>
                      <option value="request-demo">明确请求演示</option>
                      <option value="request-quote">明确询价</option>
                      <option value="procurement">明确采购计划</option>
                    </select>
                  </label>
                  <label>
                    来源 URL
                    <input name="sourceUrl" type="url" required />
                  </label>
                  <label>
                    原文摘录
                    <textarea name="quote" required maxLength={300} />
                  </label>
                  <label>
                    观察时间
                    <input name="observedAt" type="datetime-local" required />
                  </label>
                  <label>
                    <input name="verified" type="checkbox" />
                    我已人工核实此来源与线索的关联
                  </label>
                </Fields>
              </details>
              {c.signals
                .filter((x) => x.leadId === l.id)
                .map((x) => (
                  <p key={x.id}>
                    <a href={x.sourceUrl} target="_blank" rel="noreferrer">
                      {x.kind}
                    </a>{" "}
                    · {x.verified ? "人工核实" : "未核实"} · {x.quote}
                  </p>
                ))}
              <details>
                <summary>安排下一步跟进</summary>
                <Fields
                  busy={busy}
                  label="创建跟进任务"
                  onSave={(d) =>
                    void act(`crm/leads/${l.id}/tasks`, {
                      ...d,
                      dueAt: new Date(d.dueAt).toISOString(),
                    })
                  }
                >
                  <label>
                    任务
                    <input name="title" required />
                  </label>
                  <label>
                    执行人
                    <input name="owner" required defaultValue={l.owner} />
                  </label>
                  <label>
                    到期时间
                    <input name="dueAt" type="datetime-local" required />
                  </label>
                </Fields>
              </details>
              {c.followups
                .filter((x) => x.leadId === l.id)
                .map((t) => (
                  <p key={t.id}>
                    {t.title} · {t.owner} · {new Date(t.dueAt).toLocaleString()} ·{" "}
                    {t.doneAt ? (
                      "已完成"
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() => void act(`crm/tasks/${t.id}/complete`, {})}
                      >
                        完成任务
                      </button>
                    )}
                  </p>
                ))}
              <Fields
                busy={busy}
                label="保存联系记录／备注"
                onSave={(d) => void act(`crm/leads/${l.id}/logs`, d)}
              >
                <label>
                  记录人
                  <input name="actor" required />
                </label>
                <label>
                  联系结果与下一步
                  <textarea name="text" required />
                </label>
              </Fields>
              {c.logs
                .filter((x) => x.leadId === l.id)
                .map((x) => (
                  <p key={x.id}>
                    {new Date(x.at).toLocaleString()} · {x.actor}：{x.text}
                  </p>
                ))}
              <button disabled={busy} onClick={() => void act(`crm/leads/${l.id}/draft`, {})}>
                生成未发送拓展草稿
              </button>
              {c.drafts
                .filter((x) => x.leadId === l.id)
                .slice(-3)
                .map((x) => (
                  <div key={x.id}>
                    <p>模板模式 · 未发送 · {new Date(x.createdAt).toLocaleString()}</p>
                    <textarea aria-label="未发送拓展草稿" rows={8} readOnly value={x.body} />
                  </div>
                ))}
            </>
          ) : (
            <p>选择一条线索查看详情与执行跟进。</p>
          )}
        </article>
      </div>
    </section>
  );
}
