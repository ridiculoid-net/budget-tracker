"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* =========================
   Types + constants
========================= */

type EntryType = "income" | "expense";
type Theme = "cyber" | "noir" | "synth";

type Split = { category: string; amountCents: number };

type Entry = {
  id: string;
  ts: number;
  type: EntryType;
  amountCents: number;
  category: string;
  note: string;
  merchant?: string;
  splits?: Split[];
  source?: "manual" | "recurring";
};

type RuleAction =
  | { kind: "setCategory"; category: string }
  | { kind: "setMerchant"; merchant: string }
  | { kind: "split"; splits: { category: string; percent?: number; amountCents?: number }[] };

type Rule = {
  id: string;
  enabled: boolean;
  match: {
    type?: EntryType | "any";
    noteIncludes?: string;
    noteRegex?: string;
    minCents?: number;
    maxCents?: number;
  };
  action: RuleAction;
};

type Recurring = {
  id: string;
  enabled: boolean;
  type: EntryType;
  amountCents: number;
  category: string;
  note: string;
  cadence: "monthly" | "weekly";
  dayOfMonth?: number; // 1-28 recommended
  dayOfWeek?: number; // 0-6 Sun-Sat
  startTs: number;
  endTs?: number;
};

type Backup = { ts: number; label: string; entries: Entry[] };

type Settings = {
  version: 3;
  passcodeHash: string | null;
  theme: Theme;

  stealthMode: boolean;
  autoLockMinutes: number; // 0 disables

  budgets: {
    monthlyTotalCents: number;
    byCategoryCents: Record<string, number>;
  };

  rules: Rule[];
  recurring: Recurring[];
  backups: Backup[];
};

type Command = { id: string; label: string; hint?: string; run: () => void };

const ENTRIES_KEY = "moneytracker:v3:entries";
const SETTINGS_KEY = "moneytracker:v3:settings";

const CATEGORIES = {
  expense: ["Food", "Rent", "Transport", "Utilities", "Subscriptions", "Health", "Shopping", "Travel", "Other"],
  income: ["Salary", "Freelance", "Refund", "Gift", "Interest", "Other"],
};

const defaultSettings: Settings = {
  version: 3,
  passcodeHash: null,
  theme: "cyber",
  stealthMode: false,
  autoLockMinutes: 10,
  budgets: { monthlyTotalCents: 0, byCategoryCents: {} },
  rules: [
    { id: "r1", enabled: true, match: { type: "expense", noteIncludes: "uber" }, action: { kind: "setCategory", category: "Transport" } },
    { id: "r2", enabled: true, match: { type: "expense", noteIncludes: "netflix" }, action: { kind: "setCategory", category: "Subscriptions" } },
    { id: "r3", enabled: true, match: { type: "expense", noteIncludes: "whole foods" }, action: { kind: "setCategory", category: "Food" } },
  ],
  recurring: [
    {
      id: "rent",
      enabled: false,
      type: "expense",
      amountCents: 150000,
      category: "Rent",
      note: "Rent",
      cadence: "monthly",
      dayOfMonth: 1,
      startTs: Date.now(),
    },
  ],
  backups: [],
};

/* =========================
   Helpers
========================= */

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function tinyHash(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function fmtMoney(cents: number) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const showCents = remainder !== 0;
  return `${sign}$${dollars.toLocaleString()}${showCents ? "." + remainder.toString().padStart(2, "0") : ""}`;
}

function fmtDate(ts: number) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

function parseMoneyToCents(raw: string) {
  const clean = raw.replace(/[^\d.]/g, "");
  const n = Number(clean);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
}

function formatMonthLabel(m: string) {
  const [y, mm] = m.split("-").map(Number);
  return new Date(y, mm - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function safeRegex(pattern: string) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function pushBackup(settings: Settings, entries: Entry[], label: string): Settings {
  const backups = [{ ts: Date.now(), label, entries }, ...(settings.backups ?? [])].slice(0, 10);
  return { ...settings, backups };
}

function effectiveExpenseCents(e: Entry) {
  if (e.type !== "expense") return 0;
  if (e.splits?.length) return e.splits.reduce((a, s) => a + s.amountCents, 0);
  return e.amountCents;
}

/* =========================
   Rules engine
========================= */

function ruleMatches(rule: Rule, e: Entry) {
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

function applyRuleAction(action: RuleAction, e: Entry): Entry {
  if (action.kind === "setCategory") return { ...e, category: action.category };
  if (action.kind === "setMerchant") return { ...e, merchant: action.merchant };

  if (action.kind === "split") {
    const total = e.amountCents;
    let remaining = total;

    const splits: Split[] = action.splits.map((s, idx) => {
      let cents = 0;
      if (typeof s.amountCents === "number") cents = s.amountCents;
      else if (typeof s.percent === "number") cents = Math.round((total * s.percent) / 100);

      if (idx === action.splits.length - 1) cents = remaining;
      remaining -= cents;

      return { category: s.category, amountCents: Math.max(0, cents) };
    });

    return { ...e, splits };
  }

  return e;
}

function runRules(rules: Rule[], e: Entry): Entry {
  let out = e;
  for (const r of rules) {
    if (ruleMatches(r, out)) out = applyRuleAction(r.action, out);
  }
  return out;
}

/* =========================
   Recurring expansion
========================= */

function expandRecurringForMonth(recurring: Recurring[], monthStartTs: number, monthEndTs: number): Entry[] {
  const out: Entry[] = [];

  for (const r of recurring) {
    if (!r.enabled) continue;
    if (r.endTs && r.endTs < monthStartTs) continue;
    if (r.startTs > monthEndTs) continue;

    if (r.cadence === "monthly") {
      const d = new Date(monthStartTs);
      const day = Math.min(Math.max(r.dayOfMonth ?? 1, 1), 28);
      const ts = new Date(d.getFullYear(), d.getMonth(), day, 12, 0, 0, 0).getTime();
      if (ts >= monthStartTs && ts <= monthEndTs && ts >= r.startTs && (!r.endTs || ts <= r.endTs)) {
        out.push({
          id: `rec_${r.id}_${monthStartTs}`,
          ts,
          type: r.type,
          amountCents: r.amountCents,
          category: r.category,
          note: r.note,
          source: "recurring",
        });
      }
    }

    if (r.cadence === "weekly") {
      const dow = r.dayOfWeek ?? 1;
      for (let ts = monthStartTs; ts <= monthEndTs; ts += 24 * 3600 * 1000) {
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
          source: "recurring",
        });
      }
    }
  }

  return out.sort((a, b) => b.ts - a.ts);
}

/* =========================
   CSV import/export
========================= */

function toCsv(entries: Entry[]) {
  const header = "id,ts,type,amount,category,note,merchant";
  const lines = entries.map((e) => {
    const amount = (e.amountCents / 100).toFixed(2);
    const esc = (s: string) => {
      const needs = /[,"\n]/.test(s);
      const x = s.replace(/"/g, '""');
      return needs ? `"${x}"` : x;
    };
    return [e.id, String(e.ts), e.type, amount, esc(e.category), esc(e.note), esc(e.merchant ?? "")].join(",");
  });
  return [header, ...lines].join("\n");
}

function fromCsv(text: string): Entry[] {
  const rows: string[][] = [];
  let i = 0;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const readField = () => {
    let out = "";
    if (s[i] === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') {
          out += '"';
          i += 2;
          continue;
        }
        if (s[i] === '"') {
          i++;
          break;
        }
        out += s[i++];
      }
    } else {
      while (i < s.length && s[i] !== "," && s[i] !== "\n") out += s[i++];
    }
    while (i < s.length && s[i] !== "," && s[i] !== "\n") i++;
    return out;
  };

  const readRow = () => {
    const row: string[] = [];
    while (i < s.length) {
      const field = readField();
      row.push(field);
      if (s[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    return row;
  };

  while (i < s.length) {
    if (s[i] === "\n") {
      i++;
      continue;
    }
    const row = readRow();
    rows.push(row);
    while (i < s.length && s[i] !== "\n") i++;
    if (s[i] === "\n") i++;
  }

  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);

  const idI = idx("id");
  const tsI = idx("ts");
  const typeI = idx("type");
  const amtI = idx("amount");
  const catI = idx("category");
  const noteI = idx("note");
  const merchI = idx("merchant");

  const out: Entry[] = [];
  for (const r of rows.slice(1)) {
    const get = (k: number) => (k >= 0 ? (r[k] ?? "").trim() : "");
    const typeStr = get(typeI);
    const type: EntryType = typeStr === "income" ? "income" : "expense";
    const ts = Number(get(tsI));
    const amount = Number(get(amtI));
    const category = get(catI) || "Other";
    const note = get(noteI);
    const merchant = get(merchI);
    const id = get(idI) || uid();

    if (!Number.isFinite(ts) || !Number.isFinite(amount)) continue;

    out.push({
      id,
      ts,
      type,
      amountCents: Math.round(amount * 100),
      category,
      note,
      merchant: merchant || undefined,
      source: "manual",
    });
  }
  return out;
}

/* =========================
   UI mini charts
========================= */

function Sparkline({ points }: { points: number[] }) {
  const w = 260;
  const h = 64;
  const pad = 6;

  if (!points.length) {
    return (
      <div className="sparkEmpty">
        <div className="sparkEmptyInner" />
      </div>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(1e-6, max - min);

  const xs = points.map((_, j) => (j / Math.max(1, points.length - 1)) * (w - pad * 2) + pad);
  const ys = points.map((v) => {
    const t = (v - min) / span;
    return (1 - t) * (h - pad * 2) + pad;
  });

  const d = xs.map((x, j) => `${j === 0 ? "M" : "L"} ${x.toFixed(2)} ${ys[j].toFixed(2)}`).join(" ");
  const area = `${d} L ${xs[xs.length - 1].toFixed(2)} ${(h - pad).toFixed(2)} L ${xs[0].toFixed(2)} ${(h - pad).toFixed(2)} Z`;

  return (
    <svg width={w} height={h} className="spark" viewBox={`0 0 ${w} ${h}`} aria-label="Trend sparkline">
      <path className="sparkArea" d={area} />
      <path className="sparkLine" d={d} />
      <circle className="sparkDot" cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="3.2" />
    </svg>
  );
}

function Donut({ values, labels }: { values: number[]; labels: string[] }) {
  const total = values.reduce((a, b) => a + b, 0);
  const r = 44;
  const cx = 56;
  const cy = 56;
  const circ = 2 * Math.PI * r;

  if (total <= 0) {
    return (
      <svg width={112} height={112} className="donut" viewBox="0 0 112 112" aria-label="Category breakdown">
        <circle className="donutTrack" cx={cx} cy={cy} r={r} />
        <circle className="donutHole" cx={cx} cy={cy} r={r - 16} />
        <text x="56" y="60" textAnchor="middle" className="donutText">No data</text>
      </svg>
    );
  }

  let offset = 0;
  return (
    <svg width={112} height={112} className="donut" viewBox="0 0 112 112" aria-label="Category breakdown">
      <circle className="donutTrack" cx={cx} cy={cy} r={r} />
      {values.map((v, i) => {
        const frac = v / total;
        const dash = frac * circ;
        const dasharray = `${dash} ${circ - dash}`;
        const dashoffset = offset;
        offset -= dash;

        return (
          <circle
            key={labels[i]}
            className={`donutSeg donutSeg${(i % 6) + 1}`}
            cx={cx}
            cy={cy}
            r={r}
            strokeDasharray={dasharray}
            strokeDashoffset={dashoffset}
          />
        );
      })}
      <circle className="donutHole" cx={cx} cy={cy} r={r - 16} />
      <text x="56" y="54" textAnchor="middle" className="donutBig">{fmtMoney(Math.round(total * 100))}</text>
      <text x="56" y="72" textAnchor="middle" className="donutSmall">Expenses</text>
    </svg>
  );
}

/* =========================
   Command Palette
========================= */

function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    setQ("");
  }, [open]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(qq));
  }, [q, commands]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="cpOverlay" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={onClose}>
      <div className="cp" onMouseDown={(e) => e.stopPropagation()}>
        <input className="cpInput" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a command…" />
        <div className="cpList">
          {filtered.map((c) => (
            <button
              key={c.id}
              className="cpItem"
              onClick={() => {
                c.run();
                onClose();
              }}
            >
              <div className="cpLabel">{c.label}</div>
              {c.hint && <div className="cpHint">{c.hint}</div>}
            </button>
          ))}
          {filtered.length === 0 && <div className="cpEmpty">No matches.</div>}
        </div>
      </div>
    </div>
  );
}

