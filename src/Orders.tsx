import { useEffect, useState } from "react";
import type { State } from "../server/types";
import type { previewOrders } from "../server/connectors/orders";
type Preview = ReturnType<typeof previewOrders>;
const fields = [
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
];
export default function Orders({
  act,
  busy,
  data,
}: {
  act: (path: string, body: unknown) => Promise<any>;
  busy: boolean;
  data: State;
}) {
  const [text, setText] = useState("");
  const [sourceName, setSource] = useState("offline-orders");
  const [demo, setDemo] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f, f])),
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("");
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let active = true;
    fetch("/api/retail")
      .then(async (r) => {
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || "门店读取失败");
        return out;
      })
      .then((out) => {
        if (active) setStores(out.stores || []);
      })
      .catch((error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, [data]);
  const reset = () => {
    setPreview(null);
    setMessage("");
  };
  const sample = () => {
    const store = stores[0]?.id || "DEMO-STORE",
      sku = data.products[0]?.sku || "DEMO-SKU";
    const saleDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) + "T10:00:00Z",
      returnDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10) + "T10:00:00Z";
    const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
    setText(
      fields.join(",") +
        "\n" +
        ["demo-order-001-line-1", store, sku, saleDate, "2", "40", "USD", "sale", "", "", "store"]
          .map(cell)
          .join(",") +
        "\n" +
        [
          "demo-return-001",
          store,
          sku,
          returnDate,
          "-1",
          "-20",
          "USD",
          "return",
          "demo-order-001-line-1",
          "",
          "store",
        ]
          .map(cell)
          .join(","),
    );
    setSource("demo-orders");
    setDemo(true);
    setMapping(Object.fromEntries(fields.map((f) => [f, f])));
    reset();
  };
  return (
    <section className="panel operations-extension" data-draft-scope="orders-import">
      <h2>订单与退款 CSV 导入</h2>
      <p className="notice">
        离线导入 · Shopify / POS 未连接 · 不发生远程同步，不创建营销指标，避免与手动 metrics
        重复统计。
      </p>
      <p>
        每行是一个销售商品行或退货事件。externalId 必须在固定 sourceName 中唯一；相同 ID
        与相同内容重复导入会忽略，内容变化则整批阻止。支持同批销售与退货任意行序；退款必须关联已存在或同批次的原销售行。
      </p>
      <p>
        revenue
        是该行折后净商品金额，不含税运；销售正数量与非负金额，退款负数量与非正金额。不能直接使用
        Shopify 的订单 Total/Subtotal
        或单价；请在源文件中计算行级净额。此版本只接受最多两位小数的金额。
      </p>
      <p>
        当前门店：
        {stores.map((s) => `${s.id}（${s.name}）`).join("、") || "尚无；请先在零售工作台创建门店"}
        。可用 SKU：
        {data.products.map((p) => p.sku).join("、") || "尚无；请先导入商品"}。
      </p>
      <label>
        稳定来源名称
        <input
          value={sourceName}
          onChange={(e) => {
            setSource(e.target.value);
            reset();
          }}
          placeholder="例如 store-a-pos-export"
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={demo}
          onChange={(e) => {
            setDemo(e.target.checked);
            reset();
          }}
        />
        演示数据（不会自动推定为真实销量）
      </label>
      <button disabled={busy} onClick={sample}>
        载入销售与退货样例（未保存）
      </button>
      <label>
        上传 CSV
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            reset();
            if (file.size > 1000000) {
              setMessage("文件不能超过 1MB");
              return;
            }
            setText(await file.text());
          }}
        />
      </label>
      <label>
        订单行 CSV
        <textarea
          rows={9}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            reset();
          }}
        />
      </label>
      <details>
        <summary>字段映射（值为 CSV 表头名称）</summary>
        <div className="grid">
          {fields.map((field) => (
            <label key={field}>
              {field}
              <input
                value={mapping[field]}
                onChange={(e) => {
                  setMapping({ ...mapping, [field]: e.target.value });
                  reset();
                }}
              />
            </label>
          ))}
        </div>
        <p>
          originalId 仅退货必需，关联同来源的原销售 externalId。campaignId、channel
          可留空；无活动关联显示未知归因，不自动推断。
        </p>
      </details>
      <div className="actions">
        <button
          disabled={busy || !text || !sourceName}
          onClick={async () => {
            reset();
            const out = await act("orders/preview", {
              text,
              sourceName,
              demo,
              mapping,
            });
            if (out) setPreview(out);
          }}
        >
          预检订单（不保存）
        </button>
        <button
          disabled={busy || !preview?.valid || !preview.count}
          onClick={async () => {
            const out = await act("orders/import", {
              text,
              sourceName,
              demo,
              mapping,
            });
            if (out) {
              setMessage(
                `新增 ${out.count} 个事件，忽略重复 ${out.duplicates} 个。已写入当前品牌销售账本。`,
              );
              setPreview(null);
            }
          }}
        >
          确认导入订单
        </button>
      </div>
      {message && <p className="notice">{message}</p>}
      {preview && (
        <>
          <p className="notice">
            {preview.valid
              ? `预检通过：新增 ${preview.count}，重复 ${preview.duplicates}`
              : "发现错误或冲突：整批无法导入"}
            ；当前尚未保存。
          </p>
          <table>
            <thead>
              <tr>
                <th>CSV 行</th>
                <th>事件 ID / SKU</th>
                <th>数量 / 净额</th>
                <th>活动</th>
                <th>校验</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((item) => (
                <tr key={item.line}>
                  <td>{item.line}</td>
                  <td>
                    {item.row.externalId} / {item.row.sku}
                  </td>
                  <td>
                    {item.row.quantity} / {item.row.revenue} {item.row.currency}
                  </td>
                  <td>{item.row.campaignId || "未知归因"}</td>
                  <td>{item.errors.join("；") || (item.duplicate ? "重复，跳过" : "通过")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
