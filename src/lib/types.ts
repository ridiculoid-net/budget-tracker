export type TxType = "expense" | "income" | "refund";

export type Category = { id: string; name: string; createdAt: number; };

export type Transaction = {
  id: string;
  type: TxType;
  date: string;
  amountCents: number;
  merchant?: string;
  categoryId?: string;
  createdAt: number;
  updatedAt: number;
};

export type IncomeSchedule = {
  id: string;
  name: string;
  cadence: "biweekly";
  startDate: string;
  amountCents: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};
