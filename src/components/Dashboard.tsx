"use client";
import { collection, addDoc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useEffect, useState } from "react";
import CsvImport from "./CsvImport";

export default function Dashboard({ uid, onLogout }: any) {
  const [amount, setAmount] = useState("");
  const [txs, setTxs] = useState<any[]>([]);

  useEffect(() => {
    return onSnapshot(collection(db,"users",uid,"transactions"), snap => {
      setTxs(snap.docs.map(d=>d.data()));
    });
  }, [uid]);

  async function addExpense() {
    await addDoc(collection(db,"users",uid,"transactions"),{
      type:"expense",
      date:new Date().toISOString().slice(0,10),
      amountCents:Math.round(Number(amount)*100),
      createdAt:Date.now(),
      updatedAt:Date.now()
    });
    setAmount("");
  }

  return (
    <div style={{padding:20}}>
      <h1>Dashboard</h1>
      <button onClick={onLogout}>Logout</button>

      <div>
        <input value={amount} onChange={e=>setAmount(e.target.value)} placeholder="Amount"/>
        <button onClick={addExpense}>Add Expense</button>
      </div>

      <CsvImport uid={uid} />

      <pre>{JSON.stringify(txs,null,2)}</pre>
    </div>
  );
}
