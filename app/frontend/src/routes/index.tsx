import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Banknote,
  Building2,
  Coins,
  Globe2,
  Layers3,
  Menu,
  Network,
  Route as RouteIcon,
  Wallet,
  X,
} from "lucide-react";
import { BookingLink } from "@/components/institutional/booking";
import { LeadForm } from "@/components/institutional/lead-form";
import { useCustomerSession } from "@/lib/peragus/customer-session";
import "@/public-home.css";

const canonical = "https://www.peragus.com.br/";
const title = "Peragus | Infrastructure for a Borderless Economy";
const description =
  "Peragus connects currencies, markets, and financial infrastructure through cross-border payments, stablecoin settlement, and liquidity connectivity.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: canonical },
      { property: "og:image", content: `${canonical}logo-peragus.png` },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: `${canonical}logo-peragus.png` },
    ],
    links: [{ rel: "canonical", href: canonical }],
  }),
  component: PublicHome,
});

const navigation = [
  ["Company", "#company"],
  ["Infrastructure", "#infrastructure"],
  ["How It Works", "#how-it-works"],
  ["Roadmap", "#roadmap"],
  ["Partnerships", "#partnerships"],
];

const capabilities = [
  {
    name: "Cross-Border Payments",
    icon: Globe2,
    text: "Connect local payment methods with international settlement flows as supported corridors are enabled.",
  },
  {
    name: "Stablecoin Settlement",
    icon: Coins,
    text: "Use stablecoins as a settlement component, with Solana as the initial blockchain integration.",
  },
  {
    name: "Liquidity Connectivity",
    icon: Network,
    text: "Connect payment flows to liquidity providers for conversion and settlement on eligible routes.",
  },
  {
    name: "Payment Infrastructure",
    icon: Layers3,
    text: "Integrate payment initiation, provider routing and settlement tracking into your product workflow.",
  },
  {
    name: "Multi-Network Connectivity",
    icon: RouteIcon,
    text: "Extend routing across blockchain networks as network and liquidity integrations become available.",
    strategy: true,
  },
];

const steps = [
  {
    icon: Banknote,
    name: "Payment Origin",
    text: "A business initiates payment in the origin market.",
  },
  {
    icon: Layers3,
    name: "Peragus Infrastructure",
    text: "Peragus connects the instruction to the payment workflow.",
  },
  {
    icon: RouteIcon,
    name: "Conversion & Routing",
    text: "Connected providers handle conversion and routing as required.",
  },
  {
    icon: Wallet,
    name: "Destination Settlement",
    text: "The selected rail settles the payment at its destination.",
  },
];

const audiences = [
  ["Fintechs", "Integrate cross-border payments and settlement into financial products."],
  ["Payment Service Providers", "Connect payment systems to new markets and financial providers."],
  ["Financial Institutions", "Explore collaboration on payment infrastructure and settlement."],
  [
    "International Businesses",
    "Discuss payment flows for suppliers and operations across markets.",
  ],
  [
    "Merchants & Payment Platforms",
    "Explore ways to accept payments from customers in other markets.",
  ],
  ["Liquidity Providers", "Connect conversion and settlement services to payment workflows."],
  ["Technology Partners", "Build integrations across financial platforms and blockchain networks."],
];

const roadmap = [
  ["January 2027", "Pix NFC", "Implementation of Pix NFC payment acceptance."],
  [
    "April 2027",
    "Digital Asset Development",
    "Development of a proprietary Peragus token and a Paraguayan guaraní token.",
  ],
  ["July 2027", "POS Development", "Completion of Point of Sale development."],
  ["October 2027", "Business Expansion", "Team expansion and a target of 100 clients."],
  [
    "December 2027",
    "International Expansion",
    "Relocation of company headquarters to the United States and a target of 300 clients.",
  ],
];

function Brand() {
  return (
    <Link to="/" className="ih-brand">
      <img src="/peragus-institutional-mark.webp" width="42" height="30" alt="" />
      <span>PERAGUS</span>
    </Link>
  );
}

