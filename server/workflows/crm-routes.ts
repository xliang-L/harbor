import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Store } from "../store.ts";
import type { State } from "../types.ts";
import { emptyCRM, priority } from "../domain/crm.ts";
import { publicUrl } from "../security.ts";
const text = z.string().trim().min(1).max(300);
const url = text.refine((x) => {
  try {
    publicUrl(x);
    return true;
  } catch {
    return false;
  }
}, "需公开HTTP(S)来源URL");
const stage = z.enum(["new", "qualified", "contacted", "won", "lost"]);
const date = text.refine((x) => Number.isFinite(Date.parse(x)), "日期无效");
const rowSchema = z.object({
  company: text,
  domain: z.string().trim().max(200).default(""),
  name: text,
  email: z.union([z.email(), z.literal("")]).default(""),
  industry: z.string().trim().max(100).default(""),
  region: z.string().trim().max(100).default(""),
  owner: z.string().trim().max(100).default(""),
  sourceUrl: url,
  stage: stage.default("new"),
});
export function importLeads(s: State, rows: unknown[]) {
  if (!rows.length || rows.length > 500) throw new Error("每次导入1–500条线索");
  const data = rows.map((x) => rowSchema.parse(x));
  const crm = (s.crm ??= emptyCRM());
  let count = 0,
    duplicates = 0;
  for (const r of data) {
    const domain = r.domain.toLowerCase();
    let a = crm.accounts.find(
      (x) => x.company.toLowerCase() === r.company.toLowerCase() && x.domain === domain,
    );
    if (!a) {
      a = { id: randomUUID(), company: r.company, domain, industry: r.industry, region: r.region };
      crm.accounts.push(a);
    }
    let c = crm.contacts.find(
      (x) =>
        x.accountId === a!.id &&
        (r.email ? x.email.toLowerCase() === r.email.toLowerCase() : x.name === r.name),
    );
    if (!c) {
      c = { id: randomUUID(), accountId: a.id, name: r.name, email: r.email };
      crm.contacts.push(c);
    }
    if (crm.leads.some((x) => x.contactId === c!.id)) {
      duplicates++;
      continue;
    }
    crm.leads.push({
      id: randomUUID(),
      accountId: a.id,
      contactId: c.id,
      stage: r.stage,
      owner: r.owner,
      sourceUrl: r.sourceUrl,
      createdAt: new Date().toISOString(),
    });
    count++;
  }
  return { count, duplicates };
}
const csvCell = (value: string) =>
  '"' + (/^[=+\-@\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
export function crmRoutes(app: Express, store: Store) {
  const lead = (s: State, id: string) => {
    const c = (s.crm ??= emptyCRM());
    if (!c.leads.some((x) => x.id === id)) throw new Error("当前品牌下线索不存在");
    return c;
  };
  app.get("/api/crm", (_req, res) => {
    const crm = store.read().crm ?? emptyCRM();
    res.json({
      ...crm,
      ranked: crm.leads
        .map((l) => ({ ...l, ...priority(crm, l) }))
        .sort((a, b) => b.score - a.score),
      due: crm.followups
        .filter((t) => !t.doneAt && Date.parse(t.dueAt) <= Date.now())
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
      security: "本机协作标签；负责人和记录人是自报姓名，不是认证或RBAC",
    });
  });
  app.post("/api/crm/icp", (req, res) => {
    const data = z
      .object({ industries: z.array(text).max(30), regions: z.array(text).max(30) })
      .parse(req.body);
    store.change((s) => ((s.crm ??= emptyCRM()).icp = data));
    res.json({ ok: true });
  });
  app.post("/api/crm/leads", (req, res) =>
    res.json(store.change((s) => importLeads(s, [req.body]))),
  );
  for (const mode of ["preview", "import"])
    app.post(`/api/crm/leads/${mode}`, (req, res) => {
      const input = z
        .object({
          csv: z.string().max(500000).optional(),
          rows: z.array(z.unknown()).max(500).optional(),
        })
        .parse(req.body);
      const rows = input.csv
        ? parse(input.csv, { columns: true, skip_empty_lines: true, bom: true })
        : input.rows || [];
      const preview = importLeads(structuredClone(store.read()), rows);
      res.json(
        mode === "preview"
          ? { ...preview, dryRun: true }
          : store.change((s) => importLeads(s, rows)),
      );
    });
  app.get("/api/crm/export", (_req, res) => {
    const c = store.read().crm ?? emptyCRM();
    const keys = [
      "company",
      "domain",
      "name",
      "email",
      "industry",
      "region",
      "owner",
      "sourceUrl",
      "stage",
    ] as const;
    const rows = c.leads.map((l) => ({
      ...c.accounts.find((a) => a.id === l.accountId)!,
      ...c.contacts.find((x) => x.id === l.contactId)!,
      ...l,
    }));
    res
      .type("text/csv")
      .attachment("harbor-leads.csv")
      .send(
        "\ufeff" +
          [keys.join(","), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(","))].join(
            "\r\n",
          ),
      );
  });
  app.post("/api/crm/leads/:id/update", (req, res) => {
    const d = z.object({ stage, owner: z.string().trim().max(100), actor: text }).parse(req.body);
    store.change((s) => {
      const c = lead(s, req.params.id as string),
        l = c.leads.find((x) => x.id === req.params.id)!;
      c.logs.push({
        id: randomUUID(),
        leadId: l.id,
        at: new Date().toISOString(),
        actor: d.actor,
        text: `阶段 ${l.stage} → ${d.stage}；负责人 ${l.owner || "未分配"} → ${d.owner || "未分配"}`,
      });
      l.stage = d.stage;
      l.owner = d.owner;
    });
    res.json({ ok: true });
  });
  app.post("/api/crm/leads/:id/signals", (req, res) => {
    const d = z
      .object({
        kind: z.enum(["interest", "request-demo", "request-quote", "procurement"]),
        sourceUrl: url,
        quote: text,
        observedAt: date.refine((x) => Date.parse(x) <= Date.now(), "信号不能在未来"),
        verified: z.boolean(),
      })
      .parse(req.body);
    store.change((s) =>
      lead(s, req.params.id as string).signals.push({
        ...d,
        id: randomUUID(),
        leadId: req.params.id as string,
      }),
    );
    res.json({ ok: true });
  });
  app.post("/api/crm/leads/:id/tasks", (req, res) => {
    const d = z.object({ title: text, owner: text, dueAt: date }).parse(req.body);
    store.change((s) =>
      lead(s, req.params.id as string).followups.push({
        ...d,
        id: randomUUID(),
        leadId: req.params.id as string,
      }),
    );
    res.json({ ok: true });
  });
  app.post("/api/crm/tasks/:id/complete", (req, res) => {
    store.change((s) => {
      const task = s.crm?.followups.find((t) => t.id === req.params.id);
      if (!task) throw new Error("当前品牌下任务不存在");
      task.doneAt = new Date().toISOString();
    });
    res.json({ ok: true });
  });
  app.post("/api/crm/leads/:id/logs", (req, res) => {
    const d = z.object({ actor: text, text: z.string().trim().min(1).max(3000) }).parse(req.body);
    store.change((s) =>
      lead(s, req.params.id as string).logs.push({
        ...d,
        id: randomUUID(),
        leadId: req.params.id as string,
        at: new Date().toISOString(),
      }),
    );
    res.json({ ok: true });
  });
  app.post("/api/crm/leads/:id/draft", (req, res) => {
    const result = store.change((s) => {
      const c = lead(s, req.params.id as string),
        l = c.leads.find((x) => x.id === req.params.id)!,
        a = c.accounts.find((x) => x.id === l.accountId)!,
        contact = c.contacts.find((x) => x.id === l.contactId)!;
      const signal = c.signals
        .filter((x) => x.leadId === l.id && x.verified && x.kind !== "interest")
        .at(-1);
      const d = {
        id: randomUUID(),
        leadId: l.id,
        createdAt: new Date().toISOString(),
        mode: "template" as const,
        status: "unsent" as const,
        body: `${contact.name} 您好，\n我是 ${s.brand?.name || "[请填写品牌]"} 的 [请填写姓名]。希望了解 ${a.company} 当前的业务需求。${signal ? `\n待人工复核的需求引用：“${signal.quote}”（${signal.sourceUrl}）` : ""}\n如果方便，能否告知贵团队当前关注的问题及合适的沟通方式？如不相关，请忽略。\n[发送前核实事实、联系人和沟通许可；本草稿尚未发送]`,
      };
      c.drafts.push(d);
      return d;
    });
    res.json(result);
  });
}
