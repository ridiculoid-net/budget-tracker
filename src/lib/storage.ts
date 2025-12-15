import type { Entry, SettingsV3, Backup } from "./schema";

export const ENTRIES_KEY = "moneytracker:v3:entries";
export const SETTINGS_KEY = "moneytracker:v3:settings";

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, val: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

export function pushBackup(settings: SettingsV3, entries: Entry[], label: string): SettingsV3 {
  const backups: Backup[] = [
    { ts: Date.now(), label, entries },
    ...(settings.backups ?? []),
  ].slice(0, 10); // last 10
  return { ...settings, backups };
}
