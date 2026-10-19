import { test } from "node:test";
import assert from "node:assert/strict";
import type { Metric } from "../server/types.ts";
import {
  metricIdentity,
  metricQuality,
  metricStreamKey,
  sameMetricTotals,
} from "../server/domain/metrics.ts";

const epoch = Date.parse("2030-01-01T00:00:00Z");
const at = (minutes: number) => new Date(epoch + minutes * 60000).toISOString();
const now = epoch + 2000 * 60000;
function metric(id: string, extra: Partial<Metric> = {}): Metric {
  return {
    id,
    contentId: "content",
    revisionId: "revision",
    url: "https://example.com/post",
    currency: "USD",
    timezone: "UTC",
    date: at(1000),
    windowStart: at(0),
    windowEnd: at(60),
    impressions: 100,
    clicks: 10,
    conversions: 1,
    spend: 20,
    notes: "Observed window",
    ...extra,
  };
}
const statuses = (metrics: Metric[]) =>
  Object.fromEntries(metricQuality(metrics, now).rows.map((row) => [row.metric.id, row.status]));

test("window identity normalizes URLs and instants, excludes report time/timezone, and retains explicit dimensions", () => {
  const first = metric("first", {
    url: "https://example.com/post?b=2&a=1#top",
    campaignId: "campaign",
    channel: "email",
  });
  const equivalent = metric("second", {
    url: "https://example.com/post?a=1&b=2",
    campaignId: "campaign",
    channel: "email",
    date: at(1200),
    timezone: "Asia/Shanghai",
    windowStart: "2030-01-01T08:00:00+08:00",
    windowEnd: "2030-01-01T09:00:00+08:00",
  });
  assert.equal(metricStreamKey(first), metricStreamKey(equivalent));
  assert.equal(metricIdentity(first), metricIdentity(equivalent));
  for (const change of [
    { currency: "EUR" },
    { campaignId: "other" },
    { channel: "linkedin" },
    { revisionId: "other-revision" },
    { url: "https://example.com/other" },
  ])
    assert.notEqual(metricStreamKey(first), metricStreamKey({ ...first, ...change }));
  assert.notEqual(metricIdentity(first), metricIdentity({ ...first, windowEnd: at(61) }));
  assert.equal(sameMetricTotals(first, equivalent), true);
  for (const field of ["impressions", "clicks", "conversions", "spend"] as const)
    assert.equal(sameMetricTotals(first, { ...first, [field]: first[field] + 1 }), false);
  const old = metric("old", { windowStart: undefined, windowEnd: undefined, date: "2030-01-01" });
  assert.equal(
    metricIdentity(old),
    metricIdentity({ ...old, date: "2030-01-01T08:00:00+08:00", timezone: "Asia/Shanghai" }),
  );
  assert.notEqual(metricIdentity(old), metricIdentity(first));
});

test("adjacent half-open windows both contribute while containment and chains exclude every connected record", () => {
  assert.deepEqual(
    statuses([metric("a"), metric("b", { windowStart: at(60), windowEnd: at(120) })]),
    { a: "included", b: "included" },
  );
  assert.deepEqual(
    statuses([metric("outer", { windowEnd: at(120) }), metric("inner", { windowStart: at(30) })]),
    { outer: "conflict", inner: "conflict" },
  );
  const chain = [
    metric("a"),
    metric("b", { windowStart: at(50), windowEnd: at(100) }),
    metric("c", { windowStart: at(90), windowEnd: at(120) }),
    metric("safe", { windowStart: at(120), windowEnd: at(180) }),
  ];
  const quality = metricQuality(chain, now);
  assert.deepEqual(
    quality.included.map((row) => row.id),
    ["safe"],
  );
  assert.deepEqual(quality.counts, {
    included: 1,
    duplicate: 0,
    missingWindow: 0,
    invalidWindow: 0,
    conflict: 3,
    voided: 0,
  });
  assert.deepEqual(new Set(quality.rows[0].relatedIds), new Set(["b", "c"]));
  assert.ok(quality.rows.slice(0, 3).every((row) => row.issues.length > 0));
});

