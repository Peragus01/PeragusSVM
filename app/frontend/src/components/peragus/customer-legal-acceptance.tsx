import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CustomerNotice } from "@/components/peragus/customer-ui";
import {
  LEGAL_DOCUMENT_KEYS,
  LEGAL_LABELS,
  LEGAL_URLS,
  type LegalDocumentKey,
} from "@/lib/peragus/legal-acknowledgement";
import {
  LEGAL_REQUIRED_EVENT,
  LegalAcceptanceError,
  acceptLegalDocuments,
  getLegalStatus,
  legalMessage,
  type RequiredLegalDocument,
} from "@/lib/peragus/legal-acceptance";

/** Post-login step: the customer accepts exactly the documents the backend says are missing. */
export function LegalAcceptanceStep({
  token,
  missing,
  onAccepted,
}: {
  token: string;
  missing: RequiredLegalDocument[];
  onAccepted: (still: RequiredLegalDocument[]) => void;
}) {
  const [checked, setChecked] = useState<Partial<Record<LegalDocumentKey, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const documents = LEGAL_DOCUMENT_KEYS.filter((key) => missing.some((m) => m.document === key));
  const ready = documents.every((key) => checked[key] === true);
  async function submit() {
    if (lock.current || !ready) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await acceptLegalDocuments(token, missing);
      onAccepted(next.missing);
    } catch (e) {
      setError(legalMessage(e instanceof LegalAcceptanceError ? e.code : "UNAVAILABLE"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="customer-auth-card journey-wide" aria-busy={busy}>
      <span className="customer-eyebrow">ANTES DE CONTINUAR</span>
      <h1>Aceite dos documentos legais</h1>
      <p>
        Para usar a Peragus, leia e aceite a versão vigente dos documentos abaixo. O aceite fica
        registrado em sua conta.
      </p>
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {documents.map((key) => (
          <label key={key} className="customer-check">
            <input
              type="checkbox"
              checked={checked[key] === true}
              disabled={busy}
              onChange={(e) => setChecked((c) => ({ ...c, [key]: e.target.checked }))}
            />{" "}
            Li e aceito os{" "}
            <a href={LEGAL_URLS[key]} target="_blank" rel="noopener noreferrer">
              {LEGAL_LABELS[key]}
            </a>
          </label>
        ))}
        <button className="customer-button" type="submit" disabled={busy || !ready}>
          {busy ? "Registrando…" : "Aceitar e continuar"}
        </button>
      </form>
    </section>
  );
}

/**
 * Wraps customer pages. Shows the acceptance step while the backend reports missing
 * documents (on load, or when any request is refused with LEGAL_ACCEPTANCE_REQUIRED),
 * then resumes the page the customer was on.
 */
export function LegalAcceptanceGate({ token, children }: { token: string; children: ReactNode }) {
  const [missing, setMissing] = useState<RequiredLegalDocument[] | null>(null);
  const [failed, setFailed] = useState(false);
  const check = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const status = await getLegalStatus(token, signal);
        if (!signal?.aborted) {
          setFailed(false);
          setMissing(status.missing);
        }
      } catch {
        if (!signal?.aborted) setFailed(true);
      }
    },
    [token],
  );
  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    const onRequired = () => void check();
    window.addEventListener(LEGAL_REQUIRED_EVENT, onRequired);
    return () => {
      controller.abort();
      window.removeEventListener(LEGAL_REQUIRED_EVENT, onRequired);
    };
  }, [check]);
  if (missing === null)
    return failed ? (
      <div role="alert">
        <CustomerNotice kind="warning">
          Não foi possível verificar seu aceite dos documentos legais.{" "}
          <button type="button" className="customer-link" onClick={() => void check()}>
            Tentar novamente
          </button>
        </CustomerNotice>
      </div>
    ) : (
      <div className="customer-loading" role="status">
        Verificando documentos legais…
      </div>
    );
  if (missing.length > 0)
    return <LegalAcceptanceStep token={token} missing={missing} onAccepted={setMissing} />;
  return <>{children}</>;
}
