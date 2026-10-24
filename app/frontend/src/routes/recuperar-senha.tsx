import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { CustomerPublicLayout, CustomerNotice } from "@/components/peragus/customer-ui";
import { completePasswordRecovery, requestPasswordRecovery, useCustomerSession } from "@/lib/peragus/customer-session";
export const Route = createFileRoute("/recuperar-senha")({ component: PasswordRecoveryPage });
function PasswordRecoveryPage() {
  const { configured } = useCustomerSession();
  const [email,setEmail] = useState("");
  const [password,setPassword] = useState("");
  const [recoveryToken,setRecoveryToken] = useState<string | null>(null);
  const [message,setMessage] = useState("");
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  useEffect(() => {
    // Supabase's implicit recovery redirect exposes a short-lived access token in
    // the URL fragment. Remove it from browser history immediately; never persist.
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = fragment.get("access_token");
    if (fragment.get("type") === "recovery" && token && /^[A-Za-z0-9._-]+$/.test(token)) {
      setRecoveryToken(token);
    }
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      if (recoveryToken) {
        if (password.length < 8) throw new Error("A nova senha deve ter pelo menos 8 caracteres.");
        await completePasswordRecovery(recoveryToken,password);
        setRecoveryToken(null);
        setPassword("");
        setMessage("Senha atualizada. Agora você pode entrar na sua conta.");
      } else {
        await requestPasswordRecovery(email.trim());
        setMessage("Se existir uma conta para este e-mail, as instruções de recuperação serão enviadas.");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível concluir a solicitação."); }
    finally { setBusy(false); }
  }
  return <CustomerPublicLayout><div className="customer-auth-card">
    <span className="customer-eyebrow">SEGURANÇA DA CONTA</span>
    <h1>{recoveryToken ? "Defina uma nova senha." : "Recupere seu acesso."}</h1>
    <p>{recoveryToken ? "Sua solicitação foi reconhecida. Escolha uma senha forte." : "Enviaremos instruções ao seu e-mail cadastrado."}</p>
    {!configured && <CustomerNotice kind="warning">Recuperação indisponível: Supabase Auth não configurado neste ambiente.</CustomerNotice>}
    {error && <CustomerNotice kind="danger">{error}</CustomerNotice>}
    {message && <CustomerNotice>{message}</CustomerNotice>}
    <form onSubmit={e=>void submit(e)}>
      {recoveryToken ? <label className="customer-field">Nova senha<input type="password" required autoComplete="new-password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)}/></label>
       : <label className="customer-field">E-mail<input required type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>}
      <button type="submit" className="customer-button" disabled={!configured || busy} style={{width:"100%"}}>{busy ? "Processando…" : recoveryToken ? "Atualizar senha" : "Enviar instruções"}</button>
    </form>
    <p className="customer-muted" style={{marginTop:18}}>O link de recuperação deve redirecionar para /recuperar-senha, conforme as URLs autorizadas na configuração do Supabase Auth.</p>
    <Link className="customer-link" to="/login">Voltar ao login</Link>
  </div></CustomerPublicLayout>;
}