/* =========================
   Page
========================= */

export default function Page() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings);

  const [authed, setAuthed] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [newPasscode, setNewPasscode] = useState("");
  const [confirmPasscode, setConfirmPasscode] = useState("");

  const [type, setType] = useState<EntryType>("expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(CATEGORIES.expense[0]);
  const [note, setNote] = useState("");

  const [filterType, setFilterType] = useState<"all" | EntryType>("all");
  const [filterCategory, setFilterCategory] = useState<string>("All");
  const [q, setQ] = useState("");

  const [month, setMonth] = useState(() => monthKey(new Date()));

  const [showBudgets, setShowBudgets] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showRecurring, setShowRecurring] = useState(false);
  const [showBackups, setShowBackups] = useState(false);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  const [undo, setUndo] = useState<{ entry: Entry; expiresAt: number } | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ type: EntryType; amount: string; category: string; note: string }>({
    type: "expense",
    amount: "",
    category: "Other",
    note: "",
  });

  const amountRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* Load */
  useEffect(() => {
    try {
      const eraw = localStorage.getItem(ENTRIES_KEY);
      const sraw = localStorage.getItem(SETTINGS_KEY);
      if (eraw) setEntries(JSON.parse(eraw));
      if (sraw) {
        const parsed = JSON.parse(sraw) as Settings;
        setSettings({ ...defaultSettings, ...parsed, budgets: { ...defaultSettings.budgets, ...(parsed.budgets ?? {}) } });
      }
    } catch {
      // ignore
    }
  }, []);

  /* Save */
  useEffect(() => {
    try {
      localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
    } catch {}
  }, [entries]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  /* Apply theme */
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  /* Keyboard: Cmd/Ctrl+K palette, '.' quick hide */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (e.key === ".") setHidden((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Auto-lock on idle */
  useEffect(() => {
    if (!settings.autoLockMinutes || settings.autoLockMinutes <= 0) return;
    let last = Date.now();

    const bump = () => (last = Date.now());
    const events = ["mousemove", "keydown", "mousedown", "touchstart"];
    events.forEach((ev) => window.addEventListener(ev, bump, { passive: true }));

    const t = window.setInterval(() => {
      const mins = (Date.now() - last) / 60000;
      if (mins >= settings.autoLockMinutes) setAuthed(false);
    }, 2000);

    return () => {
      events.forEach((ev) => window.removeEventListener(ev, bump as any));
      window.clearInterval(t);
    };
  }, [settings.autoLockMinutes]);

  /* Month bounds */
  const monthStart = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return startOfMonth(new Date(y, m - 1, 1));
  }, [month]);

  const monthEnd = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return endOfMonth(new Date(y, m - 1, 1));
  }, [month]);

  /* Recurring entries for month */
  const recurringEntries = useMemo(() => expandRecurringForMonth(settings.recurring, monthStart, monthEnd), [settings.recurring, monthStart, monthEnd]);

  /* Merge month entries */
  const monthEntries = useMemo(() => {
    const base = entries.filter((e) => e.ts >= monthStart && e.ts <= monthEnd);
    const merged = [...recurringEntries, ...base];
    const map = new Map<string, Entry>();
    for (const e of merged) map.set(e.id, e);
    return Array.from(map.values()).sort((a, b) => b.ts - a.ts);
  }, [entries, monthStart, monthEnd, recurringEntries]);

  /* Totals */
  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const e of monthEntries) {
      if (e.type === "income") income += e.amountCents;
      else expense += effectiveExpenseCents(e);
    }
    return { income, expense, net: income - expense };
  }, [monthEntries]);

  /* Trend: daily cumulative net */
  const trend = useMemo(() => {
    const start = new Date(monthStart);
    const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    const buckets = new Array(daysInMonth).fill(0);

    for (const e of monthEntries) {
      const d = new Date(e.ts);
      const idx = d.getDate() - 1;
      const signed = e.type === "income" ? e.amountCents : -effectiveExpenseCents(e);
      buckets[idx] += signed;
    }

    const cum: number[] = [];
    let run = 0;
    for (const v of buckets) {
      run += v;
      cum.push(run / 100);
    }
    return cum;
  }, [monthEntries, monthStart]);

  /* Category breakdown */
  const expenseByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of monthEntries) {
      if (e.type !== "expense") continue;

      if (e.splits?.length) {
        for (const s of e.splits) {
          map.set(s.category, (map.get(s.category) ?? 0) + s.amountCents);
        }
      } else {
        map.set(e.category, (map.get(e.category) ?? 0) + e.amountCents);
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([cat, cents]) => ({ cat, cents }));
  }, [monthEntries]);

  const donutValues = useMemo(() => expenseByCategory.slice(0, 6).map((x) => x.cents / 100), [expenseByCategory]);
  const donutLabels = useMemo(() => expenseByCategory.slice(0, 6).map((x) => x.cat), [expenseByCategory]);

  /* Filters */
  const allCategoriesThisMonth = useMemo(() => {
    const set = new Set<string>();
    for (const e of monthEntries) {
      if (e.type === "expense") {
        if (e.splits?.length) e.splits.forEach((s) => set.add(s.category));
        else set.add(e.category);
      } else set.add(e.category);
    }
    return ["All", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [monthEntries]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return monthEntries.filter((e) => {
      if (filterType !== "all" && e.type !== filterType) return false;

      if (filterCategory !== "All") {
        if (e.type === "expense" && e.splits?.length) {
          const hit = e.splits.some((s) => s.category === filterCategory);
          if (!hit) return false;
        } else {
          if (e.category !== filterCategory) return false;
        }
      }

      if (qq) {
        const hay = `${e.note} ${e.category} ${e.type} ${e.merchant ?? ""}`.toLowerCase();
        if (!hay.includes(qq)) return false;
      }

      return true;
    });
  }, [monthEntries, filterType, filterCategory, q]);

  /* Budgets */
  const budgetTotal = settings.budgets.monthlyTotalCents;
  const totalPct = budgetTotal > 0 ? clamp(totals.expense / budgetTotal, 0, 4) : 0;

  const netTone = totals.net >= 0 ? "toneGood" : "toneBad";

  /* Categories per entry type */
  const categoriesForType = useMemo(() => (type === "expense" ? CATEGORIES.expense : CATEGORIES.income), [type]);
  useEffect(() => setCategory(categoriesForType[0]), [type]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Actions */
  function prevMonth() {
    const [y, m] = month.split("-").map(Number);
    setMonth(monthKey(new Date(y, m - 2, 1)));
  }

  function nextMonth() {
    const [y, m] = month.split("-").map(Number);
    setMonth(monthKey(new Date(y, m, 1)));
  }

  function tryLogin() {
    if (!settings.passcodeHash) {
      setAuthed(true);
      return;
    }
    const ok = tinyHash(passcode) === settings.passcodeHash;
    if (ok) setAuthed(true);
    else {
      setAuthed(false);
      setPasscode("");
    }
  }

  function setPasscodeGate() {
    if (newPasscode.length < 4) return;
    if (newPasscode !== confirmPasscode) return;
    setSettings((s) => ({ ...s, passcodeHash: tinyHash(newPasscode) }));
    setNewPasscode("");
    setConfirmPasscode("");
    setAuthed(true);
  }

  function clearGate() {
    setSettings((s) => ({ ...s, passcodeHash: null }));
    setAuthed(true);
    setPasscode("");
  }

  function addEntry() {
    const cents = parseMoneyToCents(amount);
    if (cents === null) return;

    let entry: Entry = {
      id: uid(),
      ts: Date.now(),
      type,
      amountCents: cents,
      category,
      note: note.trim(),
      source: "manual",
    };

    entry = runRules(settings.rules, entry);

    const nextEntries = [entry, ...entries];
    setEntries(nextEntries);
    setSettings((s) => pushBackup(s, nextEntries, `Added ${entry.type} ${entry.category} ${fmtMoney(entry.amountCents)}`));

    setAmount("");
    setNote("");
    amountRef.current?.focus();
  }

  function removeEntry(id: string) {
    const entry = entries.find((e) => e.id === id);
    // only manual entries are removable from storage
    if (!entry) return;

    setEntries(entries.filter((e) => e.id !== id));
    setUndo({ entry, expiresAt: Date.now() + 8000 });
  }

  function undoDelete() {
    if (!undo) return;
    setEntries([undo.entry, ...entries]);
    setUndo(null);
  }

  useEffect(() => {
    if (!undo) return;
    const t = window.setInterval(() => {
      if (undo && Date.now() > undo.expiresAt) setUndo(null);
    }, 250);
    return () => window.clearInterval(t);
  }, [undo]);

  function exportJson() {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "money-tracker-export.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    const csv = toCsv(entries);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "money-tracker-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(file: File) {
    const text = await file.text();
    let imported: Entry[] = [];

    if (file.name.toLowerCase().endsWith(".json")) {
      try {
        const raw = JSON.parse(text);
        if (Array.isArray(raw)) {
          imported = (raw as any[]).map((e: any): Entry => {
            const t: EntryType = e.type === "income" ? "income" : "expense";
            return {
              id: String(e.id ?? uid()),
              ts: Number(e.ts ?? Date.now()),
              type: t,
              amountCents: Math.round(Number(e.amountCents ?? 0)),
              category: String(e.category ?? "Other"),
              note: String(e.note ?? ""),
              merchant: e.merchant ? String(e.merchant) : undefined,
              splits: Array.isArray(e.splits)
                ? e.splits.map((s: any) => ({ category: String(s.category ?? "Other"), amountCents: Math.round(Number(s.amountCents ?? 0)) }))
                : undefined,
              source: "manual",
            };
          });
        }
      } catch {}
    } else if (file.name.toLowerCase().endsWith(".csv")) {
      imported = fromCsv(text);
    } else {
      try {
        const raw = JSON.parse(text);
        if (Array.isArray(raw)) {
          imported = (raw as any[]).map((e: any): Entry => {
            const t: EntryType = e.type === "income" ? "income" : "expense";
            return {
              id: String(e.id ?? uid()),
              ts: Number(e.ts ?? Date.now()),
              type: t,
              amountCents: Math.round(Number(e.amountCents ?? 0)),
              category: String(e.category ?? "Other"),
              note: String(e.note ?? ""),
              merchant: e.merchant ? String(e.merchant) : undefined,
              source: "manual",
            };
          });
        }
      } catch {
        imported = fromCsv(text);
      }
    }

    const safe = imported
      .filter((e) => Number.isFinite(e.ts) && Number.isFinite(e.amountCents) && e.amountCents > 0)
      .map((e) => ({ ...e, source: "manual" as const }));

    const map = new Map<string, Entry>();
    for (const e of entries) map.set(e.id, e);
    for (const e of safe) map.set(e.id, e);

    const merged = Array.from(map.values()).sort((a, b) => b.ts - a.ts);
    setEntries(merged);
    setSettings((s) => pushBackup(s, merged, `Imported ${safe.length} entries`));
  }

  function setBudgetTotal(raw: string) {
    const cents = parseMoneyToCents(raw) ?? 0;
    setSettings((s) => ({ ...s, budgets: { ...s.budgets, monthlyTotalCents: cents } }));
  }

  function setCategoryBudget(cat: string, raw: string) {
    const cents = parseMoneyToCents(raw) ?? 0;
    setSettings((s) => ({ ...s, budgets: { ...s.budgets, byCategoryCents: { ...s.budgets.byCategoryCents, [cat]: cents } } }));
  }

  function beginEdit(e: Entry) {
    if (e.source === "recurring") return; // generated, edit the recurring config instead
    setEditingId(e.id);
    setEditDraft({
      type: e.type,
      amount: (e.amountCents / 100).toFixed(2),
      category: e.category,
      note: e.note,
    });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function saveEdit(id: string) {
    const cents = parseMoneyToCents(editDraft.amount);
    if (cents === null) return;

    const updated = entries.map((e) => {
      if (e.id !== id) return e;
      let next: Entry = {
        ...e,
        type: editDraft.type,
        amountCents: cents,
        category: editDraft.category,
        note: editDraft.note,
      };
      // re-run rules (optional but useful)
      next = runRules(settings.rules, next);
      return next;
    });

    setEntries(updated);
    setSettings((s) => pushBackup(s, updated, `Edited entry ${id.slice(0, 6)}`));
    setEditingId(null);
  }

  /* Commands */
  const commands: Command[] = useMemo(
    () => [
      { id: "add-expense", label: "Add expense", hint: "Focus amount input", run: () => { setType("expense"); setTimeout(() => amountRef.current?.focus(), 0); } },
      { id: "add-income", label: "Add income", hint: "Focus amount input", run: () => { setType("income"); setTimeout(() => amountRef.current?.focus(), 0); } },
      { id: "prev-month", label: "Previous month", run: prevMonth },
      { id: "next-month", label: "Next month", run: nextMonth },
      { id: "toggle-stealth", label: `Stealth mode: ${settings.stealthMode ? "On" : "Off"}`, run: () => setSettings((s) => ({ ...s, stealthMode: !s.stealthMode })) },
      { id: "quick-hide", label: `Quick hide: ${hidden ? "On" : "Off"}`, run: () => setHidden((v) => !v) },
      { id: "budgets", label: "Open budgets", run: () => setShowBudgets(true) },
      { id: "rules", label: "Open rules", run: () => setShowRules(true) },
      { id: "recurring", label: "Open recurring", run: () => setShowRecurring(true) },
      { id: "backups", label: "Open backups", run: () => setShowBackups(true) },
      { id: "export-csv", label: "Export CSV", run: exportCsv },
      { id: "export-json", label: "Export JSON", run: exportJson },
      { id: "restore-latest", label: "Restore latest backup", hint: "Replaces current entries", run: () => {
          const b = settings.backups?.[0];
          if (!b) return;
          const ok = confirm(`Restore backup from ${new Date(b.ts).toLocaleString()} (${b.label})?`);
          if (!ok) return;
          setEntries(b.entries);
        } },
    ],
    [settings, hidden] // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* =========================
     Render
  ========================= */

  return (
    <main className={`app ${settings.stealthMode ? "amountMask" : ""} ${hidden ? "quickHide" : ""}`}>
      <div className="bgGrid" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <div className="brandMark" />
          <div>
            <div className="brandTitle">MONEY.RIDICULOID</div>
            <div className="brandSub">Cyberpunk finance dashboard</div>
          </div>
        </div>

        <div className="topActions">
          <div className="seg">
            {(["cyber", "noir", "synth"] as Theme[]).map((t) => (
              <button
                key={t}
                className={`segBtn ${settings.theme === t ? "segOn" : ""}`}
                onClick={() => setSettings((s) => ({ ...s, theme: t }))}
              >
                {t === "cyber" ? "Cyber" : t === "noir" ? "Noir" : "Synth"}
              </button>
            ))}
          </div>

          <div className="monthNav">
            <button className="btnGhost" onClick={prevMonth} aria-label="Previous month">◀</button>
            <div className="monthLabel">{formatMonthLabel(month)}</div>
            <button className="btnGhost" onClick={nextMonth} aria-label="Next month">▶</button>
          </div>

          <button className="btnGhost" onClick={() => setShowBudgets(true)}>Budgets</button>
          <button className="btnGhost" onClick={() => setShowRules(true)}>Rules</button>
          <button className="btnGhost" onClick={() => setShowRecurring(true)}>Recurring</button>
          <button className="btnGhost" onClick={() => setShowBackups(true)}>Backups</button>

          <button className="btnGhost" onClick={exportCsv}>Export CSV</button>
          <button className="btnGhost" onClick={exportJson}>Export JSON</button>

          <button className="btnGhost" onClick={() => fileInputRef.current?.click()}>Import</button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              importFile(f);
              e.currentTarget.value = "";
            }}
          />

          <button
            className="btnGhost danger"
            onClick={() => {
              const ok = confirm("Wipe ALL entries stored in this browser?");
              if (!ok) return;
              setEntries([]);
              setSettings((s) => pushBackup(s, [], "Wiped all entries"));
            }}
          >
            Wipe
          </button>
        </div>
      </header>

      <section className={`hud ${authed ? "" : "hudLocked"}`}>
        <div className="kpiRow">
          <div className="card kpi">
            <div className="kpiLabel">Net</div>
            <div className={`kpiValue ${netTone}`}>{fmtMoney(totals.net)}</div>
            <div className="kpiMeta">Income minus expenses</div>
          </div>
          <div className="card kpi">
            <div className="kpiLabel">Income</div>
            <div className="kpiValue toneGood">{fmtMoney(totals.income)}</div>
            <div className="kpiMeta">This month</div>
          </div>
          <div className="card kpi">
            <div className="kpiLabel">Expenses</div>
            <div className="kpiValue toneBad">{fmtMoney(totals.expense)}</div>
            <div className="kpiMeta">This month</div>
          </div>
          <div className="card kpi trendCard">
            <div className="kpiLabel">Trend</div>
            <Sparkline points={trend} />
            <div className="kpiMeta">Cumulative net</div>
          </div>
        </div>

        <div className="grid">
          {/* Left: Entry + charts */}
          <div className="card panel">
            <div className="panelHead">
              <div>
                <div className="panelTitle">Add Transaction</div>
                <div className="panelSub">Rules apply automatically. Cmd/Ctrl+K for commands.</div>
              </div>
              <div className="pillRow">
                <button className={`pill ${type === "expense" ? "pillOnBad" : ""}`} onClick={() => setType("expense")}>Expense</button>
                <button className={`pill ${type === "income" ? "pillOnGood" : ""}`} onClick={() => setType("income")}>Income</button>
              </div>
            </div>

            <div className="formRow">
              <div className="field">
                <label>Amount</label>
                <input
                  ref={amountRef}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="12.34"
                  onKeyDown={(e) => { if (e.key === "Enter") addEntry(); }}
                />
              </div>
              <div className="field">
                <label>Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {categoriesForType.map((c) => <option value={c} key={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div className="field">
              <label>Note</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="tacos, rent, client invoice…"
                onKeyDown={(e) => { if (e.key === "Enter") addEntry(); }}
              />
            </div>

            <div className="formActions">
              <button className="btnPrimary" onClick={addEntry}>Add</button>
              <button className="btnGhost" onClick={() => { setAmount(""); setNote(""); amountRef.current?.focus(); }}>
                Clear
              </button>
              <button className="btnGhost" onClick={() => setSettings((s) => ({ ...s, stealthMode: !s.stealthMode }))}>
                Stealth: {settings.stealthMode ? "On" : "Off"}
              </button>
              <button className="btnGhost" onClick={() => setHidden((v) => !v)}>
                Quick Hide: {hidden ? "On" : "Off"} (.)
              </button>

              <div className="hint">
                {budgetTotal > 0 ? (
                  <>
                    Budget: {fmtMoney(budgetTotal)} · Used:{" "}
                    <span className={totalPct <= 1 ? "toneGood" : "toneBad"}>{Math.round(totalPct * 100)}%</span>
                  </>
                ) : (
                  <>Set budgets for alerts</>
                )}
              </div>
            </div>

            {budgetTotal > 0 && (
              <div className="budgetBarWrap" aria-label="Budget progress">
                <div className="budgetBar">
                  <div className={`budgetFill ${totalPct <= 1 ? "budgetGood" : "budgetBad"}`} style={{ width: `${clamp(totalPct, 0, 1) * 100}%` }} />
                </div>
                <div className="budgetMeta">
                  Remaining:{" "}
                  <span className={totals.expense <= budgetTotal ? "toneGood" : "toneBad"}>
                    {fmtMoney(budgetTotal - totals.expense)}
                  </span>
                </div>
              </div>
            )}

            <div className="chartRow">
              <div className="miniTitle">Category breakdown</div>
              <div className="chartInner">
                <Donut values={donutValues} labels={donutLabels} />
                <div className="legend">
                  {expenseByCategory.slice(0, 6).map((x, i) => {
                    const pct = totals.expense > 0 ? Math.round((x.cents / totals.expense) * 100) : 0;
                    const target = settings.budgets.byCategoryCents[x.cat] ?? 0;
                    const over = target > 0 && x.cents > target;
                    return (
                      <div key={x.cat} className="legRow">
                        <div className={`legDot legDot${(i % 6) + 1}`} />
                        <div className="legMain">
                          <div className="legTop">
                            <span className="legCat">{x.cat}</span>
                            <span className={`legAmt ${over ? "toneBad" : ""}`}>{fmtMoney(x.cents)}</span>
                          </div>
                          <div className="legSub">
                            {pct}%{target > 0 ? ` · target ${fmtMoney(target)}` : ""}
                          </div>
                          {target > 0 && (
                            <div className="miniBar">
                              <div className={`miniFill ${x.cents <= target ? "budgetGood" : "budgetBad"}`} style={{ width: `${clamp(x.cents / target, 0, 1) * 100}%` }} />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {expenseByCategory.length === 0 && <div className="muted">Add expenses to see the chart.</div>}
                </div>
              </div>
            </div>
          </div>

          {/* Right: Activity */}
          <div className="card panel">
            <div className="panelHead">
              <div>
                <div className="panelTitle">Activity</div>
                <div className="panelSub">Inline edit, delete, undo. Recurring entries are generated.</div>
              </div>
            </div>

            <div className="filters">
              <div className="filterRow">
                <div className="field compact">
                  <label>Type</label>
                  <select value={filterType} onChange={(e) => setFilterType(e.target.value as any)}>
                    <option value="all">All</option>
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                  </select>
                </div>

                <div className="field compact">
                  <label>Category</label>
                  <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
                    {allCategoriesThisMonth.map((c) => <option value={c} key={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              <div className="field">
                <label>Search</label>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="uber, salary, netflix…" />
              </div>
            </div>

            <div className="list">
              {filtered.length === 0 ? (
                <div className="empty">
                  No entries for this view.
                  <div className="emptySub">The ledger sleeps. Wake it with a transaction.</div>
                </div>
              ) : (
                filtered.slice(0, 40).map((e) => {
                  const signed = e.type === "income" ? e.amountCents : -effectiveExpenseCents(e);
                  const isEditing = editingId === e.id;

                  return (
                    <div className="row" key={e.id}>
                      <div className="rowLeft">
                        <div className="rowTop">
                          <span className={`badge ${e.type === "income" ? "badgeGood" : "badgeBad"}`}>
                            {e.type.toUpperCase()}
                          </span>
                          <span className="cat">{e.category}</span>
                          <span className="date">{fmtDate(e.ts)}</span>
                          {e.source === "recurring" && <span className="tag">RECURRING</span>}
                          {e.merchant && <span className="tag">{e.merchant}</span>}
                          {e.splits?.length ? <span className="tag">SPLIT</span> : null}
                        </div>

                        {!isEditing ? (
                          <div className="note">
                            {e.note || <span className="muted">(no note)</span>}
                            {e.splits?.length ? (
                              <div className="splitNote">
                                {e.splits.map((s) => (
                                  <div key={s.category} className="splitLine">
                                    <span className="muted">{s.category}</span>
                                    <span className="muted">{fmtMoney(s.amountCents)}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="editBox">
                            <div className="editRow">
                              <div className="field compact">
                                <label>Type</label>
                                <select value={editDraft.type} onChange={(ev) => setEditDraft((d) => ({ ...d, type: ev.target.value as EntryType }))}>
                                  <option value="expense">Expense</option>
                                  <option value="income">Income</option>
                                </select>
                              </div>

                              <div className="field compact">
                                <label>Amount</label>
                                <input value={editDraft.amount} onChange={(ev) => setEditDraft((d) => ({ ...d, amount: ev.target.value }))} />
                              </div>
                            </div>

                            <div className="editRow">
                              <div className="field compact">
                                <label>Category</label>
                                <select value={editDraft.category} onChange={(ev) => setEditDraft((d) => ({ ...d, category: ev.target.value }))}>
                                  {(editDraft.type === "expense" ? CATEGORIES.expense : CATEGORIES.income).map((c) => (
                                    <option key={c} value={c}>{c}</option>
                                  ))}
                                </select>
                              </div>
                            </div>

                            <div className="field compact">
                              <label>Note</label>
                              <input value={editDraft.note} onChange={(ev) => setEditDraft((d) => ({ ...d, note: ev.target.value }))} />
                            </div>

                            <div className="editActions">
                              <button className="btnPrimary" onClick={() => saveEdit(e.id)}>Save</button>
                              <button className="btnGhost" onClick={cancelEdit}>Cancel</button>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="rowRight">
                        <div className={`amt ${signed >= 0 ? "toneGood" : "toneBad"}`}>
                          {signed >= 0 ? "+" : "−"}{fmtMoney(Math.abs(signed))}
                        </div>

                        {!isEditing && (
                          <>
                            {e.source !== "recurring" && (
                              <button className="iconBtn" onClick={() => beginEdit(e)} aria-label="Edit entry">✎</button>
                            )}
                            {e.source !== "recurring" && (
                              <button className="iconBtn" onClick={() => removeEntry(e.id)} aria-label="Delete entry">✕</button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="footerNote">Showing up to 40 items. Export for full history.</div>
          </div>
        </div>
      </section>

      {/* Undo toast */}
      {undo && (
        <div className="toast" role="status" aria-label="Undo delete">
          <div className="toastText">
            Deleted <span className="toastStrong">{undo.entry.category}</span> {fmtMoney(undo.entry.amountCents)}.
          </div>
          <button className="btnPrimary" onClick={undoDelete}>Undo</button>
          <button className="btnGhost" onClick={() => setUndo(null)}>Dismiss</button>
        </div>
      )}

      {/* Budgets modal */}
      {showBudgets && (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Budgets" onMouseDown={() => setShowBudgets(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalHead">
              <div>
                <div className="modalTitle">Budgets</div>
                <div className="modalSub">Monthly total + per-category targets.</div>
              </div>
              <button className="iconBtn" onClick={() => setShowBudgets(false)} aria-label="Close budgets">✕</button>
            </div>

            <div className="field">
              <label>Monthly total expense budget</label>
              <input
                defaultValue={settings.budgets.monthlyTotalCents ? (settings.budgets.monthlyTotalCents / 100).toFixed(2) : ""}
                placeholder="0.00"
                inputMode="decimal"
                onBlur={(e) => setBudgetTotal(e.target.value)}
              />
            </div>

            <div className="modalGrid">
              {CATEGORIES.expense.map((cat) => {
                const val = settings.budgets.byCategoryCents[cat] ?? 0;
                return (
                  <div key={cat} className="field">
                    <label>{cat} target</label>
                    <input
                      defaultValue={val ? (val / 100).toFixed(2) : ""}
                      placeholder="0.00"
                      inputMode="decimal"
                      onBlur={(e) => setCategoryBudget(cat, e.target.value)}
                    />
                  </div>
                );
              })}
            </div>

            <div className="modalActions">
              <button className="btnPrimary" onClick={() => setShowBudgets(false)}>Done</button>
              <button
                className="btnGhost danger"
                onClick={() => {
                  const ok = confirm("Clear all budgets?");
                  if (!ok) return;
                  setSettings((s) => ({ ...s, budgets: { monthlyTotalCents: 0, byCategoryCents: {} } }));
                }}
              >
                Clear budgets
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rules modal */}
      {showRules && (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Rules" onMouseDown={() => setShowRules(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalHead">
              <div>
                <div className="modalTitle">Rules</div>
                <div className="modalSub">Auto-categorize based on note text (and optional regex).</div>
              </div>
              <button className="iconBtn" onClick={() => setShowRules(false)} aria-label="Close rules">✕</button>
            </div>

            <div className="ruleList">
              {settings.rules.map((r) => (
                <div className="ruleRow" key={r.id}>
                  <label className="chk">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          rules: s.rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)),
                        }))
                      }
                    />
                    <span>Enabled</span>
                  </label>

                  <div className="ruleGrid">
                    <div className="field compact">
                      <label>Type</label>
                      <select
                        value={r.match.type ?? "any"}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            rules: s.rules.map((x) => (x.id === r.id ? { ...x, match: { ...x.match, type: e.target.value as any } } : x)),
                          }))
                        }
                      >
                        <option value="any">Any</option>
                        <option value="expense">Expense</option>
                        <option value="income">Income</option>
                      </select>
                    </div>

                    <div className="field compact">
                      <label>Note includes</label>
                      <input
                        value={r.match.noteIncludes ?? ""}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            rules: s.rules.map((x) => (x.id === r.id ? { ...x, match: { ...x.match, noteIncludes: e.target.value } } : x)),
                          }))
                        }
                        placeholder="uber"
                      />
                    </div>

                    <div className="field compact">
                      <label>Regex (optional)</label>
                      <input
                        value={r.match.noteRegex ?? ""}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            rules: s.rules.map((x) => (x.id === r.id ? { ...x, match: { ...x.match, noteRegex: e.target.value } } : x)),
                          }))
                        }
                        placeholder="(whole\\s*foods|wf)"
                      />
                    </div>

                    <div className="field compact">
                      <label>Action</label>
                      <select
                        value={r.action.kind}
                        onChange={(e) => {
                          const kind = e.target.value as RuleAction["kind"];
                          setSettings((s) => ({
                            ...s,
                            rules: s.rules.map((x) => {
                              if (x.id !== r.id) return x;
                              if (kind === "setCategory") return { ...x, action: { kind: "setCategory", category: "Other" } };
                              if (kind === "setMerchant") return { ...x, action: { kind: "setMerchant", merchant: "Merchant" } };
                              return { ...x, action: { kind: "split", splits: [{ category: "Food", percent: 50 }, { category: "Other", percent: 50 }] } };
                            }),
                          }));
                        }}
                      >
                        <option value="setCategory">Set category</option>
                        <option value="setMerchant">Set merchant</option>
                        <option value="split">Split</option>
                      </select>
                    </div>

                    {r.action.kind === "setCategory" && (
                      <div className="field compact">
                        <label>Category</label>
                        <select
                          value={r.action.category}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              rules: s.rules.map((x) => (x.id === r.id ? { ...x, action: { kind: "setCategory", category: e.target.value } } : x)),
                            }))
                          }
                        >
                          {CATEGORIES.expense.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    )}

                    {r.action.kind === "setMerchant" && (
                      <div className="field compact">
                        <label>Merchant</label>
                        <input
                          value={r.action.merchant}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              rules: s.rules.map((x) => (x.id === r.id ? { ...x, action: { kind: "setMerchant", merchant: e.target.value } } : x)),
                            }))
                          }
                        />
                      </div>
                    )}

                    {r.action.kind === "split" && (
                      <div className="muted small">
                        Split rules are supported (percent/amount), but editing splits in the UI is intentionally simple for now.
                      </div>
                    )}
                  </div>

                  <button
                    className="btnGhost danger"
                    onClick={() => setSettings((s) => ({ ...s, rules: s.rules.filter((x) => x.id !== r.id) }))}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>

            <div className="modalActions">
              <button
                className="btnGhost"
                onClick={() =>
                  setSettings((s) => ({
                    ...s,
                    rules: [
                      ...s.rules,
                      { id: uid(), enabled: true, match: { type: "expense", noteIncludes: "" }, action: { kind: "setCategory", category: "Other" } },
                    ],
                  }))
                }
              >
                + Add rule
              </button>
              <button className="btnPrimary" onClick={() => setShowRules(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Recurring modal */}
      {showRecurring && (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Recurring" onMouseDown={() => setShowRecurring(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalHead">
              <div>
                <div className="modalTitle">Recurring</div>
                <div className="modalSub">Generate predictable entries into the month view.</div>
              </div>
              <button className="iconBtn" onClick={() => setShowRecurring(false)} aria-label="Close recurring">✕</button>
            </div>

            <div className="ruleList">
              {settings.recurring.map((r) => (
                <div className="ruleRow" key={r.id}>
                  <label className="chk">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => setSettings((s) => ({ ...s, recurring: s.recurring.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)) }))}
                    />
                    <span>Enabled</span>
                  </label>

                  <div className="ruleGrid">
                    <div className="field compact">
                      <label>Type</label>
                      <select value={r.type} onChange={(e) => setSettings((s) => ({ ...s, recurring: s.recurring.map((x) => (x.id === r.id ? { ...x, type: e.target.value as EntryType } : x)) }))}>
                        <option value="expense">Expense</option>
                        <option value="income">Income</option>
                      </select>
                    </div>

                    <div className="field compact">
                      <label>Amount</label>
                      <input
                        defaultValue={(r.amountCents / 100).toFixed(2)}
                        onBlur={(e) => {
                          const cents = parseMoneyToCents(e.target.value) ?? r.amountCents;
                          setSettings((s) => ({ ...s, recurring: s.recurring.map((x) => (x.id === r.id ? { ...x, amountCents: cents } : x)) }));
                        }}
                      />
                    </div>

                    <div className="field compact">
                      <label>Category</label>
                      <select value={r.category} onChange={(e) => setSettings((s) => ({ ...s, recurring: s.recurring.map((x) => (x.id === r.id ? { ...x, category: e.target.value } : x)) }))}>
                        {(r.type === "expense" ? CATEGORIES.expense : CATEGORIES.income).map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>

                    <div className="field compact">
                      <label>Note</label>
                      <input value={r.note} onChange={(e) => setSettings((s) => ({ ...s, recurring: s.recurring.map((x) => (x.id === r.id ? { ...x, note: e.target.value } : x)) }))} />
                    </div>

                    <div className="field compact">
                      <label>Cadence</label>
                      <select value={r.cadence} onChange={(e) => setSettings((s) => ({ ...s, recurring: s.recurring.map((x) => (x.id === r.id ? { ...x, cadence: e.target.value as any } : x)) }))}>
                        <option value="monthly">Monthly</option>
                        <option value="weekly">Weekly</option>
                      </select>
                    </div>

                    {r.cadence === "monthly" ? (
                      <div className="field compact">
                        <label>Day of month (1-28)</label>
                        <input
                          type="number"
                          min={1}
                          max={28}
                          value={r.dayOfMonth ?? 1}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              recurring: s.recurring.map((x) => (x.id === r.id ? { ...x, dayOfMonth: clamp(Number(e.target.value), 1, 28) } : x)),
                            }))
                          }
                        />
                      </div>
                    ) : (
                      <div className="field compact">
                        <label>Day of week</label>
                        <select
                          value={r.dayOfWeek ?? 1}
                          onChange={(e) =>
                            setSettings((s) => ({ ...s, recurring: s.recurring.map((x) => (x.id === r.id ? { ...x, dayOfWeek: Number(e.target.value) } : x)) }))
                          }
                        >
                          <option value={0}>Sun</option>
                          <option value={1}>Mon</option>
                          <option value={2}>Tue</option>
                          <option value={3}>Wed</option>
                          <option value={4}>Thu</option>
                          <option value={5}>Fri</option>
                          <option value={6}>Sat</option>
                        </select>
                      </div>
                    )}
                  </div>

                  <button className="btnGhost danger" onClick={() => setSettings((s) => ({ ...s, recurring: s.recurring.filter((x) => x.id !== r.id) }))}>
                    Delete
                  </button>
                </div>
              ))}
            </div>

            <div className="modalActions">
              <button
                className="btnGhost"
                onClick={() =>
                  setSettings((s) => ({
                    ...s,
                    recurring: [
                      ...s.recurring,
                      {
                        id: uid(),
                        enabled: true,
                        type: "expense",
                        amountCents: 1000,
                        category: "Other",
                        note: "Recurring",
                        cadence: "monthly",
                        dayOfMonth: 1,
                        startTs: Date.now(),
                      },
                    ],
                  }))
                }
              >
                + Add recurring
              </button>
              <button className="btnPrimary" onClick={() => setShowRecurring(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Backups modal */}
      {showBackups && (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Backups" onMouseDown={() => setShowBackups(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalHead">
              <div>
                <div className="modalTitle">Backups</div>
                <div className="modalSub">Last 10 local snapshots.</div>
              </div>
              <button className="iconBtn" onClick={() => setShowBackups(false)} aria-label="Close backups">✕</button>
            </div>

            <div className="backupList">
              {(settings.backups ?? []).length === 0 ? (
                <div className="muted">No backups yet. Adds/edits/imports create snapshots.</div>
              ) : (
                settings.backups.map((b, i) => (
                  <div className="backupRow" key={b.ts}>
                    <div>
                      <div className="backupTitle">{new Date(b.ts).toLocaleString()}</div>
                      <div className="muted small">{b.label} · {b.entries.length} entries</div>
                    </div>
                    <button
                      className="btnPrimary"
                      onClick={() => {
                        const ok = confirm(`Restore backup #${i + 1}? This replaces your current entries.`);
                        if (!ok) return;
                        setEntries(b.entries);
                        setShowBackups(false);
                      }}
                    >
                      Restore
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="modalActions">
              <button className="btnPrimary" onClick={() => setShowBackups(false)}>Done</button>
              <button
                className="btnGhost danger"
                onClick={() => {
                  const ok = confirm("Clear all backups?");
                  if (!ok) return;
                  setSettings((s) => ({ ...s, backups: [] }));
                }}
              >
                Clear backups
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Login overlay */}
      {!authed && (
        <div className="lockOverlay" role="dialog" aria-modal="true" aria-label="Login">
          <div className="lockCard">
            <div className="lockTitle">Access Required</div>
            <div className="lockSub">
              Local lock for your personal dashboard. Auto-lock: {settings.autoLockMinutes ? `${settings.autoLockMinutes}m` : "off"}.
            </div>

            <div className="field">
              <label>Auto-lock minutes (0 disables)</label>
              <input
                type="number"
                min={0}
                max={240}
                value={settings.autoLockMinutes}
                onChange={(e) => setSettings((s) => ({ ...s, autoLockMinutes: Math.max(0, Number(e.target.value)) }))}
              />
            </div>

            {settings.passcodeHash ? (
              <>
                <div className="field">
                  <label>Passcode</label>
                  <input
                    value={passcode}
                    onChange={(e) => setPasscode(e.target.value)}
                    type="password"
                    placeholder="••••"
                    onKeyDown={(e) => { if (e.key === "Enter") tryLogin(); }}
                  />
                </div>

                <div className="lockActions">
                  <button className="btnPrimary" onClick={tryLogin}>Unlock</button>
                  <button className="btnGhost" onClick={clearGate}>Remove Lock</button>
                </div>

                <div className="lockHint">Forgot it? “Remove Lock” clears locally.</div>
              </>
            ) : (
              <>
                <div className="lockHint">No passcode set yet. Create one (4+ chars) or continue without.</div>

                <div className="field">
                  <label>New passcode</label>
                  <input value={newPasscode} onChange={(e) => setNewPasscode(e.target.value)} type="password" placeholder="at least 4 characters" />
                </div>

                <div className="field">
                  <label>Confirm</label>
                  <input
                    value={confirmPasscode}
                    onChange={(e) => setConfirmPasscode(e.target.value)}
                    type="password"
                    placeholder="repeat passcode"
                    onKeyDown={(e) => { if (e.key === "Enter") setPasscodeGate(); }}
                  />
                </div>

                <div className="lockActions">
                  <button className="btnPrimary" onClick={setPasscodeGate}>Set & Enter</button>
                  <button className="btnGhost" onClick={() => setAuthed(true)}>Continue Without</button>
                </div>

                <div className="lockHint">Local latch, not real auth. Perfect for a solo tool.</div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Command palette */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />

      {/* Styles */}
      <style jsx global>{`
        :root { color-scheme: dark; }

        html[data-theme="cyber"] {
          --bg: #070A12; --bg2:#0B1020;
          --card: rgba(18, 24, 45, 0.66); --card2: rgba(14, 18, 34, 0.72);
          --stroke: rgba(140, 170, 255, 0.14); --stroke2: rgba(255, 255, 255, 0.08);
          --text: rgba(240, 245, 255, 0.92); --muted: rgba(240, 245, 255, 0.62);
          --good: rgba(60, 255, 220, 0.95); --bad: rgba(255, 85, 210, 0.95);
          --accent: rgba(120, 160, 255, 0.95); --glow: rgba(120, 160, 255, 0.28);
          --shadow: 0 12px 40px rgba(0,0,0,0.55);
          --radius: 18px;
        }

        html[data-theme="noir"] {
          --bg:#050608; --bg2:#0A0C10;
          --card: rgba(18, 18, 18, 0.70); --card2: rgba(10, 10, 10, 0.72);
          --stroke: rgba(255, 255, 255, 0.10); --stroke2: rgba(255, 255, 255, 0.07);
          --text: rgba(245, 245, 245, 0.92); --muted: rgba(245, 245, 245, 0.58);
          --good: rgba(190, 255, 230, 0.95); --bad: rgba(255, 155, 155, 0.95);
          --accent: rgba(220, 220, 220, 0.95); --glow: rgba(255, 255, 255, 0.10);
          --shadow: 0 12px 40px rgba(0,0,0,0.65);
          --radius: 18px;
        }

        html[data-theme="synth"] {
          --bg:#08071A; --bg2:#120A2A;
          --card: rgba(30, 18, 58, 0.62); --card2: rgba(16, 10, 34, 0.70);
          --stroke: rgba(255, 120, 230, 0.16); --stroke2: rgba(255, 255, 255, 0.08);
          --text: rgba(246, 244, 255, 0.92); --muted: rgba(246, 244, 255, 0.60);
          --good: rgba(110, 255, 210, 0.95); --bad: rgba(255, 120, 230, 0.95);
          --accent: rgba(140, 170, 255, 0.95); --glow: rgba(255, 120, 230, 0.18);
          --shadow: 0 12px 40px rgba(0,0,0,0.60);
          --radius: 18px;
        }

        * { box-sizing: border-box; }
        html, body { height: 100%; }
        body {
          margin: 0;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
          background:
            radial-gradient(1200px 700px at 18% 10%, var(--glow), transparent 55%),
            radial-gradient(900px 600px at 80% 20%, rgba(255,85,210,0.10), transparent 52%),
            linear-gradient(180deg, var(--bg), var(--bg2));
          color: var(--text);
          overflow-x: hidden;
        }

        .app {
          max-width: 1250px;
          margin: 0 auto;
          padding: 22px 18px 58px;
          position: relative;
        }

        .bgGrid {
          position: fixed;
          inset: 0;
          pointer-events: none;
          background-image:
            linear-gradient(to right, rgba(120,160,255,0.06) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(120,160,255,0.06) 1px, transparent 1px);
          background-size: 64px 64px;
          mask-image: radial-gradient(circle at 30% 10%, rgba(0,0,0,1), rgba(0,0,0,0.38) 55%, rgba(0,0,0,0));
          opacity: 0.9;
        }

        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 14px 14px;
          border: 1px solid var(--stroke);
          border-radius: var(--radius);
          background: linear-gradient(180deg, rgba(18,24,45,0.62), rgba(10,14,30,0.62));
          box-shadow: var(--shadow);
          backdrop-filter: blur(12px);
          position: sticky;
          top: 14px;
          z-index: 10;
        }

        .brand { display: flex; gap: 12px; align-items: center; }
        .brandMark {
          width: 36px; height: 36px; border-radius: 12px;
          background:
            radial-gradient(circle at 35% 35%, var(--good), transparent 55%),
            radial-gradient(circle at 70% 65%, var(--bad), transparent 58%),
            linear-gradient(135deg, var(--accent), rgba(0,0,0,0));
          box-shadow: 0 0 0 1px rgba(120,160,255,0.22), 0 0 30px var(--glow);
        }
        .brandTitle { font-weight: 820; letter-spacing: 0.12em; font-size: 12px; opacity: 0.95; }
        .brandSub { font-size: 12px; color: var(--muted); margin-top: 2px; }

        .topActions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }

        .seg {
          display: inline-flex;
          border: 1px solid var(--stroke2);
          background: rgba(0,0,0,0.18);
          border-radius: 14px;
          padding: 3px;
          gap: 3px;
        }
        .segBtn {
          border: 1px solid transparent;
          background: transparent;
          color: var(--muted);
          border-radius: 11px;
          padding: 8px 10px;
          cursor: pointer;
          transition: background 140ms ease, color 140ms ease, transform 140ms ease;
          font-weight: 700;
          font-size: 12px;
          letter-spacing: 0.06em;
        }
        .segBtn:hover { transform: translateY(-1px); color: var(--text); }
        .segOn {
          background: rgba(120,160,255,0.14);
          color: var(--text);
          border-color: rgba(120,160,255,0.22);
          box-shadow: 0 0 0 3px rgba(120,160,255,0.10);
        }

        .monthNav {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 8px;
          border-radius: 14px;
          border: 1px solid var(--stroke2);
          background: rgba(0,0,0,0.20);
        }
        .monthLabel { font-size: 13px; color: rgba(240,245,255,0.82); min-width: 160px; text-align: center; }

        .btnGhost, .btnPrimary, .pill, .iconBtn {
          border: 1px solid var(--stroke2);
          background: rgba(0,0,0,0.18);
          color: var(--text);
          border-radius: 14px;
          padding: 10px 12px;
          cursor: pointer;
          transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
          user-select: none;
        }
        .btnGhost:hover { transform: translateY(-1px); border-color: rgba(120,160,255,0.35); box-shadow: 0 0 0 3px rgba(120,160,255,0.12); }
        .btnGhost.danger:hover { border-color: rgba(255,85,210,0.30); box-shadow: 0 0 0 3px rgba(255,85,210,0.10); }

        .btnPrimary {
          background: linear-gradient(135deg, rgba(60,255,220,0.18), rgba(120,160,255,0.16));
          border-color: rgba(60,255,220,0.26);
          box-shadow: 0 0 0 3px rgba(60,255,220,0.10), 0 0 26px rgba(60,255,220,0.10);
          font-weight: 800;
        }
        .btnPrimary:hover { transform: translateY(-1px); box-shadow: 0 0 0 3px rgba(60,255,220,0.14), 0 0 34px rgba(60,255,220,0.12); }

        .hud { margin-top: 18px; }
        .hudLocked { filter: blur(7px) saturate(0.85); pointer-events: none; }

        .kpiRow {
          display: grid;
          grid-template-columns: repeat(12, 1fr);
          gap: 12px;
        }
        .card {
          border: 1px solid var(--stroke);
          border-radius: var(--radius);
          background: linear-gradient(180deg, var(--card), var(--card2));
          box-shadow: var(--shadow);
          backdrop-filter: blur(14px);
        }
        .kpi { padding: 16px 16px; }
        .kpi:nth-child(1) { grid-column: span 3; }
        .kpi:nth-child(2) { grid-column: span 3; }
        .kpi:nth-child(3) { grid-column: span 3; }
        .trendCard { grid-column: span 3; display: flex; flex-direction: column; gap: 8px; }

        .kpiLabel { font-size: 12px; color: var(--muted); letter-spacing: 0.14em; text-transform: uppercase; }
        .kpiValue { font-size: 28px; font-weight: 900; margin-top: 6px; }
        .kpiMeta { font-size: 12px; color: var(--muted); margin-top: 8px; }

        .toneGood { color: var(--good); text-shadow: 0 0 18px rgba(60,255,220,0.12); }
        .toneBad { color: var(--bad); text-shadow: 0 0 18px rgba(255,85,210,0.10); }

        .grid {
          margin-top: 12px;
          display: grid;
          grid-template-columns: 1fr 1.2fr;
          gap: 12px;
        }

        .panel { padding: 16px; }
        .panelHead { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
        .panelTitle { font-size: 16px; font-weight: 900; letter-spacing: 0.02em; }
        .panelSub { font-size: 12px; color: var(--muted); margin-top: 4px; }

        .pillRow { display: flex; gap: 8px; }
        .pill { padding: 8px 10px; font-size: 13px; font-weight: 800; }
        .pillOnBad { border-color: rgba(255,85,210,0.35); box-shadow: 0 0 0 3px rgba(255,85,210,0.10); }
        .pillOnGood { border-color: rgba(60,255,220,0.35); box-shadow: 0 0 0 3px rgba(60,255,220,0.10); }

        .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
        .field.compact { margin-bottom: 0; }
        label { font-size: 12px; color: var(--muted); letter-spacing: 0.06em; }
        input, select {
          border-radius: 14px;
          border: 1px solid var(--stroke2);
          background: rgba(0,0,0,0.24);
          color: var(--text);
          padding: 12px 12px;
          outline: none;
          transition: border-color 140ms ease, box-shadow 140ms ease;
        }
        input:focus, select:focus {
          border-color: rgba(120,160,255,0.40);
          box-shadow: 0 0 0 3px rgba(120,160,255,0.12);
        }

        .formRow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .formActions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .hint { margin-left: auto; font-size: 12px; color: var(--muted); }

        .filters { border-top: 1px solid rgba(140,170,255,0.10); padding-top: 12px; margin-top: 6px; }
        .filterRow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }

        .list { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
        .row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 12px;
          border-radius: 16px;
          border: 1px solid rgba(140,170,255,0.10);
          background: rgba(0,0,0,0.18);
        }
        .rowLeft { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .rowTop { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .badge {
          font-size: 10px;
          padding: 5px 8px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.10);
          letter-spacing: 0.14em;
          font-weight: 900;
        }
        .badgeGood { color: var(--good); border-color: rgba(60,255,220,0.24); }
        .badgeBad { color: var(--bad); border-color: rgba(255,85,210,0.24); }
        .tag {
          font-size: 10px;
          padding: 4px 7px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(240,245,255,0.72);
          letter-spacing: 0.10em;
        }
        .cat { font-size: 12px; color: rgba(240,245,255,0.82); font-weight: 700; }
        .date { font-size: 12px; color: var(--muted); }
        .note { font-size: 13px; overflow-wrap: anywhere; }
        .muted { color: var(--muted); }
        .small { font-size: 12px; }

        .rowRight { display: flex; align-items: center; gap: 10px; }
        .amt { font-weight: 950; font-size: 14px; min-width: 110px; text-align: right; }

        .iconBtn { width: 38px; height: 38px; padding: 0; border-radius: 14px; }
        .iconBtn:hover { border-color: rgba(255,85,210,0.35); box-shadow: 0 0 0 3px rgba(255,85,210,0.10); }

        .empty { padding: 18px 10px; color: rgba(240,245,255,0.82); }
        .emptySub { margin-top: 6px; font-size: 12px; color: var(--muted); }
        .footerNote { margin-top: 12px; font-size: 12px; color: var(--muted); }

        .spark { border-radius: 14px; }
        .sparkLine { fill: none; stroke: var(--accent); stroke-width: 2.2; filter: drop-shadow(0 0 10px rgba(120,160,255,0.18)); }
        .sparkArea { fill: rgba(120,160,255,0.12); }
        .sparkDot { fill: var(--good); filter: drop-shadow(0 0 10px rgba(60,255,220,0.16)); }
        .sparkEmpty { height: 64px; display:flex; align-items:center; }
        .sparkEmptyInner { width: 100%; height: 46px; border-radius: 14px; border: 1px dashed rgba(140,170,255,0.18); background: rgba(0,0,0,0.12); }

        .budgetBarWrap { margin-top: 12px; }
        .budgetBar { height: 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.22); overflow: hidden; }
        .budgetFill { height: 100%; border-radius: 999px; }
        .budgetGood { background: rgba(60,255,220,0.45); box-shadow: 0 0 22px rgba(60,255,220,0.12); }
        .budgetBad { background: rgba(255,85,210,0.42); box-shadow: 0 0 22px rgba(255,85,210,0.12); }
        .budgetMeta { margin-top: 8px; font-size: 12px; color: var(--muted); }

        .chartRow { margin-top: 14px; }
        .miniTitle { font-weight: 900; letter-spacing: 0.06em; font-size: 12px; color: rgba(240,245,255,0.82); text-transform: uppercase; margin-bottom: 10px; }
        .chartInner { display: grid; grid-template-columns: 120px 1fr; gap: 12px; align-items: start; }

        .donutTrack { fill: none; stroke: rgba(255,255,255,0.08); stroke-width: 14; }
        .donutSeg { fill: none; stroke-width: 14; transform: rotate(-90deg); transform-origin: 56px 56px; stroke-linecap: butt; }
        .donutHole { fill: rgba(0,0,0,0.22); }
        .donutText { fill: rgba(240,245,255,0.60); font-size: 12px; font-weight: 800; }
        .donutBig { fill: rgba(240,245,255,0.90); font-size: 12px; font-weight: 950; letter-spacing: 0.02em; }
        .donutSmall { fill: rgba(240,245,255,0.60); font-size: 10px; font-weight: 800; letter-spacing: 0.10em; text-transform: uppercase; }

        .donutSeg1 { stroke: rgba(60,255,220,0.90); }
        .donutSeg2 { stroke: rgba(120,160,255,0.90); }
        .donutSeg3 { stroke: rgba(255,85,210,0.90); }
        .donutSeg4 { stroke: rgba(255,220,120,0.90); }
        .donutSeg5 { stroke: rgba(180,120,255,0.90); }
        .donutSeg6 { stroke: rgba(120,255,160,0.90); }

        .legend { display: flex; flex-direction: column; gap: 10px; }
        .legRow { display: grid; grid-template-columns: 12px 1fr; gap: 10px; }
        .legDot { width: 12px; height: 12px; border-radius: 4px; margin-top: 3px; }
        .legDot1 { background: rgba(60,255,220,0.90); }
        .legDot2 { background: rgba(120,160,255,0.90); }
        .legDot3 { background: rgba(255,85,210,0.90); }
        .legDot4 { background: rgba(255,220,120,0.90); }
        .legDot5 { background: rgba(180,120,255,0.90); }
        .legDot6 { background: rgba(120,255,160,0.90); }

        .legTop { display: flex; justify-content: space-between; gap: 12px; }
        .legCat { font-weight: 900; font-size: 13px; }
        .legAmt { font-weight: 950; font-size: 13px; }
        .legSub { font-size: 12px; color: var(--muted); margin-top: 2px; }
        .miniBar { height: 8px; margin-top: 6px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.18); overflow: hidden; }
        .miniFill { height: 100%; border-radius: 999px; }

        .splitNote { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
        .splitLine { display: flex; justify-content: space-between; gap: 12px; }

        .editBox { margin-top: 8px; }
        .editRow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }
        .editActions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }

        .toast {
          position: fixed;
          left: 50%;
          bottom: 18px;
          transform: translateX(-50%);
          width: min(900px, calc(100% - 24px));
          display: flex;
          gap: 10px;
          align-items: center;
          justify-content: space-between;
          padding: 12px 12px;
          border-radius: 18px;
          border: 1px solid var(--stroke);
          background: linear-gradient(180deg, rgba(18,24,45,0.76), rgba(10,14,30,0.76));
          box-shadow: 0 18px 60px rgba(0,0,0,0.55);
          backdrop-filter: blur(14px);
          z-index: 1000;
        }
        .toastText { color: rgba(240,245,255,0.86); font-size: 13px; }
        .toastStrong { font-weight: 950; }

        .modalOverlay {
          position: fixed;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 18px;
          background: rgba(0,0,0,0.55);
          z-index: 999;
        }
        .modal {
          width: min(980px, 100%);
          border-radius: 22px;
          border: 1px solid rgba(140,170,255,0.22);
          background: linear-gradient(180deg, rgba(18,24,45,0.76), rgba(10,14,30,0.76));
          box-shadow: 0 18px 60px rgba(0,0,0,0.65), 0 0 0 4px rgba(120,160,255,0.08);
          padding: 16px;
          backdrop-filter: blur(14px);
          max-height: min(80vh, 720px);
          overflow: auto;
        }
        .modalHead { display:flex; align-items:flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
        .modalTitle { font-weight: 950; font-size: 18px; letter-spacing: 0.02em; }
        .modalSub { margin-top: 4px; color: var(--muted); font-size: 13px; }
        .modalGrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .modalActions { display:flex; justify-content: flex-end; gap: 10px; margin-top: 12px; flex-wrap: wrap; }

        .ruleList { display: flex; flex-direction: column; gap: 12px; }
        .ruleRow { display: grid; grid-template-columns: 160px 1fr 110px; gap: 12px; padding: 12px; border: 1px solid rgba(140,170,255,0.10); border-radius: 16px; background: rgba(0,0,0,0.18); align-items: start; }
        .ruleGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .chk { display:flex; gap: 10px; align-items: center; color: rgba(240,245,255,0.78); font-size: 12px; }

        .backupList { display: flex; flex-direction: column; gap: 10px; }
        .backupRow { display:flex; justify-content: space-between; gap: 12px; align-items: center; padding: 12px; border-radius: 16px; border: 1px solid rgba(140,170,255,0.10); background: rgba(0,0,0,0.18); }
        .backupTitle { font-weight: 900; }

        .lockOverlay {
          position: fixed;
          inset: 0;
          display: grid;
          place-items: center;
          background: radial-gradient(900px 520px at 50% 20%, rgba(120,160,255,0.18), rgba(0,0,0,0.75)),
                      rgba(0,0,0,0.52);
          z-index: 999;
          padding: 18px;
        }
        .lockCard {
          width: min(520px, 100%);
          border-radius: 22px;
          border: 1px solid rgba(140,170,255,0.22);
          background: linear-gradient(180deg, rgba(18,24,45,0.76), rgba(10,14,30,0.76));
          box-shadow: 0 18px 60px rgba(0,0,0,0.65), 0 0 0 4px rgba(120,160,255,0.08);
          padding: 18px;
          backdrop-filter: blur(14px);
        }
        .lockTitle { font-weight: 950; font-size: 18px; letter-spacing: 0.02em; }
        .lockSub { margin-top: 6px; color: var(--muted); font-size: 13px; line-height: 1.45; }
        .lockActions { margin-top: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
        .lockHint { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.45; }

        /* Command palette */
        .cpOverlay {
          position: fixed;
          inset: 0;
          display: grid;
          place-items: start center;
          padding: 110px 18px 18px;
          background: rgba(0,0,0,0.55);
          z-index: 1200;
        }
        .cp {
          width: min(720px, 100%);
          border-radius: 18px;
          border: 1px solid rgba(140,170,255,0.22);
          background: linear-gradient(180deg, rgba(18,24,45,0.82), rgba(10,14,30,0.82));
          box-shadow: 0 18px 60px rgba(0,0,0,0.65);
          overflow: hidden;
        }
        .cpInput {
          width: 100%;
          border: none;
          border-bottom: 1px solid rgba(140,170,255,0.14);
          background: rgba(0,0,0,0.20);
          padding: 14px 14px;
          color: var(--text);
          outline: none;
          font-size: 14px;
        }
        .cpList { max-height: 360px; overflow: auto; }
        .cpItem {
          width: 100%;
          text-align: left;
          border: none;
          border-bottom: 1px solid rgba(140,170,255,0.10);
          background: transparent;
          color: var(--text);
          padding: 12px 14px;
          cursor: pointer;
        }
        .cpItem:hover { background: rgba(120,160,255,0.10); }
        .cpLabel { font-weight: 850; }
        .cpHint { margin-top: 4px; font-size: 12px; color: var(--muted); }
        .cpEmpty { padding: 14px; color: var(--muted); }

        /* Stealth + quick hide */
        .amountMask .amt,
        .amountMask .kpiValue,
        .amountMask .donutBig {
          filter: blur(10px);
          opacity: 0.35;
          transition: filter 160ms ease, opacity 160ms ease;
        }
        .amountMask .row:hover .amt,
        .amountMask .kpi:hover .kpiValue {
          filter: blur(0);
          opacity: 1;
        }
        .quickHide * { filter: blur(16px) saturate(0.6) !important; }

        @media (max-width: 980px) {
          .grid { grid-template-columns: 1fr; }
          .kpi:nth-child(1), .kpi:nth-child(2), .kpi:nth-child(3), .trendCard { grid-column: span 12; }
          .monthLabel { min-width: 120px; }
          .modalGrid { grid-template-columns: repeat(2, 1fr); }
          .chartInner { grid-template-columns: 1fr; }
          .ruleRow { grid-template-columns: 1fr; }
          .ruleGrid { grid-template-columns: 1fr; }
        }
        @media (max-width: 560px) {
          .modalGrid { grid-template-columns: 1fr; }
        }
      `}</style>
    </main>
  );
}
