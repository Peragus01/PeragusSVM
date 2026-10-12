import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Connection } from "@solana/web3.js";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  CORRIDOR_PATTERN,
  LIFECYCLE,
  TERMINAL,
  UUID_PATTERN,
  confirmSettlement,
  createSettlement,
  getAudit,
  getOnramp,
  getSettlement,
  initiateOfframp,
  isPositiveU64,
  publicErrorCode,
  publicStatus,
  prepareRollbackDemo,
  prepareSettlement,
  simulateSandboxPixPayment,
  type ConfirmedSettlement,
  type Offramp,
  type PreparedSettlement,
  type PublicOnramp,
  type Settlement,
  type SettlementAudit,
  type SettlementStatus,
} from "@/lib/peragus/api";
import { config, explorerAddress, explorerTx, short } from "@/lib/peragus/config";
import { hasSafeSettlementWindow } from "@/lib/peragus/checkout";
import {
  clearPendingSolanaTransaction,
  createPendingSolanaTransaction,
  loadPendingSolanaTransaction,
  savePendingSolanaTransaction,
  type PendingSolanaTransaction,
} from "@/lib/peragus/pending-solana-transaction";
import {
  base64ToBytes,
  verifyPreparedTransaction,
  verifySignedTransaction,
} from "@/lib/peragus/verify-transaction";
import {
  readAtomicRollbackEvidence,
  type AtomicRollbackEvidence,
} from "@/lib/peragus/rollback-evidence";
import { CopyButton } from "./CopyButton";
import { useConnection } from "./connection-context";
import { usePeragusWallet } from "./wallet-context";

const POLL_MS = 4000;
const MAX_BACKOFF_MS = 30000;
const PRE_TOKENIZED: SettlementStatus[] = ["created", "awaiting_pix", "pix_confirmed"];

const STATUS_LABEL: Record<SettlementStatus, string> = {
  created: "Instruction accepted",
  awaiting_pix: "Awaiting fiat payment",
  pix_confirmed: "Fiat payment confirmed",
  tokenized: "Ready for Solana execution",
  settling: "Solana settlement in progress",
  settled: "Settled on Solana",
  offramping: "Payout reconciling",
  paid_out: "Paid out",
  failed: "Failed",
  revoked: "Revoked",
};

type UiError = {
  message: string;
  code?: string;
  details?: Array<{ path: string; message: string }>;
};
function toUiError(error: unknown): UiError {
  if (error instanceof ApiError)
    return { message: error.message, code: publicErrorCode(error.code), details: error.details };
  if (error instanceof Error) return { message: error.message };
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return { message: error.message };
  }
  return { message: "Something went wrong." };
}

