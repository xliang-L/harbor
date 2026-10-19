import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/storage/store.ts";
import { createApp } from "../../server/app.ts";
import {
  applicableFacts,
  factConflicts,
  factStatus,
  factsForBrand,
  factValidity,
  normalizeFactValue,
  revisionFactIssues,
  scheduledFactIssues,
} from "../../server/domain/facts.ts";
import type { Fact, Revision, State } from "../../server/types.ts";

const now = Date.parse("2030-05-01T00:00:00Z");
const iso = (delta = 0) => new Date(now + delta).toISOString();
function fixture(): State {
  const evidence = {
    id: "source",
    title: "Product specifications",
    url: "https://example.com/specification",
    text: "The recorded specification is 500 W and requires human confirmation.",
    publishedAt: "2026-01-01T00:00:00Z",
    capturedAt: "2026-01-01T00:00:00Z",
    kind: "manual" as const,
    demo: true,
    hash: "test",
  };
  const brand = {
    name: "Fact validity demo",
    product: "Product A",
    parameters: "Provided specification",
    url: "https://example.com",
    market: "US",
    audience: "Teams",
    competitors: [],
    image: "",
    updatedAt: "2026-01-01T00:00:00Z",
    activeProductId: "product-a",
  };
  return {
    brand,
    evidence: [evidence],
    facts: [],
    contents: [],
    suggestions: [],
    tasks: [],
    metrics: [],
    sources: [],
    calendar: [],
    guidelines: null,
    campaigns: [],
    assets: [],
    products: ["a", "b"].map((id) => ({
      id: `product-${id}`,
      sku: id,
      title: `Product ${id}`,
      description: "Provided product",
      price: 10,
      currency: "USD",
      url: "https://example.com/product",
      evidenceId: evidence.id,
      sourceName: "test",
      importedAt: "2026-01-01T00:00:00Z",
      demo: true,
    })),
  };
}
function fact(id: string, extra: Partial<Fact> = {}): Fact {
  return {
    id,
    text: "Power rating is provided by a human",
    quote: fixture().evidence[0].text,
    evidenceId: "source",
    confirmedAt: "2026-01-01T00:00:00Z",
    confirmedBy: "Reviewer",
    scope: "product",
    productId: "product-a",
    ...extra,
  };
}
function revision(state: State, facts: Fact[]): Revision {
  return {
    id: "revision",
    number: 1,
    copy: "A restrained product introduction",
    scenes: [0, 1, 2].map((i) => ({
      start: i * 10,
      end: (i + 1) * 10,
      text: "Product introduction",
      visual: "Product photo",
    })),
    createdAt: "2026-01-01T00:00:00Z",
    brand: structuredClone(state.brand!),
    evidence: structuredClone(state.evidence),
    facts: structuredClone(facts),
    claims: [],
    mode: "demo-template",
  };
}

test("fact windows include validFrom and exclude validUntil, with compatible unbounded sides", () => {
  assert.equal(factValidity(fact("unbounded"), now), "active");
  const window = fact("window", { validFrom: iso(), validUntil: iso(1000) });
  assert.equal(factValidity(window, now - 1), "upcoming");
  assert.equal(factValidity(window, now), "active");
  assert.equal(factValidity(window, now + 999), "active");
  assert.equal(factValidity(window, now + 1000), "expired");
  assert.equal(factValidity(fact("from", { validFrom: iso() }), now), "active");
  assert.equal(factValidity(fact("from", { validFrom: iso() }), now - 1), "upcoming");
  assert.equal(factValidity(fact("until", { validUntil: iso() }), now - 1), "active");
  assert.equal(factValidity(fact("until", { validUntil: iso() }), now), "expired");
  assert.equal(
    factValidity(fact("offset", { validFrom: "2030-05-01T08:00:00+08:00" }), now),
    "active",
  );
  for (const invalid of [
    { validFrom: "2030-05-01" },
    { validFrom: "not a date" },
    { validUntil: "2030-02-30T00:00:00Z" },
    { validFrom: "2030-05-01T24:00:00Z" },
    { validFrom: iso(), validUntil: iso() },
    { validFrom: iso(1000), validUntil: iso() },
  ])
    assert.equal(factValidity(fact("bad", invalid), now), "invalid");
  assert.equal(factValidity(fact("bad-clock"), NaN), "invalid");
});