test("only identical windows and totals deduplicate and a conflicting neighbor invalidates the whole duplicate group", () => {
  const duplicates = [metric("b"), metric("a", { date: at(1200), timezone: "Asia/Shanghai" })];
  assert.deepEqual(statuses(duplicates), { b: "duplicate", a: "included" });
  assert.deepEqual(statuses([...duplicates].reverse()), { a: "included", b: "duplicate" });
  assert.deepEqual(metricQuality(duplicates, now).counts, {
    included: 1,
    duplicate: 1,
    missingWindow: 0,
    invalidWindow: 0,
    conflict: 0,
    voided: 0,
  });
  assert.deepEqual(statuses([metric("before"), metric("updated", { clicks: 15 })]), {
    before: "conflict",
    updated: "conflict",
  });
  const withOverlap = [
    ...duplicates,
    metric("neighbor", { windowStart: at(30), windowEnd: at(90) }),
  ];
  assert.deepEqual(statuses(withOverlap), { b: "conflict", a: "conflict", neighbor: "conflict" });
  assert.equal(metricQuality(withOverlap, now).included.length, 0);
});

test("unknown dimensions overlap known scopes conservatively while clearly separate scopes remain independent", () => {
  assert.deepEqual(statuses([metric("unknown"), metric("known", { campaignId: "campaign-a" })]), {
    unknown: "conflict",
    known: "conflict",
  });
  assert.deepEqual(statuses([metric("unknown"), metric("known", { channel: "email" })]), {
    unknown: "conflict",
    known: "conflict",
  });
  assert.deepEqual(
    statuses([
      metric("a", { campaignId: "campaign-a" }),
      metric("b", { campaignId: "campaign-b" }),
    ]),
    { a: "included", b: "included" },
  );
  assert.deepEqual(
    statuses([metric("a", { channel: "email" }), metric("b", { channel: "linkedin" })]),
    { a: "included", b: "included" },
  );
  assert.deepEqual(statuses([metric("usd"), metric("eur", { currency: "EUR" })]), {
    usd: "conflict",
    eur: "conflict",
  });
  const bridge = [
    metric("a", { campaignId: "campaign-a" }),
    metric("b", { campaignId: "campaign-b" }),
    metric("unknown"),
  ];
  assert.deepEqual(statuses(bridge), { a: "conflict", b: "conflict", unknown: "conflict" });
  const utm = "https://example.com/post?utm_campaign=Launch&utm_source=email";
  assert.deepEqual(
    statuses([
      metric("implicit", { url: utm }),
      metric("explicit", { url: utm, campaignId: "campaign-id" }),
    ]),
    { implicit: "conflict", explicit: "conflict" },
  );
  assert.deepEqual(
    statuses([
      metric("implicit", { url: utm }),
      metric("explicit", { url: utm, channel: "email" }),
    ]),
    { implicit: "conflict", explicit: "conflict" },
  );
  assert.deepEqual(
    statuses([
      metric("implicit-email", { url: utm }),
      metric("explicit-linkedin", { url: utm, channel: "linkedin" }),
    ]),
    { "implicit-email": "included", "explicit-linkedin": "included" },
  );
  assert.match(metricQuality(bridge, now).rows[0].issues.join(""), /维度口径未明确/);
});

test("changing report currency cannot duplicate traffic totals while explicitly separate streams retain their currencies", () => {
  const usd = metric("usd", { spend: 10, clicks: 10 });
  const eur = metric("eur", { currency: "EUR", spend: 9, clicks: 10 });
  assert.notEqual(
    metricIdentity(usd),
    metricIdentity(eur),
    "Exact import identity still records the reported currency",
  );
  const converted = metricQuality([usd, eur], now);
  assert.equal(converted.included.length, 0);
  assert.equal(converted.counts.conflict, 2);
  assert.deepEqual(new Set(converted.rows[0].relatedIds), new Set(["eur"]));
  const channels = metricQuality(
    [
      { ...usd, channel: "email" },
      { ...eur, channel: "linkedin" },
    ],
    now,
  );
  assert.deepEqual(
    channels.included.map((row) => [row.channel, row.currency, row.spend]),
    [
      ["email", "USD", 10],
      ["linkedin", "EUR", 9],
    ],
  );
  const campaigns = metricQuality(
    [
      { ...usd, campaignId: "campaign-a" },
      { ...eur, campaignId: "campaign-b" },
    ],
    now,
  );
  assert.deepEqual(
    campaigns.included.map((row) => [row.campaignId, row.currency]),
    [
      ["campaign-a", "USD"],
      ["campaign-b", "EUR"],
    ],
  );
  assert.deepEqual(
    statuses([usd, { ...eur, channel: "email" }]),
    { usd: "conflict", eur: "conflict" },
    "An unknown channel cannot create a separate currency stream",
  );
});

