export class JourneyError extends Error {
  constructor(public code: string) {
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
  if (!response.ok)
    throw new JourneyError(
      typeof value?.error?.code === "string" ? value.error.code : "UNAVAILABLE",
    );
  return value.data as T;
}
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
        PROFILE_VERSION_CONFLICT:
          "Os dados mudaram em outra sessão. Atualize a página antes de salvar.",
        OUTCOME_UNKNOWN:
          "Não foi possível confirmar o resultado. Consulte o estado antes de tentar novamente.",
      } as Record<string, string>
    )[code] ?? `Não foi possível concluir esta etapa (${code}). Consulte o estado antes de repetir.`
  );
}
