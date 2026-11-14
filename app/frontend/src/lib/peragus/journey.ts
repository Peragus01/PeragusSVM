import { notifyLegalRequired } from "./legal-acceptance";
export class JourneyError extends Error {
  constructor(
    public code: string,
    public fields: string[] = [],
  ) {
    super(code);
  }
}
export async function journeyRequest<T = Record<string, unknown>>(
  token: string | null,
  path: string,
  method = "GET",
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      ...(signal ? { signal } : {}),
      ...(body !== undefined
        ? {
            headers: {
              Accept: "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          }
        : {}),
    });
  } catch {
    throw new JourneyError("OUTCOME_UNKNOWN");
  }
  const value = await response.json();
  if (!response.ok) {
    notifyLegalRequired(value?.error?.code);
    throw new JourneyError(
      typeof value?.error?.code === "string" ? value.error.code : "UNAVAILABLE",
      Array.isArray(value?.error?.fields)
        ? value.error.fields
            .filter(
              (field: unknown): field is string =>
                typeof field === "string" && /^[a-z_]+(?:\.[a-z_]+)*$/.test(field),
            )
            .slice(0, 32)
        : [],
    );
  }
  return value.data as T;
}
/** A runtime kill switch is off (HTTP 503 OPERATIONS_PAUSED): nothing was created or moved. */
export const OPERATIONS_PAUSED_MESSAGE =
  "Operações temporariamente pausadas. Nada foi registrado; tente novamente mais tarde.";
/** The previous day's operator review is pending (HTTP 503 DAILY_REVIEW_REQUIRED): nothing was created. */
export const DAILY_REVIEW_REQUIRED_MESSAGE =
  "Operações temporariamente indisponíveis enquanto concluímos a revisão diária. Nada foi registrado; tente novamente mais tarde.";
/** Customer copy for a new-operation refusal that created nothing, or null for other codes. */
export const pausedMessage = (code: unknown) =>
  code === "OPERATIONS_PAUSED"
    ? OPERATIONS_PAUSED_MESSAGE
    : code === "DAILY_REVIEW_REQUIRED"
      ? DAILY_REVIEW_REQUIRED_MESSAGE
      : null;
export function journeyMessage(error: unknown) {
  const code = error instanceof JourneyError ? error.code : "UNAVAILABLE";
  return (
    (
      {
        PILOT_INVITE_NOT_AVAILABLE:
          "Convite inválido, expirado, revogado ou vinculado a outro e-mail.",
        PILOT_INVITE_RATE_LIMITED:
          "Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.",
        PILOT_INVITE_ALREADY_REDEEMED: "Este convite já foi utilizado. Entre na sua conta.",
        PILOT_INVITES_DISABLED: "O cadastro por convite está temporariamente indisponível.",
        PILOT_EMAIL_INVITES_DISABLED:
          "A emissão de convites para novos cadastros ainda não foi configurada.",
        PILOT_INVITES_UNAVAILABLE: "O serviço de convites está indisponível.",
        VALIDATION_ERROR: "Confira os campos informados.",
        OPERATIONS_PAUSED: OPERATIONS_PAUSED_MESSAGE,
        DAILY_REVIEW_REQUIRED: DAILY_REVIEW_REQUIRED_MESSAGE,
        PROFILE_VERSION_CONFLICT:
          "Os dados mudaram em outra sessão. Atualize a página antes de salvar.",
        VERIFICATION_SESSION_UNAVAILABLE:
          "A sessão de verificação de identidade está indisponível no momento. Tente novamente em alguns minutos.",
        OUTCOME_UNKNOWN:
          "Não foi possível confirmar o resultado. Consulte o estado antes de tentar novamente.",
      } as Record<string, string>
    )[code] ?? `Não foi possível concluir esta etapa (${code}). Consulte o estado antes de repetir.`
  );
}
