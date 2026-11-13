import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
import { RuntimeControlsConsole } from "@/routes/operador.controles";
import { DailyReviewConsole } from "@/routes/operador.revisao-diaria";
import { WithdrawalConsole } from "@/routes/operador.saques";
import { AlertsConsole } from "@/routes/operador.alertas";
import { OperatorDashboard } from "@/routes/operador.index";

const id = "22222222-2222-4222-8222-222222222222";
const purchase = "11111111-1111-4111-8111-111111111111";
const requestA = "33333333-3333-4333-8333-333333333333";
const requestB = "44444444-4444-4444-8444-444444444444";
const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const signature =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function backend(routes: Record<string, Handler | Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const handler = routes[`${method} ${url}`] ?? routes[`${method} ${url.split("?")[0]}`];
    if (!handler) return Response.json({ error: { code: "NOT_MOCKED" } }, { status: 404 });
    return typeof handler === "function" ? handler(url, init) : handler.clone();
  });
}
const sent = (fetcher: ReturnType<typeof backend>, method: string, path: string) =>
  fetcher.mock.calls
    .filter(([url, init]) => String(url).startsWith(path) && (init?.method ?? "GET") === method)
    .map(([, init]) => ({
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: new Headers(init?.headers).get("authorization"),
    }));
const controls = (overrides: Record<string, boolean> = {}) =>
  Response.json({
    data: {
      environment: "test",
      controls: ["new_operations", "usdt_sends", "onboarding"].map((key) => ({
        key,
        enabled: overrides[key] ?? true,
        updated_by: null,
        updated_at: null,
        environment: "test",
      })),
    },
  });
const queueItem = (state: string, extra: object = {}) => ({
  id,
  customer_id: purchase,
  purchase_intent_id: purchase,
  pix_id: id,
  created_at: "2026-11-13T12:00:00.000000Z",
  state,
  environment: "test",
  real_money: false,
  refund_request: null,
  source: { currency: "USDT", amount: "199.900000" },
  destination: { wallet_address: wallet, network: "solana", proof_network: "solana:devnet" },
  approved: state !== "pending_approval",
  approval_recorded_at: state === "pending_approval" ? null : "2026-11-13T12:01:00.000Z",
  withdrawal_started: false,
  provider_completed: false,
  recovery_required: false,
  manual_review_required: state === "needs_review",
  ...extra,
});
const queue = (...items: object[]) =>
  Response.json({ data: items, meta: { state: "all", has_more: false, next_cursor: null } });
