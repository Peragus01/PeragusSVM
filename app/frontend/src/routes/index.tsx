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
import { useReveal } from "@/components/peragus/motion";
export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Peragus — Reais em USDT, com clareza em cada etapa" },
      {
        name: "description",
        content:
          "Conheça a experiência Peragus para comprar USDT em reais e acompanhar a entrega na sua carteira Solana. Acesso atual em ambiente de testes.",
      },
    ],
  }),
  component: PublicHome,
});
export function PublicHome() {
  useReveal();
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
            <span className="public-eyebrow">REAIS → USDT · SOLANA</span>
            <h1>
              Seu próximo passo.
              <br />
              Em reais.
              <br />
              <em>Sem fronteiras.</em>
            </h1>
            <p>
              Reais para começar. USDT para ir além. Uma experiência de compra com valores claros e
              acompanhamento até sua carteira Solana.
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
          <div className="public-conversion-visual" aria-label="Jornada de compra de USDT">
            <div className="public-conversion-top">
              <span>UMA CONEXÃO. MAIS POSSIBILIDADES.</span>
              <span>↗</span>
            </div>
            <div className="public-asset">
              <span className="asset-icon brl-icon">R$</span>
              <div>
                <small>Você paga</small>
                <strong>Real brasileiro</strong>
              </div>
              <b>BRL</b>
            </div>
            <div className="public-conversion-arrow">↓</div>
            <div className="public-asset">
              <span className="asset-icon usdt-icon">₮</span>
              <div>
                <small>Você recebe</small>
                <strong>Tether USD</strong>
              </div>
              <b>USDT</b>
            </div>
            <div className="public-conversion-foot">
              <span>Solana</span>
              <span>Na sua carteira</span>
            </div>
            <p>
              Jornada planejada: cotação → revisão → Pix → entrega.
              <br />
              No ambiente atual, apenas estimativa e registro de teste.
            </p>
          </div>
        </section>
        <section className="public-section" id="como-funciona">
          <div className="public-section-heading">
            <span className="public-eyebrow">SIMPLES EM CADA ETAPA</span>
            <h2>
              Da cotação
              <br />à sua carteira.
            </h2>
            <p>Informações claras para você saber onde está e qual é o próximo passo.</p>
          </div>
          <div className="public-feature-grid">
            {[
              {
                icon: ShieldCheck,
                title: "Confira quanto recebe",
                text: "Informe o valor em reais e consulte a estimativa de USDT, com os custos disponíveis antes de avançar.",
              },
              {
                icon: Wallet,
                title: "Revise antes de pagar",
                text: "Confira a carteira de destino e os detalhes. O Pix só fica disponível quando o pagamento estiver habilitado.",
              },
              {
                icon: Globe2,
                title: "Acompanhe cada etapa",
                text: "Do pagamento à entrega, acompanhe as confirmações disponíveis no seu histórico. Sem confundir estimativa com USDT recebido.",
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
              Reais na origem. USDT na rede Solana. Cada etapa visível, da cotação à confirmação
              disponível.
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
                "Não. O ambiente atual é de testes. Uma cotação indicativa ou registro de teste não representa pagamento, conversão concluída ou entrega na carteira.",
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
