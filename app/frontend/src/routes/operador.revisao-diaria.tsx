import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { CustomerNotice, CustomerPanel } from "@/components/peragus/customer-ui";
import { FreshMfaForm, useFreshMfaAction } from "@/components/peragus/operator-actions";
import { OperatorShell, type OperatorContext } from "@/components/peragus/operator-shell";
import { recordDailyReview, type DailyReview } from "@/lib/peragus/operator-console";
import { addDays, saoPauloDay } from "@/lib/peragus/operator-labels";

export const Route = createFileRoute("/operador/revisao-diaria")({ component: DailyReviewPage });
function DailyReviewPage() {
  return (
    <OperatorShell
      title="Revisão diária"
      description="Sem a revisão do dia anterior com atividade, novas operações ficam bloqueadas (DAILY_REVIEW_REQUIRED)."
    >
      {(context) => <DailyReviewConsole {...context} />}
    </OperatorShell>
  );
}

/** POST /v1/admin/daily-reviews for an ENDED São Paulo day; idempotent per day. */
export function DailyReviewConsole({ now, ...context }: OperatorContext & { now?: Date }) {
  const { token, verifyMfa } = context;
  const [clock] = useState(() => now ?? new Date());
  const yesterday = addDays(saoPauloDay(clock), -1);
  const [day, setDay] = useState(yesterday);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<DailyReview | null>(null);
  const action = useFreshMfaAction(verifyMfa);
  function submit(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    const chosen = day,
      text = note;
    void action.start(
      token,
      (accessToken, _requestId, signal) =>
        recordDailyReview(accessToken, chosen, text, now ?? new Date(), signal),
      (review) => setResult(review),
    );
  }
  return (
    <>
      <FreshMfaForm action={action} token={token} />
      {result && (
        <CustomerNotice>
          {result.changed
            ? `Revisão de ${result.day} registrada.`
            : `A revisão de ${result.day} já estava registrada em ${new Date(result.reviewed_at).toLocaleString("pt-BR")}.`}
        </CustomerNotice>
      )}
      <CustomerPanel title="Registrar revisão">
        <p className="customer-muted">
          Revise as operações, alertas e notificações do dia antes de registrar. O registro é único
          por dia; repetir mostra quando ele foi feito.
        </p>
        {/* noValidate: the pt-BR check below explains an unended day instead of the browser. */}
        <form onSubmit={submit} noValidate>
          <label className="customer-field">
            Dia revisado (horário de São Paulo)
            <input
              type="date"
              required
              max={yesterday}
              value={day}
              onChange={(event) => setDay(event.target.value)}
            />
          </label>
          <label className="customer-field">
            Observação (opcional)
            <input maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <button className="customer-button" disabled={action.busy || !day}>
            Registrar revisão
          </button>
        </form>
      </CustomerPanel>
    </>
  );
}
