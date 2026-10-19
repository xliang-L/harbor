import { useState, useEffect, useRef } from "react";
import type { State, Content } from "../../../server/types";
import type { Act } from "../../shared/types.ts";
import { Field } from "../../components/Field";
import { fmt } from "../../shared/format";
import { project } from "../../shared/workspace";
import { applicableFacts, revisionFactIssues } from "../../../server/domain/facts";
export function Editor({
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