test("voiding an erroneous record preserves history and restores unaffected windows", () => {
  const original = metric("original");
  const wrong = metric("wrong", { windowStart: at(30), windowEnd: at(90) });
  assert.equal(metricQuality([original, wrong], now).included.length, 0);
  const history = {
    ...wrong,
    voidedAt: at(1200),
    voidedBy: "Reviewer",
    voidReason: "Wrong cumulative reporting window",
  };
  const replacement = metric("replacement", { windowStart: at(60), windowEnd: at(90) });
  const quality = metricQuality([original, history, replacement], now);
  assert.deepEqual(
    quality.included.map((row) => row.id),
    ["original", "replacement"],
  );
  assert.equal(quality.rows[1].status, "voided");
  assert.equal(quality.rows[1].metric.voidReason, history.voidReason);
  assert.equal(quality.counts.voided, 1);
});

test("legacy windows remain excluded and malformed historical rows cannot crash or enter totals", () => {
  const rows = [
    metric("legacy", { windowStart: undefined, windowEnd: undefined }),
    metric("blank", { windowStart: " ", windowEnd: "" }),
    metric("missing-end", { windowEnd: undefined }),
    metric("date-only", { windowStart: "2030-01-01" }),
    metric("rollover", { windowStart: "2030-02-30T00:00:00Z" }),
    metric("midnight", { windowStart: "2030-01-01T24:00:00Z" }),
    metric("empty", { windowEnd: at(0) }),
    metric("reversed", { windowStart: at(61) }),
    metric("collected-before-end", { date: at(59) }),
    metric("future-observation", { date: at(2001) }),
    metric("future-window", { windowEnd: at(2001), date: at(2001) }),
    metric("bad-date", { date: "invalid" }),
    metric("date-rollover", { date: "2030-02-30" }),
    metric("date-without-timezone", { date: "2030-01-01T12:00:00" }),
    metric("bad-url", { url: "invalid" }),
    metric("wrong-protocol", { url: "file:///tmp/report" }),
    metric("negative-total", { clicks: -1 }),
    metric("unsafe-total", { impressions: Number.MAX_SAFE_INTEGER + 1 }),
    metric("bad-spend", { spend: NaN }),
    metric("empty-id", { contentId: "" }),
    metric("bad-dimension", { campaignId: { id: "x" } as unknown as string }),
  ];
  const quality = metricQuality(rows, now);
  assert.equal(quality.included.length, 0);
  assert.equal(quality.counts.missingWindow, 2);
  assert.equal(quality.counts.invalidWindow, rows.length - 2);
  assert.ok(quality.rows.every((row) => row.issues.length > 0));
  assert.doesNotThrow(() => metricQuality([null, undefined, "broken"] as unknown as Metric[], now));
  assert.equal(metricQuality([metric("bad-clock")], NaN).rows[0].status, "invalid-window");
  assert.equal(
    metricQuality([metric("utc-day", { date: "2030-01-02" })], now).rows[0].status,
    "included",
    "A date-only observation means UTC midnight",
  );
});

test("quality projection does not mutate input rows or choose conflicting totals based on array order", () => {
  const rows = [
    metric("z"),
    metric("a", { clicks: 15 }),
    metric("safe", { windowStart: at(60), windowEnd: at(120) }),
  ];
  const before = structuredClone(rows);
  rows.forEach((row) => Object.freeze(row));
  Object.freeze(rows);
  const quality = metricQuality(rows, now);
  const reversed = metricQuality([...rows].reverse(), now);
  assert.deepEqual(rows, before);
  assert.deepEqual(
    quality.included.map((row) => row.id),
    ["safe"],
  );
  assert.deepEqual(
    reversed.included.map((row) => row.id),
    ["safe"],
  );
  assert.deepEqual(quality.counts, reversed.counts);
});
