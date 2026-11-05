import { useEffect, useRef, useState } from "react";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import { journeyRequest, journeyMessage } from "@/lib/peragus/journey";
import { CustomerNotice } from "./customer-ui";
export function CustomerProfileEditor() {
  const session = useCustomerSession();
  const current = session.identity?.customer?.display_name ?? "";
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    lock.current = false;
    setBusy(false);
    setName(current);
    setSaved(false);
    setError("");
    return () => {
      epoch.current++;
    };
    // Auth generations invalidate pending requests; a nickname reload does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.identity?.user.id, session.accessToken]);
  useEffect(() => {
    setName(current);
  }, [current]);
  async function save() {
    if (lock.current || !session.accessToken) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    const turn = epoch.current;
    try {
      await journeyRequest(session.accessToken, "v1/me/customer", "PATCH", {
        display_name: name.trim(),
        expected_display_name: current,
      });
      if (epoch.current !== turn) return;
      await session.reloadIdentity();
      if (epoch.current === turn) setSaved(true);
    } catch (e) {
      if (epoch.current === turn) setError(journeyMessage(e));
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      aria-busy={busy}
    >
      <label className="customer-field">
        Nome de exibição
        <input
          value={name}
          required
          minLength={2}
          maxLength={160}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <p className="customer-muted">
        Este é o nome mostrado na sua conta. Não altera seu nome legal, CPF ou dados verificados
        pela OZAV.
      </p>
      <button className="customer-button" type="submit" disabled={busy || name.trim() === current}>
        {busy ? "Salvando…" : "Salvar alterações"}
      </button>
      {error && (
        <div role="alert">
          <CustomerNotice kind="warning">{error}</CustomerNotice>
        </div>
      )}
      {saved && <CustomerNotice>Nome de exibição atualizado.</CustomerNotice>}
      <p className="customer-muted">
        E-mail e dados de identidade ficam protegidos contra edição direta. Alterações desses dados
        exigem confirmação ou nova análise.
      </p>
    </form>
  );
}