function AccountLinks() {
  const { status } = useCustomerSession();
  return status === "authenticated" ? (
    <Link to="/app">Client Account</Link>
  ) : (
    <>
      <Link to="/login">Client Login</Link>
      <Link to="/cadastro">Create Account</Link>
    </>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  return (
    <header className="ih-header">
      <div className="ih-wrap ih-header-inner">
        <Brand />
        <button
          type="button"
          className="ih-menu"
          aria-expanded={open}
          aria-controls="ih-navigation"
          aria-label={open ? "Close navigation" : "Open navigation"}
          onClick={() => setOpen(!open)}
        >
          {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
        <nav
          id="ih-navigation"
          aria-label="Main navigation"
          className={open ? "ih-nav is-open" : "ih-nav"}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              setOpen(false);
              event.currentTarget.parentElement?.querySelector("button")?.focus();
            }
          }}
        >
          <div className="ih-nav-links">
            {navigation.map(([label, href]) => (
              <a key={href} href={href} onClick={() => setOpen(false)}>
                {label}
              </a>
            ))}
          </div>
          <div className="ih-nav-actions">
            <AccountLinks />
            <BookingLink />
          </div>
        </nav>
      </div>
    </header>
  );
}

function NetworkArtwork() {
  return (
    <svg className="ih-art" viewBox="0 0 600 480" fill="none" aria-hidden="true">
      <defs>
        <pattern id="ih-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#6c91c7" opacity=".35" />
        </pattern>
        <radialGradient id="ih-glow">
          <stop stopColor="#284eaa" stopOpacity=".57" />
          <stop offset="1" stopColor="#0b1426" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ih-route">
          <stop stopColor="#4a6ba3" />
          <stop offset=".55" stopColor="#b9d2ff" />
          <stop offset="1" stopColor="#5688f0" />
        </linearGradient>
      </defs>
      <rect width="600" height="480" fill="url(#ih-glow)" />
      <rect x="20" y="20" width="560" height="440" rx="20" fill="url(#ih-grid)" />
      <g stroke="#34517d">
        <circle cx="300" cy="240" r="170" />
        <circle cx="300" cy="240" r="135" strokeDasharray="3 7" />
        <ellipse cx="300" cy="240" rx="78" ry="170" />
        <ellipse cx="300" cy="240" rx="170" ry="68" />
        <path d="M130 240h340M300 70v340" />
      </g>
      <g stroke="url(#ih-route)" strokeWidth="1.7">
        <path d="M78 144h68c79 0 65 96 154 96s72-98 152-98h70" />
        <path d="M78 348h78c65 0 62-108 144-108s67 108 154 108h68" />
        <path
          className="ih-art-signal"
          d="M78 144h68c79 0 65 96 154 96s72-98 152-98h70"
          strokeDasharray="15 600"
          stroke="#e3eeff"
          strokeWidth="3"
        />
      </g>
      <g fill="#101e37" stroke="#85aaff">
        <circle cx="78" cy="144" r="7" />
        <circle cx="78" cy="348" r="7" />
        <circle cx="522" cy="142" r="7" />
        <circle cx="522" cy="348" r="7" />
        <rect x="274" y="214" width="52" height="52" rx="11" transform="rotate(45 300 240)" />
      </g>
      <path d="m286 241 10 10 18-21" stroke="#dce9ff" strokeWidth="2.5" />
      <g fill="#bbcdee" fontSize="13" fontFamily="inherit">
        <text x="65" y="122">
          Local payments
        </text>
        <text x="65" y="375">
          Liquidity providers
        </text>
        <text x="535" y="120" textAnchor="end">
          Blockchain networks
        </text>
        <text x="535" y="375" textAnchor="end">
          Settlement rails
        </text>
      </g>
    </svg>
  );
}

