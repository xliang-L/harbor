import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/storage/store.ts";
import { consoleRoutes, reviewQueue, type ReviewState } from "../../server/routes/console.ts";
import type { Revision, State } from "../../server/types.ts";
function seed(store: Store, id: string) {
  store.change((s) => {
    s.contents.push({
      id,
      suggestion: {
        id,
        title: id,
        reason: "",
        angle: "",
        evidenceIds: [],
        quotes: [],
        mode: "template",
      },
      revisions: [
        {
          id: `${id}-r`,
          number: 1,
          createdAt: "2026-01-01T00:00:00Z",
          copy: "test",
          scenes: [],
          evidence: [],
          mode: "template",
          brand: {
            name: "Sample",
            url: "https://example.com",
            product: "Sample",
            parameters: "",
            audience: "Teams",
            market: "US",
            competitors: [],
            image: "",
            updatedAt: "2026-01-01",
          },
        } as Revision,
      ],
    });
  });
}
test("console isolates brand writes, validates context, persists audit and rejects stale/reused requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-console-"));
  const a = new Store(join(dir, "a.sqlite")),
    b = new Store(join(dir, "b.sqlite"));
  seed(a, "a-content");
  seed(b, "b-content");
  const app = express();
  app.use(express.json());
  consoleRoutes(app, () => [
    { project: "a", store: a },
    { project: "b", store: b },
  ]);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const root = `http://127.0.0.1:${address.port}`;
  const body = {
    project: "a",
    kind: "content",
    targetId: "a-content",
    actor: "Local tester",
    baseVersion: 0,
    owner: "Editor",
    priority: "high",
    dueAt: "2020-01-01T00:00:00Z",
    comment: "Please verify source",
  };
  async function post(data: object, key = "one", project = "a", suffix = "") {
    return fetch(root + "/api/console/review" + suffix, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "X-Harbor-Project": project,
      },
      body: JSON.stringify(data),
    });
  }
  try {
    assert.equal((await (await fetch(root + "/api/console")).json()).rows.length, 2);
    assert.equal((await post(body, "conflict", "b")).status, 400);
    assert.equal((await post(body, "query", "a", "?project=b")).status, 400);
    assert.equal((await post({ ...body, targetId: "b-content" })).status, 404);
    assert.equal((await post({ ...body, project: "missing" }, "missing", "missing")).status, 404);
    assert.equal((await post({ ...body, project: undefined })).status, 400);
    assert.equal((await post(body)).status, 200);
    assert.equal((await (await post(body)).json()).duplicate, true);
    assert.equal((await post({ ...body, comment: "changed" })).status, 409);
    assert.equal((await post(body, "stale")).status, 409);
    const read = a.read() as State & ReviewState;
    assert.equal(read.reviewEvents?.length, 1);
    assert.equal(read.reviewItems?.[0].owner, "Editor");
    assert.equal((b.read() as State & ReviewState).reviewEvents?.length || 0, 0);
    assert.equal(a.read().contents[0].revisions[0].approvedAt, undefined);
    const filtered = await (
      await fetch(root + "/api/console?brand=a&priority=high&due=overdue")
    ).json();
    assert.equal(filtered.rows.length, 1);
    assert.equal(filtered.rows[0].project, "a");
    const reopened = new Store(join(dir, "a.sqlite"));
    assert.equal((reopened.read() as State & ReviewState).reviewEvents?.[0].comment, body.comment);
    reopened.close();
    a.change((s) => {
      s.contents[0].revisions[0].approvedAt = "2026-01-01";
    });
    assert.equal(reviewQueue("a", a.read()).length, 0);
    a.change((s) => {
      s.guidelines = { updatedAt: "2026-02-01" } as State["guidelines"];
    });
    assert.equal(reviewQueue("a", a.read()).length, 1);
  } finally {
    await new Promise<void>((r, reject) => server.close((e) => (e ? reject(e) : r())));
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("queue includes pending campaigns and stale calendar, excludes archived entries, retains approval audit", async () => {
  const { recordApproval } = await import("../../server/routes/console.ts");
  const dir = mkdtempSync(join(tmpdir(), "harbor-console-queue-"));
  const store = new Store(join(dir, "db.sqlite"));
  try {
    seed(store, "content");
    store.change((s) => {
      s.contents[0].revisions[0].approvedAt = "2026-01-01";
      s.calendar.push({
        id: "entry",
        contentId: "content",
        revisionId: "old-revision",
        channel: "linkedin",
        account: "Local",
        scheduledAt: "2026-01-01T00:00:00Z",
        copy: "Draft",
        headline: "Old plan",
        targetUrl: "https://example.com",
        campaign: "Launch",
        createdAt: "2026-01-01",
        approvedAt: "2026-01-01",
      });
      s.campaigns.push({
        id: "launch",
        name: "Launch",
        objective: "Inform",
        audience: "Teams",
        primaryMetric: "clicks",
        target: 20,
        budget: 0,
        currency: "USD",
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: "2026-02-01T00:00:00Z",
        channels: ["linkedin"],
        contentIds: ["content"],
        productIds: [],
        assetIds: [],
        version: 1,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
      recordApproval(s, "content", "content");
    });
    const rows = reviewQueue("sample", store.read());
    assert.equal(rows.length, 2);
    assert.match(rows.find((r) => r.kind === "calendar")!.reason, /版本失效/);
    assert.match(rows.find((r) => r.kind === "campaign")!.reason, /缺少渠道/);
    store.change((s) => {
      s.calendar[0].archivedAt = "2026-01-02";
    });
    assert.equal(reviewQueue("sample", store.read()).length, 1);
    const event = (store.read() as State & ReviewState).reviewEvents![0];
    assert.equal(event.action, "approved");
    assert.match(event.actor, /未认证/);
    assert.equal(event.targetId, "content");
    assert.equal(event.revisionId, "content-r");
    assert.equal(event.targetVersion, 1);
    store.change((s) => {
      s.contents[0].revisions.push({ ...s.contents[0].revisions[0], id: "content-r2", number: 2 });
    });
    assert.equal(store.read().reviewEvents![0].revisionId, "content-r");
    assert.equal(store.read().reviewEvents![0].targetVersion, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("workspace root parses console JSON, isolates brands, and exposes genuine approval events", async () => {
  const { createWorkspaceApp } = await import("../../server/storage/workspaces.ts");
  const { randomUUID } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "harbor-console-workspace-"));
  const paths = [
    join(dir, "data", "harbor.sqlite"),
    join(dir, "data", "projects", "other", "harbor.sqlite"),
  ];
  const seedStores = paths.map((path) => new Store(path));
  seed(seedStores[0], "default-content");
  seed(seedStores[1], "other-content");
  for (const store of seedStores) {
    store.change((s) => {
      s.brand = s.contents[0].revisions[0].brand;
      const contentId = s.contents[0].id;
      s.campaigns.push({
        id: "launch",
        name: "Launch",
        objective: "Inform",
        audience: "Teams",
        primaryMetric: "clicks",
        target: 20,
        budget: 0,
        currency: "USD",
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: "2026-02-01T00:00:00Z",
        channels: ["linkedin"],
        contentIds: [contentId],
        productIds: [],
        assetIds: [],
        version: 1,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
      s.calendar.push({
        id: "entry",
        contentId,
        revisionId: `${contentId}-r`,
        channel: "linkedin",
        account: "Local",
        scheduledAt: "2026-01-02T00:00:00Z",
        copy: "Draft",
        headline: "Launch plan",
        targetUrl: "https://example.com",
        campaign: "Launch",
        campaignId: "launch",
        createdAt: "2026-01-01",
      });
    });
    store.close();
  }
  const app = createWorkspaceApp(join(dir, "data"), join(dir, "output"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: object, project = "default", key = randomUUID()) =>
    fetch(root + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Harbor-Project": project,
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  const assignment = {
    project: "other",
    kind: "content",
    targetId: "other-content",
    actor: "Reviewer",
    owner: "Editor",
    priority: "high",
    dueAt: "",
    comment: "Verify",
    baseVersion: 0,
  };
  try {
    const initial = await (await fetch(root + "/api/console")).json();
    assert.deepEqual(initial.projects.map((p: { project: string }) => p.project).sort(), [
      "default",
      "other",
    ]);
    assert.equal(initial.rows.length, 6);
    assert.equal((await post("/api/console/review", assignment)).status, 400);
    assert.equal(
      (await post("/api/console/review?project=default", assignment, "other")).status,
      400,
    );
    assert.equal(
      (await post("/api/console/review", { ...assignment, project: "default" })).status,
      404,
    );
    const assigned = await post("/api/console/review", assignment, "other");
    assert.equal(assigned.status, 200, await assigned.text());
    const after = await (await fetch(root + "/api/console?brand=other")).json();
    assert.equal(after.rows.find((r: { kind: string }) => r.kind === "content").owner, "Editor");
    const unchanged = await (await fetch(root + "/api/console?brand=default")).json();
    assert.equal(unchanged.events.length, 0);
    assert.equal(unchanged.rows.find((r: { kind: string }) => r.kind === "content").owner, "");
    const failedApproval = await post(
      "/api/contents/default-content/approve",
      { revisionId: "default-content-r" },
      "other",
    );
    assert.equal(failedApproval.status, 400);
    assert.equal(
      (
        await post(
          "/api/contents/other-content/approve?project=default",
          { revisionId: "other-content-r" },
          "other",
        )
      ).status,
      400,
    );
    const approvalKey = randomUUID();
    for (const path of [
      "/api/contents/other-content/approve",
      "/api/calendar/entry/approve",
      "/api/campaigns/launch/approve",
    ]) {
      const response = await post(
        path,
        { revisionId: "other-content-r", baseVersion: 1 },
        "other",
        path.includes("contents") ? approvalKey : randomUUID(),
      );
      assert.equal(response.status, 200, await response.text());
    }
    const repeated = await post(
      "/api/contents/other-content/approve",
      { revisionId: "other-content-r", baseVersion: 1 },
      "other",
      approvalKey,
    );
    assert.equal(repeated.status, 200);
    const reviewed = await (await fetch(root + "/api/console?brand=other")).json();
    assert.equal(reviewed.rows.length, 0);
    const approvals = reviewed.events.filter((e: { action: string }) => e.action === "approved");
    assert.deepEqual(approvals.map((e: { kind: string }) => e.kind).sort(), [
      "calendar",
      "campaign",
      "content",
    ]);
    assert.ok(
      approvals.every(
        (e: { project: string; actor: string }) =>
          e.project === "other" && e.actor.includes("未认证"),
      ),
    );
    assert.equal((await (await fetch(root + "/api/console?brand=default")).json()).rows.length, 3);
    const persisted = new Store(paths[1]);
    assert.equal(persisted.read().reviewEvents?.filter((e) => e.action === "approved").length, 3);
    const persistedEvents = persisted.read().reviewEvents!;
    assert.equal(
      persistedEvents.find((e) => e.action === "approved" && e.kind === "content")?.revisionId,
      "other-content-r",
    );
    assert.equal(
      persistedEvents.find((e) => e.action === "approved" && e.kind === "content")?.targetVersion,
      1,
    );
    assert.equal(
      persistedEvents.find((e) => e.action === "approved" && e.kind === "calendar")?.revisionId,
      "other-content-r",
    );
    const campaignEvent = persistedEvents.find(
      (e) => e.action === "approved" && e.kind === "campaign",
    )!;
    assert.equal(campaignEvent.targetVersion, 1);
    assert.equal(
      campaignEvent.approvedFingerprint,
      persisted.read().campaigns[0].approvedFingerprint,
    );
    assert.ok(campaignEvent.approvedFingerprint);
    persisted.change((s) => {
      s.campaigns[0].version = 2;
      s.campaigns[0].approvedFingerprint = undefined;
    });
    assert.equal(
      persisted.read().reviewEvents!.find((e) => e.id === campaignEvent.id)?.approvedFingerprint,
      campaignEvent.approvedFingerprint,
    );
    persisted.close();
  } finally {
    app.locals.stopScheduler();
    await new Promise<void>((r, reject) => server.close((e) => (e ? reject(e) : r())));
    rmSync(dir, { recursive: true, force: true });
  }
});
