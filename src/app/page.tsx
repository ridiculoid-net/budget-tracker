"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type EntryType = "income" | "expense";

type Entry = {
  id: string;
  ts: number;
  type: EntryType;
  amountCents: number;
  category: string;
  note: string;
};

type Settings = {
  passcodeHash: string | null;
  theme: Theme;
  budgets: {
    monthlyTotalCents: number; // overall expense budget
    byCategoryCents: Record<string, number>;
  };
};

type Theme = "cyber" | "noir" | "synth";

const STORAGE_KEY = "moneytracker:v2:entries";
const SETTINGS_KEY = "moneytracker:v2:settings";

const CATEGORIES = {
  expense: ["Food", "Rent", "Transport", "Utilities", "Subscriptions", "Health", "Shopping", "Travel", "Other"],
  income: ["Salary", "Freelance", "Refund", "Gift", "Interest", "Other"],
};

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

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
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

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseMoneyToCents(raw: string) {
  const clean = raw.replace(/[^\d.]/g, "");
  const n = Number(clean);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function formatMonthLabel(m: string) {
  const [y, mm] = m.split("-").map(Number);
  return new Date(y, mm - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function toCsv(entries: Entry[]) {
  const header = "id,ts,type,amount,category,note";
  const lines = entries.map((e) => {
    const amount = (e.amountCents / 100).toFixed(2);
    const esc = (s: string) => {
      const needs = /[,"\n]/.test(s);
      const x = s.replace(/"/g, '""');
      return needs ? `"${x}"` : x;
    };
    return [e.id, String(e.ts), e.type, amount, esc(e.category), esc(e.note)].join(",");
  });
  return [header, ...lines].join("\n");
}

function fromCsv(text: string): Entry[] {
  // Minimal CSV parser that supports quoted fields.
  const rows: string[][] = [];
  let i = 0;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const readField = () => {
    let out = "";
    let quoted = false;
    if (s[i] === '"') {
      quoted = true;
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
    // consume until comma/newline
    while (i < s.length && s[i] !== "," && s[i] !== "\n" && s[i] !== "\r") i++;
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

  const out: Entry[] = [];
  for (const r of rows.slice(1)) {
    const get = (k: number) => (k >= 0 ? (r[k] ?? "").trim() : "");
    const type = get(typeI) as EntryType;
    const ts = Number(get(tsI));
    const amount = Number(get(amtI));
    const category = get(catI) || "Other";
    const note = get(noteI);
    const id = get(idI) || uid();

    if ((type !== "income" && type !== "expense") || !Number.isFinite(ts) || !Number.isFinite(amount)) continue;

    out.push({
      id,
      ts,
      type,
      amountCents: Math.round(amount * 100),
      category,
      note,
    });
  }
  return out;
}

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

function Donut({
  values,
  labels,
}: {
  values: number[];
  labels: string[];
}) {
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

export default function Page() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [settings, setSettings] = useState<Settings>({
    passcodeHash: null,
    theme: "cyber",
    budgets: { monthlyTotalCents: 0, byCategoryCents: {} },
  });

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

  const [undo, setUndo] = useState<{ entry: Entry; expiresAt: number } | null>(null);

  const amountRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const sraw = localStorage.getItem(SETTINGS_KEY);
      if (raw) setEntries(JSON.parse(raw));
      if (sraw) setSettings(JSON.parse(sraw));
    } catch {
      // ignore
    }
  }, []);

  // Save
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {}
  }, [entries]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  // Theme apply
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  // Month bounds
  const monthStart = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return startOfMonth(new Date(y, m - 1, 1));
  }, [month]);

  const monthEnd = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return endOfMonth(new Date(y, m - 1, 1));
  }, [month]);

  const monthEntries = useMemo(() => {
    return entries
      .filter((e) => e.ts >= monthStart && e.ts <= monthEnd)
      .sort((a, b) => b.ts - a.ts);
  }, [entries, monthStart, monthEnd]);

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const e of monthEntries) {
      if (e.type === "income") income += e.amountCents;
      else expense += e.amountCents;
    }
    const net = income - expense;
    return { income, expense, net };
  }, [monthEntries]);

  // Trend: daily cumulative net
  const trend = useMemo(() => {
    const start = new Date(monthStart);
    const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    const buckets = new Array(daysInMonth).fill(0);
    for (const e of monthEntries) {
      const d = new Date(e.ts);
      const idx = d.getDate() - 1;
      const signed = e.type === "income" ? e.amountCents : -e.amountCents;
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

  const categoriesForType = useMemo(() => (type === "expense" ? CATEGORIES.expense : CATEGORIES.income), [type]);

  useEffect(() => {
    setCategory(categoriesForType[0]);
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return monthEntries.filter((e) => {
      if (filterType !== "all" && e.type !== filterType) return false;
      if (filterCategory !== "All" && e.category !== filterCategory) return false;
      if (qq) {
        const hay = `${e.note} ${e.category} ${e.type}`.toLowerCase();
        if (!hay.includes(qq)) return false;
      }
      return true;
    });
  }, [monthEntries, filterType, filterCategory, q]);

  const allCategoriesThisMonth = useMemo(() => {
    const set = new Set<string>();
    for (const e of monthEntries) set.add(e.category);
    return ["All", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [monthEntries]);

  const expenseByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of monthEntries) {
      if (e.type !== "expense") continue;
      map.set(e.category, (map.get(e.category) ?? 0) + e.amountCents);
    }
    const arr = Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([cat, cents]) => ({ cat, cents }));
    return arr;
  }, [monthEntries]);

  const donutValues = useMemo(() => expenseByCategory.slice(0, 6).map((x) => x.cents / 100), [expenseByCategory]);
  const donutLabels = useMemo(() => expenseByCategory.slice(0, 6).map((x) => x.cat), [expenseByCategory]);

  const budgetTotal = settings.budgets.monthlyTotalCents;
  const totalPct = budgetTotal > 0 ? clamp(totals.expense / budgetTotal, 0, 4) : 0;

  const netTone = totals.net >= 0 ? "toneGood" : "toneBad";

  function addEntry() {
    const cents = parseMoneyToCents(amount);
    if (cents === null) return;

    const entry: Entry = {
      id: uid(),
      ts: Date.now(),
      type,
      amountCents: cents,
      category,
      note: note.trim(),
    };

    setEntries([entry, ...entries]);
    setAmount("");
    setNote("");
    amountRef.current?.focus();
  }

  function removeEntry(id: string) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;

    setEntries(entries.filter((e) => e.id !== id));
    const expiresAt = Date.now() + 8000;
    setUndo({ entry, expiresAt });
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
    setSettings({ ...settings, passcodeHash: tinyHash(newPasscode) });
    setNewPasscode("");
    setConfirmPasscode("");
    setAuthed(true);
  }

  function clearGate() {
    setSettings({ ...settings, passcodeHash: null });
    setAuthed(true);
    setPasscode("");
  }

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
        if (Array.isArray(raw)) imported = raw as Entry[];
      } catch {}
    } else if (file.name.toLowerCase().endsWith(".csv")) {
      imported = fromCsv(text);
    } else {
      // try both
      try {
        const raw = JSON.parse(text);
        if (Array.isArray(raw)) imported = raw as Entry[];
      } catch {
        imported = fromCsv(text);
      }
    }

    // basic sanitize + dedupe by id
 const safe: Entry[] = imported
  .filter((e) => e && typeof e === "object")
  .map((e: any): Entry => {
    const t: EntryType = e.type === "income" ? "income" : "expense";
    return {
      id: String(e.id ?? uid()),
      ts: Number(e.ts ?? Date.now()),
      type: t,
      amountCents: Math.round(Number(e.amountCents ?? 0)),
      category: String(e.category ?? "Other"),
      note: String(e.note ?? ""),
    };
  })
  .filter((e) => Number.isFinite(e.ts) && Number.isFinite(e.amountCents) && e.amountCents > 0);


    const map = new Map<string, Entry>();
    for (const e of entries) map.set(e.id, e);
    for (const e of safe) map.set(e.id, e);

    setEntries(Array.from(map.values()).sort((a, b) => b.ts - a.ts));
  }

  function setBudgetTotal(raw: string) {
    const cents = parseMoneyToCents(raw);
    setSettings({
      ...settings,
      budgets: {
        ...settings.budgets,
        monthlyTotalCents: cents ?? 0,
      },
    });
  }

  function setCategoryBudget(cat: string, raw: string) {
    const cents = parseMoneyToCents(raw) ?? 0;
    setSettings({
      ...settings,
      budgets: {
        ...settings.budgets,
        byCategoryCents: { ...settings.budgets.byCategoryCents, [cat]: cents },
      },
    });
  }

  function themeLabel(t: Theme) {
    if (t === "cyber") return "Cyber";
    if (t === "noir") return "Noir";
    return "Synth";
  }

  return (
    <main className="app">
      <div className="bgGrid" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <div className="brandMark" />
          <div>
            <div className="brandTitle">MONEY.RIDICULOID</div>
            <div className="brandSub">Dashboard-first neon finance</div>
          </div>
        </div>

        <div className="topActions">
          <div className="seg">
            {(["cyber", "noir", "synth"] as Theme[]).map((t) => (
              <button
                key={t}
                className={`segBtn ${settings.theme === t ? "segOn" : ""}`}
                onClick={() => setSettings({ ...settings, theme: t })}
                aria-label={`Theme ${themeLabel(t)}`}
              >
                {themeLabel(t)}
              </button>
            ))}
          </div>

          <div className="monthNav">
            <button className="btnGhost" onClick={prevMonth} aria-label="Previous month">◀</button>
            <div className="monthLabel">{formatMonthLabel(month)}</div>
            <button className="btnGhost" onClick={nextMonth} aria-label="Next month">▶</button>
          </div>

          <button className="btnGhost" onClick={() => setShowBudgets(true)}>Budgets</button>

          <button className="btnGhost" onClick={exportCsv}>Export CSV</button>
          <button className="btnGhost" onClick={exportJson}>Export JSON</button>

          <button
            className="btnGhost"
            onClick={() => fileInputRef.current?.click()}
          >
            Import
          </button>

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
              const ok = confirm("Wipe all entries stored in this browser?");
              if (!ok) return;
              setEntries([]);
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
          <div className="card panel">
            <div className="panelHead">
              <div>
                <div className="panelTitle">Add Transaction</div>
                <div className="panelSub">Fast entry, persistent locally.</div>
              </div>
              <div className="pillRow">
                <button className={`pill ${type === "expense" ? "pillOnBad" : ""}`} onClick={() => setType("expense")}>
                  Expense
                </button>
                <button className={`pill ${type === "income" ? "pillOnGood" : ""}`} onClick={() => setType("income")}>
                  Income
                </button>
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addEntry();
                  }}
                />
              </div>

              <div className="field">
                <label>Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {categoriesForType.map((c) => (
                    <option value={c} key={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label>Note</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="tacos, rent, client invoice, etc."
                onKeyDown={(e) => {
                  if (e.key === "Enter") addEntry();
                }}
              />
            </div>

            <div className="formActions">
              <button className="btnPrimary" onClick={addEntry}>Add</button>
              <button className="btnGhost" onClick={() => { setAmount(""); setNote(""); amountRef.current?.focus(); }}>
                Clear
              </button>

              <div className="hint">
                {budgetTotal > 0 ? (
                  <>
                    Budget: {fmtMoney(budgetTotal)} · Used:{" "}
                    <span className={totalPct <= 1 ? "toneGood" : "toneBad"}>
                      {Math.round(totalPct * 100)}%
                    </span>
                  </>
                ) : (
                  <>Set budgets for alerts + progress</>
                )}
              </div>
            </div>

            {budgetTotal > 0 && (
              <div className="budgetBarWrap" aria-label="Budget progress">
                <div className="budgetBar">
                  <div
                    className={`budgetFill ${totalPct <= 1 ? "budgetGood" : "budgetBad"}`}
                    style={{ width: `${clamp(totalPct, 0, 1) * 100}%` }}
                  />
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
              <div className="chartBlock">
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
                                <div
                                  className={`miniFill ${x.cents <= target ? "budgetGood" : "budgetBad"}`}
                                  style={{ width: `${clamp(x.cents / target, 0, 1) * 100}%` }}
                                />
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
          </div>

          <div className="card panel">
            <div className="panelHead">
              <div>
                <div className="panelTitle">Activity</div>
                <div className="panelSub">Filter, search, delete, undo.</div>
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
                    {allCategoriesThisMonth.map((c) => (
                      <option value={c} key={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label>Search</label>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="food, salary, uber..." />
              </div>
            </div>

            <div className="list">
              {filtered.length === 0 ? (
                <div className="empty">
                  No entries for this view.
                  <div className="emptySub">Add one on the left. The ledger hungers.</div>
                </div>
              ) : (
                filtered.slice(0, 40).map((e) => {
                  const signed = e.type === "income" ? e.amountCents : -e.amountCents;
                  return (
                    <div className="row" key={e.id}>
                      <div className="rowLeft">
                        <div className="rowTop">
                          <span className={`badge ${e.type === "income" ? "badgeGood" : "badgeBad"}`}>
                            {e.type.toUpperCase()}
                          </span>
                          <span className="cat">{e.category}</span>
                          <span className="date">{fmtDate(e.ts)}</span>
                        </div>
                        <div className="note">{e.note || <span className="muted">(no note)</span>}</div>
                      </div>

                      <div className="rowRight">
                        <div className={`amt ${signed >= 0 ? "toneGood" : "toneBad"}`}>
                          {signed >= 0 ? "+" : "−"}{fmtMoney(Math.abs(signed))}
                        </div>
                        <button className="iconBtn" onClick={() => removeEntry(e.id)} aria-label="Delete entry">✕</button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="footerNote">
              Showing up to 40 items. Export for full history.
            </div>
          </div>
        </div>
      </section>

      {undo && (
        <div className="toast" role="status" aria-label="Undo delete">
          <div className="toastText">
            Deleted <span className="toastStrong">{undo.entry.category}</span> {fmtMoney(undo.entry.amountCents)}.
          </div>
          <button className="btnPrimary" onClick={undoDelete}>Undo</button>
          <button className="btnGhost" onClick={() => setUndo(null)}>Dismiss</button>
        </div>
      )}

      {showBudgets && (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Budgets">
          <div className="modal">
            <div className="modalHead">
              <div>
                <div className="modalTitle">Budgets</div>
                <div className="modalSub">Optional guardrails for expenses. Local-only.</div>
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
              <div className="muted small">Used for the big progress bar and “remaining”.</div>
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
                  setSettings({ ...settings, budgets: { monthlyTotalCents: 0, byCategoryCents: {} } });
                }}
              >
                Clear budgets
              </button>
            </div>
          </div>
        </div>
      )}

      {!authed && (
        <div className="lockOverlay" role="dialog" aria-modal="true" aria-label="Login">
          <div className="lockCard">
            <div className="lockTitle">Access Required</div>
            <div className="lockSub">
              Local lock. Keeps the dashboard from casual drive-by eyeballs.
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
                    onKeyDown={(e) => {
                      if (e.key === "Enter") tryLogin();
                    }}
                  />
                </div>

                <div className="lockActions">
                  <button className="btnPrimary" onClick={tryLogin}>Unlock</button>
                  <button className="btnGhost" onClick={clearGate}>Remove Lock</button>
                </div>

                <div className="lockHint">
                  Forgot it? “Remove Lock” clears locally. (No recovery.)
                </div>
              </>
            ) : (
              <>
                <div className="lockHint">
                  No passcode set yet. Create one now (4+ chars) or continue without.
                </div>

                <div className="field">
                  <label>New passcode</label>
                  <input
                    value={newPasscode}
                    onChange={(e) => setNewPasscode(e.target.value)}
                    type="password"
                    placeholder="at least 4 characters"
                  />
                </div>

                <div className="field">
                  <label>Confirm</label>
                  <input
                    value={confirmPasscode}
                    onChange={(e) => setConfirmPasscode(e.target.value)}
                    type="password"
                    placeholder="repeat passcode"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setPasscodeGate();
                    }}
                  />
                </div>

                <div className="lockActions">
                  <button className="btnPrimary" onClick={setPasscodeGate}>Set & Enter</button>
                  <button className="btnGhost" onClick={() => setAuthed(true)}>Continue Without</button>
                </div>

                <div className="lockHint">
                  This is not real auth. It’s a locally enforced door latch.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style jsx global>{`
        :root {
          color-scheme: dark;
        }

        /* Theme tokens */
        html[data-theme="cyber"] {
          --bg: #070A12;
          --bg2: #0B1020;
          --card: rgba(18, 24, 45, 0.66);
          --card2: rgba(14, 18, 34, 0.72);
          --stroke: rgba(140, 170, 255, 0.14);
          --stroke2: rgba(255, 255, 255, 0.08);
          --text: rgba(240, 245, 255, 0.92);
          --muted: rgba(240, 245, 255, 0.62);
          --good: rgba(60, 255, 220, 0.95);
          --bad: rgba(255, 85, 210, 0.95);
          --accent: rgba(120, 160, 255, 0.95);
          --glow: rgba(120, 160, 255, 0.28);
          --shadow: 0 12px 40px rgba(0,0,0,0.55);
          --radius: 18px;
        }

        html[data-theme="noir"] {
          --bg: #050608;
          --bg2: #0A0C10;
          --card: rgba(18, 18, 18, 0.70);
          --card2: rgba(10, 10, 10, 0.72);
          --stroke: rgba(255, 255, 255, 0.10);
          --stroke2: rgba(255, 255, 255, 0.07);
          --text: rgba(245, 245, 245, 0.92);
          --muted: rgba(245, 245, 245, 0.58);
          --good: rgba(190, 255, 230, 0.95);
          --bad: rgba(255, 155, 155, 0.95);
          --accent: rgba(220, 220, 220, 0.95);
          --glow: rgba(255, 255, 255, 0.10);
          --shadow: 0 12px 40px rgba(0,0,0,0.65);
          --radius: 18px;
        }

        html[data-theme="synth"] {
          --bg: #08071A;
          --bg2: #120A2A;
          --card: rgba(30, 18, 58, 0.62);
          --card2: rgba(16, 10, 34, 0.70);
          --stroke: rgba(255, 120, 230, 0.16);
          --stroke2: rgba(255, 255, 255, 0.08);
          --text: rgba(246, 244, 255, 0.92);
          --muted: rgba(246, 244, 255, 0.60);
          --good: rgba(110, 255, 210, 0.95);
          --bad: rgba(255, 120, 230, 0.95);
          --accent: rgba(140, 170, 255, 0.95);
          --glow: rgba(255, 120, 230, 0.18);
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
        html[data-theme="noir"] .bgGrid {
          background-image:
            linear-gradient(to right, rgba(255,255,255,0.045) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255,255,255,0.045) 1px, transparent 1px);
        }
        html[data-theme="synth"] .bgGrid {
          background-image:
            linear-gradient(to right, rgba(255,120,230,0.06) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(140,170,255,0.05) 1px, transparent 1px);
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
        html[data-theme="noir"] .topbar {
          background: linear-gradient(180deg, rgba(14,14,14,0.70), rgba(8,8,8,0.70));
        }
        html[data-theme="synth"] .topbar {
          background: linear-gradient(180deg, rgba(30,18,58,0.62), rgba(10,8,24,0.72));
        }

        .brand { display: flex; gap: 12px; align-items: center; }
        .brandMark {
          width: 36px;
          height: 36px;
          border-radius: 12px;
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
        html[data-theme="noir"] .segOn { background: rgba(255,255,255,0.09); box-shadow: 0 0 0 3px rgba(255,255,255,0.07); }
        html[data-theme="synth"] .segOn { background: rgba(255,120,230,0.12); box-shadow: 0 0 0 3px rgba(255,120,230,0.08); }

        .monthNav {
          display: flex;
          align-items: center;
          gap: 8px;
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
        .btnGhost:active { transform: translateY(0px); }
        .btnGhost.danger:hover { border-color: rgba(255,85,210,0.30); box-shadow: 0 0 0 3px rgba(255,85,210,0.10); }

        .btnPrimary {
          background: linear-gradient(135deg, rgba(60,255,220,0.18), rgba(120,160,255,0.16));
          border-color: rgba(60,255,220,0.26);
          box-shadow: 0 0 0 3px rgba(60,255,220,0.10), 0 0 26px rgba(60,255,220,0.10);
          font-weight: 800;
          letter-spacing: 0.02em;
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
        .pill { padding: 8px 10px; font-size: 13px; font-weight: 800; letter-spacing: 0.02em; }
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
        .rowLeft { display: flex; flex-direction: column; gap: 6px; }
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
        .cat { font-size: 12px; color: rgba(240,245,255,0.82); font-weight: 700; }
        .date { font-size: 12px; color: var(--muted); }
        .note { font-size: 13px; }
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
          width: min(920px, 100%);
          border-radius: 22px;
          border: 1px solid rgba(140,170,255,0.22);
          background: linear-gradient(180deg, rgba(18,24,45,0.76), rgba(10,14,30,0.76));
          box-shadow: 0 18px 60px rgba(0,0,0,0.65), 0 0 0 4px rgba(120,160,255,0.08);
          padding: 16px;
          backdrop-filter: blur(14px);
        }
        .modalHead { display:flex; align-items:flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
        .modalTitle { font-weight: 950; font-size: 18px; letter-spacing: 0.02em; }
        .modalSub { margin-top: 4px; color: var(--muted); font-size: 13px; }
        .modalGrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .modalActions { display:flex; justify-content: flex-end; gap: 10px; margin-top: 12px; flex-wrap: wrap; }

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

        @media (max-width: 980px) {
          .grid { grid-template-columns: 1fr; }
          .kpi:nth-child(1), .kpi:nth-child(2), .kpi:nth-child(3), .trendCard { grid-column: span 12; }
          .monthLabel { min-width: 120px; }
          .modalGrid { grid-template-columns: repeat(2, 1fr); }
          .chartInner { grid-template-columns: 1fr; }
        }
        @media (max-width: 560px) {
          .modalGrid { grid-template-columns: 1fr; }
        }
      `}</style>
    </main>
  );
}
