import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { CustomerNotice, CustomerPanel, SectionTitle } from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { usePeragusWallet } from "@/components/peragus/wallet-context";
import { formatPreviewBrl, parsePreviewBrl, verificationCopy } from "@/lib/peragus/customer-ux";

export const Route = createFileRoute("/app/comprar-usdt")({ component: PurchasePage });

type Stage = 1 | 2 | 3;
const STAGES: { number: Stage; label: string }[] = [
  { number: 1, label: "Valor" },
  { number: 2, label: "Revisão" },
  { number: 3, label: "Pagamento" },
];

function PurchasePage() {
  const { identity } = useCustomerSession();
  const wallet = usePeragusWallet();
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<Stage>(1);
  const value = parsePreviewBrl(amount);
  const verification = verificationCopy(identity?.customer ?? null);
  const canOperate = Boolean(
    identity?.customer?.operations_enabled &&
    identity.customer.verification_status === "approved" &&
    !identity.customer.suspended,
  );

  function setPreviewValue(next: string) {
    setAmount(next);
    setStage(1);
  }
  function next(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value !== null) setStage(2);
  }

  return (
    <>
      <SectionTitle
        eyebrow="COMPRA DE USDT / PRÉVIA"
        title="Veja como sua compra vai funcionar."
        description="Informe o valor em reais, confira as informações disponíveis e entenda a etapa do Pix."
      />

      <CustomerNotice>
        <strong>Esta é uma prévia, não uma compra.</strong> Nenhuma cobrança será criada. Cotação,
        taxa, instruções Pix e entrega de USDT só poderão aparecer depois da integração autorizada.
      </CustomerNotice>

      <ol className="customer-purchase-steps" aria-label="Etapas da compra">
        {STAGES.map((item) => (
          <li
            key={item.number}
            className={
              "customer-purchase-step" +
              (item.number === stage ? " is-current" : "") +
              (item.number < stage ? " is-complete" : "")
            }
            aria-current={item.number === stage ? "step" : undefined}
          >
            <span>{item.number}</span>
            {item.label}
          </li>
        ))}
      </ol>

      <div className="customer-purchase-layout">
        <div className="customer-purchase-main">
          {stage === 1 && (
            <CustomerPanel title="Quanto você deseja comprar?">
              <form onSubmit={next}>
                <label
                  className="customer-field customer-purchase-amount"
                  htmlFor="customer-purchase-value"
                >
                  Valor em reais (BRL)
                  <div className="customer-amount-input">
                    <span aria-hidden="true">R$</span>
                    <input
                      id="customer-purchase-value"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="250,00"
                      value={amount}
                      onChange={(event) => setPreviewValue(event.target.value)}
                      aria-describedby="customer-purchase-help"
                    />
                  </div>
                </label>
                <p className="customer-muted" id="customer-purchase-help">
                  Digite apenas números e até duas casas decimais. O valor informado é somente uma
                  intenção de compra e não cria compromisso financeiro.
                </p>
                <div className="customer-amount-suggestions" aria-label="Exemplos de valores">
                  {["100,00", "250,00", "500,00"].map((suggestion) => (
                    <button
                      type="button"
                      key={suggestion}
                      className="customer-button-secondary"
                      onClick={() => setPreviewValue(suggestion)}
                    >
                      R$ {suggestion}
                    </button>
                  ))}
                </div>
                {amount.length > 0 && value === null && (
                  <p className="customer-field-error" role="status">
                    Informe um valor positivo, sem separadores de milhar e com até duas casas
                    decimais.
                  </p>
                )}
                <div className="customer-purchase-footer">
                  <button type="submit" className="customer-button" disabled={value === null}>
                    Revisar valores <ArrowRight size={17} aria-hidden="true" />
                  </button>
                </div>
              </form>
            </CustomerPanel>
          )}

          {stage === 2 && value !== null && (
            <CustomerPanel title="Revise sua intenção">
              <div className="customer-purchase-amount-summary">
                <span>Você informou</span>
                <strong>{formatPreviewBrl(value)}</strong>
                <small>BRL → USDT na rede Solana · somente prévia</small>
              </div>
              <div className="customer-row">
                <span>Taxa de câmbio</span>
                <b>Aguardando integração</b>
              </div>
              <div className="customer-row">
                <span>Taxas da operação</span>
                <b>Não informadas</b>
              </div>
              <div className="customer-row">
                <span>USDT a receber</span>
                <b>Não calculado</b>
              </div>
              <div className="customer-row">
                <span>Carteira destino</span>
                <b>{wallet.address ? "Carteira Devnet conectada (teste)" : "Não selecionada"}</b>
              </div>

              <CustomerNotice kind="warning">
                Estes números não são uma cotação. Sem taxa de câmbio e tarifas confirmadas, a
                Peragus não pode informar quanto USDT você receberia.
              </CustomerNotice>
              <div className="customer-purchase-footer">
                <button
                  type="button"
                  className="customer-button-secondary"
                  onClick={() => setStage(1)}
                >
                  <ArrowLeft size={16} aria-hidden="true" /> Alterar valor
                </button>
                <button type="button" className="customer-button" onClick={() => setStage(3)}>
                  Entender o pagamento <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </CustomerPanel>
          )}

          {stage === 3 && value !== null && (
            <CustomerPanel title="Pagamento Pix ainda não disponível">
              <div className="customer-payment-locked">
                <span className="customer-payment-lock-icon">
                  <LockKeyhole size={27} aria-hidden="true" />
                </span>
                <h2>A compra não foi iniciada</h2>
                <p>
                  A prévia de {formatPreviewBrl(value)} terminou. Nenhum Pix foi emitido, nenhum
                  valor foi debitado e nenhuma transação de USDT foi criada.
                </p>
              </div>
              <div className="customer-row">
                <span>Valor informado</span>
                <b>{formatPreviewBrl(value)}</b>
              </div>
              <div className="customer-row">
                <span>Status do Pix</span>
                <b>Não emitido</b>
              </div>
              <div className="customer-row">
                <span>Status da compra</span>
                <b>Não iniciada</b>
              </div>
              <button className="customer-button customer-purchase-disabled" type="button" disabled>
                <LockKeyhole size={16} aria-hidden="true" /> Gerar Pix — indisponível
              </button>
              <div className="customer-purchase-footer">
                <button
                  type="button"
                  className="customer-button-secondary"
                  onClick={() => setStage(2)}
                >
                  <ArrowLeft size={16} aria-hidden="true" /> Voltar à revisão
                </button>
                <Link to="/app/minha-conta" className="customer-link">
                  Consultar minha verificação <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
            </CustomerPanel>
          )}
        </div>

        <aside className="customer-purchase-side" aria-label="Preparação para comprar">
          <CustomerPanel title="Antes de comprar">
            <div className="customer-checkline">
              <ShieldCheck size={17} aria-hidden="true" />
              <div>
                <strong>Conta autenticada</strong>
                <p>{identity?.user.email ?? "Identidade não disponível"}</p>
              </div>
            </div>
            <div className="customer-checkline">
              <ShieldCheck size={17} aria-hidden="true" />
              <div>
                <strong>Identidade: {verification.label}</strong>
                <p>{verification.guidance}</p>
              </div>
            </div>
            <div className="customer-checkline">
              <ShieldCheck size={17} aria-hidden="true" />
              <div>
                <strong>Carteira Solana</strong>
                <p>
                  {wallet.address
                    ? "Devnet conectada; titularidade não verificada."
                    : "Nenhuma carteira conectada."}
                </p>
              </div>
            </div>
            {!wallet.address && (
              <button className="customer-button-secondary" type="button" onClick={wallet.open}>
                Conectar carteira de testes
              </button>
            )}
            <p className="customer-muted">
              {canOperate
                ? "Seu perfil informa permissão para operar, mas esta interface não possui um fluxo financeiro autorizado."
                : "Operações não habilitadas. A prévia não contorna as verificações da Peragus."}
            </p>
            <Link to="/app/minha-conta" className="customer-link">
              Entender a verificação de identidade <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </CustomerPanel>
        </aside>
      </div>
    </>
  );
}
