import { useEffect, useRef, useState } from "react";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { CustomerNotice, CustomerPanel } from "./customer-ui";
import {
  documentLabels,
  documentStates,
  documentMessage,
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
  const [type, setType] = useState<DocumentType>("identity_document");
  const [side, setSide] = useState<DocumentSide>("front");
  const [file, setFile] = useState<File | null>(null);
  const [synthetic, setSynthetic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
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
    setRows([]);
    setRequirements(null);
    setFile(null);
    setSynthetic(false);
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
        if (!controller.signal.aborted) setError(documentMessage(e));
      });
    return () => {
      mounted.current = false;
      controller.abort();
      abort.current?.abort();
    };
  }, [token]);
  const effectiveSide = type === "identity_document" ? side : "none";
  const blocked =
    unknown ||
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
    try {
      if (kind === "list") {
        const [list, required] = await Promise.all([
          listDocuments(token, controller.signal),
          documentRequirements(token, controller.signal),
        ]);
        if (mounted.current && !controller.signal.aborted) {
          setRows(list);
          setRequirements(required);
          setReady(true);
        }
      } else {
        if (kind === "send" && (!file || !synthetic || blocked || !ready)) return;
        const value =
          kind === "refresh"
            ? await refreshDocument(token, id!, controller.signal)
            : await sendDocument(
                token,
                file!,
                type,
                effectiveSide,
                crypto.randomUUID(),
                controller.signal,
              );
        if (mounted.current && !controller.signal.aborted) {
          setRows((prev) => [value, ...prev.filter((r) => r.id !== value.id)]);
          setMessage(documentStates[value.state]);
          if (kind === "send") resetFile();
        }
      }
    } catch (e) {
      if (mounted.current && !controller.signal.aborted) {
        setError(documentMessage(e));
        if (kind === "send") {
          setUnknown(true);
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
    <CustomerPanel title="Documentos para verificação">
      <p>O recebimento dos arquivos não conclui a análise de identidade nem libera operações.</p>
      <CustomerNotice>
        Ambiente de testes: envie somente arquivos sintéticos. Não envie documentos reais.
      </CustomerNotice>
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      <button
        type="button"
        className="customer-button-secondary"
        disabled={busy}
        onClick={() => void act("list")}
      >
        Atualizar envios
      </button>
      {ready && (
        <>
          <p>
            {required === null
              ? "A lista de documentos necessários está indisponível. Consulte o suporte antes de enviar."
              : required?.length === 0
                ? "Nenhum arquivo pendente foi informado. A análise de identidade pode continuar pendente."
                : "Documentos solicitados:"}
          </p>
          {!!required?.length && (
            <ul>
              {required.map((r) => (
                <li key={r.doc_type}>
                  {Object.hasOwn(documentLabels, r.doc_type)
                    ? documentLabels[r.doc_type as DocumentType]
                    : r.doc_type === "liveness"
                      ? "Prova de vida"
                      : "Verificação adicional"}
                  {!r.supported_for_upload && " — requer outra etapa; consulte o suporte."}
                </li>
              ))}
            </ul>
          )}
          {!!required?.some((r) => r.supported_for_upload) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act("send");
              }}
            >
              <fieldset className="customer-document-fields" disabled={busy || unknown}>
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
                <label className="customer-field">
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
                <label className="customer-field">
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
        <ul aria-label="Envios de documentos">
          {rows.map((r) => (
            <li key={r.id}>
              <strong>
                {documentLabels[r.doc_type]}
                {r.side === "front" ? " — frente" : r.side === "back" ? " — verso" : ""}
              </strong>
              <p>{documentStates[r.state]}</p>
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
      )}
    </CustomerPanel>
  );
}
