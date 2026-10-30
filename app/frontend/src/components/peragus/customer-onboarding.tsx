import { useEffect, useRef, useState } from "react";
import { CustomerNotice, CustomerPanel } from "./customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { journeyRequest, journeyMessage } from "@/lib/peragus/journey";

type Draft = { version: number; individual: Individual };
type Individual = {
  legal_name: string;
  cpf: string;
  date_of_birth: string;
  nationality: string;
  phone: { country_code: string; number: string };
  residential_address: {
    line1: string;
    number: string;
    neighborhood: string;
    city: string;
    state: string;
    postal_code: string;
    country: "BR";
    complement?: string;
  };
  source_of_funds: string;
  monthly_income_usd: number;
  expected_monthly_volume_usd: number;
  occupation?: string;
};
type Terms = {
  session_id: string;
  state: string;
  terms_url: string | null;
  can_accept: boolean;
  expired: boolean;
};
type Verification = {
  status: string | null;
  identity_outcome: string | null;
  session_url: string | null;
  environment: "test";
  sandbox_only: true;
};
const empty: Individual = {
  legal_name: "",
  cpf: "",
  date_of_birth: "",
  nationality: "BR",
  phone: { country_code: "+55", number: "" },
  residential_address: {
    line1: "",
    number: "",
    neighborhood: "",
    city: "",
    state: "SP",
    postal_code: "",
    country: "BR",
  },
  source_of_funds: "",
  monthly_income_usd: 0,
  expected_monthly_volume_usd: 0,
};
export function CustomerOnboarding() {
  const { accessToken, identity } = useCustomerSession();
  const [individual, setIndividual] = useState<Individual>(empty);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [terms, setTerms] = useState<Terms | null>(null);
  const [registration, setRegistration] = useState<{ state: string } | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [screening, setScreening] = useState<{ status: string; result: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [synthetic, setSynthetic] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const lock = useRef(false);
  const epoch = useRef(0);
  const userId = identity?.user.id;
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    setBusy(false);
    const abort = new AbortController();
    setLoaded(false);
    setDraft(null);
    setTerms(null);
    setRegistration(null);
    setVerification(null);
    setIndividual(empty);
    setAccepted(false);
    setSynthetic(false);
    setError("");
    if (!accessToken || !identity?.customer) return;
    const paths = [
      "onboarding/individual",
      "onboarding/terms",
      "onboarding",
      "onboarding/verification",
      "onboarding/screening",
    ];
    void Promise.allSettled(
      paths.map((path) =>
        journeyRequest<any>(accessToken, `v1/me/${path}`, "GET", undefined, abort.signal),
      ),
    ).then((results) => {
      if (abort.signal.aborted) return;
      const d = results[0],
        t = results[1],
        r = results[2],
        v = results[3];
      if (d?.status === "fulfilled") {
        setDraft(d.value);
        if (d.value?.individual) setIndividual(d.value.individual);
      } else if (d?.status === "rejected") setError(journeyMessage(d.reason));
      if (t?.status === "fulfilled") setTerms(t.value);
      if (r?.status === "fulfilled") setRegistration(r.value);
      if (v?.status === "fulfilled") setVerification(v.value);
      const screening = results[4];
      if (screening?.status === "fulfilled") setScreening(screening.value);
      setLoaded(true);
    });
    return () => {
      epoch.current++;
      abort.abort();
    };
  }, [accessToken, userId, identity?.customer?.id]);
  async function act(path: string, body?: object, method = "POST") {
    if (lock.current || !accessToken) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const turn = epoch.current;
    try {
      const result = await journeyRequest<any>(accessToken, `v1/me/${path}`, method, body);
      if (epoch.current !== turn) return;
      if (path === "onboarding/individual") setDraft(result);
      else if (path.startsWith("onboarding/terms")) {
        setTerms(result);
        setAccepted(false);
      } else if (path.includes("verification")) setVerification(result);
      else if (path.includes("screening")) setScreening(result);
      else if (path.startsWith("onboarding")) setRegistration(result);
    } catch (e) {
      if (epoch.current === turn) setError(journeyMessage(e));
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const locked = registration?.state === "linked";
  const field = (key: keyof Individual, label: string, type = "text") => (
    <label key={key} className="customer-field">
      {label}
      <input
        required={key !== "occupation"}
        type={type}
        value={String(individual[key] ?? "")}
        disabled={locked || busy}
        onChange={(e) =>
          setIndividual({
            ...individual,
            [key]: type === "number" ? Number(e.target.value) : e.target.value,
          })
        }
        {...(type === "number" ? { min: 0, step: "0.01" } : {})}
      />
    </label>
  );
  const stateLabel =
    verification?.identity_outcome === "approved"
      ? "Aprovado em teste"
      : verification?.identity_outcome === "rejected"
        ? "Não aprovado"
        : verification?.status === "expired"
          ? "Verificação expirada"
          : verification?.status === "in_progress"
            ? "Em andamento"
            : verification
              ? "Pendente de verificação"
              : "Não iniciado";
  return (
    <div className="journey-onboarding">
      <CustomerNotice kind="warning">
        Cadastro e KYC obrigatórios · ambiente de testes. Use apenas dados sintéticos. Não envie
        documentos reais neste ambiente.
      </CustomerNotice>
      <ol className="journey-step-list">
        <li>1. Conta e convite</li>
        <li>2. Dados e consentimento</li>
        <li>3. Verificação de identidade</li>
      </ol>
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {!loaded ? (
        <p role="status">Recuperando seu cadastro…</p>
      ) : (
        <>
          <CustomerPanel title="Seus dados cadastrais">
            <p className="customer-muted">
              Seus dados são enviados ao servidor para validação e armazenamento criptografado. Não
              são salvos neste navegador.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  "onboarding/individual",
                  { expected_version: draft?.version ?? 0, individual },
                  "PUT",
                );
              }}
              aria-busy={busy}
            >
              <div className="journey-fields">
                {field("legal_name", "Nome completo")}
                {field("cpf", "CPF")}
                {field("date_of_birth", "Data de nascimento", "date")}
                {field("nationality", "Nacionalidade (código de duas letras)")}
                {field("occupation", "Ocupação")}
                {field("source_of_funds", "Origem dos recursos")}
                {field("monthly_income_usd", "Renda mensal em USD", "number")}
                {field("expected_monthly_volume_usd", "Volume mensal esperado em USD", "number")}
                <label className="customer-field">
                  Telefone (DDD e número)
                  <input
                    required
                    inputMode="tel"
                    disabled={locked || busy}
                    value={individual.phone.number}
                    onChange={(e) =>
                      setIndividual({
                        ...individual,
                        phone: { country_code: "+55", number: e.target.value },
                      })
                    }
                  />
                </label>
                {(["line1", "number", "neighborhood", "city", "state", "postal_code"] as const).map(
                  (key, i) => (
                    <label className="customer-field" key={key}>
                      {["Endereço", "Número", "Bairro", "Cidade", "UF", "CEP"][i]}
                      <input
                        required
                        disabled={locked || busy}
                        value={individual.residential_address[key]}
                        onChange={(e) =>
                          setIndividual({
                            ...individual,
                            residential_address: {
                              ...individual.residential_address,
                              [key]:
                                key === "state" ? e.target.value.toUpperCase() : e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  ),
                )}
              </div>
              {!locked && (
                <button className="customer-button" disabled={busy} type="submit">
                  {busy ? "Salvando…" : draft ? "Salvar dados" : "Salvar e continuar"}
                </button>
              )}
              {draft && (
                <p role="status" className="customer-muted">
                  Dados salvos · versão {draft.version}.
                  {locked
                    ? " Dados enviados à análise não podem ser alterados por esta etapa."
                    : ""}
                </p>
              )}
            </form>
          </CustomerPanel>
          {draft && (
            <CustomerPanel title="Termos e envio do cadastro">
              {!terms ? (
                <button
                  className="customer-button-secondary"
                  disabled={busy}
                  onClick={() => void act("onboarding/terms", {})}
                >
                  Consultar termos para aceite
                </button>
              ) : (
                <>
                  <p className="customer-muted">
                    Situação dos termos:{" "}
                    {terms.state === "accepted"
                      ? "Aceitos"
                      : terms.expired
                        ? "Expirados"
                        : "Aguardando aceite"}
                  </p>
                  {terms.terms_url &&
                    /^https:\/\/([a-z0-9-]+\.)*ozav\.io(?:\/|$)/i.test(terms.terms_url) && (
                      <a
                        className="customer-link"
                        href={terms.terms_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Ler os termos da OZAV ↗
                      </a>
                    )}
                  {terms.can_accept && (
                    <>
                      <label className="journey-check">
                        <input
                          type="checkbox"
                          checked={accepted}
                          onChange={(e) => setAccepted(e.target.checked)}
                        />
                        Li e aceito os termos apresentados para esta sessão.
                      </label>
                      <button
                        className="customer-button"
                        disabled={!accepted || busy}
                        onClick={() =>
                          void act("onboarding/terms/accept", {
                            session_id: terms.session_id,
                            accepted: true,
                          })
                        }
                      >
                        Confirmar aceite
                      </button>
                    </>
                  )}
                  {terms.expired && !locked && (
                    <button
                      className="customer-button-secondary"
                      disabled={busy}
                      onClick={() =>
                        void act("onboarding/terms", { renew_session_id: terms.session_id })
                      }
                    >
                      Abrir nova sessão de termos
                    </button>
                  )}
                  {terms.state === "accepted" && !locked && (
                    <>
                      <label className="journey-check">
                        <input
                          type="checkbox"
                          checked={synthetic}
                          onChange={(e) => setSynthetic(e.target.checked)}
                        />
                        Confirmo que os dados usados neste ambiente são sintéticos, sem documentos
                        reais.
                      </label>
                      <button
                        className="customer-button"
                        disabled={!synthetic || busy}
                        onClick={() =>
                          void act("onboarding/submit", {
                            draft_version: draft.version,
                            terms_session_id: terms.session_id,
                            sandbox_data_confirmed: true,
                          })
                        }
                      >
                        Enviar cadastro para verificação
                      </button>
                    </>
                  )}
                  {registration && (
                    <p className="customer-muted">
                      {locked
                        ? "Cadastro vinculado à análise de identidade."
                        : "Envio em acompanhamento. Consulte o estado antes de repetir."}
                    </p>
                  )}
                  {registration && (
                    <button
                      className="customer-button-secondary"
                      disabled={busy}
                      onClick={() => void act("onboarding/refresh", {})}
                    >
                      Atualizar cadastro enviado
                    </button>
                  )}
                </>
              )}
            </CustomerPanel>
          )}
          {locked && (
            <CustomerPanel title="Verificação de identidade obrigatória">
              <div className="customer-row">
                <span>KYC</span>
                <b>{stateLabel}</b>
              </div>
              {!verification ? (
                <button
                  className="customer-button"
                  disabled={busy}
                  onClick={() => void act("onboarding/verification", {})}
                >
                  Iniciar verificação de identidade
                </button>
              ) : (
                <>
                  <CustomerNotice>
                    A OZAV não disponibiliza captura hospedada de documentos com chave de teste. A
                    sessão pode ser criada e consultada, mas a captura e a aprovação real não podem
                    ser concluídas aqui.
                  </CustomerNotice>
                  <button
                    className="customer-button-secondary"
                    disabled={busy}
                    onClick={() => void act("onboarding/verification/refresh", {})}
                  >
                    Atualizar verificação
                  </button>
                </>
              )}
              <div className="customer-row">
                <span>Análise de conformidade</span>
                <b>
                  {screening?.status === "completed" && screening.result === "clear"
                    ? "Concluída em teste"
                    : screening
                      ? "Em acompanhamento"
                      : "Não iniciada"}
                </b>
              </div>
              <button
                className="customer-button-secondary"
                disabled={busy}
                onClick={() =>
                  void act(screening ? "onboarding/screening/refresh" : "onboarding/screening", {})
                }
              >
                {screening
                  ? "Atualizar análise de conformidade"
                  : "Iniciar análise de conformidade"}
              </button>
              <p className="customer-muted">
                O cadastro permanece pendente até a verificação exigida. Mesmo uma aprovação em
                teste não autoriza transações reais. Não há botão para simular aprovação nesta
                jornada.
              </p>
            </CustomerPanel>
          )}
        </>
      )}
    </div>
  );
}
