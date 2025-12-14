"use client";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useEffect, useState } from "react";
import Dashboard from "./Dashboard";

export default function AuthGate() {
  const [user, setUser] = useState<any>(null);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (!user) {
    return (
      <div style={{display:"flex",justifyContent:"center",alignItems:"center",height:"100vh"}}>
        <button onClick={() => signInWithPopup(auth,new GoogleAuthProvider())}>
          Sign in with Google
        </button>
      </div>
    );
  }
  return <Dashboard uid={user.uid} onLogout={() => signOut(auth)} />;
}
