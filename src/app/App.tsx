import { useState, useEffect, useRef } from "react";
import type { Data } from "../shared/types.ts";
import { fmt } from "../shared/format";
import { project } from "../shared/workspace";
import { BrandPage } from "../features/brand/BrandPage";
import { Market } from "../features/sources/Market";
import { Studio } from "../features/content/Studio";
import { Metrics } from "../features/analytics/Metrics";
import { Retail } from "../features/retail/Retail";
import Orders from "../features/integrations/Orders";
import { Console } from "../features/workspace/Console";
import Integrations from "../features/integrations/Integrations";
import { Attribution } from "../features/analytics/Attribution";
import { CRM } from "../features/crm/CRM";
import { Planning, StartChecklist } from "../features/campaigns/Planning";
import { Workflows } from "../features/operations/Workflows";
import { Overview } from "../features/workspace/Overview";
import { Postiz } from "../features/integrations/Postiz";
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
export function App() {
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
