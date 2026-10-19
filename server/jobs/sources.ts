import { randomUUID, createHash } from "node:crypto";
import type { Store } from "../storage/store.ts";
import { collectSource } from "../connectors/sources.ts";
import type { SourceItem } from "../connectors/sources.ts";
import { publicUrl } from "../security.ts";
export function saveCollection(store: Store, sourceId: string, items: SourceItem[]) {
  const at = new Date().toISOString();
  return store.change((s) => {
    const source = s.sources.find((x) => x.id === sourceId);
    if (!source) throw new Error("来源不存在");
    const ids: string[] = [];
    let added = 0;
    for (const item of items) {
      publicUrl(item.url);
      if (item.text.length < 20 || item.text.length > 30000) throw new Error("来源正文长度无效");
      const hash = createHash("sha512").update(item.text).digest("hex");
      let e = s.evidence.find((x) => x.url === item.url && x.text === item.text);
      if (!e) {
        e = {
          ...item,
          id: randomUUID(),
          kind: "fetch",
          demo: false,
          hash,
          capturedAt: at,
        };
        s.evidence.push(e);
        added++;
      }
      ids.push(e.id);
    }
    const hash = createHash("sha512")
      .update(JSON.stringify(items.map((x) => [x.url, x.text]).sort()))
      .digest("hex");
    const previousHash = source.history.at(-1)?.hash;
    source.history.push({
      at,
      added,
      hash,
      previousHash,
      changed: previousHash !== undefined && previousHash !== hash,
      evidenceIds: ids,
    });
    source.lastSuccessAt = at;
    source.lastError = undefined;
    if (added) s.suggestions = [];
    return `${source.label}: ${items.length} 条 / 新增 ${added} / ${previousHash && previousHash !== hash ? "检测到变化" : "初次或无变化"}`;
  });
}
export async function syncSource(store: Store, id: string) {
  const source = store.change((s) => {
    const x = s.sources.find((x) => x.id === id);
    if (!x) throw new Error("来源不存在");
    x.lastAttemptAt = new Date().toISOString();
    x.nextRunAt = new Date(Date.now() + x.intervalHours * 3600000).toISOString();
    return structuredClone(x);
  });
  try {
    return saveCollection(store, id, await collectSource(source));
  } catch (e) {
    store.change((s) => {
      s.sources.find((x) => x.id === id)!.lastError = (e as Error).message;
    });
    throw e;
  }
}
