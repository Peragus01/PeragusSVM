import { useEffect, useRef, useState } from "react";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { CustomerNotice, CustomerPanel } from "./customer-ui";
import { Link } from "@tanstack/react-router";
import { CustomerKycOverview } from "./customer-kyc-overview";
import {
  DocumentClientError,
  documentLabels,
  documentStates,
  documentMessage,
  documentOutcomeUncertain,
  documentRequirementState,
  listDocuments,
  documentRequirements,
  refreshDocument,
  sendDocument,
  validateDocumentFile,
  type DocumentRecord,
  type DocumentRequirements,
  type DocumentType,
  type DocumentSide,
} from "@/lib/peragus/documents";

export function CustomerDocuments() {
  const { accessToken, identity } = useCustomerSession();
  // Remount private state on account change; old async completions cannot update the new view.
  return accessToken && identity?.customer ? (
    <DocumentForm key={identity.user.id + ":" + identity.customer.id} token={accessToken} />
  ) : null;
}
function DocumentForm({ token }: { token: string }) {
  const [rows, setRows] = useState<DocumentRecord[]>([]);
  const [requirements, setRequirements] = useState<DocumentRequirements | null>(null);
  const [ready, setReady] = useState(false);
  const [profileRequired, setProfileRequired] = useState(false);
  const [type, setType] = useState<DocumentType>("identity_document");
  const [side, setSide] = useState<DocumentSide>("front");
  const [file, setFile] = useState<File | null>(null);
  const [synthetic, setSynthetic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    lock.current = false;
    setBusy(false);
    setReady(false);
    setProfileRequired(false);
    setRows([]);
    setRequirements(null);
    setFile(null);
    setSynthetic(false);
    setUnknown(null);
    setError("");
    setMessage("");
    if (input.current) input.current.value = "";
    const controller = new AbortController();
    abort.current = controller;
    void Promise.all([
      listDocuments(token, controller.signal),
      documentRequirements(token, controller.signal),
    ])
      .then(([list, required]) => {
        if (!controller.signal.aborted) {
          setRows(list);
          setRequirements(required);
          const first = required.required_documents?.find((r) => r.supported_for_upload);
          if (first) setType(first.doc_type as DocumentType);
          setReady(true);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          if (e instanceof DocumentClientError && e.code === "DOCUMENT_CUSTOMER_REQUIRED")
            setProfileRequired(true);
          else setError(documentMessage(e));
        }
      });
    return () => {
      mounted.current = false;
      controller.abort();
      abort.current?.abort();
    };
  }, [token]);
  const effectiveSide = type === "identity_document" ? side : "none";
  const blocked =
    !!unknown ||
    rows.some(
      (r) =>
        r.doc_type === type &&
        r.side === effectiveSide &&
        !["received", "rejected"].includes(r.state),
    );
  const resetFile = () => {
    setFile(null);
    setSynthetic(false);
    if (input.current) input.current.value = "";
  };
  async function act(kind: "list" | "send" | "refresh", id?: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const controller = new AbortController();
    abort.current = controller;
    let requestId: string | undefined;
    try {
      if (kind === "send") requestId = crypto.randomUUID();
      if (kind === "list") {
        const [list, required] = await Promise.all([
          listDocuments(token, controller.signal),
          documentRequirements(token, controller.signal),
        ]);
        if (mounted.current && !controller.signal.aborted) {
          setRows(list);
          setRequirements(required);
          setReady(true);
          setProfileRequired(false);
          if (
            list.some(
              (row) => row.request_id === unknown && ["received", "rejected"].includes(row.state),
            )
          )
            setUnknown(null);
        }
      } else {
        if (kind === "send" && (!file || !synthetic || blocked || !ready)) return;
        const value =
          kind === "refresh"
            ? await refreshDocument(token, id!, controller.signal)
            : await sendDocument(token, file!, type, effectiveSide, requestId!, controller.signal);
        if (mounted.current && !controller.signal.aborted) {
          setRows((prev) =>
            prev.some((row) => row.id === value.id)
              ? prev.map((row) => (row.id === value.id ? value : row))
              : [value, ...prev],
          );
          if (value.request_id === unknown && ["received", "rejected"].includes(value.state))
            setUnknown(null);
          setMessage(documentStates[value.state]);
          if (kind === "send") resetFile();
        }
      }
    } catch (e) {
      if (mounted.current && !controller.signal.aborted) {
        if (e instanceof DocumentClientError && e.code === "DOCUMENT_CUSTOMER_REQUIRED") {
          setProfileRequired(true);
          setReady(false);
        } else setError(documentMessage(e));
        if (kind === "send" && requestId && documentOutcomeUncertain(e)) {
          setUnknown(requestId!);
          resetFile();
        }
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const required = requirements?.required_documents;
  return (
    <div className="customer-documents-page">
      <CustomerKycOverview
        state={profileRequired ? "profile_required" : ready ? "documents" : error ? "unavailable" : "checking"}
        received={rows.filter((row) => row.state === "received").length}
        pending={rows.filter((row) => !["received", "rejected"].includes(row.state)).length}
        canUpload={!!requirements?.required_documents?.some((row) => row.supported_for_upload)}
        hasHistory={rows.length > 0}
      />
      <div className="customer-documents-intro">
        <p>O recebimento dos arquivos não conclui a análise de identidade nem libera operações.</p>
        <CustomerNotice>
          Ambiente de testes: envie somente arquivos sintéticos. Não envie documentos reais.
        </CustomerNotice>
      </div>
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {!profileRequired && (
        <button
          type="button"
          className="customer-button-secondary customer-document-refresh"
          disabled={busy}
          onClick={() => void act("list")}
        >
          Atualizar envios
        </button>
      )}
      {ready && (
        <>
          <div id="documentos-solicitados" className="customer-kyc-anchor" />
          <CustomerPanel title="Documentos solicitados">
            <p>
              {required === null
                ? "A lista de documentos necessários está indisponível. Consulte o suporte antes de enviar."
                : required?.length === 0
                  ? "Nenhum arquivo pendente foi informado. A análise de identidade pode continuar pendente."
                  : "Documentos solicitados:"}
            </p>
            {!!required?.length && (
              <ul className="customer-document-requirements" aria-label="Documentos solicitados">
                {required.map((r) => {
                  const progress = documentRequirementState(rows, r.doc_type);
                  return (
                    <li key={r.doc_type}>
                      <strong>
                        {Object.hasOwn(documentLabels, r.doc_type)
                          ? documentLabels[r.doc_type as DocumentType]
                          : r.doc_type === "liveness"
                            ? "Prova de vida"
                            : "Verificação adicional"}
                      </strong>
                      <span className="customer-document-state" data-state={progress.state}>
                        {!r.supported_for_upload
                          ? "Requer outra etapa; consulte o suporte."
                          : progress.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CustomerPanel>
          {!!required?.some((r) => r.supported_for_upload) && (
            <div id="enviar-documento" className="customer-kyc-anchor">
            <CustomerPanel title="Enviar documento">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act("send");
                }}
              >
                <fieldset className="customer-document-fields" disabled={busy || !!unknown}>
                  <legend>Enviar arquivo de teste</legend>
                  <label className="customer-field">
                    Tipo de documento
                    <select
                      aria-label="Tipo de documento"
                      value={type}
                      onChange={(e) => {
                        setType(e.target.value as DocumentType);
                        setSide("front");
                        resetFile();
                        setError("");
                      }}
                    >
                      {Object.entries(documentLabels)
                        .filter(([key]) =>
                          required.some((r) => r.doc_type === key && r.supported_for_upload),
                        )
                        .map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                    </select>
                  </label>
                  {type === "identity_document" && (
                    <label className="customer-field">
                      Lado
                      <select
                        aria-label="Lado do documento"
                        value={side}
                        onChange={(e) => {
                          setSide(e.target.value as DocumentSide);
                          resetFile();
                        }}
                      >
                        <option value="front">Frente</option>
                        <option value="back">Verso</option>
                        <option value="single">Documento em uma única imagem</option>
                      </select>
                    </label>
                  )}
                  <label className="customer-field customer-document-file">
                    Arquivo (até 4 MiB)
                    <input
                      ref={input}
                      aria-label="Arquivo de teste"
                      type="file"
                      accept={
                        ["proof_of_address", "bank_statement"].includes(type)
                          ? "image/jpeg,image/png,application/pdf"
                          : "image/jpeg,image/png"
                      }
                      onChange={(e) => {
                        const next = e.target.files?.[0] ?? null;
                        setSynthetic(false);
                        setFile(null);
                        if (!next) return;
                        const invalid = validateDocumentFile(next, type);
                        if (invalid) {
                          setError(invalid);
                          e.target.value = "";
                        } else {
                          setError("");
                          setFile(next);
                        }
                      }}
                    />
                  </label>
                  <label className="customer-document-synthetic">
                    <input
                      type="checkbox"
                      className="customer-document-consent"
                      checked={synthetic}
                      onChange={(e) => setSynthetic(e.target.checked)}
                    />
                    Confirmo que este arquivo é sintético e não contém documentos reais.
                  </label>
                  {blocked && (
                    <p>
                      Há um envio sem confirmação para este documento. Atualize o estado antes de
                      enviar outro arquivo.
                    </p>
                  )}
                  <button
                    className="customer-button"
                    type="submit"
                    disabled={
                      !file ||
                      !synthetic ||
                      blocked ||
                      !required.some((r) => r.doc_type === type && r.supported_for_upload)
                    }
                  >
                    {busy ? "Enviando…" : "Enviar arquivo de teste"}
                  </button>
                </fieldset>
              </form>
            </CustomerPanel>
            </div>
          )}
        </>
      )}
      {unknown && (
        <p role="status">
          O envio teve resultado incerto. Não repita o envio. Consulte a lista e atualize o estado
          do arquivo; se ele não aparecer, procure o suporte.
        </p>
      )}
      {!!rows.length && (
        <div id="historico-documentos" className="customer-kyc-anchor">
        <CustomerPanel title="Acompanhe seus envios">
          <ul className="customer-document-history" aria-label="Envios de documentos">
            {rows.map((r) => (
              <li key={r.id}>
                <strong>
                  {documentLabels[r.doc_type]}
                  {r.side === "front" ? " — frente" : r.side === "back" ? " — verso" : ""}
                </strong>
                <p className="customer-document-state" data-state={r.state}>
                  {documentStates[r.state]}
                </p>
                {!["received", "rejected"].includes(r.state) && (
                  <button
                    type="button"
                    className="customer-button-secondary"
                    disabled={busy}
                    onClick={() => void act("refresh", r.id)}
                  >
                    Consultar recebimento
                  </button>
                )}
              </li>
            ))}
          </ul>
        </CustomerPanel>
        </div>
      )}
      {ready && !rows.length && (
        <p className="customer-muted">Você ainda não enviou arquivos por esta conta.</p>
      )}
      <Link to="/app/minha-conta" className="customer-link">
        Voltar à Minha conta →
      </Link>
    </div>
  );
}
