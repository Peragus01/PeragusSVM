import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  CircleDollarSign,
  Globe2,
  Layers3,
  ShieldCheck,
  SquareCode,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Architecture } from "@/components/peragus/Architecture";
import { HealthCard } from "@/components/peragus/HealthCard";
import networkImage from "@/assets/settlement-network.jpg";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Peragus — Settlement Control Room" },
      {
        name: "description",
        content:
          "The on-chain payment processing and settlement network for Latin America. Explore B2B settlement orchestration, atomic Token-2022 execution, and Devnet audit evidence.",
      },
      { property: "og:title", content: "Peragus — Settlement Control Room" },
      {
        property: "og:description",
        content:
          "Institutional payment infrastructure for Latin America. One instruction, atomic Solana settlement, verifiable audit evidence.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});
function Index() {
  return (
    <div className="overview-page">
      <section className="institutional-hero">
        <img
          className="network-image"
          src={networkImage}
          alt="Latin America connected through an institutional settlement network"
          width={1536}
          height={1024}
        />
        <div className="hero-content">
          <div className="hero-eyebrow">
            <span className="status-dot" />
            INSTITUTIONAL PAYMENTS. ON-CHAIN CERTAINTY.
          </div>
          <h1>
            The On-Chain Payment
            <br className="desktop-break" /> Processing & Settlement
            <br className="desktop-break" /> Network for <span>Latin America.</span>
          </h1>
          <p>
            Built for acquirers, payment processors, and platforms.
            <br className="desktop-break" />
            Coordinate fiat rails. Settle atomically on Solana.
            <br className="desktop-break" />
            Verify every step.
          </p>
          <div className="hero-actions">
            <Button size="lg" asChild>
              <Link to="/settlements">
                Open settlement control room
                <ArrowRight />
              </Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link to="/developers">
                View API contract
                <ArrowUpRight />
              </Link>
            </Button>
          </div>
          <div className="hero-footnote">
            <ShieldCheck />
            B2B infrastructure<span>·</span>Solana Devnet<span>·</span>Verifiable by design
          </div>
        </div>
        <div className="globe-label">
          <span className="status-dot" />
          LATAM → GLOBAL SETTLEMENT<span>DEVNET NETWORK</span>
        </div>
      </section>
      <div className="metrics-banner">
        {[
          {
            icon: Layers3,
            title: "Two-Leg Atomic Execution",
            subtitle: "Token-2022 · all or nothing",
          },
          {
            icon: ShieldCheck,
            title: "Contingency Escrow",
            subtitle: "Protected liquidity · recovery ready",
          },
          {
            icon: CircleDollarSign,
            title: "Fiat rail coordination",
            subtitle: "Asynchronous · reconciled · idempotent",
          },
          {
            icon: CheckCircle2,
            title: "Independent verification",
            subtitle: "Backend re-checks every Devnet signature",
          },
        ].map((metric) => (
          <div className="metric" key={metric.title}>
            <metric.icon />
            <div>
              <strong>{metric.title}</strong>
              <span>{metric.subtitle}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="page-content">
        <HealthCard />
        <Architecture full />
        <div className="developer-banner">
          <div className="flex items-center gap-4">
            <div className="developer-icon">
              <SquareCode />
            </div>
            <div>
              <h3>Your payment stack. One settlement API.</h3>
              <p>
                From acquirer instruction to sanitized audit evidence — one settlement lifecycle.
              </p>
            </div>
          </div>
          <Button variant="outline" asChild>
            <Link to="/developers">
              View API specification
              <ArrowUpRight />
            </Link>
          </Button>
        </div>
        <div className="infrastructure-note">
          <Globe2 />
          <span>Built for Latin America. Designed for institutional scale.</span>
          <span>Fiat coordination ≠ atomic on-chain execution</span>
        </div>
      </div>
    </div>
  );
}