export function PublicHome() {
  return (
    <div className="peragus-institutional" lang="en">
      <a className="ih-skip" href="#main-content">
        Skip to content
      </a>
      <Header />
      <main id="main-content">
        <section className="ih-hero">
          <div className="ih-wrap ih-hero-grid">
            <div className="ih-hero-content">
              <p className="ih-kicker">Cross-border payment infrastructure</p>
              <h1>The infrastructure for a borderless economy.</h1>
              <p className="ih-lead">
                Connecting currencies, markets, and opportunities through a more seamless financial
                infrastructure.
              </p>
              <div className="ih-actions">
                <BookingLink />
                <a href="#infrastructure" className="ih-button ih-secondary">
                  Explore Our Infrastructure <ArrowDown size={16} aria-hidden="true" />
                </a>
              </div>
            </div>
            <NetworkArtwork />
          </div>
        </section>

        <section id="company" className="ih-section ih-wrap ih-split">
          <div>
            <p className="ih-kicker">Who We Are</p>
            <h2>The world moves across borders. Payments should too.</h2>
          </div>
          <div className="ih-prose">
            <p>
              International payments often require businesses to coordinate local payment methods,
              currency conversion and settlement across separate providers. Each handoff adds work
              for the teams that route payments and track delivery.
            </p>
            <p>
              Peragus builds B2B infrastructure that connects local payment rails, liquidity
              providers, stablecoins and blockchain settlement in one workflow. We work with
              businesses and partners to define the payment routes and integrations their operations
              require.
            </p>
          </div>
        </section>

        <section id="infrastructure" className="ih-section ih-band">
          <div className="ih-wrap">
            <p className="ih-kicker">Our Infrastructure</p>
            <h2>Connect the systems that move money.</h2>
            <p className="ih-lead">
              Commercial availability depends on the corridor, providers and integrations involved.
            </p>
            <div className="ih-capabilities">
              {capabilities.map(({ name, icon: Icon, text, strategy }) => (
                <article key={name}>
                  <Icon aria-hidden="true" />
                  {strategy && <span className="ih-stage">Strategic direction</span>}
                  <h3>{name}</h3>
                  <p>{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="ih-section ih-wrap">
          <p className="ih-kicker">How It Works</p>
          <h2>From payment origin to settlement.</h2>
          <p className="ih-lead">A conceptual flow for a cross-border payment.</p>
          <ol className="ih-flow">
            {steps.map(({ icon: Icon, name, text }) => (
              <li key={name}>
                <Icon aria-hidden="true" />
                <h3>{name}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="who-we-serve" className="ih-section ih-band">
          <div className="ih-wrap ih-split">
            <div>
              <p className="ih-kicker">Who We Serve</p>
              <h2>Built for businesses that move money across markets.</h2>
            </div>
            <dl className="ih-audiences">
              {audiences.map(([name, text]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="roadmap" className="ih-section ih-wrap">
          <p className="ih-kicker">Roadmap 2027</p>
          <h2>Building the future of global payments.</h2>
          <p className="ih-lead">Our vision and strategic milestones for 2027.</p>
          <ol className="ih-timeline">
            {roadmap.map(([date, name, text]) => (
              <li key={date}>
                <p className="ih-date">{date}</p>
                <h3>{name}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
          <p className="ih-roadmap-note">
            These milestones represent Peragus’s strategic plans and targets for 2027.
          </p>
        </section>

        <section id="partnerships" className="ih-section ih-band">
          <div className="ih-wrap ih-split">
            <div>
              <p className="ih-kicker">Partnerships</p>
              <h2>Let's build the future of financial infrastructure together.</h2>
            </div>
            <div className="ih-prose">
              <Building2 aria-hidden="true" />
              <p>
                We welcome conversations with liquidity providers, fintechs, financial institutions,
                payment companies, technology integration partners, blockchain networks and
                financial infrastructure providers.
              </p>
              <div className="ih-actions">
                <a href="#commercial-inquiry" className="ih-button">
                  Become a Partner <ArrowRight size={17} aria-hidden="true" />
                </a>
                <BookingLink secondary />
              </div>
            </div>
          </div>
        </section>

        <section id="commercial-inquiry" className="ih-section ih-conversion">
          <div className="ih-wrap ih-split">
            <div>
              <p className="ih-kicker">Contact</p>
              <h2>Let's build a borderless economy together.</h2>
              <p className="ih-lead">
                Looking for cross-border payment infrastructure or exploring a strategic
                partnership? Let's discuss how Peragus can connect with your business.
              </p>
              <p>Book a 30-minute meeting with the founder of Peragus.</p>
              <BookingLink />
            </div>
            <LeadForm />
          </div>
        </section>
      </main>

      <footer className="ih-footer">
        <div className="ih-wrap">
          <div className="ih-footer-grid">
            <div>
              <Brand />
              <p>Financial infrastructure for cross-border payments, liquidity and settlement.</p>
            </div>
            <nav aria-label="Company links">
              {navigation.map(([label, href]) => (
                <a href={href} key={href}>
                  {label}
                </a>
              ))}
            </nav>
            <nav aria-label="Client links">
              <AccountLinks />
              <a href="mailto:contato@peragus.com.br">
                contato@peragus.com.br <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            </nav>
            <nav aria-label="Legal links">
              <a href="/legal/termos-de-uso.html">Terms of Use</a>
              <a href="/legal/politica-de-privacidade.html">Privacy Policy</a>
              <a href="/legal/politica-de-reembolso.html">Refund Policy</a>
            </nav>
          </div>
          <p className="ih-copyright">© {new Date().getUTCFullYear()} Peragus LTDA · Brazil</p>
        </div>
      </footer>
    </div>
  );
}
