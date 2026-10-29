import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Globe2,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { PeragusBrand } from "@/components/peragus/customer-ui";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import "@/public-home.css";
export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Peragus — Uma nova conexão com o seu dinheiro" },
      {
        name: "description",
        content:
          "Conheça a Peragus. Stablecoins e pagamentos para conectar pessoas e negócios na América Latina. Acesso ao piloto por convite.",
      },
    ],
  }),
  component: PublicHome,
});
export function PublicHome() {
  const { status } = useCustomerSession();
  return (
    <div className="peragus-home">
      <a className="peragus-skip" href="#principal">
        Ir para o conteúdo
      </a>
      <header className="public-nav">
        <Link to="/" aria-label="Peragus — início">
          <PeragusBrand />
        </Link>
        <nav aria-label="Navegação principal">
          <a href="#como-funciona">Como funciona</a>
          <a href="#para-empresas">Para empresas</a>
          <a href="#duvidas">Dúvidas</a>
        </nav>
        <div className="public-nav-actions">
          <Link to="/login" className="public-login">
            Entrar
          </Link>
          <Link to={status === "authenticated" ? "/app" : "/cadastro"} className="public-button">
            {status === "authenticated" ? "Minha conta" : "Tenho um convite"}
            <ArrowUpRight size={16} />
          </Link>
        </div>
      </header>
      <main id="principal">
        <section className="public-hero">
          <img
            src="/peragus-life.webp"
            alt="Empreendedora usando o celular em seu café"
            width="1672"
            height="941"
            fetchPriority="high"
          />
          <div className="public-hero-shade" />
          <div className="public-hero-content">
            <span className="public-eyebrow">FEITA PARA CONECTAR</span>
            <h1>
              Seu dinheiro.
              <br />
              Novas possibilidades.
              <br />
              <em>Menos fronteiras.</em>
            </h1>
            <p>
              Uma experiência mais simples para conectar reais, stablecoins e negócios na América
              Latina.
            </p>
            <Link to="/login" className="public-button">
              Acessar minha conta <ArrowRight size={19} />
            </Link>
            <a href="#como-funciona" className="public-hero-more">
              Conheça a Peragus <ChevronDown size={16} />
            </a>
            <span className="public-pilot-note">
              Piloto fechado em ambiente de testes. Operações reais ainda não disponíveis.
            </span>
          </div>
        </section>
        <section className="public-section" id="como-funciona">
          <div className="public-section-heading">
            <span className="public-eyebrow">SIMPLES EM CADA ETAPA</span>
            <h2>
              Do primeiro acesso
              <br />
              ao acompanhamento.
            </h2>
            <p>Informações claras para você saber onde está e qual é o próximo passo.</p>
          </div>
          <div className="public-feature-grid">
            {[
              {
                icon: ShieldCheck,
                title: "Sua conta, seu acesso",
                text: "Entre com sua conta e acompanhe seu cadastro e as verificações de identidade.",
              },
              {
                icon: Wallet,
                title: "Uma compra por etapas",
                text: "Consulte uma estimativa e registre sua intenção de compra no piloto sandbox.",
              },
              {
                icon: Globe2,
                title: "Tudo no seu histórico",
                text: "Consulte seus registros e diferencie uma estimativa de uma conversão ou entrega confirmada.",
              },
            ].map(({ icon: Icon, title, text }, i) => (
              <article key={title}>
                <span className="public-feature-icon">
                  <Icon size={23} />
                </span>
                <small>0{i + 1}</small>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="public-business public-section" id="para-empresas">
          <div>
            <span className="public-eyebrow">PERAGUS PARA NEGÓCIOS</span>
            <h2>
              Conexões que vão
              <br />
              além das fronteiras.
            </h2>
            <p>
              Estamos construindo infraestrutura de pagamentos com stablecoins para aproximar
              empresas, plataformas e clientes na América Latina.
            </p>
            <ul>
              <li>
                <Check size={17} /> Foco em pagamentos transfronteiriços
              </li>
              <li>
                <Check size={17} /> Acompanhamento das etapas da operação
              </li>
              <li>
                <Check size={17} /> Integração entre moeda local e ativos digitais
              </li>
            </ul>
          </div>
          <div className="public-business-card">
            <span>BRASIL ↔ AMÉRICA LATINA</span>
            <Globe2 size={120} strokeWidth={0.8} />
            <h3>
              Uma região.
              <br />
              Muitas possibilidades.
            </h3>
            <p>
              Produto em desenvolvimento. Funcionalidades e disponibilidade sujeitas às condições do
              piloto.
            </p>
          </div>
        </section>
        <section className="public-section public-faq" id="duvidas">
          <div className="public-section-heading">
            <span className="public-eyebrow">ANTES DE COMEÇAR</span>
            <h2>
              Suas dúvidas,
              <br />
              com clareza.
            </h2>
          </div>
          <div>
            {[
              [
                "Como acesso minha conta?",
                "Use o botão Entrar no topo da página. Se você já participa do piloto, utilize seu e-mail e senha cadastrados.",
              ],
              [
                "Posso criar uma conta agora?",
                "O piloto é fechado e o cadastro depende de convite e da disponibilidade de adesão. A página de cadastro informa a situação atual.",
              ],
              [
                "As operações deste ambiente movimentam dinheiro real?",
                "Não. O ambiente atual é de testes. Uma cotação indicativa ou intenção registrada não representa pagamento, conversão concluída ou entrega na carteira.",
              ],
              [
                "O valor estimado é o valor final?",
                "Não. A estimativa pode variar. Taxas e valores líquidos só são apresentados quando informados e confirmados pelo serviço responsável.",
              ],
            ].map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <ChevronDown size={18} />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="public-end">
          <span className="public-eyebrow">SEU PRÓXIMO PASSO</span>
          <h2>Já faz parte do piloto?</h2>
          <p>Acesse sua conta e acompanhe suas operações.</p>
          <Link to="/login" className="public-button">
            Entrar na Peragus <ArrowRight size={18} />
          </Link>
        </section>
      </main>
      <footer className="public-footer">
        <PeragusBrand />
        <p>Infraestrutura para uma América Latina mais conectada.</p>
        <Link to="/login">Entrar</Link>
        <Link to="/cadastro">Acesso por convite</Link>
        <small>© {new Date().getFullYear()} Peragus. Piloto em ambiente de testes.</small>
      </footer>
    </div>
  );
}
