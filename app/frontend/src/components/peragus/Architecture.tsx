import { useState } from "react";
import {
  ArrowRight,
  Building2,
  Check,
  CircleDollarSign,
  FileCheck2,
  GitBranch,
  Layers3,
  LockKeyhole,
  ShieldCheck,
  Signature,
  Unplug,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
const stages = [
  { title: "Acquirer", subtitle: "Submits payment instruction", icon: Building2, number: "01" },
  {
    title: "Peragus",
    subtitle: "Orchestrates end to end",
    icon: GitBranch,
    number: "02",
  },
  {
    title: "Liquidity rails",
    subtitle: "Asynchronous fiat coordination",
    icon: CircleDollarSign,
    number: "03",
  },
  {
    title: "Solana settlement",
    subtitle: "Two Token-2022 legs · one transaction",
    icon: Layers3,
    number: "04",
  },
  {
    title: "Confirmation",
    subtitle: "Verified on-chain · audited",
    icon: FileCheck2,
    number: "05",
  },
];
const safeguards = [
  {
    label: "Missing signature",
    icon: Signature,
    result: "Transaction rejected",
    detail:
      "All payer, Peragus attestation, and liquidity authority signatures are required. A missing signature rejects the transaction with zero token balance change.",
  },
  {
    label: "Either leg fails",
    icon: LockKeyhole,
    result: "Entire transaction rolls back",
    detail:
      "The payer leg and liquidity leg run in one Solana transaction. If either leg fails, both revert completely. Fiat operations are not part of this atomic boundary.",
  },
  {
    label: "Provider interruption",
    icon: Unplug,
    result: "Contingency protection activates",
    detail:
      "Escrow refunds liquidity or executes the configured fallback SLA. Reconcile the external transfer before retrying; never assume a fiat payout completed.",
  },
  {
    label: "Process interruption",
    icon: RotateCcw,
    result: "Idempotent resumption",
    detail:
      "Resume with the original request_id. Verify identity and event hashes before retrying so a restart does not duplicate a payment instruction.",
  },
];
export function Architecture({ full = false }: { full?: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <section className="architecture-section">
      <div className="section-heading">
        <div>
          <div className="eyebrow">BUILT FOR PAYMENT INFRASTRUCTURE</div>
          <h2>
            One instruction. Coordinated end to end<span className="heading-dot">.</span>
          </h2>
        </div>
        <span className="section-meta">THE SETTLEMENT PATH</span>
      </div>
      <div className="architecture-flow">
        {stages.map((stage, i) => (
          <div key={stage.number} className={`flow-stage stage-${i}`}>
            <div className="flow-node">
              <span className="stage-number">{stage.number}</span>
              <stage.icon />
              <span className="node-status">
                <Check />
              </span>
            </div>
            <h3>{stage.title}</h3>
            <p>{stage.subtitle}</p>
            {i < 4 && <ArrowRight className="flow-arrow" />}
          </div>
        ))}
      </div>
      <div className="boundary-grid">
        <div className="fiat-boundary">
          <div className="boundary-heading">
            <span className="boundary-icon">
              <GitBranch />
            </span>
            <strong>Fiat coordination boundary</strong>
            <span className="boundary-tag">ASYNCHRONOUS</span>
          </div>
          <p>Durable state · contingency reserve · reconciliation · idempotent request identity</p>
        </div>
        <div className="atomic-boundary">
          <div className="boundary-heading">
            <span className="boundary-icon">
              <ShieldCheck />
            </span>
            <strong>Atomic Solana boundary</strong>
            <span className="boundary-tag">ALL OR NOTHING</span>
          </div>
          <p>
            Payer + liquidity leg · one transaction · rollback on failure · authority cosignatures
          </p>
        </div>
      </div>
      <div className="safeguard-row">
        <span className="safeguard-label">
          <ShieldCheck />
          SAFE BY DESIGN
        </span>
        {safeguards.map((guard, i) => (
          <Button
            variant="ghost"
            size="sm"
            key={guard.label}
            aria-expanded={selected === i}
            onClick={() => setSelected(selected === i ? null : i)}
            className={selected === i ? "active-guard" : ""}
          >
            <guard.icon />
            {guard.label}
            <ArrowRight className="guard-arrow" />
          </Button>
        ))}
      </div>
      {selected !== null && (
        <div className="guard-detail">
          <ShieldCheck className="size-5 text-primary" />
          <div>
            <strong>{safeguards[selected]?.result}</strong>
            <p>{safeguards[selected]?.detail}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSelected(null)}
            aria-label="Close safeguard details"
          >
            <X />
          </Button>
        </div>
      )}
      {full && (
        <div className="architecture-extra">
          <div>
            <h3>For institutions, not retail banking.</h3>
            <p>
              Merchant acquirers submit payment instructions through the API. Payment processors,
              marketplaces, and payment platforms use the same settlement path to coordinate
              liquidity and reconcile results across Latin American corridors.
            </p>
          </div>
          <div>
            <h3>Atomic settlement has a precise boundary.</h3>
            <p>
              Only the two Token-2022 token legs are executed atomically on Solana. External fiat
              transfers remain asynchronous and are protected by contingency reserves, provider
              reconciliation, and idempotent request identity.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
