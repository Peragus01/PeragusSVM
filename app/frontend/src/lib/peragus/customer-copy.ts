import type { MoneyMode } from "./config";

export function profileLabel(value: string | undefined) {
  return (
    (
      {
        draft: "Em preenchimento",
        pending: "Em análise",
        submitted: "Enviado para análise",
        in_review: "Em análise",
        action_required: "Ação necessária",
        approved: "Aprovado",
        rejected: "Não aprovado",
      } as Record<string, string>
    )[value ?? ""] ?? "Consultar cadastro"
  );
}

/** Test-environment notices exist only in test mode; live shows none of them. */
export function environmentNotice(mode: MoneyMode): string | null {
  return mode === "test" ? "Ambiente de testes · sem dinheiro real" : null;
}
export function environmentFooterNotice(mode: MoneyMode): string | null {
  return mode === "test" ? "Ambiente de testes · sem operações reais" : null;
}
export function pilotStoryNote(mode: MoneyMode): string {
  return mode === "test" ? "Piloto fechado · ambiente de testes" : "Piloto fechado";
}
export function walletNetworkNotice(mode: MoneyMode): string {
  return mode === "test"
    ? "Rede de testes Solana Devnet. A assinatura comprova controle do endereço e não autoriza pagamentos. Um endereço já vinculado não é substituído por esta tela."
    : "Rede Solana. A assinatura comprova controle do endereço e não autoriza pagamentos. Um endereço já vinculado não é substituído por esta tela.";
}
