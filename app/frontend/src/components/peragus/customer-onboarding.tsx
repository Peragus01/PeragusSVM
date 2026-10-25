import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Circle, Clock3, ShieldCheck } from "lucide-react";
import { usePeragusWallet } from "./wallet-context";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { onboardingState, verificationCopy } from "@/lib/peragus/customer-ux";

export function CustomerOnboarding() {
  const { identity, status } = useCustomerSession();
  const wallet = usePeragusWallet();
  const flow = onboardingState(
    status === "authenticated",
    identity?.customer ?? null,
    wallet.address,
  );
  const next = flow.next;
  const label = verificationCopy(identity?.customer ?? null);
  const progress = Math.round((flow.completed / flow.total) * 100);

  return (
    <section className="customer-onboarding" aria-labelledby="customer-onboarding-title">
      <div className="customer-onboarding-heading">
        <div>
          <span className="customer-eyebrow">COMECE POR AQUI</span>
          <h2 id="customer-onboarding-title">Prepare sua conta</h2>
          <p>Três passos para conhecer o piloto. Pagamentos ainda não estão disponíveis.</p>
        </div>
        <span className="customer-onboarding-count">
          {flow.completed} de {flow.total} etapas
        </span>
      </div>
      <div
        className="customer-progress"
        role="progressbar"
        aria-label="Etapas de preparação da conta"
        aria-valuemin={0}
        aria-valuemax={flow.total}
        aria-valuenow={flow.completed}
      >
        <span style={{ width: progress + "%" }} />
      </div>
      <ol className="customer-onboarding-list">
        {flow.steps.map((step) => {
          const isNext = next?.key === step.key;
          return (
            <li key={step.key} className={"customer-onboarding-step" + (isNext ? " is-next" : "")}>
              <span aria-hidden="true" className="customer-onboarding-symbol">
                {step.complete ? (
                  <CheckCircle2 size={20} />
                ) : isNext ? (
                  <Clock3 size={20} />
                ) : (
                  <Circle size={20} />
                )}
              </span>
              <div className="customer-onboarding-step-copy">
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
              </div>
              <span className={"customer-onboarding-state" + (step.complete ? " is-done" : "")}>
                {step.complete ? "Concluído" : isNext ? "Próximo passo" : "Pendente"}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="customer-onboarding-actions">
        {next ? (
          <Link className="customer-button customer-onboarding-cta" to={next.href}>
            {next.key === "identity" ? "Verificar situação da conta" : next.action}
            <ArrowRight size={17} aria-hidden="true" />
          </Link>
        ) : (
          <Link className="customer-button customer-onboarding-cta" to="/app/comprar-usdt">
            Conhecer a prévia de compra <ArrowRight size={17} aria-hidden="true" />
          </Link>
        )}
        <span className="customer-muted">
          {label.approved
            ? "Identidade aprovada não libera operações automaticamente."
            : "Sua verificação depende do status da API."}
        </span>
      </div>
      <div className="customer-onboarding-note">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>Conectar uma carteira de testes não comprova titularidade nem habilita Pix.</span>
      </div>
    </section>
  );
}
