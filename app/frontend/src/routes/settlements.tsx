import { createFileRoute } from "@tanstack/react-router";
import { ControlRoom } from "@/components/peragus/ControlRoom";
export const Route = createFileRoute("/settlements")({
  head: () => ({
    meta: [
      { title: "Settlement Workspace — Peragus" },
      {
        name: "description",
        content:
          "Create and track live Peragus settlements: fiat coordination, atomic Token-2022 execution on Solana Devnet, and sanitized audit evidence.",
      },
      { property: "og:title", content: "Settlement Workspace — Peragus" },
      {
        property: "og:description",
        content:
          "Live B2B settlement control room: wallet signing, Devnet confirmation, reserve status, and audit evidence.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SettlementPage,
});
function SettlementPage() {
  return (
    <div className="page-content dedicated-page">
      <div className="eyebrow">PERAGUS / SETTLEMENTS</div>
      <h1 className="page-title">Every instruction. Every state. One record.</h1>
      <p className="page-subtitle">
        Create or load a settlement and follow its real backend state from instruction to payout.
      </p>
      <ControlRoom />
    </div>
  );
}
