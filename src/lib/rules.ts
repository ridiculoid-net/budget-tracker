import type { Entry, Rule, RuleAction } from "./schema";

function safeRegex(pattern: string) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function matches(rule: Rule, e: Entry) {
  if (!rule.enabled) return false;
  const t = rule.match.type ?? "any";
  if (t !== "any" && t !== e.type) return false;

  const note = (e.note ?? "").toLowerCase();
  const inc = (rule.match.noteIncludes ?? "").trim().toLowerCase();
  if (inc && !note.includes(inc)) return false;

  if (rule.match.noteRegex) {
    const r = safeRegex(rule.match.noteRegex);
    if (!r) return false;
    if (!r.test(e.note ?? "")) return false;
  }

  if (typeof rule.match.minCents === "number" && e.amountCents < rule.match.minCents) return false;
  if (typeof rule.match.maxCents === "number" && e.amountCents > rule.match.maxCents) return false;

  return true;
}

function applyAction(action: RuleAction, e: Entry): Entry {
  if (action.kind === "setCategory") return { ...e, category: action.category };
  if (action.kind === "setMerchant") return { ...e, merchant: action.merchant };

  if (action.kind === "split") {
    // percent-based splits preferred; fall back to amountCents.
    const total = e.amountCents;
    let remaining = total;

    const splits = action.splits.map((s, idx) => {
      let cents = 0;
      if (typeof s.amountCents === "number") cents = s.amountCents;
      else if (typeof s.percent === "number") cents = Math.round((total * s.percent) / 100);

      // last split gets leftovers
      if (idx === action.splits.length - 1) cents = remaining;
      remaining -= cents;

      return { category: s.category, amountCents: Math.max(0, cents) };
    });

    return { ...e, splits };
  }

  return e;
}

export function runRules(rules: Rule[], e: Entry): Entry {
  let out = e;
  for (const r of rules) {
    if (matches(r, out)) out = applyAction(r.action, out);
  }
  return out;
}
