import { useState } from "react";
import type { Brand } from "../../../server/types";
import type { Act } from "../../shared/types.ts";
import { Field } from "../../components/Field";
import { fmt } from "../../shared/format";
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
export function BrandPage({ brand, busy, act }: { brand: Brand | null; busy: boolean; act: Act }) {
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
