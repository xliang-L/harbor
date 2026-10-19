import { useEffect, useState } from "react";
const demo = {
  results: [
    {
      id: "demo-101",
      properties: {
        company: "DEMO Harbor Retail",
        website: "https://retail.example.com",
        firstname: "Demo",
        lastname: "Buyer",
        email: "buyer@retail.example.com",
        industry: "Retail",
        country: "US",
        hubspot_owner_id: "demo-owner",
        sourceUrl: "https://example.com/demo",
      },
      archived: false,
    },
    {
      id: "demo-102",
      properties: {
        company: "DEMO Harbor Agency",
        website: "agency.example.com",
        firstname: "Demo",
        lastname: "Partner",
        email: "partner@agency.example.com",
        industry: "Agency",
        country: "UK",
        hubspot_owner_id: "demo-owner",
        sourceUrl: "https://example.com/demo",
      },
      archived: false,
    },
  ],
};
type Mapping = Record<string, string>;
type Preview = {
  valid: boolean;
  skipped: number;
  counts: { count: number; duplicates: number } | null;
  rows: {
    line: number;
    valid: boolean;
    skipped: boolean;
    errors: string[];
    row: Record<string, string>;
  }[];
};
export default function Integrations({
  act,
  busy,
}: {
  act: (path: string, body: unknown) => Promise<any>;
  busy: boolean;
}) {
  const [mapping, setMapping] = useState<Mapping>({});
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/integrations")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "无法加载连接状态");
        return data;
      })
      .then((data) => {
        if (active) {
          setMapping(data.mapping);
          setStatus(data.note);
        }
      })
      .catch((e) => {
        if (active) setStatus(`加载失败：${e.message}`);
      });
    return () => {
      active = false;
    };
  }, []);
  const reset = () => {
    setPreview(null);
    setResult("");
  };
  return (
    <section className="panel operations-extension" data-draft-scope="hubspot-import">
      <h2>平台接入与本地导入</h2>
      <p className="notice">
        HubSpot：未连接 · 邮箱：未连接 · Webhook：未连接 · Shopify：仅文件导入（品牌工作台）
      </p>
      <p>{status || "正在读取连接状态…"}</p>
      <h3>HubSpot 联系人 JSON → 当前品牌 B2B 线索</h3>
      <p>
        支持最多 500 条联系人数组或 API 导出形状的 results 数组、properties
        字段。必须提供公司、姓名、邮箱和来源链接（HubSpot 导出缺少来源时需补充 sourceUrl
        或映射现有字段）。归档联系人跳过；相同公司/域名与邮箱按 CRM
        规则去重。重复记录不会更新已有资料。邮箱导出的同形状 JSON 可手动粘贴；不接受只有事件 ID 的
        webhook 通知，也不发送邮件。
      </p>
      <label>
        导入文件
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            reset();
            if (file.size > 1000000) {
              setResult("文件不能超过 1MB");
              return;
            }
            setText(await file.text());
          }}
        />
      </label>
      <button
        disabled={busy}
        onClick={() => {
          setText(JSON.stringify(demo, null, 2));
          reset();
        }}
      >
        载入演示 JSON（尚未导入）
      </button>
      <label>
        联系人 JSON
        <textarea
          rows={10}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            reset();
          }}
          placeholder='{"results":[{"properties":{"company":"公司","email":"name@example.com"}}]}'
        />
      </label>
      <details>
        <summary>字段映射（输入源属性名，空值表示忽略；company/name/email/sourceUrl 必填）</summary>
        <div className="grid">
          {Object.entries(mapping).map(([field, key]) => (
            <label key={field}>
              {field}
              <input
                value={key}
                onChange={(e) => {
                  setMapping({ ...mapping, [field]: e.target.value });
                  reset();
                }}
              />
            </label>
          ))}
        </div>
        <p>
          使用 firstname 时会自动拼接 lastname。hubspot_owner_id
          只是用户导入的负责人标识，不代表账户授权。
        </p>
      </details>
      <div className="actions">
        <button
          disabled={busy || !text || !Object.keys(mapping).length}
          onClick={async () => {
            reset();
            const out = await act("integrations/hubspot/preview", { text, mapping });
            if (out) setPreview(out);
          }}
        >
          预检（不保存）
        </button>
        <button
          disabled={busy || !preview?.valid || !preview.counts?.count}
          onClick={async () => {
            const out = await act("integrations/hubspot/import", { text, mapping });
            if (out) {
              setResult(
                `已导入 ${out.count} 条，重复 ${out.duplicates} 条，归档跳过 ${out.skipped} 条。未发生外部调用。`,
              );
              setPreview(null);
            }
          }}
        >
          确认导入当前品牌
        </button>
      </div>
      {result && <p className="notice">{result}</p>}
      {preview && (
        <>
          <p className="notice">
            {preview.valid
              ? `可新增 ${preview.counts?.count ?? 0} 条；重复 ${preview.counts?.duplicates ?? 0} 条；跳过 ${preview.skipped} 条`
              : "有错误，整批导入已阻止"}
            。预检未写入数据。
          </p>
          <table>
            <thead>
              <tr>
                <th>行</th>
                <th>公司</th>
                <th>联系人</th>
                <th>邮箱</th>
                <th>校验</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr key={row.line}>
                  <td>{row.line}</td>
                  <td>{row.row.company}</td>
                  <td>{row.row.name}</td>
                  <td>{row.row.email}</td>
                  <td>{row.skipped ? "归档，跳过" : row.valid ? "通过" : row.errors.join("；")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
