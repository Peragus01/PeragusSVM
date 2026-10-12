import { Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConnection } from "./connection-context";

export function HealthCard() {
  const { backend, health, checkedAt, base, recheck } = useConnection();
  return (
    <section className="cr-card cr-health" aria-live="polite">
      <div className="cr-card-head">
        <div className="flex items-center gap-3">
          <Activity className="size-5 text-primary" />
          <div>
            <h3>
              Backend{" "}
              {backend === "online" ? "online" : backend === "checking" ? "checking…" : "offline"}
            </h3>
            <p className="cr-muted">
              <code>GET {base}/health</code>
              {checkedAt && ` · checked ${new Date(checkedAt).toLocaleTimeString()}`}
            </p>
          </div>
        </div>
        <Button size="icon" variant="ghost" aria-label="Check backend health" onClick={recheck}>
          <RefreshCw />
        </Button>
      </div>
      {health ? (
        <p className="cr-muted">
          Version <code>{health.version}</code> · uptime{" "}
          <code>{Math.round(health.uptimeSeconds)}s</code>
        </p>
      ) : backend === "offline" ? (
        <p className="cr-muted">
          The hosted preview cannot reach a locally running backend. Run the frontend locally next
          to the Peragus backend to see live state.
        </p>
      ) : null}
      <p className="cr-muted">
        Peragus serves merchant acquirers, payment processors, marketplaces, and payment platforms
        in Latin America.
      </p>
    </section>
  );
}
