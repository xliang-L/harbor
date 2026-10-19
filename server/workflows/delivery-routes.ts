import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.ts";
import type { DeliveryReceipt } from "../types.ts";
import { publicUrl } from "../security.ts";
import {
  deliveryIssues,
  deliveryProofKey,
  deliverySummary,
  receiptFactIssues,
} from "../domain/deliveries.ts";
import { revisionFactIssues } from "../domain/facts.ts";

const actor = z.string().trim().min(1).max(120);
const proofUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      publicUrl(value);
      return true;
    } catch {
      return false;
    }
  }, "交付链接需为公开 HTTP(S) URL");
const input = z
  .object({
    revisionId: z.string().min(1),
    deliveredAt: z.iso
      .datetime({ offset: true })
      .refine((value) => Date.parse(value) <= Date.now(), "交付时间不能在未来"),
    destinationUrl: proofUrl.default(""),
    externalId: z.string().trim().max(300).default(""),
    actor,
    notes: z.string().trim().max(2000).default(""),
  })
  .refine(
    (value) => !!(value.destinationUrl || value.externalId),
    "请至少填写交付链接或外部凭证编号",
  );

export function deliveryRoutes(app: Express, store: Store) {
  app.get("/api/deliveries", (_req, res) => res.json(deliverySummary(store.read())));
  app.post("/api/calendar/:id/deliveries", (req, res) => {
    const data = input.parse(req.body);
    const result = store.change((state) => {
      const entry = state.calendar.find((e) => e.id === req.params.id);
      if (!entry || entry.revisionId !== data.revisionId)
        throw new Error("排期不属于当前品牌或内容版本已变化，请刷新核对");
      const issues = deliveryIssues(state, entry);
      if (issues.length) throw new Error(issues.join("；"));
      const revision = state.contents
        .find((c) => c.id === entry.contentId)!
        .revisions.find((r) => r.id === entry.revisionId)!;
      if (
        Date.parse(data.deliveredAt) <
        Math.max(Date.parse(entry.approvedAt!), Date.parse(revision.approvedAt!))
      )
        throw new Error("交付时间不能早于该版本的内容和渠道审批时间");
      const historicalIssues = revisionFactIssues(state, revision, Date.parse(data.deliveredAt));
      if (historicalIssues.length)
        throw new Error(`实际交付时间的事实依据不可用：${historicalIssues.join("；")}`);
      const proof = deliveryProofKey({ ...data, channel: entry.channel, account: entry.account });
      if (
        (state.deliveries || []).some((r) => {
          if (r.voidedAt) return false;
          const prior = deliveryProofKey(r);
          return (
            (!!proof.external && proof.external === prior.external) ||
            (!!proof.url && proof.url === prior.url)
          );
        })
      )
        throw new Error("同一渠道账号已有该链接或凭证的有效回执，请核对原记录");
      const receipt: DeliveryReceipt = {
        ...data,
        deliveredAt: new Date(data.deliveredAt).toISOString(),
        id: randomUUID(),
        calendarId: entry.id,
        contentId: entry.contentId,
        channel: entry.channel,
        account: entry.account,
        source: "manual",
        recordedAt: new Date().toISOString(),
        snapshot: structuredClone(entry),
        contentApprovedAt: revision.approvedAt!,
        factIds: (revision.facts || []).map((f) => f.id),
      };
      (state.deliveries ||= []).push(receipt);
      return receipt;
    });
    res.json(result);
  });
  app.post("/api/deliveries/:id/void", (req, res) => {
    const data = z.object({ actor, reason: z.string().trim().min(1).max(2000) }).parse(req.body);
    store.change((state) => {
      const receipt = state.deliveries?.find((r) => r.id === req.params.id);
      if (!receipt) throw new Error("当前品牌下交付记录不存在");
      if (receipt.voidedAt) throw new Error("这条记录已经撤销，原始审计信息保持不变");
      receipt.voidedAt = new Date().toISOString();
      receipt.voidedBy = data.actor;
      receipt.voidReason = data.reason;
    });
    res.json({ ok: true });
  });
  app.get("/api/deliveries/:id/export", (req, res) => {
    const state = store.read(),
      receipt = state.deliveries?.find((r) => r.id === req.params.id);
    if (!receipt) return res.status(404).json({ error: "当前品牌下交付记录不存在" });
    res.attachment(`harbor-delivery-${receipt.id}.json`).json({
      ...receipt,
      currentFactIssues: receiptFactIssues(state, receipt),
      note: "人工记录及当时的审批/渠道快照，不是平台独立核验的发布凭证。撤销只作用于本地记录。",
    });
  });
}
