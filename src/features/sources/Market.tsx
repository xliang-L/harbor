import { useState } from "react";
import type { Act, Data } from "../../shared/types.ts";
import { Field } from "../../components/Field";
import { fmt } from "../../shared/format";
export function Market({
  data,
  busy,
  act,
  next,
}: {
  data: Data;
  busy: boolean;
  act: Act;
  next: () => void;
}) {
  const [method, setMethod] = useState("paste");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [date, setDate] = useState("");
  const [text, setText] = useState("");
  const [csv, setCsv] = useState("");
  const [demo, setDemo] = useState(false);
  return (
    <>
      <div className="stats">
        <div>
          <strong>{data.evidence.length.toString().padStart(2, "0")}</strong>
          <span>已保存的证据</span>
        </div>
        <div>
          <strong>{data.suggestions.length.toString().padStart(2, "0")}</strong>
          <span>可追溯的营销建议</span>
        </div>
        <div>
          <strong>100%</strong>
          <span>由你指定来源</span>
        </div>
      </div>
      <div className="card">
        <div className="section-title">
          <h2>添加公开资料</h2>
          <span>只抓取指定公开网页，不绕过访问限制</span>
        </div>
        <div className="tabs">
          {[
            ["paste", "粘贴文本"],
            ["csv", "导入 CSV"],
            ["fetch", "抓取指定网址"],
          ].map(([v, l]) => (
            <button className={method === v ? "selected" : ""} key={v} onClick={() => setMethod(v)}>
              {l}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              method === "fetch" ? "tasks" : "evidence",
              method === "fetch"
                ? { kind: "fetch", payload: { url, publishedAt: date } }
                : method === "csv"
                  ? { csv }
                  : { title, url, publishedAt: date, text, demo },
            );
          }}
        >
          {method === "csv" ? (
            <>
              <p className="muted">
                表头：title,url,publishedAt,text,demo（可选 true/false）。CSV 最多 100 行；不支持
                PDF。
              </p>
              <label>
                CSV 文件
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void f.text().then(setCsv);
                  }}
                />
              </label>
              <label>
                CSV 内容
                <textarea
                  required
                  value={csv}
                  onChange={(e) => setCsv(e.target.value)}
                  placeholder={"title,url,publishedAt,text,demo"}
                />
              </label>
            </>
          ) : (
            <>
              <div className="grid">
                <Field
                  label="来源 URL"
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…"
                />
                <Field
                  label="资料发布时间 / 观察时间"
                  type="datetime-local"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              {method === "paste" && (
                <>
                  <Field
                    label="资料标题"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <label>
                    公开原文（至少 20 字符）
                    <textarea
                      required
                      minLength={20}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={demo}
                      onChange={(e) => setDemo(e.target.checked)}
                    />
                    这是测试 / 演示资料（不能冒充真实市场证据）
                  </label>
                </>
              )}
            </>
          )}
          <button className="primary" disabled={busy}>
            {method === "fetch" ? "安全抓取并保存" : "保存证据"} ↗
          </button>
        </form>
      </div>
      <div className="section-title spaced">
        <h2>证据库</h2>
        <span>保留原文、来源时间、入库时间与 内容摘要</span>
      </div>
      {!data.evidence.length ? (
        <div className="empty">还没有资料。先粘贴一段带来源的公开原文。</div>
      ) : (
        <div className="evidence-grid">
          {data.evidence.map((e) => (
            <details className="card evidence" key={e.id}>
              <summary>
                <span className={"badge " + (e.demo ? "amber" : "")}>
                  {e.demo ? "演示资料" : e.kind === "fetch" ? "网页抓取" : "人工导入 · 未独立核验"}
                </span>
                <h3>{e.title}</h3>
                <small>{fmt(e.publishedAt)} ↗</small>
              </summary>
              <a href={e.url} target="_blank" rel="noreferrer">
                {e.url}
              </a>
              <p className="source-text">{e.text}</p>
              <small>
                入库：{fmt(e.capturedAt)}
                <br />
                证据 ID：{e.id}
                <br />
                内容摘要：{e.hash}
              </small>
            </details>
          ))}
        </div>
      )}
      <div className="section-title spaced">
        <div>
          <h2>找到下一个内容角度</h2>
          <p className="muted">建议是待验证的假设，引用可展开核对。</p>
        </div>
        <button
          className="primary"
          disabled={busy || !data.brand || !data.evidence.length}
          onClick={() => act("tasks", { kind: "suggest" })}
        >
          生成 3 条营销建议 ↗
        </button>
      </div>
      <div className="suggestions">
        {data.suggestions.map((s, i) => (
          <article className="card" key={s.id}>
            <span className="eyebrow">
              INSIGHT / 0{i + 1} · {s.mode === "model" ? "模型草稿" : "模板演示"}
            </span>
            <h3>{s.title}</h3>
            <p>{s.reason}</p>
            {s.quotes.map((q, j) => (
              <blockquote key={j}>
                <p>“{q.quote}”</p>
                <a
                  href={data.evidence.find((e) => e.id === q.evidenceId)?.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  证据：
                  {data.evidence.find((e) => e.id === q.evidenceId)?.title} ↗
                </a>
              </blockquote>
            ))}
            <button
              className="secondary"
              disabled={busy}
              onClick={async () => {
                const out = await act("tasks", {
                  kind: "content",
                  payload: { suggestionId: s.id },
                });
                if (out) next();
              }}
            >
              选择并生成内容 →
            </button>
          </article>
        ))}
      </div>
    </>
  );
}
