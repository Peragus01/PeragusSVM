import { createContext, useContext } from "react";
import type { HealthResponse } from "@/lib/peragus/api";

export type BackendState = "checking" | "online" | "offline";
type Connection = {
  base: string;
  backend: BackendState;
  health: HealthResponse | null;
  checkedAt: string | null;
  ping: number | null;
  recheck: () => void;
};
export const Context = createContext<Connection>({
  base: "/api",
  backend: "checking",
  health: null,
  checkedAt: null,
  ping: null,
  recheck: () => {},
});
export const useConnection = () => useContext(Context);
