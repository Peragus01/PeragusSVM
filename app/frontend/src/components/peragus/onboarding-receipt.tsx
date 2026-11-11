import { useMoneyMode } from "@/lib/peragus/config";
import { CustomerNotice, CustomerPanel } from "./customer-ui";
export type OnboardingReview = {
  review_state:
    | "not_submitted"
    | "pending_identity"
    | "in_review"
    | "action_required"
    | "approved"
    | "rejected";
  email_notifications: { enabled: boolean };
};
export function OnboardingReceipt({ review }: { review: OnboardingReview | null }) {
  const state = review?.review_state;
  const test = useMoneyMode() === "test";
  const title =
    state === "approved"
      ? test
        ? "Verificações concluídas em teste"
        : "Verificações concluídas"
      : state === "rejected"
        ? "Análise concluída: cadastro não aprovado"
        : state === "in_review"
          ? "Seu cadastro está em análise"
          : state === "action_required"
            ? "Precisamos de uma ação sua"
            : "Recebemos seu cadastro";
  return (
    <CustomerPanel title={title}>
      <div role="status" aria-live="polite">
        <p>
          {state === "in_review"
            ? "Estamos verificando seus dados. Você pode acompanhar o andamento em Minha conta."
            : state === "approved"
              ? test
                ? "As verificações deste cadastro de teste foram concluídas. Compras, pagamentos e transferências reais continuam indisponíveis."
                : "As verificações do seu cadastro foram concluídas."
              : state === "rejected"
                ? "O cadastro não foi aprovado. Consulte o estado da verificação em Minha conta."
                : state === "action_required"
                  ? "Confira as pendências abaixo para continuar. Seu cadastro permanece pendente."
                  : "O envio dos dados foi confirmado. A verificação de identidade ainda precisa ser concluída; seu cadastro permanece pendente."}
        </p>
        {review?.email_notifications.enabled ? (
          <p>
            Avisaremos pelo e-mail da sua conta quando a análise for concluída ou se precisarmos de
            alguma informação adicional.
          </p>
        ) : (
          <p>
            Acompanhe as atualizações em Minha conta. O aviso por e-mail ainda não está disponível
            para esta conta.
          </p>
        )}
      </div>
      {test && (state === "pending_identity" || !state) && (
        <CustomerNotice>
          Ambiente de testes: a captura de documentos não está disponível. Não envie documentos
          reais.
        </CustomerNotice>
      )}
    </CustomerPanel>
  );
}
