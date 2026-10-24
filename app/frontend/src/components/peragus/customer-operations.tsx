import { useEffect, useState } from "react";
import { getCustomerOperations, type CustomerOperation, type CustomerOperationsPage } from "@/lib/peragus/customer-reads";
import { useCustomerSession } from "@/lib/peragus/customer-session";

export function useOperations(limit = 20) {
  const { accessToken, identity } = useCustomerSession();
  const [data, setData] = useState<CustomerOperationsPage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  useEffect(() => { setCursor(undefined); setData(null); setState("loading"); }, [identity?.user.id]);
  useEffect(() => {
    if (!accessToken) { setData(null); setState("error"); setError("Sessão indisponível."); return; }
    const controller = new AbortController();
    setState("loading"); setError("");
    getCustomerOperations(accessToken,{limit,cursor,signal:controller.signal})
      .then(page => {
        if (controller.signal.aborted) return;
        setData(current => cursor && current ? {data:[...current.data,...page.data],meta:page.meta} : page);
        setState("ready");
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setError(err && typeof err === "object" && "httpStatus" in err && err.httpStatus === 401
          ? "Sessão inválida. Entre novamente."
          : "Não foi possível consultar seu histórico. Tente novamente.");
        setState("error");
      });
    return () => controller.abort();
  }, [accessToken, cursor, limit, identity?.user.id, revision]);
  return {data, state, error, more: () => { if (data?.meta.next_cursor) setCursor(data.meta.next_cursor); },
    retry: () => setRevision(value => value + 1)};
}
export function formatAmount(amount: string | null | undefined, currency: "BRL" | "USDT") {
  if (amount == null || amount.trim() === "") return "Não informado";
  const number = Number(amount);
  if (!Number.isFinite(number)) return "Não informado";
  if (currency === "BRL") return new Intl.NumberFormat("pt-BR", {style:"currency",currency:"BRL"}).format(number);
  return number.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:6}) + " USDT";
}
export function operationLabel(operation: CustomerOperation) {
  if (operation.onchain_delivery_verified && operation.mainnet_execution) return "Entrega verificada";
  if (operation.withdrawal?.provider_completed) return "Provedor finalizado · entrega não verificada";
  if (operation.withdrawal?.recovery_required) return "Requer análise";
  if (operation.stage === "withdrawal") return "Retirada em processamento";
  if (operation.stage === "pix") return "Pix / conversão em acompanhamento";
  return "Registro de compra";
}
export function statusStyle(operation: CustomerOperation) {
  return operation.withdrawal?.recovery_required ? "customer-chip-danger" : operation.onchain_delivery_verified && operation.mainnet_execution ? "customer-chip-green" : "customer-chip-warning";
}
export function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Data indisponível" : date.toLocaleString("pt-BR", {dateStyle:"short",timeStyle:"short"});
}
