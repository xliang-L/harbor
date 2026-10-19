import React, { useEffect, useState } from "react";
import type { listPostizPosts } from "../../../server/connectors/postiz";

type Result = Awaited<ReturnType<typeof listPostizPosts>>;
type Status = { configured: boolean; integrationId: string | null; note: string };
const labels = {
  QUEUE: "Postiz 排队中",
  DRAFT: "Postiz 草稿",
  PUBLISHED: "Postiz 报告已发布",
  ERROR: "Postiz 报告失败",
};

export function Postiz({
  act,
  busy,
}: {
  act: (path: string, body: unknown) => Promise<any>;
  busy: boolean;
}) {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<Result>();
  const [start, setStart] = useState(() =>
    new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
  );
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    const timeout = setTimeout(() => abort.abort(), 10000);
    void fetch("/api/postiz/status", { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Postiz 配置状态暂不可用");
        const value: Status = await response.json();
        if (active) {
          setStatus(value);
          setError("");
        }
      })
      .catch(() => {
        if (active) setError("Postiz 配置状态加载失败，请检查本机服务后重试。");
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      abort.abort();
    };
  }, [retry]);
  const rangeValid =
    !!start &&
    !!end &&
    Date.parse(end) >= Date.parse(start) &&
    Date.parse(end) - Date.parse(start) < 31 * 86400000;
  return (
    <section className="card operations-extension" aria-label="Postiz 只读连接">
      <div className="section-title">
        <h2>Postiz 渠道状态</h2>
        <span className="badge">只读连接</span>
      </div>
      <p>
        查询当前品牌绑定账号的帖子状态和发布链接，辅助核对交付。查询不会发布内容，也不会自动生成交付回执。
      </p>
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button onClick={() => setRetry((x) => x + 1)}>重试 Postiz 配置</button>
        </div>
      )}
      {!status && !error && <p role="status">读取连接配置…</p>}
      {status && !status.configured && (
        <p className="notice">
          当前品牌尚未配置 Postiz。请在项目环境配置中填写 API 地址、密钥和绑定账号 ID，重启 Harbor
          后使用。每个品牌单独配置，密钥保留在本机服务端。
        </p>
      )}
      {status?.configured && (
        <>
          <p>绑定账号 ID：{status.integrationId} · 已配置，尚需实际查询验证。</p>
          <div className="grid">
            <label>
              Postiz 开始日期（UTC）
              <input
                type="date"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  setResult(undefined);
                }}
              />
            </label>
            <label>
              Postiz 结束日期（UTC）
              <input
                type="date"
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value);
                  setResult(undefined);
                }}
              />
            </label>
          </div>
          <p className="muted">
            最多 31 个 UTC 日。查询的是排期窗口；Postiz 的计划时间不能作为平台实际发布时间。
          </p>
          {!rangeValid && <p role="alert">请选择先后顺序正确、不超过 31 天的日期。</p>}
          <button
            disabled={busy || !rangeValid}
            onClick={async () => {
              setResult(undefined);
              const value = await act("postiz/check", {
                startDate: new Date(start + "T00:00:00Z").toISOString(),
                endDate: new Date(end + "T23:59:59.999Z").toISOString(),
              });
              if (value) setResult(value);
            }}
          >
            查询 Postiz 状态
          </button>
        </>
      )}
      {result && (
        <>
          <p>
            账号：{result.integration.name} · {result.integration.identifier} · 查询时间{" "}
            {new Date(result.checkedAt).toLocaleString("zh-CN")}
          </p>
          {result.integration.disabled && (
            <p className="notice error">Postiz 标记该账号已停用，下方历史状态仅供核对。</p>
          )}
          <p className="muted">{result.note}</p>
          {!result.posts.length && (
            <p className="empty">当前账号在这个排期窗口没有返回帖子。没有记录不等于未曾发布。</p>
          )}
          {result.posts.map((post, index) => (
            <article className="card" key={`${post.id}:${post.publishDate}:${index}`}>
              <span className={`badge ${post.state === "ERROR" ? "amber" : ""}`}>
                {labels[post.state]}
              </span>
              <p>计划时间：{new Date(post.publishDate).toLocaleString("zh-CN")}（当前设备时区）</p>
              <p>
                外部帖子 ID：{post.id} · 账号：{post.integration.name}
              </p>
              {post.error && <p className="notice error">{post.error}</p>}
              <details>
                <summary>核对 Postiz 文案与当前内容</summary>
                <pre className="json-preview">{post.content}</pre>
              </details>
              {post.releaseURL && (
                <p>
                  <a href={post.releaseURL} target="_blank" rel="noreferrer">
                    打开 Postiz 提供的发布链接
                  </a>
                </p>
              )}
              <p className="muted">
                请核对账号、文案和具体版本，再到渠道日历填写人工交付回执。该链接及状态来自
                Postiz，Harbor 未独立核验平台页面。
              </p>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
