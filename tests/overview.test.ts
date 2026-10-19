import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overview } from "../server/domain/overview.ts";
import { Store } from "../server/store.ts";
import { createWorkspaceApp } from "../server/storage/workspaces.ts";
import { emptyCRM } from "../server/domain/crm.ts";
import type { State, Source, Task } from "../server/types.ts";

const now = Date.parse("2026-10-18T04:00:00Z");
const iso = (hours: number) => new Date(now + hours * 3600000).toISOString();
function blank(): State {
  const store = new Store(":memory:");
  try {
    return store.read();
  } finally {
    store.close();
  }
}
const source = (id: string, extra: Partial<Source> = {}): Source => ({
  id,
  label: id,
  connector: "web",
  url: "https://example.com",
  category: "market",
  enabled: true,
  intervalHours: 24,
  nextRunAt: iso(1),
  history: [],
  ...extra,
});
const task = (
  id: string,
  kind: Task["kind"],
  status: Task["status"],
  payload: unknown,
  hours = 0,
): Task => ({
  id,
  kind,
  status,
  payload,
  attempt: 1,
  createdAt: iso(hours),
  updatedAt: iso(hours),
  error: status === "failed" ? "本地模拟失败" : undefined,
});

test("overview distinguishes paused/unknown/failed/recovered sources without double-counting sync failures", () => {
  const state = blank();
  state.sources = [
    source("paused", { enabled: false }),
    source("unknown"),
    source("manual-failed", { enabled: false, lastError: "HTTP 403" }),
    source("failed", { lastError: "HTTP 500" }),
    source("recovered", { lastSuccessAt: iso(-1) }),
    source("due", { lastSuccessAt: iso(-25), nextRunAt: iso(-1) }),
    source("retrying", { lastError: "HTTP 429" }),
  ];
  state.tasks = [
    task("old-sync", "sync", "failed", { sourceId: "recovered" }, -2),
    task("bad-sync", "sync", "failed", { sourceId: "failed" }),
    task("retry", "sync", "running", { sourceId: "retrying" }),
  ];
  const before = JSON.stringify(state);
  const result = overview(state, now);
  assert.deepEqual(
    result.sources.map((s) => s.status),
    ["paused", "never", "failed", "failed", "current", "overdue", "running"],
  );
  assert.equal(result.sources[2].schedulerPaused, true);
  assert.equal(result.counts.problems, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(result.counts.activeTasks, 1);
  assert.equal(JSON.stringify(state), before, "overview must not mutate saved state");
});

test("overview clears superseded failures but retains unrelated failed operations", () => {
  const state = blank();
  state.tasks = [
    task("old", "suggest", "failed", {}, -2),
    task("new", "suggest", "succeeded", {}, -1),
    task("other", "content", "failed", { suggestionId: "other" }),
    task("render-old", "render", "failed", { contentId: "a", revisionId: "r" }, -2),
    task("render-new", "render", "succeeded", { revisionId: "r", contentId: "a" }, -1),
  ];
  assert.deepEqual(
    overview(state, now).failures.map((t) => t.id),
    ["other"],
  );
});

test("overview uses current approvals, excludes archived schedules and completed followups, and bounds upcoming dates", () => {
  const state = blank();
  state.brand = {
    name: "Brand",
    url: "https://example.com",
    product: "Product",
    parameters: "Provided facts",
    audience: "Teams",
    market: "US",
    competitors: [],
    image: "",
    updatedAt: iso(-5),
  };
  state.contents = [
    {
      id: "content",
      suggestion: {
        id: "s",
        title: "Review this",
        reason: "r",
        angle: "a",
        evidenceIds: [],
        quotes: [],
        mode: "demo-template",
      },
      revisions: [
        {
          id: "revision",
          number: 1,
          copy: "Copy",
          scenes: [],
          createdAt: iso(-5),
          approvedAt: iso(-4),
          brand: state.brand,
          evidence: [],
          mode: "demo-template",
        },
      ],
    },
  ];
  const entry = {
    id: "upcoming",
    contentId: "content",
    revisionId: "revision",
    channel: "linkedin",
    account: "brand",
    scheduledAt: iso(12),
    copy: "Copy",
    headline: "Plan",
    targetUrl: "https://example.com",
    campaign: "plan",
    createdAt: iso(-1),
    approvedAt: iso(-1),
  };
  state.calendar = [
    entry,
    { ...entry, id: "past", scheduledAt: iso(-1) },
    { ...entry, id: "far", scheduledAt: iso(169) },
    { ...entry, id: "archived", archivedAt: iso(0) },
  ];
  state.crm = emptyCRM();
  state.crm.followups = [
    { id: "due", leadId: "lead", title: "Follow up", owner: "Owner", dueAt: iso(-1) },
    { id: "done", leadId: "lead", title: "Done", owner: "Owner", dueAt: iso(-1), doneAt: iso(0) },
    { id: "future", leadId: "lead", title: "Future", owner: "Owner", dueAt: iso(1) },
  ];
  let result = overview(state, now);
  assert.deepEqual(
    result.upcoming.map((e) => e.id),
    ["upcoming"],
  );
  assert.equal(result.upcoming[0].needsReview, false);
  assert.deepEqual(
    result.recentDue.map((e) => e.id),
    ["past"],
    "approved schedules remain visible after their delivery time",
  );
  assert.equal(result.needsSetup, true, "missing guidelines and campaign still require onboarding");
  assert.equal(result.counts.reviews, 0);
  assert.equal(result.counts.followups, 1);
  assert.equal(result.followups[0].leadId, "lead");
  state.guidelines = {
    goal: "Changed",
    tone: "Clear",
    valueProposition: "Useful",
    forbiddenClaims: [],
    primaryMetric: "clicks",
    target: 1,
    updatedAt: iso(0),
  };
  result = overview(state, now);
  assert.equal(
    result.counts.reviews,
    4,
    "current content plus three unarchived schedules require approval again",
  );
  assert.equal(result.upcoming[0].needsReview, true);
});

test("overview empty workspace preserves missing data and demo distinctions", () => {
  const state = blank();
  assert.equal(overview(state, now).needsSetup, true);
  assert.equal(overview(state, now).sources.length, 0);
  assert.deepEqual(overview(state, now).evidence, { real: 0, demo: 0 });
  state.evidence = [false, true, true].map((demo, i) => ({
    id: String(i),
    title: "Source",
    url: "https://example.com",
    publishedAt: iso(-1),
    capturedAt: iso(0),
    text: "Source text",
    hash: "existing",
    kind: "manual",
    demo,
  }));
  assert.deepEqual(overview(state, now).evidence, { real: 1, demo: 2 });
});

test("overview API is read-only and remains isolated by project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-overview-test-"));
  const setup = new Store(join(dir, "projects", "alpha", "harbor.sqlite"));
  setup.change((s) => {
    s.sources.push(source("private-source", { enabled: false, lastError: "fixture failure" }));
  });
  setup.close();
  const app = createWorkspaceApp(dir, join(dir, "output"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const alpha: ReturnType<typeof overview> = await fetch(
      base + "/api/overview?project=alpha",
    ).then((r) => r.json());
    const other: ReturnType<typeof overview> = await fetch(base + "/api/overview").then((r) =>
      r.json(),
    );
    assert.equal(alpha.sources[0].label, "private-source");
    assert.equal(other.sources.length, 0);
    assert.equal((await fetch(base + "/api/overview?project=missing")).status, 404);
    assert.equal(
      (
        await fetch(base + "/api/overview?project=alpha", {
          headers: { "X-Harbor-Project": "default" },
        })
      ).status,
      400,
    );
  } finally {
    app.locals.stopScheduler();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
