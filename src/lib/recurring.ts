import type { Entry, Recurring } from "./schema";

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function expandRecurringForMonth(recurring: Recurring[], monthStart: number, monthEnd: number): Entry[] {
  const out: Entry[] = [];

  for (const r of recurring) {
    if (!r.enabled) continue;
    if (r.endTs && r.endTs < monthStart) continue;
    if (r.startTs > monthEnd) continue;

    if (r.cadence === "monthly") {
      const d = new Date(monthStart);
      const day = Math.min(Math.max(r.dayOfMonth ?? 1, 1), 28);
      const ts = new Date(d.getFullYear(), d.getMonth(), day, 12, 0, 0, 0).getTime();
      if (ts >= monthStart && ts <= monthEnd && ts >= r.startTs && (!r.endTs || ts <= r.endTs)) {
        out.push({
          id: `rec_${r.id}_${monthStart}`,
          ts,
          type: r.type,
          amountCents: r.amountCents,
          category: r.category,
          note: r.note,
        });
      }
    }

    if (r.cadence === "weekly") {
      const dow = r.dayOfWeek ?? 1; // default Monday
      for (let ts = monthStart; ts <= monthEnd; ts += 24 * 3600 * 1000) {
        const d = new Date(ts);
        if (d.getDay() !== dow) continue;
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0).getTime();
        if (t < r.startTs) continue;
        if (r.endTs && t > r.endTs) continue;
        out.push({
          id: `rec_${r.id}_${t}`,
          ts: t,
          type: r.type,
          amountCents: r.amountCents,
          category: r.category,
          note: r.note,
        });
      }
    }
  }

  // stable ordering
  return out.sort((a, b) => b.ts - a.ts);
}
