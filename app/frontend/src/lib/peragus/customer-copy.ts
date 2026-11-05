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
