import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { CustomerPublicLayout, CustomerNotice } from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
export const Route = createFileRoute("/login")({ component: LoginPage });
function LoginPage() {
  const session = useCustomerSession();
  const navigate = useNavigate();
  const [email,setEmail] = useState("");
  const [password,setPassword] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    try { await session.login(email.trim(),password); await navigate({to:"/app"}); }
    catch (e) { setError(e instanceof Error ? e.message : "Não foi possível entrar."); }
    finally { setBusy(false); }
  }
  return <CustomerPublicLayout><div className="customer-auth-card">
    <span className="customer-eyebrow">ACESSO À PERAGUS</span>
    <h1>Entre na sua conta.</h1>
    <p>Acompanhe suas operações e verifique sua identidade com segurança.</p>
    {!session.configured && <CustomerNotice kind="warning">Supabase Auth não configurado neste ambiente. Configure apenas VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY públicos no frontend. Não use service_role.</CustomerNotice>}
    {error && <CustomerNotice kind="danger">{error}</CustomerNotice>}
    <form onSubmit={e=>void submit(e)}>
      <label className="customer-field">E-mail<input required autoComplete="username" type="email" value={email} onChange={e=>setEmail(e.target.value)} /></label>
      <label className="customer-field">Senha<input required autoComplete="current-password" type="password" value={password} onChange={e=>setPassword(e.target.value)} /></label>
      <button className="customer-button" style={{width:"100%"}} disabled={!session.configured || busy} type="submit">{busy ? "Validando identidade…" : "Entrar na Peragus"}</button>
    </form>
    <div className="customer-row"><Link className="customer-link" to="/recuperar-senha">Esqueci minha senha</Link><Link className="customer-link" to="/cadastro">Tenho um convite</Link></div>
    <p className="customer-muted" style={{marginTop:14}}>Por segurança, a sessão é mantida somente na memória. Recarregar a página exige novo login.</p>
  </div></CustomerPublicLayout>;
}
