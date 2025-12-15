"use client";

import { useEffect, useMemo, useState } from "react";

export type Command = { id: string; label: string; hint?: string; run: () => void };

export default function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
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
        <input
          className="cpInput"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a command…"
        />
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
