import { Retail } from "./Retail";
import Orders from "./Orders";
import { Console } from "./Console";
import Integrations from "./Integrations";
import { Attribution } from "./Attribution";
import { CRM } from "./CRM";
import { Planning, StartChecklist } from "./Planning";
import { Workflows } from "./Workflows";
import { Overview } from "./Overview";
import { Postiz } from "./Postiz";
import { applicableFacts, revisionFactIssues } from "../server/domain/facts";
import { metricQuality } from "../server/domain/metrics";
import { channels } from "../server/domain/channels";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { State, Brand, Content, Revision } from "../server/types";
import "./style.css";
type Data = State & { mode: string };
const pages = [
  "品牌档案",
  "市场动态",
  "内容工作台",
  "效果记录",
  "运营流程",
  "活动与商品",
  "B2B 线索",
  "多品牌控制台",
  "平台导入",
  "门店与促销",
  "今日工作台",
];
const navigationOrder = [10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
function currentRoute() {
  const params = new URLSearchParams(location.search);
  const value = params.get("page");
  const n = value === null ? 10 : Number(value);
  return {
    page: Number.isInteger(n) && n >= 0 && n < pages.length ? n : 10,
    section: params.get("section") || "",
    target: params.get("target") || "",
  };
}
type DraftScope = { key: string; element: HTMLElement };
function draftSnapshot(element: HTMLElement) {
  return JSON.stringify(
    Array.from(
      element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input, select, textarea",
      ),
    )
      .filter((field) => field.type !== "hidden" && !("readOnly" in field && field.readOnly))
      .map((field) => [field.type, field.value, "checked" in field ? field.checked : null]),
  );
}
const blank = {
  name: "",
  url: "",
  product: "",
  parameters: "",
  audience: "",
  market: "美国",
  competitors: [],
  image: "",
  updatedAt: "",
} as Brand;
const fmt = (s: string) => new Date(s).toLocaleString("zh-CN");
const project = new URLSearchParams(location.search).get("project") || "default";
// Keep project context on downloads and iframe URLs as well as API requests.
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  if (typeof input === "string" && input.startsWith("/api/")) {
    const u = new URL(input, location.origin);
    u.searchParams.set("project", project);
    return originalFetch(u, {
      ...init,
      headers: { ...init?.headers, "X-Harbor-Project": project },
    });
  }
  return originalFetch(input, init);
};
function App() {
  const [projects, setProjects] = useState<string[]>([]);
  const [newProject, setNewProject] = useState("");
  const [data, setData] = useState<Data>();
  const [route, setRoute] = useState(currentRoute);
  const { page, section, target } = route;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const requestKeys = useRef(new Map<string, string>());
  const drafts = useRef(new Map<string, { baseline: string; current: string; version: number }>());
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const actionScope = useRef<DraftScope | null>(null);
  const historyIndex = useRef(
    typeof history.state?.harborIndex === "number" ? history.state.harborIndex : 0,
  );
  const ignorePop = useRef(false);
  const routeRef = useRef(route);
  const syncUnsaved = () =>
    setHasUnsaved(
      Array.from(drafts.current.values()).some((draft) => draft.current !== draft.baseline),
    );
  const clearDrafts = () => {
    drafts.current.clear();
    setHasUnsaved(false);
  };
  const confirmDiscard = () => {
    const changed = Array.from(drafts.current.values()).some(
      (draft) => draft.current !== draft.baseline,
    );
    if (changed && !window.confirm("当前页面有尚未保存的修改。离开后这些修改将丢失，确定离开吗？"))
      return false;
    clearDrafts();
    return true;
  };
  const scopeFor = (target: EventTarget | null): DraftScope | null => {
    if (!(target instanceof Element)) return null;
    const element = target.closest<HTMLElement>("[data-draft-scope], form");
    const main = element?.closest("main");
    if (!element || !main) return null;
    const explicit = element.dataset.draftScope;
    const tab = main.querySelector(".tabs button.selected")?.textContent || "";
    return {
      key: `${page}:${explicit || `${tab}:${Array.from(main.querySelectorAll("form")).indexOf(element as HTMLFormElement)}`}`,
      element,
    };
  };
  const rememberDraft = (target: EventTarget | null, changed = false) => {
    const scope = scopeFor(target);
    if (!scope) return;
    const snapshot = draftSnapshot(scope.element);
    const previous = drafts.current.get(scope.key);
    if (!previous || (!changed && previous.current === previous.baseline)) {
      drafts.current.set(scope.key, {
        baseline: snapshot,
        current: snapshot,
        version: previous?.version || 0,
      });
    } else if (changed) {
      drafts.current.set(scope.key, {
        ...previous,
        current: snapshot,
        version: previous.version + 1,
      });
    }
    syncUnsaved();
  };
  const onDraftSaveStart = (element: HTMLElement) => {
    const scope = scopeFor(element);
    const version = scope ? drafts.current.get(scope.key)?.version : undefined;
    return () => {
      if (!scope) return;
      const draft = drafts.current.get(scope.key);
      if (!draft || draft.version !== version) return;
      const snapshot = draftSnapshot(scope.element);
      drafts.current.set(scope.key, {
        baseline: snapshot,
        current: snapshot,
        version: draft.version,
      });
      syncUnsaved();
    };
  };
  const navigate = (nextPage: number, nextSection = "", nextTarget = "") => {
    if (nextPage === page && nextSection === section && nextTarget === target) return;
    if ((nextPage !== page || nextTarget !== target) && !confirmDiscard()) return;
    const next = { page: nextPage, section: nextSection, target: nextTarget };
    const url = new URL(location.href);
    url.searchParams.set("page", String(nextPage));
    if (nextSection) url.searchParams.set("section", nextSection);
    else url.searchParams.delete("section");
    if (nextTarget) url.searchParams.set("target", nextTarget);
    else url.searchParams.delete("target");
    historyIndex.current += 1;
    history.pushState({ ...history.state, harborIndex: historyIndex.current }, "", url);
    routeRef.current = next;
    setRoute(next);
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    if (typeof history.state?.harborIndex !== "number")
      history.replaceState({ ...history.state, harborIndex: historyIndex.current }, "");
    const pop = (event: PopStateEvent) => {
      if (ignorePop.current) {
        ignorePop.current = false;
        return;
      }
      const next = currentRoute();
      const targetIndex =
        typeof event.state?.harborIndex === "number" ? event.state.harborIndex : 0;
      if (
        (next.page !== routeRef.current.page || next.target !== routeRef.current.target) &&
        !confirmDiscard()
      ) {
        ignorePop.current = true;
        history.go(historyIndex.current - targetIndex);
        return;
      }
      historyIndex.current = targetIndex;
      routeRef.current = next;
      setRoute(next);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (!hasUnsaved) return;
    const protect = (event: BeforeUnloadEvent) => {
      if (!Array.from(drafts.current.values()).some((draft) => draft.current !== draft.baseline))
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [hasUnsaved]);
  const refresh = async () => {
    try {
      const response = await fetch("/api/state");
      if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`);
      setData(await response.json());
      setConnectionError("");
    } catch (e) {
      setConnectionError(
        `暂时无法连接本机 Harbor：${(e as Error).message}。请确认服务运行后重试。`,
      );
    }
  };
  useEffect(() => {
    void fetch("/api/projects")
      .then((r) => r.json())
      .then((x) => setProjects(x.projects || ["default"]))
      .catch(() => setProjects([project]));
    void refresh();
    const timer = setInterval(() => void refresh(), 1800);
    return () => clearInterval(timer);
  }, []);
  async function act(path: string, body: unknown) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    const scope = actionScope.current;
    const draftVersion = scope ? drafts.current.get(scope.key)?.version : undefined;
    const signature = path + JSON.stringify(body);
    const key = requestKeys.current.get(signature) || crypto.randomUUID();
    requestKeys.current.set(signature, key);
    try {
      const response = await fetch("/api/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });
      const out = await response.json();
      if (!response.ok) throw new Error(out.error);
      requestKeys.current.delete(signature);
      // Previews and read-only checks do not save the user's draft.
      const savesDraft =
        !path.includes("preview") &&
        !path.startsWith("tasks") &&
        path !== "model/check" &&
        !path.endsWith("/report");
      if (savesDraft && scope) {
        const draft = drafts.current.get(scope.key);
        if (draft && draft.version === draftVersion) {
          const snapshot = draftSnapshot(scope.element);
          drafts.current.set(scope.key, {
            baseline: snapshot,
            current: snapshot,
            version: draft.version,
          });
          syncUnsaved();
        }
      }
      setError(false);
      setMessage(
        out.count !== undefined
          ? path.startsWith("metrics")
            ? `已新增 ${out.count} 条指标，跳过 ${out.duplicates || 0} 条完全重复记录`
            : `已导入 ${out.count} 条新资料（相同原文自动去重）`
          : "已保存 / 任务已提交",
      );
      await refresh();
      return out;
    } catch (e) {
      setError(true);
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <div className="loading">
        {connectionError || "正在打开本地工作台…"}
        {connectionError && <button onClick={() => void refresh()}>重试连接</button>}
      </div>
    );
  const pending = data.tasks.filter((t) => ["queued", "running"].includes(t.status));
  return (
    <div className="shell">
      <aside>
        <a
          className="logo"
          href={`?project=${encodeURIComponent(project)}&page=10`}
          onClick={(event) => {
            event.preventDefault();
            navigate(10);
          }}
        >
          <span>◒</span> harbor<span className="dot">.</span>
        </a>
        <p className="tagline">从洞察，到一次有效表达。</p>
        <div className="workspace">
          <div className="avatar">{data.brand?.name[0] || "H"}</div>
          <div>
            <strong>{data.brand?.name || "我的品牌空间"}</strong>
            <small>本地工作区 · V3</small>
          </div>
        </div>
        <label className="project-select">
          品牌项目
          <select
            aria-label="品牌项目"
            value={project}
            onChange={(e) => {
              if (!confirmDiscard()) return;
              location.search = "?project=" + encodeURIComponent(e.target.value);
            }}
          >
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!confirmDiscard()) return;
            const out = await act("projects", { id: newProject });
            if (out) location.search = "?project=" + encodeURIComponent(out.id);
          }}
        >
          <input
            aria-label="新项目标识"
            placeholder="新项目：brand-name"
            pattern="[a-z0-9][a-z0-9-]{0,39}"
            required
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
          />
          <button className="secondary" disabled={busy}>
            创建独立品牌项目
          </button>
        </form>
        <nav>
          {navigationOrder.map((i) => (
            <button
              key={i}
              className={page === i ? "active" : ""}
              aria-current={page === i ? "page" : undefined}
              onClick={() => navigate(i)}
            >
              <span>{["◈", "◉", "▣", "↗", "◷", "◎", "◇", "▦", "⇄", "⌂", "◒"][i]}</span>
              {pages[i]}
              <small>{String(i + 1).padStart(2, "0")}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="green-dot" /> SQLite 本地持久化
          <p>
            内容由你审核、下载和发布。
            <br />
            不会自动发帖或投放广告。
          </p>
        </div>
      </aside>
      <main
        onFocusCapture={(event) => rememberDraft(event.target)}
        onPointerDownCapture={(event) => rememberDraft(event.target)}
        onChangeCapture={(event) => rememberDraft(event.target, true)}
        onClickCapture={(event) => {
          actionScope.current = scopeFor(event.target);
          if (event.target instanceof Element && event.target.closest("[data-draft-change]")) {
            const scope = actionScope.current;
            if (scope) {
              rememberDraft(scope.element);
              requestAnimationFrame(() => rememberDraft(scope.element, true));
            }
          }
        }}
        onSubmitCapture={(event) => {
          actionScope.current = scopeFor(event.target);
        }}
      >
        <header>
          <span>WORKSPACE / {pages[page]}</span>
          <div className="pill">
            {data.mode === "demo-template" ? "模板演示模式 · 未连接模型" : "已配置模型适配器"}
          </div>
        </header>
        <section className="page">
          <div className="page-heading">
            <div>
              <p className="eyebrow">BUILD WITH EVIDENCE</p>
              <h1>{pages[page]}</h1>
              <p>
                {
                  [
                    "让每一条内容，从了解你的品牌开始。",
                    "把公开资料变成可追溯的营销假设。",
                    "从一条建议，走向可审核的内容版本。",
                    "用真实反馈，记录每一次内容实验。",
                    "把来源、优先行动、渠道审批与复盘连成闭环。",
                    "从商品、目标和品牌规范，走向可审核的活动交付。",
                    "核实需求、安排跟进，让每条线索都有下一步。",
                    "集中处理各品牌的审核、分配与协作记录。",
                    "先预览字段与来源，再导入当前品牌。",
                    "让库存、销售证据和人工促销审核连成闭环。",
                    "先处理影响交付的事项，再推进今天最重要的行动。",
                  ][page]
                }
              </p>
            </div>
          </div>
          {connectionError && (
            <div role="alert" className="notice error">
              {connectionError}
              <button onClick={() => void refresh()}>重试连接</button>
            </div>
          )}
          {message && (
            <div role="status" className={"notice " + (error ? "error" : "")}>
              {message}
              <button onClick={() => setMessage("")}>×</button>
            </div>
          )}
          {hasUnsaved && (
            <p className="notice" role="status">
              有未保存的修改，离开当前页面前请先保存。
            </p>
          )}
          {page === 10 && <Overview data={data} navigate={navigate} busy={busy} act={act} />}
          {page === 7 && <Console onDraftSaveStart={onDraftSaveStart} />}
          {page === 8 && (
            <>
              <Postiz act={act} busy={busy} />
              <Integrations act={act} busy={busy} />
              <Orders act={act} busy={busy} data={data} />
            </>
          )}
          {page === 9 && <Retail data={data} act={act} busy={busy} />}
          {page === 3 && <Attribution data={data} />}
          {page === 6 && <CRM data={data} act={act} busy={busy} confirmDiscard={confirmDiscard} />}
          {page === 0 && <StartChecklist data={data} navigate={navigate} />}
          {page === 5 && (
            <Planning
              data={data}
              act={act}
              busy={busy}
              navigate={navigate}
              section={section}
              target={target}
              confirmDiscard={confirmDiscard}
            />
          )}
          {page === 0 && <BrandPage brand={data.brand} busy={busy} act={act} />}
          {page === 1 && (
            <Market
              data={data}
              busy={busy || pending.some((t) => t.kind === "suggest")}
              act={act}
              next={() => navigate(2)}
            />
          )}
          {page === 2 && (
            <Studio
              data={data}
              busy={busy}
              act={act}
              target={target}
              selectContent={(id) => navigate(2, "", id)}
              confirmDiscard={confirmDiscard}
            />
          )}
          {page === 3 && <Metrics data={data} busy={busy} act={act} />}
          {page === 4 && (
            <Workflows
              data={data}
              busy={busy}
              act={act}
              section={section}
              target={target}
              navigate={navigate}
            />
          )}
          <section className="tasks">
            <div className="section-title">
              <h3>任务活动</h3>
              <span>
                {pending.length ? "正在处理 " + pending.length + " 项" : "所有任务状态已同步"}
              </span>
            </div>
            {!data.tasks.length ? (
              <p className="muted">保存品牌、导入资料后，开始你的第一项任务。</p>
            ) : (
              data.tasks
                .slice(-6)
                .reverse()
                .map((t) => (
                  <div className="task" key={t.id}>
                    <span className={"status " + t.status}>
                      {
                        {
                          queued: "排队",
                          running: "处理中",
                          succeeded: "完成",
                          failed: "失败",
                        }[t.status]
                      }
                    </span>
                    <div>
                      <strong>
                        {
                          {
                            fetch: "公开资料抓取",
                            suggest: "生成营销建议",
                            content: "生成英文文案与分镜",
                            render: "视频渲染",
                            sync: "同步监测来源",
                          }[t.kind]
                        }
                      </strong>
                      <small>
                        {t.error || t.result || "任务处理中，请稍候"} · 尝试 {t.attempt} 次 ·{" "}
                        {fmt(t.updatedAt)}
                      </small>
                    </div>
                    {t.status === "failed" && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => act(`tasks/${t.id}/retry`, {})}
                      >
                        重试
                      </button>
                    )}
                  </div>
                ))
            )}
          </section>
        </section>
        <footer>
          HARBOR · 证据驱动，人来决策。
          <span>LOCAL FIRST / NO AUTO PUBLISH</span>
        </footer>
      </main>
    </div>
  );
}
type Act = (path: string, body: unknown) => Promise<any>;
function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label>
      {label}
      <input {...props} />
    </label>
  );
}
function BrandPage({ brand, busy, act }: { brand: Brand | null; busy: boolean; act: Act }) {
  const [b, setB] = useState(brand || blank);
  const [competitors, setCompetitors] = useState((brand?.competitors || []).join("\n"));
  const [imgError, setImgError] = useState("");
  const set = (key: keyof Brand, value: string) => setB({ ...b, [key]: value });
  return (
    <div className="two-col">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void act("brand", {
            ...b,
            competitors: competitors
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          });
        }}
      >
        <div className="section-title">
          <h2>品牌基础信息</h2>
          <span>01 / BRAND DNA</span>
        </div>
        {brand?.activeProductId && (
          <p className="notice">
            当前绑定目录商品：{brand.product}
            。修改商品名称或参数后，需要到“活动与商品”重新选择商品，才能继续使用该商品的事实。
          </p>
        )}
        <div className="grid">
          <Field
            label="品牌名称"
            value={b.name}
            required
            onChange={(e) => set("name", e.target.value)}
            placeholder="例如：North Coast"
          />
          <Field
            label="品牌网址"
            type="url"
            value={b.url}
            required
            onChange={(e) => set("url", e.target.value)}
            placeholder="https://your-brand.com"
          />
        </div>
        <Field
          label="产品名称（建议英文，用于英文文案）"
          value={b.product}
          required
          onChange={(e) => set("product", e.target.value)}
          placeholder="例如：Everyday insulated bottle"
        />
        <label>
          产品参数与已确认事实
          <textarea
            required
            value={b.parameters}
            onChange={(e) => set("parameters", e.target.value)}
            placeholder="材质、规格、定价、已验证的功能；不要填无法证实的宣传承诺。"
          />
        </label>
        <div className="grid">
          <Field
            label="目标市场"
            value={b.market}
            required
            onChange={(e) => set("market", e.target.value)}
          />
          <Field
            label="目标受众"
            value={b.audience}
            required
            onChange={(e) => set("audience", e.target.value)}
            placeholder="例如：城市通勤者"
          />
        </div>
        <label>
          竞品网址 · 最多 3 个，每行一个
          <textarea
            value={competitors}
            onChange={(e) => setCompetitors(e.target.value)}
            placeholder="https://competitor.com"
          />
        </label>
        <button disabled={busy} className="primary">
          保存品牌档案 <span>↗</span>
        </button>
        {brand && (
          <p className="muted">上次保存：{fmt(brand.updatedAt)} · 已有内容保留其生成时的品牌快照</p>
        )}
      </form>
      <div>
        <div className="product-card">
          <p className="eyebrow">YOUR NEXT STORY</p>
          {b.image ? (
            <img src={b.image} alt="产品图片" />
          ) : (
            <div className="bottle">
              <div />
              <span>
                YOUR
                <br />
                BRAND
              </span>
            </div>
          )}
          <h2>{b.name || "从你的产品开始"}</h2>
          <p>{b.image ? "已上传产品图片" : "自制示意素材 · 非真实产品照片"}</p>
          <label className="upload">
            上传产品图片
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 2000000) {
                  setImgError("图片不能超过 2MB");
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                  set("image", String(reader.result));
                  setImgError("");
                };
                reader.readAsDataURL(f);
              }}
            />
          </label>
          {imgError && <p>{imgError}</p>}
        </div>
        <div className="hint">
          <h3>每一步都可追溯</h3>
          <p>品牌参数 → 公开证据 → 营销建议 → 内容版本 → 人工批准 → 效果记录</p>
          <p>没有模型配置时使用规则模板，不伪装为真实 AI 分析。</p>
        </div>
      </div>
    </div>
  );
}
function Market({
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
function Studio({
  data,
  busy,
  act,
  target,
  selectContent,
  confirmDiscard,
}: {
  data: Data;
  busy: boolean;
  act: Act;
  target: string;
  selectContent: (id: string) => void;
  confirmDiscard: () => boolean;
}) {
  const [selected, setSelected] = useState(() => target || data.contents.at(-1)?.id || "");
  useEffect(() => {
    if (target) setSelected(target);
    else if (!selected && data.contents.length) setSelected(data.contents.at(-1)!.id);
  }, [target, selected, data.contents]);
  const c = data.contents.find((c) => c.id === selected);
  return (
    <>
      {data.contents.length > 0 && (
        <label>
          选择内容
          <select
            aria-label="选择内容"
            value={c?.id || ""}
            onChange={(e) => selectContent(e.target.value)}
          >
            {data.contents.map((c, i) => (
              <option value={c.id} key={c.id}>
                {i + 1}. {c.suggestion.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {c ? (
        <Editor
          key={c.id}
          c={c}
          state={data}
          guidelinesAt={data.guidelines?.updatedAt || ""}
          busy={
            busy ||
            data.tasks.some(
              (t) =>
                t.kind === "render" &&
                t.payload.contentId === c.id &&
                ["queued", "running"].includes(t.status),
            )
          }
          act={act}
          confirmDiscard={confirmDiscard}
        />
      ) : selected ? (
        <div className="notice error" role="alert">
          这条内容不存在或已不在当前品牌中。请从上方选择当前品牌的其他内容。
        </div>
      ) : (
        <div className="empty big">
          <span>▣</span>
          <h2>下一条品牌故事，从证据开始</h2>
          <p>在「市场动态」生成建议，选择一个角度生成英文文案和 30 秒分镜。</p>
        </div>
      )}
    </>
  );
}
function Editor({
  c,
  state,
  busy,
  act,
  guidelinesAt,
  confirmDiscard,
}: {
  c: Content;
  state: State;
  busy: boolean;
  act: Act;
  guidelinesAt: string;
  confirmDiscard: () => boolean;
}) {
  const latest = c.revisions.at(-1)!;
  const [baseRevisionId, setBaseRevisionId] = useState(latest.id);
  const r = c.revisions.find((revision) => revision.id === baseRevisionId) || latest;
  const factIssues = revisionFactIssues(state, r);
  const availableFacts = applicableFacts(state, r.brand);
  const approved =
    !!r.approvedAt && (r.approvalGuidelinesAt || "") === guidelinesAt && factIssues.length === 0;
  const [copy, setCopy] = useState(r.copy);
  const [scenes, setScenes] = useState(r.scenes);
  const [renderer, setRenderer] = useState(r.renderer || "hyperframes");
  const [savedDraft, setSavedDraft] = useState(false);
  const [factReview, setFactReview] = useState({
    enabled: false,
    confirmed: false,
    actor: "",
    reason: "",
    factIds: [] as string[],
  });
  const liveDraft = useRef({ copy, scenes, renderer, factReview });
  liveDraft.current = { copy, scenes, renderer, factReview };
  const dirty =
    factReview.enabled ||
    copy !== r.copy ||
    JSON.stringify(scenes) !== JSON.stringify(r.scenes) ||
    renderer !== (r.renderer || "hyperframes");
  const conflict = latest.id !== r.id;
  useEffect(() => {
    if (!conflict || (dirty && !savedDraft)) return;
    setBaseRevisionId(latest.id);
    setCopy(latest.copy);
    setScenes(latest.scenes);
    setRenderer(latest.renderer || "hyperframes");
    setSavedDraft(false);
  }, [conflict, dirty, savedDraft, latest]);
  const root = `/api/contents/${c.id}/${r.id}`;
  return (
    <>
      <div className="version-bar">
        <span className="badge">VERSION {r.number}</span>
        <strong>{approved ? "已批准当前版本" : "等待人工审核"}</strong>
        <small>
          {r.mode === "model" ? "模型草稿" : "模板演示文案"} ·{" "}
          {dirty ? "未保存的修改，保存后须重新批准" : fmt(r.createdAt)}
        </small>
      </div>
      {conflict && dirty && !savedDraft && (
        <div className="notice error" role="alert">
          <div>
            服务器已有 V{latest.number}，你的未保存文案与分镜仍保留在下方。请核对最新版本后继续。
            <details>
              <summary>查看服务器最新文案与分镜</summary>
              <pre className="json-preview">
                {latest.copy}
                {"\n\n"}
                {latest.scenes
                  .map((scene) => `${scene.start}–${scene.end}s：${scene.text}\n${scene.visual}`)
                  .join("\n\n")}
              </pre>
            </details>
            <button type="button" onClick={() => setBaseRevisionId(latest.id)}>
              保留我的修改，基于最新版本继续
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirmDiscard()) {
                  setBaseRevisionId(latest.id);
                  setCopy(latest.copy);
                  setScenes(latest.scenes);
                  setRenderer(latest.renderer || "hyperframes");
                }
              }}
            >
              放弃我的修改并加载最新版本
            </button>
          </div>
        </div>
      )}
      <div className="two-col studio" data-draft-scope={`content:${c.id}`}>
        <div className="card">
          <h2>英文营销文案</h2>
          <label>
            可编辑文案
            <textarea
              className="copy"
              value={copy}
              onChange={(e) => {
                setSavedDraft(false);
                setCopy(e.target.value);
              }}
            />
          </label>
          <h3>30 秒视频分镜</h3>
          {scenes.map((s, i) => (
            <div className="scene-edit" key={i}>
              <span>
                {s.start}–{s.end}s
              </span>
              <label>
                屏幕文案 {i + 1}
                <input
                  value={s.text}
                  onChange={(e) => {
                    setSavedDraft(false);
                    setScenes(scenes.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)));
                  }}
                />
              </label>
              <label>
                画面说明 {i + 1}
                <input
                  value={s.visual}
                  onChange={(e) => {
                    setSavedDraft(false);
                    setScenes(
                      scenes.map((x, j) => (j === i ? { ...x, visual: e.target.value } : x)),
                    );
                  }}
                />
              </label>
            </div>
          ))}
          <p className="muted">
            画面说明用于人工分镜交付；当前渲染器采用固定图片缩放与文字淡入，修改说明不会自动改变动画类型。
          </p>
          {factIssues.length > 0 && (
            <div className="notice error" role="alert">
              <div>
                <strong>事实依据需要复核，当前版本不能审批或交付</strong>
                <ul>
                  {factIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
                <p>
                  请先在“运营流程 →
                  来源与事实”确认适用范围，修改上方文案及分镜，再完成下方复核；也可以重新生成内容。
                </p>
              </div>
            </div>
          )}
          <fieldset>
            <legend>重新核查此版本的事实依据</legend>
            <p className="muted">
              内容商品：
              {state.products.find((p) => p.id === r.brand.activeProductId)?.title ||
                "未绑定目录商品"}
              。只有品牌通用事实和这个商品的有效事实可选。重新核查会生成新版本并清除旧审批。
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={factReview.enabled}
                onChange={(event) => {
                  setSavedDraft(false);
                  setFactReview({ ...factReview, enabled: event.target.checked });
                }}
              />
              本次保存包含事实复核
            </label>
            {factReview.enabled && (
              <>
                {availableFacts.map((fact) => (
                  <label className="check" key={fact.id}>
                    <input
                      type="checkbox"
                      checked={factReview.factIds.includes(fact.id)}
                      onChange={(event) => {
                        setSavedDraft(false);
                        setFactReview({
                          ...factReview,
                          factIds: event.target.checked
                            ? [...factReview.factIds, fact.id]
                            : factReview.factIds.filter((id) => id !== fact.id),
                        });
                      }}
                    />
                    {fact.scope === "product" ? "商品" : "品牌通用"}：{fact.text}
                  </label>
                ))}
                {!availableFacts.length && (
                  <p>
                    没有适用于此内容的有效事实。请先补充事实，或删除文案与分镜中依赖旧事实的表述后明确复核。
                  </p>
                )}
                <Field
                  label="事实复核人（自报）"
                  value={factReview.actor}
                  maxLength={120}
                  onChange={(e) => setFactReview({ ...factReview, actor: e.target.value })}
                />
                <label>
                  事实复核说明
                  <textarea
                    minLength={5}
                    maxLength={1000}
                    value={factReview.reason}
                    onChange={(e) => setFactReview({ ...factReview, reason: e.target.value })}
                    placeholder="说明更换了哪些依据、修改或删除了哪些声明。"
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={factReview.confirmed}
                    onChange={(e) => setFactReview({ ...factReview, confirmed: e.target.checked })}
                  />
                  我已核对全文与分镜，所选事实覆盖保留的声明；未选事实的相关声明已删除。
                </label>
              </>
            )}
          </fieldset>
          <button
            className="secondary"
            disabled={
              busy ||
              !dirty ||
              conflict ||
              (factReview.enabled &&
                (!factReview.confirmed ||
                  !factReview.actor.trim() ||
                  factReview.reason.trim().length < 5))
            }
            onClick={async () => {
              const submitted = JSON.stringify({ copy, scenes, renderer, factReview });
              const result = await act(`contents/${c.id}/revise`, {
                baseRevisionId: r.id,
                copy,
                scenes,
                renderer,
                ...(factReview.enabled
                  ? {
                      factReview: {
                        confirmed: factReview.confirmed,
                        actor: factReview.actor,
                        reason: factReview.reason,
                        factIds: factReview.factIds,
                      },
                    }
                  : {}),
              });
              if (result && JSON.stringify(liveDraft.current) === submitted) {
                setSavedDraft(true);
                setFactReview({
                  enabled: false,
                  confirmed: false,
                  actor: "",
                  reason: "",
                  factIds: [],
                });
              }
            }}
          >
            保存为新版本（原审批失效）
          </button>
        </div>
        <div>
          <div className="card preview-card">
            <div className="section-title">
              <h2>动态预览</h2>
              <span>30 SEC / 16:9</span>
            </div>
            <label>
              视频渲染器
              <select
                value={renderer}
                onChange={(e) => {
                  setSavedDraft(false);
                  setRenderer(e.target.value as "hyperframes" | "remotion");
                }}
              >
                <option value="hyperframes">HyperFrames</option>
                <option value="remotion">Remotion</option>
              </select>
            </label>
            <p className="muted">切换渲染器后，请保存为新版本并重新批准。</p>
            <div className="preview-wrap">
              {r.video ? (
                <video
                  aria-label="已渲染 MP4 预览"
                  controls
                  src={`${root}/video-preview?project=${encodeURIComponent(project)}`}
                  style={{ width: "100%", height: "100%" }}
                />
              ) : (
                <iframe
                  title="30秒动态预览"
                  src={`${root}/preview?project=${encodeURIComponent(project)}`}
                  sandbox="allow-scripts"
                />
              )}
            </div>
            <p className="muted">
              未渲染时展示通用分镜动画示意；生成后显示真实 MP4。
              {r.brand.image ? "使用上传的产品图片。" : "当前使用自制示意素材。"}
            </p>
            <button
              className="secondary"
              disabled={busy || dirty || conflict}
              onClick={() =>
                act("tasks", {
                  kind: "render",
                  payload: { contentId: c.id, revisionId: r.id },
                })
              }
            >
              {busy
                ? "任务处理中…"
                : r.video
                  ? "重新渲染 MP4"
                  : `使用 ${r.renderer === "remotion" ? "Remotion" : "HyperFrames"} 渲染 MP4`}
            </button>
            {r.video && <p className="success">✓ MP4 已生成并通过 ffprobe 时长校验</p>}
          </div>
          <div className="card approval">
            <h3>人工审核与交付</h3>
            <p>核对产品事实、来源、措辞及画面，批准后可下载当前版本。修改后必须重新批准。</p>
            <button
              className="primary"
              disabled={busy || dirty || approved || conflict || factIssues.length > 0}
              onClick={() => act(`contents/${c.id}/approve`, { revisionId: r.id })}
            >
              批准当前版本 V{r.number} ✓
            </button>
            {approved && !dirty && (
              <div className="downloads">
                <a href={`${root}/download?project=${encodeURIComponent(project)}`}>
                  下载文案、分镜与证据 JSON ↓
                </a>
                {r.video && (
                  <a href={`${root}/video?project=${encodeURIComponent(project)}`}>
                    下载 MP4 视频 ↓
                  </a>
                )}
              </div>
            )}
          </div>
          <details className="card">
            <summary>版本历史与引用证据</summary>
            {c.revisions.map((x) => (
              <p key={x.id}>
                V{x.number} · {fmt(x.createdAt)} · {x.approvedAt ? "曾批准" : "未批准"}
                {x.id !== r.id ? "（已非当前版本，不可下载）" : ""}
                {x.factReview && (
                  <small>
                    {" "}
                    · 事实复核：{x.factReview.actor}（自报）· {fmt(x.factReview.reviewedAt)} ·{" "}
                    {x.factReview.reason}
                  </small>
                )}
              </p>
            ))}
            {r.evidence.map((e) => (
              <blockquote key={e.id}>
                <a href={e.url} target="_blank" rel="noreferrer">
                  {e.title}
                </a>
                <p>{e.text}</p>
                <small>
                  {e.demo ? "演示资料" : "公开资料"} · {e.hash}
                </small>
              </blockquote>
            ))}
          </details>
        </div>
      </div>
    </>
  );
}
function Metrics({ data, busy, act }: { data: Data; busy: boolean; act: Act }) {
  const options = data.contents.flatMap((c) =>
    c.revisions.filter((r) => r.approvedAt).map((r) => ({ c, r })),
  );
  const [revision, setRevision] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [sampledAt, setSampledAt] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const chosen = options.find((x) => x.r.id === revision) || options[0];
  const campaigns = data.campaigns.filter((campaign) =>
    campaign.contentIds.includes(chosen?.c.id || ""),
  );
  const selectedCampaign = campaigns.some((campaign) => campaign.id === campaignId)
    ? campaignId
    : "";
  const quality = metricQuality(data.metrics);
  const statusLabels = {
    included: "已计入汇总",
    duplicate: "重复已排除",
    "missing-window": "统计窗口未确认",
    "invalid-window": "统计窗口无效",
    conflict: "窗口冲突 · 待核对",
    voided: "已撤销",
  };
  return (
    <>
      <div className="card">
        <h2>记录一次发布效果</h2>
        <p className="muted">手动录入，不连接广告账户。历史已批准版本仍可记录发布后的效果。</p>
        <form
          data-draft-scope="metric-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!chosen) return;
            const f = new FormData(e.currentTarget);
            void act("metrics", {
              contentId: chosen.c.id,
              revisionId: chosen.r.id,
              url: f.get("url"),
              date: new Date(sampledAt).toISOString(),
              windowStart: new Date(windowStart).toISOString(),
              windowEnd: new Date(windowEnd).toISOString(),
              impressions: Number(f.get("impressions")),
              clicks: Number(f.get("clicks")),
              conversions: Number(f.get("conversions")),
              spend: Number(f.get("spend")),
              notes: f.get("notes"),
              currency,
              timezone: f.get("timezone"),
              campaignId: selectedCampaign || undefined,
              channel: String(f.get("channel") || "").trim() || undefined,
            });
          }}
        >
          <label>
            已批准内容版本
            <select
              aria-label="已批准内容版本"
              required
              value={chosen?.r.id || ""}
              onChange={(e) => setRevision(e.target.value)}
            >
              <option value="" disabled>
                请先批准一个内容版本
              </option>
              {options.map(({ c, r }) => (
                <option key={r.id} value={r.id}>
                  {c.suggestion.title} · V{r.number}
                </option>
              ))}
            </select>
          </label>
          <div className="grid">
            <Field label="发布链接" name="url" required type="url" />
            <Field
              label="采样时间"
              name="date"
              required
              type="datetime-local"
              step="0.001"
              min={windowEnd || undefined}
              value={sampledAt}
              onChange={(event) => setSampledAt(event.target.value)}
            />
          </div>
          <div className="grid">
            <Field
              label="统计窗口开始"
              name="windowStart"
              required
              type="datetime-local"
              step="0.001"
              value={windowStart}
              onChange={(event) => setWindowStart(event.target.value)}
            />
            <Field
              label="统计窗口结束（不含）"
              name="windowEnd"
              required
              type="datetime-local"
              step="0.001"
              min={windowStart || undefined}
              value={windowEnd}
              onChange={(event) => setWindowEnd(event.target.value)}
            />
          </div>
          <p className="muted">
            窗口和采样时间按设备时区 {deviceTimezone}{" "}
            输入。填写数据实际覆盖的区间，起点计入、终点不计入；采样时间是读取或导出报表的时间，不能早于窗口结束。报表时区只记录统计口径。
          </p>
          <div className="grid">
            <label>
              关联活动（可选）
              <select
                aria-label="关联活动（可选）"
                value={selectedCampaign}
                onChange={(event) => setCampaignId(event.target.value)}
              >
                <option value="">未指定，尝试按唯一 UTM 归因</option>
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              效果渠道（可选）
              <input
                aria-label="效果渠道（可选）"
                name="channel"
                list="metric-channel-options"
                maxLength={100}
                placeholder="linkedin / email / x"
              />
              <datalist id="metric-channel-options">
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </datalist>
            </label>
          </div>
          <div className="grid">
            <Field
              label="花费币种"
              name="currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              pattern="[A-Z]{3}"
              maxLength={3}
              required
              placeholder="USD / CNY / EUR"
            />
            <Field
              label="报表时区（IANA）"
              name="timezone"
              defaultValue={deviceTimezone}
              required
              placeholder="Asia/Shanghai"
            />
          </div>
          <div className="grid four">
            {[
              ["impressions", "曝光"],
              ["clicks", "点击"],
              ["conversions", "转化"],
              ["spend", `花费（${currency || "未选币种"}）`],
            ].map(([n, l]) => (
              <Field
                key={n}
                label={l}
                name={n}
                type="number"
                min="0"
                step={n === "spend" ? "0.01" : "1"}
                defaultValue="0"
                required
              />
            ))}
          </div>
          <label>
            观察与复盘
            <textarea name="notes" placeholder="记录报表来源、统计口径及下一次实验方向…" />
          </label>
          <button className="primary" disabled={busy || !chosen}>
            保存效果记录 ↗
          </button>
        </form>
      </div>
      <div className="section-title spaced" id="metric-records">
        <h2>原始效果记录</h2>
        <span>
          {data.metrics.length} 条保留记录 · {quality.counts.included} 条计入汇总
        </span>
      </div>
      <div className="card table-wrap">
        <table style={{ minWidth: 1240 }}>
          <thead style={{ whiteSpace: "nowrap" }}>
            <tr>
              <th>发布 / 版本</th>
              <th>窗口 / 采样</th>
              <th>汇总状态</th>
              <th>曝光</th>
              <th>点击</th>
              <th>CTR</th>
              <th>转化</th>
              <th>花费</th>
              <th>复盘</th>
            </tr>
          </thead>
          <tbody>
            {quality.rows.map(({ metric: m, status, issues, relatedIds }, index) => {
              if (!m || typeof m !== "object")
                return (
                  <tr key={`invalid-${index}`}>
                    <td colSpan={9}>
                      历史指标记录格式无效，暂不计入汇总。原始数据保留，请核对导入来源。
                    </td>
                  </tr>
                );
              return (
                <tr key={m.id || `invalid-${index}`} id={m.id ? `metric-${m.id}` : undefined}>
                  <td>
                    <a href={m.url} target="_blank" rel="noreferrer">
                      发布链接 ↗
                    </a>
                    <small>
                      V
                      {
                        data.contents
                          .find((c) => c.id === m.contentId)
                          ?.revisions.find((r: Revision) => r.id === m.revisionId)?.number
                      }
                    </small>
                    <small>
                      {m.channel || "未指定渠道"} ·{" "}
                      {data.campaigns.find((campaign) => campaign.id === m.campaignId)?.name ||
                        "未直接指定活动"}
                    </small>
                  </td>
                  <td>
                    {m.windowStart && m.windowEnd ? (
                      <>
                        <small>开始：{fmt(m.windowStart)}</small>
                        <small>结束：{fmt(m.windowEnd)}（不含）</small>
                      </>
                    ) : (
                      <small>统计窗口未填写</small>
                    )}
                    <small>采样：{fmt(m.date)}</small>
                    <small>报表时区：{m.timezone || "未登记"}</small>
                  </td>
                  <td>
                    <span className={`badge${status === "included" ? "" : " amber"}`}>
                      {statusLabels[status]}
                    </span>
                    {issues.length > 0 && (
                      <ul>
                        {issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    )}
                    {relatedIds.length > 0 && (
                      <details>
                        <summary>查看关联记录（{relatedIds.length}）</summary>
                        {relatedIds.map((id) => (
                          <button
                            key={id}
                            type="button"
                            className="secondary"
                            onClick={() =>
                              document
                                .getElementById(`metric-${id}`)
                                ?.scrollIntoView({ block: "center" })
                            }
                          >
                            查看记录 {data.metrics.findIndex((metric) => metric?.id === id) + 1}
                          </button>
                        ))}
                      </details>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.impressions) ? m.impressions : "无效数值"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.clicks) ? m.clicks : "无效数值"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.impressions) &&
                    m.impressions > 0 &&
                    Number.isFinite(m.clicks)
                      ? ((m.clicks / m.impressions) * 100).toFixed(1) + "%"
                      : "—"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.conversions) ? m.conversions : "无效数值"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {Number.isFinite(m.spend) ? m.spend.toFixed(2) : "无效数值"}{" "}
                    {typeof m.currency === "string" ? m.currency : "未登记币种"}
                  </td>
                  <td>
                    {typeof m.notes === "string" ? m.notes : ""}
                    {m.voidedAt ? (
                      <p>
                        撤销：{m.voidedBy}（自报）· {fmt(m.voidedAt)}
                        <br />
                        原因：{m.voidReason}
                      </p>
                    ) : (
                      m.id && (
                        <details>
                          <summary>撤销需要更正的记录</summary>
                          <form
                            data-draft-scope={`metric-void:${m.id}`}
                            onSubmit={(event) => {
                              event.preventDefault();
                              const form = new FormData(event.currentTarget);
                              void act(`metrics/${m.id}/void`, {
                                actor: form.get("actor"),
                                reason: form.get("reason"),
                              });
                            }}
                          >
                            <p>
                              撤销后仍保留原始数值和原因，但不再计入汇总。核对正确窗口后可重新录入。
                            </p>
                            <label>
                              撤销人（自报）
                              <input name="actor" required maxLength={120} />
                            </label>
                            <label>
                              指标撤销原因
                              <textarea name="reason" required maxLength={2000} />
                            </label>
                            <button className="secondary" disabled={busy}>
                              确认撤销指标记录
                            </button>
                          </form>
                        </details>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!data.metrics.length && (
          <p className="empty">还没有效果记录。先批准并下载内容，再手动发布。</p>
        )}
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