test("potential conflicts use exact scope and normalized attributes while preserving meaningful value characters", () => {
  const state = fixture();
  const a = fact("a", { attribute: "  ＰＯＷＥＲ  ", value: " 500   W " });
  const same = fact("same", { attribute: "power", value: "500 W" });
  const different = fact("different", { attribute: "Power", value: "600 W" });
  assert.equal(factConflicts([a, same], now).length, 0);
  const groups = factConflicts([a, same, different], now);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].scope, "product");
  assert.equal(groups[0].productId, "product-a");
  assert.deepEqual(groups[0].factIds, ["a", "same", "different"]);
  assert.deepEqual(groups[0].values, ["500 W", "600 W"]);
  assert.equal(factStatus(a, [a, different], now).status, "conflict");
  assert.deepEqual(factStatus(a, [a, different], now).conflictIds, ["different"]);
  assert.deepEqual(factsForBrand([a, different], state.brand, now), []);
  assert.equal(factConflicts([a, { ...different, productId: "product-b" }], now).length, 0);
  assert.equal(
    factConflicts([a, { ...different, scope: "brand", productId: undefined }], now).length,
    0,
  );
  for (const excluded of [
    { withdrawnAt: iso(-1) },
    { validFrom: iso(1) },
    { validUntil: iso() },
    { scope: undefined },
    { attribute: undefined, value: undefined },
  ])
    assert.equal(factConflicts([a, { ...different, ...excluded }], now).length, 0);
  assert.equal(
    factConflicts([a, { ...different, value: "500W" }], now).length,
    1,
    "Do not infer unit or spacing equivalence",
  );
  assert.equal(
    factConflicts([a, { ...different, value: "500 w" }], now).length,
    1,
    "Values remain case-sensitive",
  );
  for (const [left, right] of [
    ["10² g", "102 g"],
    ["㎏", "kg"],
    ["½ kg", "1⁄2 kg"],
  ]) {
    assert.notEqual(normalizeFactValue(left), normalizeFactValue(right));
    assert.equal(
      factConflicts(
        [
          fact("left", { attribute: "mass", value: left }),
          fact("right", { attribute: "mass", value: right }),
        ],
        now,
      ).length,
      1,
    );
  }
  assert.equal(
    normalizeFactValue(" e\u0301  g "),
    "é g",
    "Canonical Unicode and whitespace normalization remain supported",
  );
  assert.equal(factStatus(fact("partial", { attribute: "power" }), [], now).status, "invalid");
  assert.equal(factStatus(fact("legacy", { scope: undefined }), [], now).status, "legacy");
});

test("current and scheduled checks block expired/conflicting facts and compare time and attribute snapshots", () => {
  const state = fixture();
  state.facts = [fact("valid", { attribute: "power", value: "500 W", validUntil: iso(1000) })];
  const current = revision(state, state.facts);
  assert.deepEqual(
    applicableFacts(state, state.brand, now).map((f) => f.id),
    ["valid"],
  );
  assert.deepEqual(revisionFactIssues(state, current, now), []);
  assert.match(scheduledFactIssues(state, current, iso(1000), now).join(""), /排期时间：.*已过期/);
  assert.deepEqual(scheduledFactIssues(state, current, iso(-1000), now), []);
  assert.match(scheduledFactIssues(state, current, "invalid", now).join(""), /排期时间无效/);
  const extended = structuredClone(state);
  extended.facts[0].validUntil = iso(2000);
  assert.match(revisionFactIssues(extended, current, now).join(""), /不一致/);
  for (const change of [{ validFrom: iso(-1000) }, { attribute: "capacity" }, { value: "600 W" }]) {
    const changed = structuredClone(state);
    Object.assign(changed.facts[0], change);
    assert.match(revisionFactIssues(changed, current, now).join(""), /不一致/);
  }
  state.facts[0].validUntil = undefined;
  const indefinite = revision(state, state.facts);
  state.facts.push(
    fact("future-conflict", { attribute: "POWER", value: "600 W", validFrom: iso(1000) }),
  );
  assert.deepEqual(revisionFactIssues(state, indefinite, now), []);
  assert.match(
    scheduledFactIssues(state, indefinite, iso(1000), now).join(""),
    /排期时间：.*潜在冲突/,
  );
  assert.equal(applicableFacts(state, state.brand, now + 1000).length, 0);
  state.facts[1].withdrawnAt = iso();
  assert.deepEqual(scheduledFactIssues(state, indefinite, iso(1000), now), []);
});

