import { createFileRoute } from "@tanstack/react-router";
import { CustomerLayout } from "@/components/peragus/customer-ui";
export const Route = createFileRoute("/app")({ component: CustomerLayout });
