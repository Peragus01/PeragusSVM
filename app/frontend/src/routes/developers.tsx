import { createFileRoute } from "@tanstack/react-router";
import { ApiReference } from "@/components/peragus/ApiReference";
export const Route = createFileRoute("/developers")({
  head: () => ({
    meta: [
      { title: "Developer API — Peragus" },
      {
        name: "description",
        content:
          "Peragus settlement API contract: create, read, prepare, confirm, payout, and audit routes with request and response shapes.",
      },
      { property: "og:title", content: "Developer API — Peragus" },
      {
        property: "og:description",
        content:
          "One settlement lifecycle API for acquirers: instructions, atomic Solana execution, payouts, and sanitized audit evidence.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DevelopersPage,
});
function DevelopersPage() {
  return (
    <div className="page-content dedicated-page">
      <ApiReference />
    </div>
  );
}
