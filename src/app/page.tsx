"use client";

import { useState } from "react";
import AuthGate from "../components/AuthGate";

type Entry = {
  id: number;
  type: "income" | "expense";
  label: string;
  amount: number;
};

export default function Page() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"income" | "expense">("expense");

  const addEntry = () => {
    if (!label || !amount) return;

    setEntries([
      ...entries,
      {
        id: Date.now(),
        type,
        label,
        amount: Number(amount),
      },
    ]);

    setLabel("");
    setAmount("");
  };

  const income = entries
    .filter(e => e.type === "income")
    .reduce((a, b) => a + b.amount, 0);

  const expenses = entries
    .filter(e => e.type === "expense")
    .reduce((a, b) => a + b.amount, 0);

  const balance = income - expenses;

  return (
    <AuthGate>
      <main style={{ maxWidth: 600, margin: "40px auto", fontFamily: "system-ui" }}>
        {!loggedIn ? (
          <>
            <h1>Money Tracker</h1>
            <button onClick={() => setLoggedIn(true)}>
              Log in
            </button>
          </>
        ) : (
          <>
            <h1>Dashboard</h1>

            <p><strong>Balance:</strong> ${balance}</p>
            <p>Income: ${income}</p>
            <p>Expenses: ${expenses}</p>

            <hr />

            <h2>Add Entry</h2>

            <select value={type} onChange={e => setType(e.target.value as any)}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>

            <br /><br />

            <input
              placeholder="Description"
              value={label}
              onChange={e => setLabel(e.target.value)}
            />

            <br /><br />

            <input
              type="number"
              placeholder="Amount"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />

            <br /><br />

            <button onClick={addEntry}>Add</button>

            <hr />

            <h2>Entries</h2>
            <ul>
              {entries.map(e => (
                <li key={e.id}>
                  {e.type === "expense" ? "−" : "+"}${e.amount} {e.label}
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </AuthGate>
  );
}
