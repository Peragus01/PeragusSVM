import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CustomerNotice, CustomerPanel } from "@/components/peragus/customer-ui";
import { OperatorApiError, toOperatorError } from "@/lib/peragus/operator-console";
import { operatorErrorMessage } from "@/lib/peragus/operator-labels";

export type VerifyMfa = (code: string) => Promise<string>;
/** What every operator screen receives from the operator shell. */
export interface OperatorScreenProps {
  token: string;
  verifyMfa: VerifyMfa;
}

/** pt-BR message with the backend code on a secondary line. */
export function OperatorErrorNotice({ error }: { error: OperatorApiError | null }) {
  if (!error) return null;
  return (
    <CustomerNotice kind="warning">
      {operatorErrorMessage(error.code, error.details)}
      <br />
      <small className="customer-muted">Código: {error.code}</small>
    </CustomerNotice>
  );
}

/** Answers after which a current TOTP is confirmed and the same request repeated once. */
const mfaCodes = ["OPERATOR_MFA_STALE", "WITHDRAWAL_OPERATOR_MFA_REQUIRED"];
/** A definitive answer: nothing ambiguous happened, a new click is a new intent. */
const definitive = (error: OperatorApiError) =>
  error.status >= 400 &&
  error.status < 500 &&
  !mfaCodes.includes(error.code) &&
  error.code !== "OUTCOME_UNKNOWN";
const pausedCodes = ["OPERATIONS_PAUSED", "DAILY_REVIEW_REQUIRED"];

type Run<T> = (token: string, requestId: string, signal: AbortSignal) => Promise<T>;
/**
 * Money action with a fresh request_id per user intent (Task 9 flow, generalized):
 * - OPERATOR_MFA_STALE / WITHDRAWAL_OPERATOR_MFA_REQUIRED: the caller shows FreshMfaForm;
 *   `reverify` confirms a current TOTP and repeats the SAME request (same request_id) once
 *   with the new token. Never more.
 * - Unknown outcome (network/5xx): the intent stays pending; only `repeat` (same
 *   request_id, last token that reached the backend) is offered, never a new intent.
 * - Definitive answers (4xx, paused): the intent ends.
 * An in-flight request is never aborted (not even on unmount): its outcome must not be lost.
 */
