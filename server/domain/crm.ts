export type Account = {
  id: string;
  company: string;
  domain: string;
  industry: string;
  region: string;
};
export type Contact = { id: string; accountId: string; name: string; email: string };
export type Lead = {
  id: string;
  accountId: string;
  contactId: string;
  owner: string;
  stage: "new" | "qualified" | "contacted" | "won" | "lost";
  sourceUrl: string;
  createdAt: string;
};
export type Signal = {
  id: string;
  leadId: string;
  kind: "interest" | "request-demo" | "request-quote" | "procurement";
  sourceUrl: string;
  quote: string;
  observedAt: string;
  verified: boolean;
};
export type Followup = {
  id: string;
  leadId: string;
  title: string;
  owner: string;
  dueAt: string;
  doneAt?: string;
};
export type CRM = {
  accounts: Account[];
  contacts: Contact[];
  leads: Lead[];
  signals: Signal[];
  followups: Followup[];
  logs: { id: string; leadId: string; at: string; actor: string; text: string }[];
  drafts: {
    id: string;
    leadId: string;
    body: string;
    createdAt: string;
    mode: "template";
    status: "unsent";
  }[];
  icp: { industries: string[]; regions: string[] };
};
export const emptyCRM = (): CRM => ({
  accounts: [],
  contacts: [],
  leads: [],
  signals: [],
  followups: [],
  logs: [],
  drafts: [],
  icp: { industries: [], regions: [] },
});
export function priority(crm: CRM, lead: Lead, now = Date.now()) {
  const a = crm.accounts.find((x) => x.id === lead.accountId)!;
  const fit =
    (crm.icp.industries.includes(a.industry) ? 15 : 0) +
    (crm.icp.regions.includes(a.region) ? 15 : 0);
  const signals = crm.signals.filter(
    (x) =>
      x.leadId === lead.id &&
      x.verified &&
      x.kind !== "interest" &&
      now - Date.parse(x.observedAt) <= 90 * 86400000,
  );
  const intent = signals.length
    ? Math.max(
        ...signals.map((x) =>
          x.kind === "procurement" ? 60 : x.kind === "request-quote" ? 50 : 40,
        ),
      )
    : 0;
  const score = fit + intent;
  return {
    score,
    level: score >= 60 ? "high" : score >= 30 ? "medium" : "low",
    explanation: `ICP 匹配 ${fit} 分；近90天人工核实的明确询价/演示/采购信号 ${signals.length} 条，最高 ${intent} 分。一般关注不计购买意向；不是成交概率。`,
    nextAction:
      lead.stage === "won" || lead.stage === "lost"
        ? "已关闭线索；复核后再安排任务"
        : signals.length
          ? "核实需求、预算与决策时间，安排人工跟进"
          : "先验证联系人与业务需求，不能凭热度推断采购意向",
  };
}
