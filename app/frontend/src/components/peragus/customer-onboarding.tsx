import { CustomerDocumentSummary } from "./customer-document-summary";
import { OnboardingReceipt, type OnboardingReview } from "./onboarding-receipt";
import { useEffect, useRef, useState } from "react";
import { CustomerNotice, CustomerPanel } from "./customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { journeyRequest, journeyMessage, JourneyError } from "@/lib/peragus/journey";

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
  monthly_income_usd: number | "";
  expected_monthly_volume_usd: number | "";
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
const fieldMessages: Record<string, string> = {
  "individual.legal_name": "Informe o nome completo, entre 2 e 160 caracteres.",
  "individual.cpf": "Informe um CPF válido, com 11 dígitos.",
  "individual.date_of_birth": "Informe uma data válida. A idade deve ser entre 18 e 120 anos.",
  "individual.nationality": "Use o código de duas letras maiúsculas do país, como BR.",
  "individual.occupation": "Use até 160 caracteres para a ocupação.",
  "individual.source_of_funds": "Informe a origem dos recursos, com até 160 caracteres.",
  "individual.monthly_income_usd":
    "Informe um valor entre 0 e 1.000.000.000 USD, com até duas casas decimais.",
  "individual.expected_monthly_volume_usd":
    "Informe um valor entre 0 e 1.000.000.000 USD, com até duas casas decimais.",
  "individual.phone.number":
    "Informe o DDD e o telefone usando apenas números, entre 5 e 18 dígitos.",
  "individual.residential_address.line1": "Informe o endereço, com até 160 caracteres.",
  "individual.residential_address.number": "Informe o número, com até 20 caracteres.",
  "individual.residential_address.neighborhood": "Informe o bairro, com até 100 caracteres.",
  "individual.residential_address.city": "Informe a cidade, com até 100 caracteres.",
  "individual.residential_address.state": "Informe uma UF brasileira válida, como SP.",
  "individual.residential_address.postal_code": "Informe um CEP com 8 dígitos.",
};
const fieldSummary = "Corrija os campos destacados para continuar.";
export function CustomerOnboarding() {
  const { accessToken, identity } = useCustomerSession();
  const [individual, setIndividual] = useState<Individual>(empty);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [terms, setTerms] = useState<Terms | null>(null);
  const [registration, setRegistration] = useState<{ state: string } | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [screening, setScreening] = useState<{ status: string; result: string } | null>(null);
  const [review, setReview] = useState<OnboardingReview | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [synthetic, setSynthetic] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const lock = useRef(false);
  const epoch = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const focusError = useRef(false);
  useEffect(() => {
    if (!focusError.current || busy) return;
    const input = formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
    if (!input) return;
    focusError.current = false;
    input.focus({ preventScroll: true });
    input.scrollIntoView?.({ block: "center", behavior: "instant" });
  }, [fieldErrors, busy]);
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
    setReview(null);
    setVerification(null);
    setIndividual(empty);
    setAccepted(false);
    setSynthetic(false);
    setError("");
    setFieldErrors({});
    focusError.current = false;
    if (!accessToken || !identity?.customer) return;
    void Promise.allSettled([
      journeyRequest<Draft>(
        accessToken,
        "v1/me/onboarding/individual",
        "GET",
        undefined,
        abort.signal,
      ),
      journeyRequest<Terms>(accessToken, "v1/me/onboarding/terms", "GET", undefined, abort.signal),
      journeyRequest<{ state: string }>(
        accessToken,
        "v1/me/onboarding",
        "GET",
        undefined,
        abort.signal,
      ),
      journeyRequest<Verification>(
        accessToken,
        "v1/me/onboarding/verification",
        "GET",
        undefined,
        abort.signal,
      ),
      journeyRequest<{ status: string; result: string }>(
        accessToken,
        "v1/me/onboarding/screening",
        "GET",
        undefined,
        abort.signal,
      ),
      journeyRequest<OnboardingReview>(
        accessToken,
        "v1/me/onboarding/status",
        "GET",
        undefined,
        abort.signal,
      ),
    ]).then((results) => {
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
      if (results[5]?.status === "fulfilled") setReview(results[5].value);
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
    if (path === "onboarding/individual") setFieldErrors({});
    const turn = epoch.current;
    try {
      const result = await journeyRequest<unknown>(accessToken, `v1/me/${path}`, method, body);
      if (epoch.current !== turn) return;
      if (path === "onboarding/individual") setDraft(result as Draft);
      else if (path.startsWith("onboarding/terms")) {
        setTerms(result as Terms);
        setAccepted(false);
      } else if (path.includes("verification")) setVerification(result as Verification);
      else if (path.includes("screening"))
        setScreening(result as { status: string; result: string });
      else if (path.startsWith("onboarding")) setRegistration(result as { state: string });
      if (path.startsWith("onboarding")) {
        try {
          const status = await journeyRequest<OnboardingReview>(
            accessToken,
            "v1/me/onboarding/status",
            "GET",
          );
          if (epoch.current === turn) setReview(status);
        } catch {
          if (epoch.current === turn) setReview(null);
        }
      }
    } catch (e) {
      if (epoch.current === turn) {
        const errors: Record<string, string> = {};
        if (
          path === "onboarding/individual" &&
          e instanceof JourneyError &&
          e.code === "VALIDATION_ERROR"
        ) {
          for (const field of e.fields) {
            const visibleField =
              field === "individual.phone" || field === "individual.phone.country_code"
                ? "individual.phone.number"
                : field;
            if (Object.hasOwn(fieldMessages, visibleField))
              errors[visibleField] = fieldMessages[visibleField]!;
          }
        }
        if (Object.keys(errors).length) {
          focusError.current = true;
          setFieldErrors(errors);
          setError(fieldSummary);
        } else setError(journeyMessage(e));
      }
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const locked = registration?.state === "linked";
  const inputProps = (path: string) => ({
    id: path,
    name: path,
    "aria-invalid": fieldErrors[path] ? true : undefined,
    "aria-describedby": fieldErrors[path] ? `${path}-error` : undefined,
  });
  const fieldError = (path: string) =>
    fieldErrors[path] ? (
      <span className="customer-field-error" id={`${path}-error`}>
        {fieldErrors[path]}
      </span>
    ) : null;
  const field = (key: keyof Individual, label: string, type = "text") => (
    <div key={key} className="customer-field">
      <label htmlFor={`individual.${key}`}>{label}</label>
      <input
        {...inputProps(`individual.${key}`)}
        required={key !== "occupation"}
        type={type}
        value={String(individual[key] ?? "")}
        disabled={locked || busy}
        onChange={(e) =>
          setIndividual({
            ...individual,
            [key]:
              type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value,
          })
        }
        {...(type === "number" ? { min: 0, max: 1_000_000_000, step: "0.01" } : {})}
      />
      {fieldError(`individual.${key}`)}
    </div>
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
    <div className="journey-onboarding" id="dados-cadastrais">
      <CustomerNotice kind="warning">
        Cadastro e KYC obrigatórios · ambiente de testes. Use apenas dados sintéticos. Não envie
        documentos reais neste ambiente.
      </CustomerNotice>
      <ol className="journey-step-list customer-kyc-stepper" aria-label="Etapas do cadastro">
        <li data-complete="true">
          <span aria-hidden="true">01</span>
          <div>
            <strong>Conta e convite</strong>
            <small>Seu acesso à Peragus</small>
          </div>
        </li>
        <li aria-current={!locked ? "step" : undefined} data-complete={locked || undefined}>
          <span aria-hidden="true">02</span>
          <div>
            <strong>Dados cadastrais</strong>
            <small>Identificação e endereço</small>
          </div>
        </li>
        <li aria-current={locked ? "step" : undefined}>
          <span aria-hidden="true">03</span>
          <div>
            <strong>Verificação de identidade</strong>
            <small>Documentos e acompanhamento</small>
          </div>
        </li>
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
              ref={formRef}
              noValidate
              onChange={(e) => {
                if (!(e.target instanceof HTMLInputElement)) return;
                const name = e.target.name;
                if (!fieldErrors[name]) return;
                if (Object.keys(fieldErrors).length === 1 && error === fieldSummary) setError("");
                setFieldErrors((previous) => {
                  const next = { ...previous };
                  delete next[name];
                  return next;
                });
              }}
              onSubmit={(e) => {
                e.preventDefault();
                if (busy || locked) return;
                const errors: Record<string, string> = {};
                for (const input of e.currentTarget.querySelectorAll<HTMLInputElement>("input")) {
                  if (!input.validity.valid)
                    errors[input.name] = input.validity.valueMissing
                      ? "Preencha este campo."
                      : (fieldMessages[input.name] ?? "Confira este campo.");
                }
                if (Object.keys(errors).length) {
                  focusError.current = true;
                  setFieldErrors(errors);
                  setError(fieldSummary);
                  return;
                }
                void act(
                  "onboarding/individual",
                  { expected_version: draft?.version ?? 0, individual },
                  "PUT",
                );
              }}
              aria-busy={busy}
            >
              <div className="customer-kyc-form-groups">
                <fieldset className="customer-kyc-fieldset">
                  <legend>1. Informações pessoais</legend>
                  <p>Preencha os dados de identificação e o telefone de contato.</p>
                  <div className="journey-fields">
                    {field("legal_name", "Nome completo")}
                    {field("cpf", "CPF")}
                    {field("date_of_birth", "Data de nascimento", "date")}
                    {field("nationality", "Nacionalidade (código de duas letras)")}
                    <div className="customer-field">
                      <label htmlFor="individual.phone.number">Telefone (DDD e número)</label>
                      <input
                        {...inputProps("individual.phone.number")}
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
                      {fieldError("individual.phone.number")}
                    </div>
                  </div>
                </fieldset>
                <fieldset className="customer-kyc-fieldset">
                  <legend>2. Endereço residencial</legend>
                  <p>Informe o endereço vinculado ao seu cadastro.</p>
                  <div className="journey-fields">
                    {(
                      ["line1", "number", "neighborhood", "city", "state", "postal_code"] as const
                    ).map((key, i) => (
                      <div className="customer-field" key={key}>
                        <label htmlFor={`individual.residential_address.${key}`}>
                          {["Endereço", "Número", "Bairro", "Cidade", "UF", "CEP"][i]}
                        </label>
                        <input
                          {...inputProps(`individual.residential_address.${key}`)}
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
                        {fieldError(`individual.residential_address.${key}`)}
                      </div>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="customer-kyc-fieldset">
                  <legend>3. Perfil e origem dos recursos</legend>
                  <p>Estas informações fazem parte da análise cadastral.</p>
                  <div className="journey-fields">
                    {field("occupation", "Ocupação")}
                    {field("source_of_funds", "Origem dos recursos")}
                    {field("monthly_income_usd", "Renda mensal em USD", "number")}
                    {field(
                      "expected_monthly_volume_usd",
                      "Volume mensal esperado em USD",
                      "number",
                    )}
                  </div>
                </fieldset>
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
            <>
              <OnboardingReceipt review={review} />
              <CustomerDocumentSummary />
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
                    <details>
                      <summary>Sobre a verificação no ambiente de testes</summary>
                      <p>
                        O envio de arquivos, quando disponível, aparece na seção de documentos. A
                        verificação permanece pendente até a análise; não envie documentos reais
                        neste ambiente.
                      </p>
                    </details>
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
                    void act(
                      screening ? "onboarding/screening/refresh" : "onboarding/screening",
                      {},
                    )
                  }
                >
                  {screening
                    ? "Atualizar análise de conformidade"
                    : "Iniciar análise de conformidade"}
                </button>
                <p className="customer-muted">
                  Seu cadastro permanece pendente até a conclusão das verificações obrigatórias.
                  Este ambiente não permite operações reais.
                </p>
              </CustomerPanel>
            </>
          )}
        </>
      )}
    </div>
  );
}
