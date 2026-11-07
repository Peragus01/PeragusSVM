import { Check, Clock3 } from "lucide-react";
export function PurchaseTimeline({
  paymentConfirmed,
  deliveryVerified,
  mainnetExecution,
  testEnvironment,
}: {
  paymentConfirmed: boolean;
  deliveryVerified: boolean;
  mainnetExecution: boolean;
  testEnvironment: boolean;
}) {
  const delivered = deliveryVerified && mainnetExecution && !testEnvironment;
  const steps = [
    { label: testEnvironment ? "Registro de teste" : "Compra registrada", done: true },
    {
      label: paymentConfirmed
        ? testEnvironment
          ? "Pagamento confirmado em teste"
          : "Pagamento confirmado"
        : "Pagamento não confirmado",
      done: paymentConfirmed,
    },
    { label: delivered ? "USDT entregue" : "Entrega não confirmada", done: delivered },
  ];
  return (
    <ol className="premium-delivery-timeline" aria-label="Acompanhamento da compra">
      {steps.map(({ label, done }) => (
        <li key={label} className={done ? "confirmed" : ""}>
          {done ? <Check size={18} /> : <Clock3 size={18} />}
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}
