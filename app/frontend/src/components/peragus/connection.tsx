import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getHealth, type HealthResponse } from "@/lib/peragus/api";
import { config } from "@/lib/peragus/config";
import { Context, type BackendState } from "./connection-context";

const HEALTH_INTERVAL_MS = 15000;

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [backend, setBackend] = useState<BackendState>("checking");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [ping, setPing] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    try {
      const result = await getHealth(config.apiBaseUrl, current.signal);
      if (current.signal.aborted) return;
      setHealth(result);
      setBackend("online");
    } catch {
      if (current.signal.aborted) return;
      setHealth(null);
      setBackend("offline");
    } finally {
      if (!current.signal.aborted) setCheckedAt(new Date().toISOString());
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, HEALTH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [check]);

  useEffect(() => {
    let active = true;
    const rpc = new AbortController();
    const started = performance.now();
    fetch(config.solanaRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: rpc.signal,
    })
      .then((r) => r.json())
      .then((data: { result?: string }) => {
        if (active && data.result === "ok") setPing(Math.round(performance.now() - started));
      })
      .catch(() => {});
    return () => {
      active = false;
      rpc.abort();
    };
  }, []);

  return (
    <Context.Provider
      value={{
        base: config.apiBaseUrl,
        backend,
        health,
        checkedAt,
        ping,
        recheck: () => void check(),
      }}
    >
      {children}
    </Context.Provider>
  );
}