function ErrorNote({ error, onRetry }: { error: UiError; onRetry?: () => void }) {
  return (
    <div role="alert" className="cr-error">
      <AlertTriangle className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{error.message}</p>
        {error.details && error.details.length > 0 && (
          <ul>
            {error.details.map((d) => (
              <li key={d.path}>
                <code>{d.path}</code> is invalid
              </li>
            ))}
          </ul>
        )}
        {error.code && (
          <details>
            <summary>Developer detail</summary>
            <code>{error.code}</code>
          </details>
        )}
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

function Mono({ value, href, size = 8 }: { value: string; href?: string; size?: number }) {
  return (
    <span className="cr-mono">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {short(value, size)}
          <ExternalLink className="size-3" />
        </a>
      ) : (
        <code title={value}>{short(value, size)}</code>
      )}
      <CopyButton value={value} label="Copy value" />
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cr-row">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

/** Renders backend state only; it never advances or invents a status. */
export function StatusTimeline({ status }: { status: SettlementStatus }) {
  const halted = status === "failed" || status === "revoked";
  const current = LIFECYCLE.indexOf(status);
  return (
    <div>
      {halted && (
        <div role="status" className="cr-error mb-3">
          <XCircle className="size-4" />
          <p>
            Settlement {status}. No further lifecycle steps will run. Check the reserve outcome
            below.
          </p>
        </div>
      )}
      <ol className="cr-timeline" aria-label="Settlement lifecycle">
        {LIFECYCLE.map((step, i) => {
          const state =
            !halted && i < current
              ? "done"
              : !halted && i === current
                ? step === "paid_out"
                  ? "done"
                  : "current"
                : "pending";
          return (
            <li key={step} data-state={state}>
              {state === "done" ? (
                <CheckCircle2 />
              ) : state === "current" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Circle />
              )}
              <span>{STATUS_LABEL[step]}</span>
              <code>{step}</code>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FlowStrip() {
  const steps = ["Acquirer", "Peragus", "Liquidity rails", "Solana settlement", "Confirmation"];
  return (
    <div className="cr-flow">
      <ol>
        {steps.map((s, i) => (
          <li key={s} data-atomic={i === 3 ? "true" : undefined}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            {s}
          </li>
        ))}
      </ol>
      <p>
        Peragus orchestrates the whole workflow. Fiat legs are coordinated asynchronously through
        durable state, a contingency reserve, and reconciliation. Only the two Token-2022 transfers
        share one Solana transaction: both settle, or neither does.
      </p>
    </div>
  );
}

/** Absent or unparsable times render as "Unavailable", never as a blank field. */
function formatTime(value: string | null | undefined) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function defaultExpiry() {
  const date = new Date(Date.now() + 2 * 60 * 60 * 1000);
  date.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function finderModule(x: number, y: number, originX: number, originY: number) {
  const localX = x - originX;
  const localY = y - originY;
  if (localX < 0 || localY < 0 || localX > 6 || localY > 6) {
    return null;
  }
  const outer = localX === 0 || localY === 0 || localX === 6 || localY === 6;
  const inner = localX >= 2 && localX <= 4 && localY >= 2 && localY <= 4;
  return outer || inner;
}

function demoQrModules(seed: string) {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }

  return Array.from({ length: 21 * 21 }, (_, index) => {
    const x = index % 21;
    const y = Math.floor(index / 21);
    const finder = [
      finderModule(x, y, 0, 0),
      finderModule(x, y, 14, 0),
      finderModule(x, y, 0, 14),
    ].find((value) => value !== null);
    if (finder !== undefined) return finder;

    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % 3 === 0;
  });
}

export function SandboxPixQr({ seed }: { seed: string }) {
  const modules = demoQrModules(seed);
  return (
    <figure className="cr-pix-qr">
      <svg
        role="img"
        aria-label="Fictitious sandbox Pix QR code"
        viewBox="0 0 21 21"
        shapeRendering="crispEdges"
      >
        <rect width="21" height="21" fill="#fff" />
        {modules.map((enabled, index) =>
          enabled ? (
            <rect
              key={index}
              x={index % 21}
              y={Math.floor(index / 21)}
              width="1"
              height="1"
              fill="#081812"
            />
          ) : null,
        )}
      </svg>
      <figcaption>SANDBOX · NOT PAYABLE</figcaption>
    </figure>
  );
}

function CreateForm({ onCreated }: { onCreated: (s: Settlement, replay: boolean) => void }) {
  const { base, backend } = useConnection();
  const wallet = usePeragusWallet();
  const [form, setForm] = useState({
    corridor_id: config.demoCorridorId,
    recipient_wallet: config.demoRecipientWallet,
    source_amount: "500000000",
    destination_amount: "89550000",
    expires_at: "",
  });
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  useEffect(() => setForm((f) => (f.expires_at ? f : { ...f, expires_at: defaultExpiry() })), []);
  const update = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setRequestId(""); // a changed payload is a new instruction
  };
  const invalid = [
    !CORRIDOR_PATTERN.test(form.corridor_id) && "Corridor ID must be 64 hexadecimal characters.",
    !form.recipient_wallet && "Recipient wallet is required.",
    !isPositiveU64(form.source_amount) && "Source amount must be a positive base-unit integer.",
    !isPositiveU64(form.destination_amount) &&
      "Destination amount must be a positive base-unit integer.",
  ].filter(Boolean) as string[];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!wallet.address) return wallet.open();
    const expires = new Date(form.expires_at);
    if (!hasSafeSettlementWindow(form.expires_at)) {
      setError({
        message:
          "Keep at least 60 minutes between creation and expiry so the Pix and reserve windows cannot overlap.",
      });
      return;
    }
    const id = requestId || `acq-${crypto.randomUUID()}`;
    setRequestId(id);
    setBusy(true);
    setError(null);
    try {
      const result = await createSettlement(base, {
        request_id: id,
        corridor_id: form.corridor_id.toLowerCase(),
        payer_wallet: wallet.address,
        recipient_wallet: form.recipient_wallet.trim(),
        source_amount: form.source_amount,
        destination_amount: form.destination_amount,
        expires_at: expires.toISOString(),
      });
      onCreated(result.data, Boolean(result.meta?.idempotent_replay));
    } catch (e) {
      setError(toUiError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="cr-card" onSubmit={(e) => void submit(e)}>
      <h3>Create settlement instruction</h3>
      <p className="cr-muted">
        Demo purchase: a Brazilian buyer pays BRL 500 by Pix for a purchase in Paraguay. The
        connected wallet represents the acquiring participant; the demo backend prepares its capped,
        valueless Devnet assets automatically.
      </p>
      <Row label="Payer wallet">
        {wallet.address ? (
          <Mono value={wallet.address} href={explorerAddress(wallet.address)} />
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={wallet.open}>
            Connect wallet
          </Button>
        )}
      </Row>
      <label className="cr-label">
        Corridor ID
        <input
          className="field"
          value={form.corridor_id}
          onChange={(e) => update("corridor_id", e.target.value.trim())}
          placeholder="64 hexadecimal characters"
          spellCheck={false}
        />
      </label>
      <label className="cr-label">
        Recipient wallet
        <input
          className="field"
          value={form.recipient_wallet}
          onChange={(e) => update("recipient_wallet", e.target.value)}
          placeholder="Solana public key"
          spellCheck={false}
        />
      </label>
      <div className="cr-grid-2">
        <label className="cr-label">
          Source amount (BRL base units)
          <input
            className="field"
            inputMode="numeric"
            value={form.source_amount}
            onChange={(e) => update("source_amount", e.target.value.replace(/\D/g, ""))}
            placeholder="500000000"
          />
        </label>
        <label className="cr-label">
          Destination amount (USDT base units)
          <input
            className="field"
            inputMode="numeric"
            value={form.destination_amount}
            onChange={(e) => update("destination_amount", e.target.value.replace(/\D/g, ""))}
            placeholder="89550000"
          />
        </label>
      </div>
      <label className="cr-label">
        Expires at (local time)
        <input
          className="field"
          type="datetime-local"
          value={form.expires_at}
          onChange={(e) => update("expires_at", e.target.value)}
        />
        {!form.expires_at && <span>— Unavailable until an expiry is set.</span>}
      </label>
      {requestId && (
        <Row label="Request ID (kept for retries)">
          <Mono value={requestId} size={10} />
        </Row>
      )}
      {error && <ErrorNote error={error} />}
      {form.source_amount && invalid.length > 0 && <p className="cr-muted">{invalid[0]}</p>}
      <Button
        type="submit"
        disabled={busy || backend !== "online" || (Boolean(wallet.address) && invalid.length > 0)}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Send />}
        {!wallet.address
          ? "Connect wallet to continue"
          : busy
            ? "Preparing sandbox checkout…"
            : "Start sandbox checkout"}
      </Button>
      {backend !== "online" && (
        <p className="cr-muted">Available once the backend health check succeeds.</p>
      )}
    </form>
  );
}

function LookupForm({ onLoad }: { onLoad: (id: string) => void }) {
  const [value, setValue] = useState("");
  const valid = UUID_PATTERN.test(value.trim());
  return (
    <form
      className="cr-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onLoad(value.trim().toLowerCase());
      }}
    >
      <h3>Look up a settlement</h3>
      <p className="cr-muted">
        <code>GET /v1/settlements/:id</code>
      </p>
      <label className="cr-label">
        Settlement ID
        <input
          className="field"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="UUID"
          spellCheck={false}
        />
      </label>
      {value && !valid && <p className="cr-muted">Enter a valid UUID.</p>}
      <Button type="submit" variant="outline" disabled={!valid}>
        <Search />
        Load settlement
      </Button>
    </form>
  );
}

type ExecStep =
  | "idle"
  | "preparing"
  | "verifying"
  | "signing"
  | "broadcasting"
  | "confirming"
  | "recording"
  | "done";
const EXEC_LABEL: Record<ExecStep, string> = {
  idle: "",
  preparing: "Requesting co-signed transaction…",
  verifying: "Verifying signer, blockhash, co-signatures, and message hash…",
  signing: "Waiting for your wallet signature…",
  broadcasting: "Broadcasting to Solana Devnet…",
  confirming: "Waiting for Devnet confirmation…",
  recording: "Backend is verifying the transaction on-chain…",
  done: "Settlement verified on-chain by the backend.",
};

type RollbackStep =
  | "idle"
  | "preparing"
  | "verifying"
  | "signing"
  | "broadcasting"
  | "confirming"
  | "inspecting"
  | "proven";

const ROLLBACK_LABEL: Record<RollbackStep, string> = {
  idle: "",
  preparing: "Preparing controlled second-leg failure…",
  verifying: "Verifying the fault-injection transaction…",
  signing: "Waiting for the acquirer wallet signature…",
  broadcasting: "Broadcasting the expected failure to Devnet…",
  confirming: "Waiting for the failed transaction to be recorded…",
  inspecting: "Comparing on-chain balances before and after…",
  proven: "Atomic rollback verified on Solana Devnet.",
};

function SettlementPanel({ id, notice }: { id: string; notice: string }) {
  const { base } = useConnection();
  const wallet = usePeragusWallet();
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [onramp, setOnramp] = useState<PublicOnramp | null>(null);
  const [audit, setAudit] = useState<SettlementAudit | null>(null);
  const [pollError, setPollError] = useState<UiError | null>(null);
  const [polling, setPolling] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastPolled, setLastPolled] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedSettlement | null>(null);
  const [pendingTransaction, setPendingTransaction] = useState<PendingSolanaTransaction | null>(
    null,
  );
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [signature, setSignature] = useState("");
  const [confirmed, setConfirmed] = useState<ConfirmedSettlement | null>(null);
  const [step, setStep] = useState<ExecStep>("idle");
  const [execError, setExecError] = useState<UiError | null>(null);
  const [rollbackStep, setRollbackStep] = useState<RollbackStep>("idle");
  const [rollbackError, setRollbackError] = useState<UiError | null>(null);
  const [rollbackEvidence, setRollbackEvidence] = useState<AtomicRollbackEvidence | null>(null);
  const [rollbackSignature, setRollbackSignature] = useState("");
  const [pixBusy, setPixBusy] = useState(false);
  const [pixAccepted, setPixAccepted] = useState(false);
  const [pixError, setPixError] = useState<UiError | null>(null);
  const [payout, setPayout] = useState<Offramp | null>(null);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState<UiError | null>(null);
  const settlementStatus = settlement?.status;
  const alive = useRef(true);
  const autoPayoutStarted = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const pending = loadPendingSolanaTransaction(id);
    setPendingTransaction(pending);
    setSignature(pending?.signature ?? "");
    setRecoveryLoaded(true);
  }, [id]);

  useEffect(() => {
    if (
      settlementStatus &&
      ["settled", "offramping", "paid_out", "failed", "revoked"].includes(settlementStatus)
    ) {
      clearPendingSolanaTransaction(id);
      setPendingTransaction(null);
    }
  }, [id, settlementStatus]);

  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!controller.signal.aborted)
        timer = setTimeout(() => void tick(), Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS));
    };
    const tick = async () => {
      if (document.visibilityState === "hidden") return schedule();
      try {
        const { data } = await getSettlement(base, id, controller.signal);
        if (controller.signal.aborted) return;
        setSettlement(data);
        if (PRE_TOKENIZED.includes(data.status)) {
          const result = await getOnramp(base, id, controller.signal).catch(() => null);
          if (result && !controller.signal.aborted) setOnramp(result.data);
        }
        const auditResult = await getAudit(base, id, controller.signal).catch(() => null);
        if (auditResult && !controller.signal.aborted) setAudit(auditResult.data);
        failures = 0;
        setPollError(null);
        setLastPolled(new Date().toISOString());
        if (TERMINAL.has(data.status)) {
          setPolling(false);
          return;
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        failures++;
        setPollError(toUiError(e));
        if (e instanceof ApiError && e.code === "SETTLEMENT_NOT_FOUND") {
          setPolling(false);
          return;
        }
      }
      schedule();
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, id, polling, refreshKey]);

  const refresh = () => {
    setPolling(true);
    setRefreshKey((k) => k + 1);
  };

  const confirmSandboxPix = async () => {
    setPixBusy(true);
    setPixError(null);
    try {
      await simulateSandboxPixPayment(base, id);
      if (!alive.current) return;
      setPixAccepted(true);
      refresh();
    } catch (error) {
      if (alive.current) setPixError(toUiError(error));
    } finally {
      if (alive.current) setPixBusy(false);
    }
  };

  const record = async (sig: string) => {
    setStep("recording");
    setExecError(null);
    try {
      const { data } = await confirmSettlement(base, id, sig);
      if (!alive.current) return;
      setConfirmed(data);
      clearPendingSolanaTransaction(id);
      setPendingTransaction(null);
      setStep("done");
      refresh();
    } catch (e) {
      if (!alive.current) return;
      setExecError(toUiError(e));
      setStep("idle");
    }
  };

  const execute = async () => {
    if (!wallet.address) return wallet.open();
    if (pendingTransaction) {
      setExecError({
        message:
          "A signed transaction is awaiting reconciliation. Reconcile it before requesting another signature.",
      });
      return;
    }
    const signer = wallet.address;
    setExecError(null);
    try {
      setStep("preparing");
      const { data } = await prepareSettlement(base, id);
      if (!alive.current) return;
      setPrepared(data);
      setStep("verifying");
      const tx = await verifyPreparedTransaction(data, signer);
      setStep("signing");
      const signedBytes = await wallet.signTransaction(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      );
      if (!alive.current) return;
      const signed = verifySignedTransaction(signedBytes, tx);
      const recovery = createPendingSolanaTransaction(id, data, signed);
      savePendingSolanaTransaction(recovery);
      setPendingTransaction(recovery);
      setSignature(recovery.signature);
      setStep("broadcasting");
      const rpc = new Connection(config.solanaRpcUrl, "confirmed");
      const sig = await rpc.sendRawTransaction(signed.serialize());
      if (!alive.current) return;
      if (sig !== recovery.signature)
        throw new Error("Devnet returned an unexpected signature; recovery remains locked.");
      setStep("confirming");
      const result = await rpc.confirmTransaction(
        {
          signature: sig,
          blockhash: data.recent_blockhash,
          lastValidBlockHeight: data.last_valid_block_height,
        },
        "confirmed",
      );
      if (!alive.current) return;
      if (result.value.err)
        throw new Error("The transaction failed on Solana. Neither token leg settled.");
      await record(sig);
    } catch (e) {
      if (!alive.current) return;
      setExecError(toUiError(e));
      setStep("idle");
    }
  };

  const proveAtomicRollback = async () => {
    if (!wallet.address) return wallet.open();
    if (pendingTransaction) {
      setRollbackError({
        message: "Reconcile the saved settlement transaction before running the rollback proof.",
      });
      return;
    }

    const signer = wallet.address;
    setRollbackError(null);
    setRollbackEvidence(null);
    setRollbackSignature("");

    try {
      setRollbackStep("preparing");
      const { data } = await prepareRollbackDemo(base, id);
      if (!alive.current) return;

      setRollbackStep("verifying");
      const transaction = await verifyPreparedTransaction(data, signer);

      setRollbackStep("signing");
      const signedBytes = await wallet.signTransaction(
        transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      );
      if (!alive.current) return;

      const signed = verifySignedTransaction(signedBytes, transaction);
      const recovery = createPendingSolanaTransaction(id, data, signed);
      setRollbackSignature(recovery.signature);

      const rpc = new Connection(config.solanaRpcUrl, "confirmed");
      setRollbackStep("broadcasting");
      let broadcastError: unknown = null;
      try {
        const signature = await rpc.sendRawTransaction(signed.serialize(), {
          skipPreflight: true,
          maxRetries: 20,
        });
        if (signature !== recovery.signature) {
          throw new Error("Devnet returned an unexpected rollback-proof signature.");
        }
      } catch (error) {
        // A public RPC may time out after forwarding the bytes. The locally
        // derived signature remains authoritative, so inspect it before
        // deciding that the broadcast failed.
        broadcastError = error;
      }

      setRollbackStep("confirming");
      let evidence: AtomicRollbackEvidence;
      try {
        evidence = await readAtomicRollbackEvidence(rpc, data, recovery.signature);
      } catch (error) {
        if (broadcastError) {
          const message = toUiError(broadcastError).message;
          throw new Error(`Devnet did not expose rollback evidence after broadcast: ${message}`);
        }
        throw error;
      }
      if (!alive.current) return;

      setRollbackStep("inspecting");
      setRollbackEvidence(evidence);
      setRollbackStep("proven");
      refresh();
    } catch (error) {
      if (!alive.current) return;
      setRollbackError(toUiError(error));
      setRollbackStep("idle");
    }
  };

  const reconcilePending = async () => {
    const pending = pendingTransaction;
    if (!pending) return;
    setExecError(null);
    setSignature(pending.signature);
    try {
      const rpc = new Connection(config.solanaRpcUrl, "confirmed");
      setStep("confirming");
      const { value } = await rpc.getSignatureStatuses([pending.signature], {
        searchTransactionHistory: true,
      });
      const chainStatus = value[0];
      if (chainStatus?.err) {
        clearPendingSolanaTransaction(id);
        setPendingTransaction(null);
        setSignature("");
        throw new Error(
          "The saved transaction failed on Solana. Neither token leg settled; a new transaction may now be prepared.",
        );
      }

      if (!chainStatus) {
        const blockHeight = await rpc.getBlockHeight("confirmed");
        if (blockHeight > pending.lastValidBlockHeight) {
          clearPendingSolanaTransaction(id);
          setPendingTransaction(null);
          setSignature("");
          throw new Error(
            "The saved transaction expired without confirmation. A new transaction may now be prepared.",
          );
        }
        setStep("broadcasting");
        const rebroadcast = await rpc.sendRawTransaction(
          base64ToBytes(pending.signedTransactionBase64),
        );
        if (rebroadcast !== pending.signature)
          throw new Error("Devnet returned an unexpected signature; recovery remains locked.");
      }

      if (
        chainStatus?.confirmationStatus !== "confirmed" &&
        chainStatus?.confirmationStatus !== "finalized"
      ) {
        setStep("confirming");
        const result = await rpc.confirmTransaction(
          {
            signature: pending.signature,
            blockhash: pending.recentBlockhash,
            lastValidBlockHeight: pending.lastValidBlockHeight,
          },
          "confirmed",
        );
        if (result.value.err) {
          clearPendingSolanaTransaction(id);
          setPendingTransaction(null);
          setSignature("");
          throw new Error(
            "The saved transaction failed on Solana. Neither token leg settled; a new transaction may now be prepared.",
          );
        }
      }
      await record(pending.signature);
    } catch (e) {
      if (!alive.current) return;
      setExecError(toUiError(e));
      setStep("idle");
    }
  };

  const startPayout = useCallback(async () => {
    setPayoutBusy(true);
    setPayoutError(null);
    try {
      const { data } = await initiateOfframp(base, id, config.demoPayoutDestinationId);
      if (!alive.current) return;
      setPayout(data);
      setPolling(true);
      setRefreshKey((key) => key + 1);
    } catch (e) {
      if (alive.current) setPayoutError(toUiError(e));
    } finally {
      if (alive.current) setPayoutBusy(false);
    }
  }, [base, id]);

  useEffect(() => {
    if (
      settlementStatus !== "settled" ||
      !config.demoPayoutDestinationId ||
      autoPayoutStarted.current
    ) {
      return;
    }
    autoPayoutStarted.current = true;
    void startPayout();
  }, [settlementStatus, startPayout]);

  if (!settlement)
    return (
      <div className="cr-card">
        {pollError ? (
          <ErrorNote error={pollError} onRetry={refresh} />
        ) : (
          <p className="cr-muted flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading settlement {short(id, 6)}…
          </p>
        )}
      </div>
    );

  const status = settlement.status;
  const busyExec = step !== "idle" && step !== "done";
  const busyRollback = rollbackStep !== "idle" && rollbackStep !== "proven";
  const reserve = audit?.contingency_reserve ?? null;
  const solana = audit?.solana_settlement ?? null;
  const walletMatches = wallet.address === settlement.payer_wallet;

  return (
    <div className="cr-panel">
      {notice && (
        <p role="status" className="cr-notice">
          <CheckCircle2 className="size-4" /> {notice}
        </p>
      )}
      <div className="cr-card">
        <div className="cr-card-head">
          <div>
            <h3>{STATUS_LABEL[status]}</h3>
            <p className="cr-muted">
              Live backend state · version {settlement.version}
              {lastPolled && ` · checked ${new Date(lastPolled).toLocaleTimeString()}`}
            </p>
          </div>
          <div className="flex gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label={polling ? "Pause polling" : "Resume polling"}
              title={polling ? "Pause polling" : "Resume polling"}
              onClick={() => (polling ? setPolling(false) : refresh())}
            >
              {polling ? <Pause /> : <Play />}
            </Button>
            <Button size="icon" variant="ghost" aria-label="Refresh now" onClick={refresh}>
              <RefreshCw />
            </Button>
          </div>
        </div>
        {pollError && <ErrorNote error={pollError} onRetry={refresh} />}
        <StatusTimeline status={status} />
        <div className="cr-rows">
          <Row label="Settlement ID">
            <Mono value={settlement.id} size={8} />
          </Row>
          <Row label="Request ID">
            <Mono value={settlement.request_id} size={10} />
          </Row>
          <Row label="Payer">
            <Mono value={settlement.payer_wallet} href={explorerAddress(settlement.payer_wallet)} />
          </Row>
          <Row label="Recipient">
            <Mono
              value={settlement.recipient_wallet}
              href={explorerAddress(settlement.recipient_wallet)}
            />
          </Row>
          <Row label="Amounts (base units)">
            <code>
              {settlement.source_amount} BRL → {settlement.destination_amount} USDT
            </code>
          </Row>
          <Row label="Expires">
            <code>{formatTime(settlement.expires_at)}</code>
          </Row>
        </div>
      </div>

      <div className="cr-card" data-boundary="fiat">
        <span className="cr-tag">Fiat coordination · asynchronous</span>
        <h3>Liquidity rails</h3>
        {PRE_TOKENIZED.includes(status) ? (
          onramp ? (
            <div className="cr-rows">
              <Row label="On-ramp stage">
                <code>{onramp.stage}</code>
              </Row>
              <Row label="Payment instructions">
                {onramp.pix ? (
                  <span>
                    {onramp.pix.expired ? "Expired" : "Sandbox payment instructions ready"} ·
                    expires {formatTime(onramp.pix.expires_at)}
                  </span>
                ) : (
                  <span className="cr-muted">Preparing…</span>
                )}
              </Row>
              {status === "awaiting_pix" && onramp.pix && (
                <div className="cr-pix-checkout">
                  <div>
                    <span className="cr-tag">Customer checkout · sandbox</span>
                    <h4>Pay BRL {onramp.source_amount_brl ?? "—"} with Pix</h4>
                    <p className="cr-muted">
                      Scan the fictitious QR as the buyer, then confirm payment to continue the real
                      sandbox and Devnet workflow. No real Pix transfer is created.
                    </p>
                    <p className="cr-muted">Merchant location · Paraguay</p>
                  </div>
                  <SandboxPixQr seed={settlement.id} />
                  {pixAccepted ? (
                    <p className="cr-success" role="status">
                      <Loader2 className="size-4 animate-spin" /> Sandbox payment accepted.
                      Reconciling the persisted rail events…
                    </p>
                  ) : (
                    <Button
                      onClick={() => void confirmSandboxPix()}
                      disabled={pixBusy || onramp.pix.expired}
                    >
                      {pixBusy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                      {pixBusy ? "Confirming sandbox payment…" : "I've paid with Pix"}
                    </Button>
                  )}
                  {onramp.pix.expired && (
                    <p className="cr-warn">This sandbox Pix instruction has expired.</p>
                  )}
                  {pixError && (
                    <ErrorNote error={pixError} onRetry={() => void confirmSandboxPix()} />
                  )}
                </div>
              )}
              {status === "pix_confirmed" && (
                <p className="cr-success">
                  <CheckCircle2 className="size-4" /> Pix confirmed. Preparing the on-chain
                  settlement assets…
                </p>
              )}
            </div>
          ) : (
            <p className="cr-muted">Waiting for on-ramp readiness…</p>
          )
        ) : (
          <p className="cr-muted">Fiat collection stage complete for this settlement.</p>
        )}
        <h4>Contingency reserve</h4>
        {reserve ? (
          <div className="cr-rows">
            <Row label="Status">
              <code data-reserve={reserve.status}>{reserve.status}</code>
            </Row>
            <Row label="Resolution">
              <code>{reserve.resolution_action}</code>
            </Row>
            <Row label="Amount">
              <code>{reserve.amount_usdt} USDT</code>
            </Row>
            <Row label="Reserve PDA">
              <Mono value={reserve.reserve_pda} href={explorerAddress(reserve.reserve_pda)} />
            </Row>
            <Row label="Funding tx">
              <Mono value={reserve.create_signature} href={explorerTx(reserve.create_signature)} />
            </Row>
            {reserve.resolution_signature && (
              <Row label="Resolution tx">
                <Mono
                  value={reserve.resolution_signature}
                  href={explorerTx(reserve.resolution_signature)}
                />
              </Row>
            )}
          </div>
        ) : (
          <p className="cr-muted">No reserve recorded yet.</p>
        )}
      </div>

      <div className="cr-card" data-boundary="atomic">
        <span className="cr-tag cr-tag-atomic">Atomic Solana boundary</span>
        <h3>Two Token-2022 legs, one transaction</h3>
        <p className="cr-muted">
          The payer leg and liquidity leg execute in a single Devnet transaction co-signed by
          Peragus. A missing signature or a failed leg settles neither.
        </p>
        <p className="cr-muted">
          The sandbox liquidity-rail credit is completed before this step and remains outside the
          Solana atomic boundary. This failure proof never confirms the backend settlement or starts
          payout.
        </p>
        {(status === "tokenized" || rollbackEvidence) && (
          <div className="cr-rollback-proof">
            <div>
              <span className="cr-tag">Optional failure proof · Devnet</span>
              <h4>Force leg B to fail before settlement</h4>
              <p className="cr-muted">
                Peragus injects an impossible destination amount into a separate sandbox
                transaction. Leg A reaches Token-2022, leg B fails for insufficient liquidity, and
                Solana must revert every token balance and the new settlement PDA.
              </p>
            </div>

            {rollbackEvidence ? (
              <>
                <p className="cr-success" role="status">
                  <ShieldCheck className="size-4" /> Expected failure recorded — atomic rollback
                  verified.
                </p>
                <div className="cr-rows">
                  <Row label="Failed Devnet transaction">
                    <Mono
                      value={rollbackEvidence.signature}
                      href={explorerTx(rollbackEvidence.signature)}
                    />
                  </Row>
                  <Row label="Execution evidence">
                    <code>Leg A reached · Leg B insufficient funds</code>
                  </Row>
                  <Row label="Settlement PDA">
                    <code>absent after rollback</code>
                  </Row>
                  <Row label="Backend settlement">
                    <code>
                      {status === "tokenized"
                        ? "tokenized · ready for the valid transaction"
                        : `${status} · valid transaction completed afterward`}
                    </code>
                  </Row>
                </div>
                <div className="cr-table-wrap">
                  <table className="cr-balance-table">
                    <thead>
                      <tr>
                        <th>Token account</th>
                        <th>Before</th>
                        <th>After</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rollbackEvidence.balances.map((balance) => (
                        <tr key={balance.account}>
                          <td title={balance.address}>{balance.account}</td>
                          <td>
                            <code>{balance.before}</code>
                          </td>
                          <td>
                            <code>{balance.after}</code>
                          </td>
                          <td>
                            <strong>Unchanged</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="cr-muted">
                  Token balances are unchanged. As on any failed Solana transaction, the payer may
                  still incur the network fee.
                </p>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => void proveAtomicRollback()}
                disabled={busyRollback || busyExec || Boolean(pendingTransaction) || !walletMatches}
              >
                {busyRollback ? <Loader2 className="animate-spin" /> : <AlertTriangle />}
                {busyRollback ? "Running rollback proof…" : "Run second-leg failure proof"}
              </Button>
            )}

            {rollbackStep !== "idle" && (
              <p className="cr-muted flex items-center gap-2" role="status">
                {busyRollback && <Loader2 className="size-4 animate-spin" />}
                {ROLLBACK_LABEL[rollbackStep]}
              </p>
            )}
            {rollbackSignature && !rollbackEvidence && (
              <Row label="Expected failed transaction">
                <Mono value={rollbackSignature} href={explorerTx(rollbackSignature)} />
              </Row>
            )}
            {rollbackError && (
              <ErrorNote error={rollbackError} onRetry={() => void proveAtomicRollback()} />
            )}
          </div>
        )}
        {status === "tokenized" && !confirmed && (
          <>
            {wallet.address && !walletMatches && (
              <p className="cr-warn">
                Connected wallet differs from the settlement payer. Signing will be refused.
              </p>
            )}
            {pendingTransaction ? (
              <>
                <p className="cr-warn">
                  A signed transaction was saved before broadcast at{" "}
                  {formatTime(pendingTransaction.savedAt)}. Reconciliation reuses those exact bytes
                  and never requests a second signature.
                </p>
                <Button onClick={() => void reconcilePending()} disabled={busyExec}>
                  {busyExec ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  Reconcile saved transaction
                </Button>
              </>
            ) : (
              <Button
                onClick={() => void execute()}
                disabled={busyExec || busyRollback || !recoveryLoaded}
              >
                {busyExec ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                {!recoveryLoaded
                  ? "Checking transaction recovery…"
                  : wallet.address
                    ? rollbackEvidence
                      ? "Continue with valid liquidity"
                      : "Verify, sign & broadcast"
                    : "Connect payer wallet"}
              </Button>
            )}
          </>
        )}
        {step !== "idle" && (
          <p className="cr-muted flex items-center gap-2" role="status">
            {busyExec && <Loader2 className="size-4 animate-spin" />}
            {EXEC_LABEL[step]}
          </p>
        )}
        {execError && <ErrorNote error={execError} />}
        <div className="cr-rows">
          {(prepared || pendingTransaction) && (
            <>
              {prepared && (
                <Row label="Settlement PDA">
                  <Mono
                    value={prepared.settlement_pda}
                    href={explorerAddress(prepared.settlement_pda)}
                  />
                </Row>
              )}
              <Row label="Message hash">
                <Mono value={prepared?.message_hash ?? pendingTransaction!.messageHash} size={10} />
              </Row>
            </>
          )}
          {(confirmed?.signature || signature) && (
            <Row label="Transaction">
              <Mono
                value={confirmed?.signature ?? signature}
                href={explorerTx(confirmed?.signature ?? signature)}
              />
            </Row>
          )}
          {confirmed && (
            <Row label="Slot">
              <code>{confirmed.slot}</code>
            </Row>
          )}
          {solana?.atomic_signature && (
            <Row label="Recorded atomic tx">
              <Mono value={solana.atomic_signature} href={explorerTx(solana.atomic_signature)} />
            </Row>
          )}
          {solana && (
            <Row label="Backend verified">
              <code>{solana.verified ? "true" : "false"}</code>
            </Row>
          )}
        </div>
        {!["tokenized", ...LIFECYCLE.slice(4)].includes(status) && status !== "failed" && (
          <p className="cr-muted">Available once the settlement reaches tokenized.</p>
        )}
      </div>

      <div className="cr-card" data-boundary="fiat">
        <span className="cr-tag">Fiat coordination · asynchronous</span>
        <h3>Payout</h3>
        {status === "settled" && !payout && !payoutError && (
          <>
            {config.demoPayoutDestinationId ? (
              <p className="cr-muted flex items-center gap-2" role="status">
                <Loader2 className="size-4 animate-spin" /> Starting the sandbox payout
                automatically…
              </p>
            ) : (
              <p className="cr-muted">Set the sandbox payout destination to enable payout.</p>
            )}
          </>
        )}
        {payoutError && (
          <ErrorNote
            error={payoutError}
            onRetry={() => {
              autoPayoutStarted.current = true;
              void startPayout();
            }}
          />
        )}
        {payout && (
          <p className="cr-muted">
            Payout requested ({publicStatus(payout.provider_status)}). Completion is confirmed only
            by polled settlement and audit state.
          </p>
        )}
        {status === "paid_out" ? (
          <p className="cr-success">
            <CheckCircle2 className="size-4" /> Paid out — confirmed by backend state.
          </p>
        ) : status === "offramping" ? (
          <p className="cr-muted">Reconciling payout…</p>
        ) : (
          status !== "settled" && <p className="cr-muted">Available once settled on Solana.</p>
        )}
      </div>

      <AuditPanel audit={audit} />
    </div>
  );
}

function AuditPanel({ audit }: { audit: SettlementAudit | null }) {
  if (!audit)
    return (
      <div className="cr-card">
        <h3>Audit evidence</h3>
        <p className="cr-muted">No audit evidence available yet.</p>
      </div>
    );
  const events = [...(audit.onramp?.events ?? []), ...(audit.offramp?.events ?? [])].sort((a, b) =>
    a.occurred_at.localeCompare(b.occurred_at),
  );
  const checks = Object.entries(audit.checks) as [string, boolean][];
  return (
    <div className="cr-card cr-wide">
      <div className="cr-card-head">
        <div>
          <h3>Sanitized audit evidence</h3>
          <p className="cr-muted">
            <code>GET /v1/settlements/:id/audit</code> · generated{" "}
            {new Date(audit.generated_at).toLocaleString()}
          </p>
        </div>
      </div>
      <ul className="cr-checks">
        {checks.map(([key, ok]) => (
          <li key={key} data-ok={ok}>
            {ok ? <CheckCircle2 /> : <Circle />}
            {key.replace(/_/g, " ")}
          </li>
        ))}
        {audit.onramp && (
          <li data-ok={audit.onramp.identity_consistent}>
            {audit.onramp.identity_consistent ? <CheckCircle2 /> : <XCircle />}
            on-ramp identity consistent
          </li>
        )}
        {audit.offramp && (
          <li data-ok={audit.offramp.identity_consistent}>
            {audit.offramp.identity_consistent ? <CheckCircle2 /> : <XCircle />}
            payout identity consistent
          </li>
        )}
      </ul>
      {audit.warnings.length > 0 && (
        <p className="cr-warn">{audit.warnings.length} audit warning(s) reported by the backend.</p>
      )}
      {events.length > 0 ? (
        <div className="cr-events">
          {events.map((event) => (
            <div key={event.event_id}>
              <code>{new Date(event.occurred_at).toLocaleString()}</code>
              <strong>{publicStatus(event.provider_status)}</strong>
              <span>
                {event.amounts.source.amount} {event.amounts.source.currency} →{" "}
                {event.amounts.target.amount} {event.amounts.target.currency}
              </span>
              <Mono value={event.content_hash} size={10} />
            </div>
          ))}
        </div>
      ) : (
        <p className="cr-muted">No rail events recorded yet.</p>
      )}
    </div>
  );
}

export function ControlRoom() {
  const { backend, base } = useConnection();
  const [active, setActive] = useState<{ id: string; notice: string } | null>(null);
  return (
    <section className="cr" id="control-room">
      <FlowStrip />
      {backend === "offline" && (
        <div role="status" className="cr-warn cr-banner">
          <AlertTriangle className="size-4" />
          Backend offline at <code>{base}</code>. Run the frontend locally with the Peragus backend
          to create live settlements. Nothing shown here is simulated.
        </div>
      )}
      <div className="cr-layout">
        <div className="cr-side">
          <CreateForm
            onCreated={(s, replay) =>
              setActive({
                id: s.id,
                notice: replay
                  ? "Existing instruction replayed (idempotent)."
                  : "Settlement created.",
              })
            }
          />
          <LookupForm onLoad={(id) => setActive({ id, notice: "" })} />
        </div>
        <div className="cr-main">
          {active ? (
            <SettlementPanel key={active.id} id={active.id} notice={active.notice} />
          ) : (
            <div className="cr-card cr-empty">
              <h3>No settlement loaded</h3>
              <p className="cr-muted">
                Create an instruction or load an existing settlement ID to observe its live state.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
