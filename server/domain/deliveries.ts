import type { CalendarEntry, DeliveryReceipt, State } from "../types.ts";
import { brandIssues } from "./campaigns.ts";
import { validateChannel } from "./channels.ts";
import { revisionFactIssues } from "./facts.ts";

export function deliveryIssues(state: State, entry: CalendarEntry, now = Date.now()): string[] {
  const issues: string[] = [];
  const revision = state.contents.find((c) => c.id === entry.contentId)?.revisions.at(-1);
  if (entry.archivedAt) issues.push("排期已归档，请先恢复并复核");
  if (!revision || revision.id !== entry.revisionId)
    issues.push("排期的内容版本已失效，请为当前版本重新安排交付");
  if (
    !revision?.approvedAt ||
    (revision.approvalGuidelinesAt || "") !== (state.guidelines?.updatedAt || "")
  )
    issues.push("当前内容版本尚未有效批准");
  if (
    !entry.approvedAt ||
    (entry.approvalGuidelinesAt || "") !== (state.guidelines?.updatedAt || "")
  )
    issues.push("该渠道、账号与文案尚未有效批准");
  if (revision) issues.push(...revisionFactIssues(state, revision, now));
  issues.push(...brandIssues(state, entry.copy + "\n" + entry.headline));
  try {
    validateChannel(entry.channel, entry.copy, entry.headline);
  } catch (error) {
    issues.push((error as Error).message);
  }
  if (state.deliveries?.some((receipt) => receipt.calendarId === entry.id && !receipt.voidedAt))
    issues.push("该排期已有有效回执；如记录错误，请先撤销原记录");
  return [...new Set(issues)];
}

export function receiptFactIssues(
  state: State,
  receipt: DeliveryReceipt,
  now = Date.now(),
): string[] {
  const revision = state.contents
    .find((c) => c.id === receipt.contentId)
    ?.revisions.find((r) => r.id === receipt.revisionId);
  return revision ? revisionFactIssues(state, revision, now) : ["原交付版本不存在，请核对历史记录"];
}

export function deliverySummary(state: State, now = Date.now()) {
  return {
    entries: state.calendar
      .filter(
        (entry) => !entry.archivedAt || state.deliveries?.some((r) => r.calendarId === entry.id),
      )
      .map((entry) => {
        const issues = deliveryIssues(state, entry, now);
        return {
          calendarId: entry.id,
          canRecord: issues.length === 0,
          issues,
          receipts: (state.deliveries || [])
            .filter((r) => r.calendarId === entry.id)
            .map((r) => ({ ...r, factIssues: receiptFactIssues(state, r, now) })),
        };
      }),
    note: "人工交付记录，尚未经平台核验。撤销仅纠正本地记录，不删除渠道内容或撤回消息。",
  };
}

export function deliveryProofKey(
  receipt: Pick<DeliveryReceipt, "channel" | "account" | "destinationUrl" | "externalId">,
) {
  let url = receipt.destinationUrl;
  if (url) {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.sort();
    url = parsed.toString();
  }
  const account = [receipt.channel, receipt.account.trim().toLowerCase()];
  return {
    external: receipt.externalId ? JSON.stringify([...account, receipt.externalId]) : "",
    url: url ? JSON.stringify([...account, url]) : "",
  };
}
