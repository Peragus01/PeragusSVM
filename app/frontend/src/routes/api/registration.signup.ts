import { createFileRoute } from "@tanstack/react-router";
import { handleLegalSignup } from "@/lib/peragus/legal-signup.server";

export const Route = createFileRoute("/api/registration/signup")({
  server: {
    handlers: {
      POST: ({ request }) => handleLegalSignup(request),
    },
  },
});
