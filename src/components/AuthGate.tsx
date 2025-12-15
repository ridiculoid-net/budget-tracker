"use client";

import type { ReactNode } from "react";

type AuthGateProps = {
  children?: ReactNode;
};

export default function AuthGate({ children }: AuthGateProps) {
  return <>{children ?? null}</>;
}
