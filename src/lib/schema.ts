export type EntryType = "income" | "expense";

export type Entry = {
  id: string;
  ts: number;
  type: EntryType;
  amountCents: number;
  category: string;
  note: string;
  splits?: { category: string; amountCents: number }[]; // optional split support
  merchant?: string; // extracted via rules
};

export type RuleAction =
  | { kind: "setCategory"; category: string }
  | { kind: "setMerchant"; merchant: string }
  | { kind: "split"; splits: { category: string; percent?: number; amountCents?: number }[] };

export type Rule = {
  id: string;
  enabled: boolean;
  match: {
    type?: EntryType | "any";
    noteIncludes?: string;      // substring match
    noteRegex?: string;         // optional regex string
    minCents?: number;
    maxCents?: number;
  };
  action: RuleAction;
};

export type Recurring = {
  id: string;
  enabled: boolean;
  type: EntryType;
  amountCents: number;
  category: string;
  note: string;
  cadence: "monthly" | "weekly";
  dayOfMonth?: number; // 1-28 recommended
  dayOfWeek?: number;  // 0-6 Sun-Sat
  startTs: number;
  endTs?: number;
};

export type Backup = {
  ts: number;
  label: string;
  entries: Entry[];
};

export type Theme = "cyber" | "noir" | "synth";

export type SettingsV3 = {
  version: 3;
  passcodeHash: string | null;
  theme: Theme;

  stealthMode: boolean;      // blur amounts unless hovered
  autoLockMinutes: number;   // 0 disables

  budgets: {
    monthlyTotalCents: number;
    byCategoryCents: Record<string, number>;
  };

  rules: Rule[];
  recurring: Recurring[];

  backups: Backup[]; // rolling local backups
};
