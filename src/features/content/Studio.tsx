import { useState, useEffect } from "react";
import type { Act, Data } from "../../shared/types.ts";
import { Editor } from "./Editor";
export function Studio({
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
