import type { Brand, Fact, Revision, State } from "../types.ts";

export const normalizeFactAttribute = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
export const normalizeFactValue = (value: string) =>
  value.normalize("NFC").trim().replace(/\s+/g, " ");

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!parts) return NaN;
  const [, yearText, monthText, dayText, hour, minute, second] = parts;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return !days ||
    day < 1 ||
    day > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second || "0") > 59
    ? NaN
    : Date.parse(value);
}

export function factValidity(
  fact: Fact,
  now = Date.now(),
): "active" | "upcoming" | "expired" | "invalid" {
  const from = timestamp(fact.validFrom),
    until = timestamp(fact.validUntil);
  if (
    !Number.isFinite(now) ||
    (from !== undefined && !Number.isFinite(from)) ||
    (until !== undefined && !Number.isFinite(until)) ||
    (from !== undefined && until !== undefined && from >= until)
  )
    return "invalid";
  if (from !== undefined && now < from) return "upcoming";
  if (until !== undefined && now >= until) return "expired";
  return "active";
}

export type FactConflict = {
  key: string;
  scope: "brand" | "product";
  productId?: string;
  attribute: string;
  factIds: string[];
  values: string[];
};

function definedScope(fact: Fact) {
  return (
    (fact.scope === "brand" && !fact.productId) || (fact.scope === "product" && !!fact.productId)
  );
}

export function factConflicts(facts: Fact[], now = Date.now()): FactConflict[] {
  const groups = new Map<string, { group: FactConflict; values: Map<string, string> }>();
  for (const fact of facts) {
    if (
      fact.withdrawnAt ||
      !definedScope(fact) ||
      factValidity(fact, now) !== "active" ||
      !fact.attribute?.trim() ||
      !fact.value?.trim()
    )
      continue;
    const key = JSON.stringify([
      fact.scope,
      fact.productId || "",
      normalizeFactAttribute(fact.attribute),
    ]);
    const entry = groups.get(key) || {
      group: {
        key,
        scope: fact.scope!,
        productId: fact.productId,
        attribute: fact.attribute,
        factIds: [],
        values: [],
      },
      values: new Map<string, string>(),
    };
    entry.group.factIds.push(fact.id);
    entry.values.set(normalizeFactValue(fact.value), fact.value);
    groups.set(key, entry);
  }
  return [...groups.values()]
    .filter((entry) => entry.values.size > 1)
    .map((entry) => ({ ...entry.group, values: [...entry.values.values()] }));
}

export function factStatus(fact: Fact, allFacts: Fact[], now = Date.now()) {
  const validity = factValidity(fact, now);
  const conflictIds =
    factConflicts(allFacts, now)
      .find((group) => group.factIds.includes(fact.id))
      ?.factIds.filter((id) => id !== fact.id) || [];
  let status: "active" | "upcoming" | "expired" | "invalid" | "legacy" | "withdrawn" | "conflict" =
    validity;
  let issue = "";
  if (fact.withdrawnAt) {
    status = "withdrawn";
    issue = "已撤回，需重新生成或明确复核事实";
  } else if (!fact.scope) {
    status = "legacy";
    issue = "尚未确认适用范围，需人工重确认并复核内容";
  } else if (
    !definedScope(fact) ||
    !!fact.attribute?.trim() !== !!fact.value?.trim() ||
    validity === "invalid"
  ) {
    status = "invalid";
    issue = "适用范围、属性或有效时间无效，需重新确认";
  } else if (validity === "upcoming") issue = "尚未生效，不能用于此时点的内容或交付";
  else if (validity === "expired") issue = "已过期，需重新确认有效期并复核内容";
  else if (conflictIds.length) {
    status = "conflict";
    issue = "存在相同范围和属性的不同值，属于潜在冲突，需人工核查";
  }
  return { status, validity, conflictIds, issues: issue ? [issue] : [] };
}

export function factsForBrand(facts: Fact[], brand: Brand | null, now = Date.now()): Fact[] {
  if (!brand) return [];
  const conflicts = new Set(factConflicts(facts, now).flatMap((group) => group.factIds));
  return facts.filter(
    (fact) =>
      !fact.withdrawnAt &&
      factValidity(fact, now) === "active" &&
      !conflicts.has(fact.id) &&
      !!fact.attribute?.trim() === !!fact.value?.trim() &&
      ((fact.scope === "brand" && !fact.productId) ||
        (fact.scope === "product" && !!fact.productId && fact.productId === brand.activeProductId)),
  );
}

export function applicableFacts(
  state: State,
  brand: Brand | null = state.brand,
  now = Date.now(),
): Fact[] {
  return factsForBrand(state.facts, brand, now).filter(
    (fact) =>
      (!fact.productId || state.products.some((product) => product.id === fact.productId)) &&
      state.evidence.some(
        (evidence) => evidence.id === fact.evidenceId && evidence.text.includes(fact.quote),
      ),
  );
}

// Validate against the live registry, while using the revision's own product
// context. Selecting another product must not invalidate unrelated old content.
export function revisionFactIssues(state: State, revision: Revision, now = Date.now()): string[] {
  const issues: string[] = [];
  const snapshots = revision.facts || [];
  const applicable = applicableFacts(state, revision.brand, now);
  for (const snapshot of snapshots) {
    const label = `事实「${snapshot.text.slice(0, 60)}」`;
    const live = state.facts.find((fact) => fact.id === snapshot.id);
    const status = live ? factStatus(live, state.facts, now) : undefined;
    if (!live) issues.push(`${label}已不存在，需重新生成或明确复核事实`);
    else if (status?.status === "withdrawn")
      issues.push(...status.issues.map((issue) => label + issue));
    else if (!snapshot.scope || !live.scope)
      issues.push(`${label}尚未确认适用范围，需人工重确认并复核内容`);
    else if (status?.status !== "active")
      issues.push(...(status?.issues || []).map((issue) => label + issue));
    else if (!applicable.some((fact) => fact.id === snapshot.id))
      issues.push(`${label}不适用于此内容商品或来源已失效`);
    else if (
      JSON.stringify([
        snapshot.text,
        snapshot.quote,
        snapshot.evidenceId,
        snapshot.scope,
        snapshot.productId || "",
        snapshot.validFrom || "",
        snapshot.validUntil || "",
        snapshot.attribute || "",
        snapshot.value || "",
      ]) !==
      JSON.stringify([
        live.text,
        live.quote,
        live.evidenceId,
        live.scope,
        live.productId || "",
        live.validFrom || "",
        live.validUntil || "",
        live.attribute || "",
        live.value || "",
      ])
    )
      issues.push(`${label}与确认记录不一致，需重新复核事实`);
  }
  for (const claim of revision.claims || []) {
    if (!snapshots.some((fact) => fact.id === claim.factId && fact.quote === claim.quote))
      issues.push("文案声明缺少对应事实快照，需重新生成或明确复核事实");
  }
  return [...new Set(issues)];
}

export function scheduledFactIssues(
  state: State,
  revision: Revision,
  scheduledAt: string,
  now = Date.now(),
): string[] {
  const issues = revisionFactIssues(state, revision, now);
  const scheduled = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduled)) return [...issues, "排期时间无效，请核对排期记录"];
  if (scheduled > now) {
    const current = new Set(issues);
    issues.push(
      ...revisionFactIssues(state, revision, scheduled)
        .filter((issue) => !current.has(issue))
        .map((issue) => `排期时间：${issue}`),
    );
  }
  return issues;
}