export function useFreshMfaAction(verifyMfa: VerifyMfa) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<OperatorApiError | null>(null);
  const [staleMfa, setStaleMfa] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pending = useRef<{
    requestId: string;
    run: Run<unknown>;
    done: (v: unknown) => void;
  } | null>(null);
  const retried = useRef(false);
  const inFlight = useRef(false);
  /** Last token used for an attempt: the fresh one after a reverify. */
  const lastToken = useRef<string | null>(null);
  async function attempt(token: string) {
    const intent = pending.current;
    if (!intent || inFlight.current) return;
    inFlight.current = true;
    lastToken.current = token;
    setBusy(true);
    setError(null);
    try {
      const value = await intent.run(token, intent.requestId, new AbortController().signal);
      pending.current = null;
      setPendingId(null);
      intent.done(value);
    } catch (err) {
      const failure = toOperatorError(err);
      setError(failure);
      const needsMfa = mfaCodes.includes(failure.code);
      setStaleMfa(needsMfa && !retried.current);
      // The intent ends on a definitive answer, and on a second MFA answer (one retry only).
      if (
        definitive(failure) ||
        pausedCodes.includes(failure.code) ||
        (needsMfa && retried.current)
      ) {
        pending.current = null;
        setPendingId(null);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function start<T>(token: string, run: Run<T>, done: (value: T) => void) {
    if (inFlight.current || pending.current) return Promise.resolve();
    const requestId = crypto.randomUUID();
    pending.current = { requestId, run: run as Run<unknown>, done: done as (v: unknown) => void };
    retried.current = false;
    setPendingId(requestId);
    setStaleMfa(false);
    return attempt(token);
  }
  async function reverify(code: string) {
    if (inFlight.current || retried.current || !pending.current) return;
    setBusy(true);
    setError(null);
    let fresh: string;
    try {
      fresh = await verifyMfa(code);
    } catch {
      setError(new OperatorApiError("MFA_CODE_REJECTED", 400));
      setBusy(false);
      return;
    }
    retried.current = true;
    setStaleMfa(false);
    setBusy(false);
    await attempt(fresh);
  }
  /** Repeats the pending intent (same request_id) after an unknown outcome, with the last good token. */
  function repeat(fallbackToken: string) {
    if (staleMfa) return Promise.resolve();
    return attempt(lastToken.current ?? fallbackToken);
  }
  const uncertain = !!pendingId && !!error && !staleMfa && !definitive(error);
  /** True while a request is in flight or an intent is still open (MFA retry or unknown outcome). */
  const locked = busy || !!pendingId;
  return { busy, error, staleMfa, pendingId, uncertain, locked, start, reverify, repeat };
}
export type FreshMfaAction = ReturnType<typeof useFreshMfaAction>;

/** Current-TOTP form shown once after OPERATOR_MFA_STALE; plus "repeat" after an unknown outcome. */
export function FreshMfaForm({ action, token }: { action: FreshMfaAction; token: string }) {
  const [code, setCode] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = code;
    setCode("");
    await action.reverify(value);
  }
  return (
    <>
      {action.error?.code === "MFA_CODE_REJECTED" ? (
        <CustomerNotice kind="warning">
          Não foi possível confirmar o autenticador. Use um código atual e tente novamente.
        </CustomerNotice>
      ) : (
        <OperatorErrorNotice error={action.error} />
      )}
      {(action.staleMfa || action.error?.code === "MFA_CODE_REJECTED") && (
        <form onSubmit={(event) => void submit(event)}>
          <label className="customer-field">
            Código atual do autenticador
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button className="customer-button" disabled={action.busy}>
            Confirmar e repetir
          </button>
        </form>
      )}
      {action.uncertain && (
        <div className="customer-row">
          <span className="customer-muted">
            Resultado incerto: repita a mesma solicitação (mesma chave de idempotência).
          </span>
          <button
            type="button"
            className="customer-button-secondary"
            disabled={action.busy}
            onClick={() => void action.repeat(token)}
          >
            Repetir mesma solicitação
          </button>
        </div>
      )}
    </>
  );
}

/** Inline confirmation step required before every money action. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  disabled,
  busy,
  cancelDisabled,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  disabled?: boolean;
  busy?: boolean;
  /** Keeps the dialog open while its intent is in flight or unresolved. */
  cancelDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="dialog" aria-modal="false" aria-label={title} className="operator-dialog">
      <CustomerPanel title={title}>
        {children}
        <div className="customer-row">
          <button
            type="button"
            className="customer-button"
            disabled={disabled || busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            className="customer-button-secondary"
            disabled={busy || cancelDisabled}
            onClick={onCancel}
          >
            Cancelar
          </button>
        </div>
      </CustomerPanel>
    </div>
  );
}

export const isMfaGate = (error: OperatorApiError | null) =>
  error?.code === "WITHDRAWAL_OPERATOR_MFA_REQUIRED" || error?.code === "OPERATOR_MFA_STALE";
/** Read with abort on unmount/token change; `reload(freshToken)` after an MFA confirmation. */
export function useOperatorRead<T>(
  token: string,
  load: (token: string, signal: AbortSignal) => Promise<T>,
  /** Reloads when this value changes (e.g. a filter). */
  key: string = "",
) {
  const [state, setState] = useState<{
    data: T | null;
    error: OperatorApiError | null;
    loading: boolean;
  }>({ data: null, error: null, loading: true });
  const loader = useRef(load);
  loader.current = load;
  const current = useRef<AbortController | null>(null);
  const run = useCallback((accessToken: string) => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setState((value) => ({ ...value, loading: true, error: null }));
    loader
      .current(accessToken, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false });
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setState({ data: null, error: toOperatorError(err), loading: false });
      });
  }, []);
  useEffect(() => {
    run(token);
    return () => current.current?.abort();
  }, [token, run, key]);
  return { ...state, reload: (fresh?: string) => run(fresh ?? token) };
}
