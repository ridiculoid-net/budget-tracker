"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type EntryType = "income" | "expense";

type Entry = {
  id: string;
  ts: number; // epoch ms
  type: EntryType;
  amountCents: number;
  category: string;
  note: string;
};

type Settings = {
  passcodeHash: string | null; // simple hash for local gate
};

const STORAGE_KEY = "moneytracker:v1";
const SETTINGS_KEY = "moneytracker:settings:v1";

const CATEGORIES = {
  expense: ["Food", "Rent", "Transport", "Utilities", "Subscriptions", "Health", "Shopping", "Travel", "Other"],
  income: ["Salary", "Freelance", "Refund", "Gift", "Interest", "Other"],
};

function fmtMoney(cents: number) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString()}${remainder.toString().padStart(2, "0") === "00" ? "" : "." + remainder.toString().padStart(2, "0")}`;
}

function fmtDate(ts: number) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

// Tiny non-crypto hash (good enough for “keep me honest” local gate)
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

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
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
  const span = Math.max(1, max - min);

  const xs = points.map((_, i) => (i / Math.max(1, points.length - 1)) * (w - pad * 2) + pad);
  const ys = points.map((v) => {
    const t = (v - min) / span;
    return (1 - t) * (h - pad * 2) + pad;
  });

  const d = xs.map((x, i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${ys[i].toFixed(2)}`).join(" ");
  const area = `${d} L ${xs[xs.length - 1].toFixed(2)} ${(h - pad).toFixed(2)} L ${xs[0].toFixed(2)} ${(h - pad).toFixed(2)} Z`;

  return (
    <svg width={w} height={h} className="spark" viewBox={`0 0 ${w} ${h}`} aria-label="Trend sparkline">
      <path className="sparkArea" d={area} />
      <path className="sparkLine" d={d} />
      <circle className="sparkDot" cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="3.2" />
    </svg>
  );
}