async function apiSetup() {
  const dir = mkdtempSync(join(tmpdir(), "harbor-fact-validity-"));
  const store = new Store(join(dir, "db.sqlite"));
  store.change((s) => Object.assign(s, fixture()));
  const server = createApp(store, join(dir, "output")).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`;
  return {
    store,
    base,
    post: async (path: string, body: object) => {
      const response = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      return { status: response.status, ...(await response.json()) };
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const input = {
  text: "Human-confirmed power specification",
  evidenceId: "source",
  quote: fixture().evidence[0].text,
  scope: "product",
  productId: "product-a",
  actor: "Reviewer",
};

test("fact API validates dates and paired attributes, includes them in duplicate identity, and preserves exponent values", async () => {
  const api = await apiSetup();
  try {
    for (const invalid of [
      { attribute: "power" },
      { value: "500 W" },
      { validFrom: "2030-05-01" },
      { validUntil: "2030-02-30T00:00:00Z" },
      { validFrom: iso(), validUntil: iso() },
      { validFrom: iso(1000), validUntil: iso() },
    ])
      assert.equal((await api.post("facts", { ...input, ...invalid })).status, 400);
    assert.equal(api.store.read().facts.length, 0);
    const fromOnly = await api.post("facts", {
      ...input,
      validFrom: "2030-05-01T08:00:00+08:00",
      attribute: "power",
      value: " 500   W ",
    });
    assert.equal(fromOnly.status, 200);
    assert.equal(api.store.read().facts[0].validFrom, iso());
    assert.equal(api.store.read().facts[0].value, "500 W");
    const duplicate = await api.post("facts", {
      ...input,
      validFrom: iso(),
      attribute: "ＰＯＷＥＲ",
      value: "500 W",
    });
    assert.equal(duplicate.id, fromOnly.id);
    assert.equal(duplicate.duplicate, true);
    const untilOnly = await api.post("facts", {
      ...input,
      validUntil: iso(),
      attribute: "power",
      value: "500 W",
    });
    assert.equal(untilOnly.status, 200);
    assert.notEqual(untilOnly.id, fromOnly.id);
    const unbounded = await api.post("facts", {
      ...input,
      validFrom: "",
      validUntil: " ",
      attribute: "",
      value: " ",
    });
    assert.equal(unbounded.status, 200);
    assert.equal(api.store.read().facts.find((f) => f.id === unbounded.id)?.attribute, undefined);
    const superscript = await api.post("facts", { ...input, attribute: "mass", value: "10² g" });
    const ordinary = await api.post("facts", { ...input, attribute: "mass", value: "102 g" });
    assert.notEqual(superscript.id, ordinary.id);
    assert.equal(api.store.read().facts.find((f) => f.id === superscript.id)?.value, "10² g");
    assert.ok(
      factConflicts(api.store.read().facts).some(
        (group) => group.factIds.includes(superscript.id) && group.factIds.includes(ordinary.id),
      ),
    );
  } finally {
    await api.close();
  }
});

test("append-only reconfirmation renews expired/upcoming facts without restoring old approvals or reviving withdrawals", async () => {
  const api = await apiSetup();
  const at = Date.now();
  const past = new Date(at - 86400000).toISOString(),
    future = new Date(at + 86400000).toISOString();
  try {
    const expired = await api.post("facts", {
      ...input,
      attribute: "power",
      value: "500 W",
      validUntil: past,
    });
    assert.equal(expired.status, 200);
    const old = api.store.read().facts.find((f) => f.id === expired.id)!;
    api.store.change((s) => {
      const r = revision(s, [old]);
      r.approvedAt = past;
      s.contents.push({
        id: "content",
        suggestion: {
          id: "suggestion",
          title: "Product introduction",
          reason: "Hypothesis",
          angle: "Neutral",
          evidenceIds: ["source"],
          quotes: [],
          mode: "demo-template",
        },
        revisions: [r],
      });
    });
    const renewed = await api.post("facts", {
      ...input,
      attribute: "power",
      value: "500 W",
      validUntil: future,
      reconfirmsFactId: old.id,
    });
    assert.equal(renewed.status, 200);
    assert.notEqual(renewed.id, old.id);
    assert.equal(api.store.read().facts.find((f) => f.id === old.id)?.validUntil, past);
    assert.equal(api.store.read().facts.find((f) => f.id === renewed.id)?.reconfirmsFactId, old.id);
    assert.equal(
      (
        await api.post("facts", {
          ...input,
          attribute: "power",
          value: "500 W",
          validUntil: future,
          reconfirmsFactId: old.id,
        })
      ).id,
      renewed.id,
    );
    assert.ok(applicableFacts(api.store.read()).some((f) => f.id === renewed.id));
    assert.match(
      revisionFactIssues(api.store.read(), api.store.read().contents[0].revisions[0]).join(""),
      /已过期/,
    );
    assert.equal(
      (await api.post("contents/content/approve", { revisionId: "revision" })).status,
      400,
    );
    assert.equal((await fetch(api.base + "contents/content/revision/download")).status, 400);
    for (const mutation of [
      { text: "Different claim" },
      { scope: "brand", productId: undefined },
      { productId: "product-b" },
      { attribute: "capacity" },
      { value: "600 W" },
    ])
      assert.equal(
        (
          await api.post("facts", {
            ...input,
            attribute: "power",
            value: "500 W",
            validUntil: future,
            reconfirmsFactId: old.id,
            ...mutation,
          })
        ).status,
        400,
      );
    const upcoming = await api.post("facts", {
      ...input,
      text: "A separate future confirmation",
      validFrom: future,
    });
    assert.equal(upcoming.status, 200);
    const earlier = await api.post("facts", {
      ...input,
      text: "A separate future confirmation",
      validFrom: past,
      reconfirmsFactId: upcoming.id,
    });
    assert.equal(earlier.status, 200);
    assert.notEqual(earlier.id, upcoming.id);
    assert.equal(
      factValidity(api.store.read().facts.find((f) => f.id === upcoming.id)!),
      "upcoming",
    );
    assert.equal(factValidity(api.store.read().facts.find((f) => f.id === earlier.id)!), "active");
    assert.equal(
      (
        await api.post(`facts/${renewed.id}/withdraw`, {
          actor: "Reviewer",
          reason: "Confirmed source is no longer reliable",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await api.post("facts", {
          ...input,
          attribute: "power",
          value: "500 W",
          validUntil: future,
          reconfirmsFactId: renewed.id,
        })
      ).status,
      400,
    );
    assert.ok(api.store.read().facts.find((f) => f.id === renewed.id)?.withdrawnAt);
  } finally {
    await api.close();
  }
});

test("new contradictory attributes block a previously approved revision until the conflicting record is withdrawn", async () => {
  const api = await apiSetup();
  try {
    const first = await api.post("facts", { ...input, attribute: "power", value: "500 W" });
    api.store.change((s) =>
      s.contents.push({
        id: "content",
        suggestion: {
          id: "suggestion",
          title: "Product introduction",
          reason: "Hypothesis",
          angle: "Neutral",
          evidenceIds: ["source"],
          quotes: [],
          mode: "demo-template",
        },
        revisions: [revision(s, [s.facts.find((f) => f.id === first.id)!])],
      }),
    );
    assert.equal(
      (await api.post("contents/content/approve", { revisionId: "revision" })).status,
      200,
    );
    const conflict = await api.post("facts", { ...input, attribute: "POWER", value: "600 W" });
    assert.equal(conflict.status, 200, "Preserve conflicting evidence for human review");
    assert.equal(
      (await api.post("contents/content/approve", { revisionId: "revision" })).status,
      400,
    );
    assert.equal((await fetch(api.base + "contents/content/revision/download")).status, 400);
    assert.equal(applicableFacts(api.store.read()).length, 0);
    assert.equal(
      (
        await api.post(`facts/${conflict.id}/withdraw`, {
          actor: "Reviewer",
          reason: "The second value was entered incorrectly",
        })
      ).status,
      200,
    );
    assert.equal(
      (await api.post("contents/content/approve", { revisionId: "revision" })).status,
      200,
    );
  } finally {
    await api.close();
  }
});