const alerts = Response.json({
  data: [
    {
      id: `pix_open_after_close:${id}`,
      resource_id: id,
      kind: "pix_open_after_close",
      severity: "high",
      first_recorded_at: "2026-11-13T12:00:00.000000Z",
      purchase_intent_id: purchase,
      pix_id: id,
      withdrawal_request_id: null,
      refund_request_id: null,
      detail_path: "/v1/admin/customer-reconciliation",
      environment: "test",
      stored_evidence_only: true,
      execution_authorized: false,
    },
  ],
  meta: { has_more: false, next_cursor: null, environment: "test" },
});
const notifications = Response.json({
  data: [
    {
      id,
      kind: "withdrawal_refused_transfer_found",
      severity: "high",
      recipient_role: "trusted",
      status: "uncertain",
      last_error: "PROVIDER_UNCONFIRMED",
      purchase_id: purchase,
      created_at: "2026-11-13T12:00:00.000000Z",
      first_attempt_at: "2026-11-13T12:00:01.000000Z",
      updated_at: "2026-11-13T12:00:11.000000Z",
      environment: "test",
    },
  ],
  meta: { environment: "test", limit: 100, status: "all" },
});
const stale = () => Response.json({ error: { code: "OPERATOR_MFA_STALE" } }, { status: 403 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runtime controls screen", () => {
  it("renders the three switches and PUTs a toggle with the mandatory reason after confirmation", async () => {
    const fetcher = backend({
      "GET /api/v1/admin/runtime-controls": controls(),
      "PUT /api/v1/admin/runtime-controls": Response.json({
        data: {
          key: "usdt_sends",
          enabled: false,
          updated_by: id,
          updated_at: "2026-11-13T12:00:00.000Z",
          environment: "test",
          changed: true,
        },
      }),
    });
    render(<RuntimeControlsConsole token="synthetic.aal2" verifyMfa={vi.fn()} />);
    const row = (await screen.findByText("Envios de USDT")).closest(".customer-row") as HTMLElement;
    expect(screen.getByText("Novas operações")).toBeInTheDocument();
    expect(screen.getByText("Cadastros")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Desligar" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Confirmar alteração" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Motivo da alteração"), {
      target: { value: "Pausa preventiva do piloto" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar alteração" }));
    await screen.findByText(/Envios de USDT: desligada/);
    expect(sent(fetcher, "PUT", "/api/v1/admin/runtime-controls")[0]!.body).toEqual({
      key: "usdt_sends",
      enabled: false,
      reason: "Pausa preventiva do piloto",
    });
  });
});

describe("daily review screen", () => {
  it("refuses today without calling the API and posts an ended day", async () => {
    const fetcher = backend({
      "POST /api/v1/admin/daily-reviews": Response.json({
        data: {
          day: "2026-11-12",
          reviewed_by: id,
          reviewed_at: "2026-11-13T12:00:00.000Z",
          note: "Sem pendências",
          environment: "test",
          changed: true,
        },
      }),
    });
    render(
      <DailyReviewConsole
        token="synthetic.aal2"
        verifyMfa={vi.fn()}
        now={new Date("2026-11-13T15:00:00Z")}
      />,
    );
    const day = screen.getByLabelText("Dia revisado (horário de São Paulo)");
    expect(day).toHaveValue("2026-11-12");
    fireEvent.change(day, { target: { value: "2026-11-13" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar revisão" }));
    expect(await screen.findByText(/ainda não terminou/)).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(day, { target: { value: "2026-11-12" } });
    fireEvent.change(screen.getByLabelText("Observação (opcional)"), {
      target: { value: "Sem pendências" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Registrar revisão" }));
    expect(await screen.findByText(/Revisão de 2026-11-12 registrada/)).toBeInTheDocument();
    expect(sent(fetcher, "POST", "/api/v1/admin/daily-reviews")[0]!.body).toEqual({
      day: "2026-11-12",
      note: "Sem pendências",
    });
  });

  it("shows DAILY_REVIEW_DAY_NOT_ENDED from the backend in pt-BR with the code", async () => {
    backend({
      "POST /api/v1/admin/daily-reviews": Response.json(
        { error: { code: "DAILY_REVIEW_DAY_NOT_ENDED" } },
        { status: 409 },
      ),
    });
    render(
      <DailyReviewConsole
        token="synthetic.aal2"
        verifyMfa={vi.fn()}
        now={new Date("2026-11-13T15:00:00Z")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Registrar revisão" }));
    expect(await screen.findByText(/ainda não terminou/)).toBeInTheDocument();
    expect(screen.getByText(/DAILY_REVIEW_DAY_NOT_ENDED/)).toBeInTheDocument();
  });
});

describe("withdrawal queue screen", () => {
  it("lists amounts with a short wallet prefix only", async () => {
    backend({ "GET /api/v1/admin/withdrawal-requests": queue(queueItem("pending_approval")) });
    render(<WithdrawalConsole token="synthetic.aal2" verifyMfa={vi.fn()} />);
    expect(await screen.findByText(/199\.900000 USDT/)).toBeInTheDocument();
    expect(screen.getByText("Aguardando aprovação", { selector: "strong" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(wallet);
    expect(document.body.textContent).toContain(wallet.slice(0, 4));
  });

  it("approval: OPERATOR_MFA_STALE re-verifies and retries once with the same request_id", async () => {
    const verifyMfa = vi.fn().mockResolvedValue("synthetic.fresh");
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(requestA).mockReturnValueOnce(requestB);
    let posts = 0;
    const fetcher = backend({
      "GET /api/v1/admin/withdrawal-requests": queue(queueItem("pending_approval")),
      [`POST /api/v1/admin/withdrawal-requests/${id}/approval`]: () => {
        posts++;
        return posts <= 2
          ? stale()
          : Response.json({ data: { id, approved: true }, meta: { idempotent_replay: false } });
      },
    });
    render(<WithdrawalConsole token="synthetic.aal2" verifyMfa={verifyMfa} />);
    fireEvent.click(await screen.findByRole("button", { name: "Aprovar" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Motivo da aprovação"), {
      target: { value: "Conferi Pix, conversão e carteira" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar aprovação" }));
    fireEvent.change(await screen.findByLabelText("Código atual do autenticador"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e repetir" }));
    await waitFor(() => expect(posts).toBe(2));
    expect(verifyMfa).toHaveBeenCalledWith("654321");
    // A second stale answer is shown, never retried automatically.
    expect(await screen.findByText(/confirme um código atual do autenticador/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Código atual do autenticador")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const calls = sent(fetcher, "POST", `/api/v1/admin/withdrawal-requests/${id}/approval`);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual({
      request_id: requestA,
      reason: "Conferi Pix, conversão e carteira",
    });
    expect(calls[1]!.body.request_id).toBe(requestA);
    expect(calls[0]!.authorization).toBe("Bearer synthetic.aal2");
    expect(calls[1]!.authorization).toBe("Bearer synthetic.fresh");
  });

  it("execute in live requires typing LIVE_USDT_SEND and shows the remaining delay from the backend", async () => {
    vi.stubEnv("VITE_PERAGUS_MONEY_MODE", "live");
    const live = queueItem("approved", {
      environment: "live",
      real_money: true,
      destination: { wallet_address: wallet, network: "solana", proof_network: "solana:mainnet" },
    });
    const fetcher = backend({
      "GET /api/v1/admin/withdrawal-requests": queue(live),
      [`POST /api/v1/admin/withdrawal-requests/${id}/execution`]: Response.json(
        {
          error: {
            code: "EXECUTION_TOO_EARLY",
            remaining_delay_seconds: 600,
            automatic_retry: false,
          },
        },
        { status: 409 },
      ),
    });
    render(<WithdrawalConsole token="synthetic.aal2" verifyMfa={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Executar" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/dinheiro real/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Confirmar envio" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Digite LIVE_USDT_SEND/), {
      target: { value: "live_usdt_send" },
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Digite LIVE_USDT_SEND/), {
      target: { value: "LIVE_USDT_SEND" },
    });
    fireEvent.click(confirm);
    expect(await screen.findByText(/faltam 10 min/)).toBeInTheDocument();
    expect(screen.getByText(/EXECUTION_TOO_EARLY/)).toBeInTheDocument();
    expect(
      sent(fetcher, "POST", `/api/v1/admin/withdrawal-requests/${id}/execution`)[0]!.body
        .confirmation,
    ).toBe("LIVE_USDT_SEND");
  });

  it("execute in test needs no typed confirmation and explains a missing token account", async () => {
    backend({
      "GET /api/v1/admin/withdrawal-requests": queue(queueItem("approved")),
      [`POST /api/v1/admin/withdrawal-requests/${id}/execution`]: Response.json(
        { error: { code: "DESTINATION_TOKEN_ACCOUNT_MISSING", automatic_retry: false } },
        { status: 409 },
      ),
    });
    render(<WithdrawalConsole token="synthetic.aal2" verifyMfa={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Executar" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByLabelText(/Digite LIVE_USDT_SEND/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar envio" }));
    expect(await screen.findByText(/não tem conta de token USDT/)).toBeInTheDocument();
  });

  it("details show the delivery verification, the review reason and a mode-aware explorer link", async () => {
    backend({
      "GET /api/v1/admin/withdrawal-requests": queue(queueItem("needs_review")),
      [`GET /api/v1/admin/withdrawal-requests/${id}/execution`]: Response.json({
        data: {
          id: requestA,
          withdrawal_request_id: id,
          request_id: requestA,
          state: "provider_completed",
          environment: "test",
          real_money: false,
          source: { currency: "USDT", amount: "199.900000" },
          destination: {
            wallet_address: wallet,
            network: "solana",
            proof_network: "solana:devnet",
          },
          provider_target_amount: "199.800000",
          provider_transaction_reference: signature,
          provider_refusal_code: null,
          provider_completed: true,
          execution_requested: true,
          recovery_required: false,
          manual_review_required: true,
          onchain_delivery_verified: false,
          delivery_status: "review",
          delivery_reason: "AMOUNT_MISMATCH",
          delivered_amount: null,
          delivery_simulated: false,
          refused_transfer_found: false,
          delivery_pending_reason: null,
        },
      }),
    });
    render(<WithdrawalConsole token="synthetic.aal2" verifyMfa={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Detalhes" }));
    expect(await screen.findByText(/Entrega em revisão/)).toBeInTheDocument();
    expect(screen.getByText(/valor creditado fora da faixa/)).toBeInTheDocument();
    expect(screen.getByText(/AMOUNT_MISMATCH/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ver no explorer/ })).toHaveAttribute(
      "href",
      `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    );
  });
});

describe("withdrawal queue: in-flight and uncertain money actions", () => {
  const twoRows = () =>
    queue(queueItem("pending_approval"), { ...queueItem("needs_review"), id: requestB });
  async function confirmApproval() {
    fireEvent.click(await screen.findByRole("button", { name: "Aprovar" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Motivo da aprovação"), {
      target: { value: "Conferi Pix, conversão e carteira" },
    });
    return within(dialog).getByRole("button", { name: "Confirmar aprovação" });
  }

  it("a double click sends exactly one request, and nothing else can be opened while in flight", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestA);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetcher = backend({
      "GET /api/v1/admin/withdrawal-requests": twoRows(),
      [`POST /api/v1/admin/withdrawal-requests/${id}/approval`]: async () => {
        await gate;
        return Response.json({ data: { id, approved: true }, meta: { idempotent_replay: false } });
      },
    });
    render(<WithdrawalConsole token="synthetic.aal2" verifyMfa={vi.fn()} />);
    const confirm = await confirmApproval();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(
        sent(fetcher, "POST", `/api/v1/admin/withdrawal-requests/${id}/approval`),
      ).toHaveLength(1),
    );
    expect(screen.getByRole("button", { name: "Detalhes" })).toBeDisabled();
    expect(screen.getByLabelText("Situação")).toBeDisabled();
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }),
    ).toBeDisabled();
    release();
    expect(await screen.findByText(/Aprovação registrada/)).toBeInTheDocument();
    expect(sent(fetcher, "POST", `/api/v1/admin/withdrawal-requests/${id}/approval`)).toHaveLength(
      1,
    );
  });

  it("an unknown outcome keeps the intent: panel/filter locked, repeat reuses the same request_id", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(requestA).mockReturnValueOnce(requestB);
    let posts = 0;
    const fetcher = backend({
      "GET /api/v1/admin/withdrawal-requests": twoRows(),
      [`POST /api/v1/admin/withdrawal-requests/${id}/approval`]: () =>
        ++posts === 1
          ? Response.json({ error: { code: "WITHDRAWAL_APPROVAL_UNAVAILABLE" } }, { status: 503 })
          : Response.json({ data: { id, approved: true }, meta: { idempotent_replay: true } }),
    });
    render(<WithdrawalConsole token="synthetic.aal2" verifyMfa={vi.fn()} />);
    fireEvent.click(await confirmApproval());
    const repeat = await screen.findByRole("button", { name: "Repetir mesma solicitação" });
    expect(screen.getByText(/Resultado incerto/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Detalhes" })).toBeDisabled();
    expect(screen.getByLabelText("Situação")).toBeDisabled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Confirmar aprovação" })).toBeDisabled();
    fireEvent.click(repeat);
    expect(await screen.findByText(/Aprovação registrada/)).toBeInTheDocument();
    const calls = sent(fetcher, "POST", `/api/v1/admin/withdrawal-requests/${id}/approval`);
    expect(calls.map((call) => call.body.request_id)).toEqual([requestA, requestA]);
    expect(screen.getByRole("button", { name: "Detalhes" })).not.toBeDisabled();
  });

  it("repeat after a re-verification uses the fresh token kept by the action", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestA);
    const verifyMfa = vi.fn().mockResolvedValue("synthetic.fresh");
    let posts = 0;
    const fetcher = backend({
      "GET /api/v1/admin/withdrawal-requests": twoRows(),
      [`POST /api/v1/admin/withdrawal-requests/${id}/approval`]: () => {
        posts++;
        if (posts === 1) return stale();
        if (posts === 2)
          return Response.json({ error: { code: "X_UNAVAILABLE" } }, { status: 503 });
        return Response.json({ data: { id, approved: true }, meta: { idempotent_replay: true } });
      },
    });
    render(<WithdrawalConsole token="synthetic.aal2" verifyMfa={verifyMfa} />);
    fireEvent.click(await confirmApproval());
    fireEvent.change(await screen.findByLabelText("Código atual do autenticador"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e repetir" }));
    fireEvent.click(await screen.findByRole("button", { name: "Repetir mesma solicitação" }));
    expect(await screen.findByText(/Aprovação registrada/)).toBeInTheDocument();
    const calls = sent(fetcher, "POST", `/api/v1/admin/withdrawal-requests/${id}/approval`);
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer synthetic.aal2",
      "Bearer synthetic.fresh",
      "Bearer synthetic.fresh",
    ]);
    expect(new Set(calls.map((call) => call.body.request_id))).toEqual(new Set([requestA]));
  });

  it("Conciliar shows its errors and offers the fresh-MFA form instead of swallowing them", async () => {
    const verifyMfa = vi.fn().mockResolvedValue("synthetic.fresh");
    let reconciles = 0;
    const fetcher = backend({
      "GET /api/v1/admin/withdrawal-requests": queue(queueItem("uncertain")),
      [`GET /api/v1/admin/withdrawal-requests/${id}/execution`]: Response.json({
        data: {
          id: requestA,
          withdrawal_request_id: id,
          request_id: requestA,
          state: "uncertain",
          environment: "test",
          source: { currency: "USDT", amount: "199.900000" },
          provider_transaction_reference: null,
          provider_refusal_code: null,
          provider_completed: false,
          recovery_required: true,
          manual_review_required: false,
          onchain_delivery_verified: false,
          delivery_status: null,
          delivery_reason: null,
          delivered_amount: null,
          refused_transfer_found: false,
          delivery_pending_reason: null,
        },
      }),
      [`POST /api/v1/admin/withdrawal-requests/${id}/execution/reconcile`]: () =>
        ++reconciles === 1
          ? Response.json({ error: { code: "WITHDRAWAL_OPERATOR_MFA_REQUIRED" } }, { status: 403 })
          : Response.json({
              data: {
                id: requestA,
                withdrawal_request_id: id,
                state: "provider_completed",
                environment: "test",
                delivery_status: "simulated",
                delivery_reason: "SIMULATED: test",
                recovery_required: false,
              },
            }),
    });
    render(<WithdrawalConsole token="synthetic.aal2" verifyMfa={verifyMfa} />);
    fireEvent.click(await screen.findByRole("button", { name: "Detalhes" }));
    fireEvent.click(await screen.findByRole("button", { name: /Conciliar/ }));
    expect(await screen.findByText(/WITHDRAWAL_OPERATOR_MFA_REQUIRED/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Código atual do autenticador"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e repetir" }));
    expect(await screen.findByText(/Envio simulado/)).toBeInTheDocument();
    const calls = sent(
      fetcher,
      "POST",
      `/api/v1/admin/withdrawal-requests/${id}/execution/reconcile`,
    );
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer synthetic.aal2",
      "Bearer synthetic.fresh",
    ]);
  });
});

describe("alerts screen", () => {
  it("renders operational alerts and uncertain/failed notifications", async () => {
    backend({
      "GET /api/v1/admin/operational-alerts": alerts,
      "GET /api/v1/admin/operator-notifications": notifications,
    });
    render(<AlertsConsole token="synthetic.aal2" verifyMfa={vi.fn()} />);
    expect(await screen.findByText("Pix em aberto após encerramento")).toBeInTheDocument();
    expect(
      await screen.findByText("Envio recusado com transferência encontrada"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Resultado incerto/)).toBeInTheDocument();
    expect(screen.getByText(/PROVIDER_UNCONFIRMED/)).toBeInTheDocument();
  });
});

describe("dashboard", () => {
  it("shows switch states, open operations by status and top alerts", async () => {
    backend({
      "GET /api/v1/admin/runtime-controls": controls({ usdt_sends: false }),
      "GET /api/v1/admin/withdrawal-requests": queue(
        queueItem("pending_approval"),
        { ...queueItem("approved"), id: requestA },
        { ...queueItem("completed"), id: requestB },
      ),
      "GET /api/v1/admin/refund-requests": Response.json({
        data: [],
        meta: { has_more: false, next_cursor: null },
      }),
      "GET /api/v1/admin/operational-alerts": alerts,
      "GET /api/v1/admin/daily-reviews?day=2026-11-12": Response.json({
        data: {
          day: "2026-11-12",
          reviewed: false,
          reviewed_at: null,
          has_activity: true,
          environment: "test",
        },
      }),
    });
    render(
      <OperatorDashboard
        token="synthetic.aal2"
        verifyMfa={vi.fn()}
        now={new Date("2026-11-13T15:00:00Z")}
      />,
    );
    expect(
      await screen.findByText(/Ontem \(2026-11-12\): revisão pendente com atividade/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Envios de USDT: desligada/)).toBeInTheDocument();
    expect(screen.getByText(/Novas operações: ligada/)).toBeInTheDocument();
    expect(await screen.findByText("Aguardando aprovação: 1")).toBeInTheDocument();
    expect(screen.getByText("Aprovado: 1")).toBeInTheDocument();
    expect(screen.queryByText(/Enviado pelo provedor: /)).toBeNull();
    expect(await screen.findByText("Pix em aberto após encerramento")).toBeInTheDocument();
    expect(screen.getByText(/2026-11-12/)).toBeInTheDocument();
  });

  it("asks for a current TOTP when the switches read is MFA-stale, then reloads", async () => {
    const verifyMfa = vi.fn().mockResolvedValue("synthetic.fresh");
    let reads = 0;
    backend({
      "GET /api/v1/admin/runtime-controls": () => (++reads === 1 ? stale() : controls()),
      "GET /api/v1/admin/withdrawal-requests": queue(),
      "GET /api/v1/admin/refund-requests": Response.json({
        data: [],
        meta: { has_more: false, next_cursor: null },
      }),
      "GET /api/v1/admin/operational-alerts": alerts,
    });
    render(<OperatorDashboard token="synthetic.aal2" verifyMfa={verifyMfa} />);
    fireEvent.change(await screen.findByLabelText("Código do autenticador"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar MFA" }));
    expect(await screen.findByText(/Envios de USDT: ligada/)).toBeInTheDocument();
    expect(verifyMfa).toHaveBeenCalledWith("123456");
  });
});