export default function Page() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [settings, setSettings] = useState<Settings>({ passcodeHash: null });

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

  const amountRef = useRef<HTMLInputElement | null>(null);

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
    } catch {
      // ignore
    }
  }, [entries]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [settings]);

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

  // Trend: daily net for the month
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

    // cumulative for a smoother cyber vibe
    const cum: number[] = [];
    let run = 0;
    for (const v of buckets) {
      run += v;
      cum.push(run / 100);
    }
    return cum;
  }, [monthEntries, monthStart]);

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

  const categoriesForType = useMemo(() => {
    return type === "expense" ? CATEGORIES.expense : CATEGORIES.income;
  }, [type]);

  useEffect(() => {
    setCategory(categoriesForType[0]);
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps

  function addEntry() {
    const clean = amount.replace(/[^\d.]/g, "");
    const n = Number(clean);
    if (!Number.isFinite(n) || n <= 0) return;

    const cents = Math.round(n * 100);
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
    setEntries(entries.filter((e) => e.id !== id));
  }

  function prevMonth() {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    setMonth(monthKey(d));
  }

  function nextMonth() {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m, 1);
    setMonth(monthKey(d));
  }

  const allCategoriesThisMonth = useMemo(() => {
    const set = new Set<string>();
    for (const e of monthEntries) set.add(e.category);
    return ["All", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [monthEntries]);

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
    setSettings({ passcodeHash: tinyHash(newPasscode) });
    setNewPasscode("");
    setConfirmPasscode("");
    setAuthed(true);
  }

  function clearGate() {
    setSettings({ passcodeHash: null });
    setAuthed(true);
    setPasscode("");
  }

  const monthLabel = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }, [month]);

  const netTone = totals.net >= 0 ? "toneGood" : "toneBad";

  return (
    <main className="app">
      <div className="bgGrid" aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <div className="brandMark" />
          <div>
            <div className="brandTitle">MONEY.RIDICULOID</div>
            <div className="brandSub">Neon ledger for a mortal world</div>
          </div>
        </div>

        <div className="topActions">
          <div className="monthNav">
            <button className="btnGhost" onClick={prevMonth} aria-label="Previous month">◀</button>
            <div className="monthLabel">{monthLabel}</div>
            <button className="btnGhost" onClick={nextMonth} aria-label="Next month">▶</button>
          </div>

          <button
            className="btnGhost"
            onClick={() => {
              const ok = confirm("Export entries to JSON?");
              if (!ok) return;
              const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "money-tracker-export.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export
          </button>

          <button
            className="btnGhost"
            onClick={() => {
              const ok = confirm("This will wipe all entries stored in this browser. Continue?");
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
            <div className="kpiMeta">Income minus Expenses</div>
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
                <div className="panelSub">Fast entry. Zero drama.</div>
              </div>
              <div className="pillRow">
                <button
                  className={`pill ${type === "expense" ? "pillOnBad" : ""}`}
                  onClick={() => setType("expense")}
                >
                  Expense
                </button>
                <button
                  className={`pill ${type === "income" ? "pillOnGood" : ""}`}
                  onClick={() => setType("income")}
                >
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
              />
            </div>

            <div className="formActions">
              <button className="btnPrimary" onClick={addEntry}>
                Add
              </button>

              <button
                className="btnGhost"
                onClick={() => {
                  setAmount("");
                  setNote("");
                  amountRef.current?.focus();
                }}
              >
                Clear
              </button>

              <div className="hint">
                Stored locally in this browser.
              </div>
            </div>
          </div>

          <div className="card panel">
            <div className="panelHead">
              <div>
                <div className="panelTitle">Activity</div>
                <div className="panelSub">Filter, search, delete.</div>
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
                  No entries yet for this view.
                  <div className="emptySub">Add one on the left. Your future self will nod approvingly.</div>
                </div>
              ) : (
                filtered.slice(0, 20).map((e) => {
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
                        <button className="iconBtn" onClick={() => removeEntry(e.id)} aria-label="Delete entry">
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="footerNote">
              Showing up to 20 items. Export for full history.
            </div>
          </div>
        </div>
      </section>

      {!authed && (
        <div className="lockOverlay" role="dialog" aria-modal="true" aria-label="Login">
          <div className="lockCard">
            <div className="lockTitle">Access Required</div>
            <div className="lockSub">
              Local-only lock. Keeps casual eyes out of your neon vault.
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
                  Forgot it? “Remove Lock” clears locally. (No recovery, no server.)
                </div>
              </>
            ) : (
              <>
                <div className="lockHint">
                  No passcode set yet. Create one now (4+ chars), or just continue.
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
                  This is a local gate, not real auth. Perfect for a personal dashboard on your own domain.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style jsx global>{`
        :root {
          color-scheme: dark;
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

        * { box-sizing: border-box; }
        html, body { height: 100%; }
        body {
          margin: 0;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
          background: radial-gradient(1200px 700px at 18% 10%, rgba(120,160,255,0.16), transparent 55%),
                      radial-gradient(900px 600px at 80% 20%, rgba(255,85,210,0.12), transparent 52%),
                      linear-gradient(180deg, var(--bg), var(--bg2));
          color: var(--text);
          overflow-x: hidden;
        }

        .app {
          max-width: 1200px;
          margin: 0 auto;
          padding: 22px 18px 36px;
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
          mask-image: radial-gradient(circle at 30% 10%, rgba(0,0,0,1), rgba(0,0,0,0.35) 55%, rgba(0,0,0,0));
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
          width: 36px;
          height: 36px;
          border-radius: 12px;
          background:
            radial-gradient(circle at 35% 35%, rgba(60,255,220,0.95), transparent 55%),
            radial-gradient(circle at 70% 65%, rgba(255,85,210,0.9), transparent 58%),
            linear-gradient(135deg, rgba(120,160,255,0.8), rgba(0,0,0,0));
          box-shadow: 0 0 0 1px rgba(120,160,255,0.22), 0 0 30px rgba(120,160,255,0.28);
        }
        .brandTitle { font-weight: 820; letter-spacing: 0.12em; font-size: 12px; opacity: 0.95; }
        .brandSub { font-size: 12px; color: var(--muted); margin-top: 2px; }

        .topActions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
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

        .btnPrimary {
          background: linear-gradient(135deg, rgba(60,255,220,0.18), rgba(120,160,255,0.16));
          border-color: rgba(60,255,220,0.26);
          box-shadow: 0 0 0 3px rgba(60,255,220,0.10), 0 0 26px rgba(60,255,220,0.10);
          font-weight: 700;
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
        .kpiValue { font-size: 28px; font-weight: 860; margin-top: 6px; }
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
        .panelTitle { font-size: 16px; font-weight: 820; letter-spacing: 0.02em; }
        .panelSub { font-size: 12px; color: var(--muted); margin-top: 4px; }

        .pillRow { display: flex; gap: 8px; }
        .pill { padding: 8px 10px; font-size: 13px; }
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
        }
        .badgeGood { color: var(--good); border-color: rgba(60,255,220,0.24); }
        .badgeBad { color: var(--bad); border-color: rgba(255,85,210,0.24); }
        .cat { font-size: 12px; color: rgba(240,245,255,0.82); }
        .date { font-size: 12px; color: var(--muted); }
        .note { font-size: 13px; }
        .muted { color: var(--muted); }

        .rowRight { display: flex; align-items: center; gap: 10px; }
        .amt { font-weight: 850; font-size: 14px; min-width: 110px; text-align: right; }

        .iconBtn { width: 38px; height: 38px; padding: 0; border-radius: 14px; }
        .iconBtn:hover { border-color: rgba(255,85,210,0.35); box-shadow: 0 0 0 3px rgba(255,85,210,0.10); }

        .empty { padding: 18px 10px; color: rgba(240,245,255,0.82); }
        .emptySub { margin-top: 6px; font-size: 12px; color: var(--muted); }
        .footerNote { margin-top: 12px; font-size: 12px; color: var(--muted); }

        .spark { border-radius: 14px; }
        .sparkLine { fill: none; stroke: rgba(120,160,255,0.95); stroke-width: 2.2; filter: drop-shadow(0 0 10px rgba(120,160,255,0.18)); }
        .sparkArea { fill: rgba(120,160,255,0.12); }
        .sparkDot { fill: rgba(60,255,220,0.95); filter: drop-shadow(0 0 10px rgba(60,255,220,0.16)); }

        .sparkEmpty { height: 64px; display:flex; align-items:center; }
        .sparkEmptyInner { width: 100%; height: 46px; border-radius: 14px; border: 1px dashed rgba(140,170,255,0.18); background: rgba(0,0,0,0.12); }

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
        .lockTitle { font-weight: 900; font-size: 18px; letter-spacing: 0.02em; }
        .lockSub { margin-top: 6px; color: var(--muted); font-size: 13px; line-height: 1.45; }
        .lockActions { margin-top: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
        .lockHint { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.45; }

        @media (max-width: 980px) {
          .grid { grid-template-columns: 1fr; }
          .kpi:nth-child(1), .kpi:nth-child(2), .kpi:nth-child(3), .trendCard { grid-column: span 12; }
          .monthLabel { min-width: 120px; }
        }
      `}</style>
    </main>
  );
}
