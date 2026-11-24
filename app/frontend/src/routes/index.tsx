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
import {
  HomeLocaleContext,
  homeLocale,
  homeLocales,
  translateHome,
  useHomeTranslation,
  type HomeLocale,
} from "@/components/institutional/home-locales";
import "@/public-home.css";

const canonical = "https://www.peragus.com.br/";
const title = "Peragus | Infrastructure for a Borderless Economy";
const description =
  "Peragus connects currencies, markets, and financial infrastructure through cross-border payments, stablecoin settlement, and liquidity connectivity.";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { lang?: HomeLocale } => ({
    lang: homeLocale(search["lang"]),
  }),
  loaderDeps: ({ search }) => ({ lang: search.lang }),
  loader: ({ deps }) => deps,
  head: ({ loaderData }) => {
    const locale = loaderData?.lang ?? "en";
    const pageTitle = translateHome(locale, title);
    const pageDescription = translateHome(locale, description);
    const pageUrl = localizedUrl(locale);
    return {
      meta: [
        { title: pageTitle },
        { name: "description", content: pageDescription },
        { property: "og:title", content: pageTitle },
        { property: "og:description", content: pageDescription },
        { property: "og:url", content: pageUrl },
        { property: "og:image", content: `${canonical}logo-peragus.png` },
        { name: "twitter:card", content: "summary" },
        { name: "twitter:title", content: pageTitle },
        { name: "twitter:description", content: pageDescription },
        { name: "twitter:image", content: `${canonical}logo-peragus.png` },
      ],
      links: [
        { rel: "canonical", href: pageUrl },
        ...homeLocales.map((lang) => ({
          rel: "alternate",
          hrefLang: lang,
          href: localizedUrl(lang),
        })),
        { rel: "alternate", hrefLang: "x-default", href: canonical },
      ],
    };
  },
  component: LocalizedHome,
});

function homePath(locale: HomeLocale) {
  return locale === "en" ? "/" : `/?lang=${locale}`;
}

function localizedUrl(locale: HomeLocale) {
  return new URL(homePath(locale), canonical).href;
}

function LocalizedHome() {
  return <PublicHome locale={Route.useSearch().lang ?? "en"} />;
}

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

function Brand({ locale }: { locale: HomeLocale }) {
  return (
    <a href={homePath(locale)} className="ih-brand">
      <img src="/peragus-institutional-mark.webp" width="42" height="30" alt="" />
      <span>PERAGUS</span>
    </a>
  );
}

function AccountLinks() {
  const t = useHomeTranslation();
  const { status } = useCustomerSession();
  return status === "authenticated" ? (
    <Link to="/app">{t("Client Account")}</Link>
  ) : (
    <>
      <Link to="/login">{t("Client Login")}</Link>
      <Link to="/cadastro">{t("Create Account")}</Link>
    </>
  );
}

function Header({ locale }: { locale: HomeLocale }) {
  const t = useHomeTranslation();
  const [open, setOpen] = useState(false);
  return (
    <header className="ih-header">
      <div className="ih-wrap ih-header-inner">
        <Brand locale={locale} />
        <button
          type="button"
          className="ih-menu"
          aria-expanded={open}
          aria-controls="ih-navigation"
          aria-label={open ? t("Close navigation") : t("Open navigation")}
          onClick={() => setOpen(!open)}
        >
          {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
        <nav
          id="ih-navigation"
          aria-label={t("Main navigation")}
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
                {t(label)}
              </a>
            ))}
          </div>
          <div className="ih-nav-actions">
            <AccountLinks />
            <BookingLink />
          </div>
        </nav>
        <div role="navigation" aria-label={t("Language")} className="ih-languages">
          {homeLocales.map((language) => (
            <a
              key={language}
              href={homePath(language)}
              hrefLang={language}
              lang={language}
              aria-label={{ en: "English", "pt-BR": "Português", es: "Español" }[language]}
              aria-current={locale === language ? "page" : undefined}
            >
              {{ en: "EN", "pt-BR": "PT", es: "ES" }[language]}
            </a>
          ))}
        </div>
      </div>
    </header>
  );
}

function NetworkArtwork() {
  const t = useHomeTranslation();
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
          {t("Local payments")}
        </text>
        <text x="65" y="375">
          {t("Liquidity providers")}
        </text>
        <text x="535" y="120" textAnchor="end">
          {t("Blockchain networks")}
        </text>
        <text x="535" y="375" textAnchor="end">
          {t("Settlement rails")}
        </text>
      </g>
    </svg>
  );
}

export function PublicHome({ locale = "en" }: { locale?: HomeLocale } = {}) {
  return (
    <HomeLocaleContext.Provider value={locale}>
      <HomeContent locale={locale} />
    </HomeLocaleContext.Provider>
  );
}

function HomeContent({ locale }: { locale: HomeLocale }) {
  const t = useHomeTranslation();
  return (
    <div className="peragus-institutional" lang={locale}>
      <a className="ih-skip" href="#main-content">
        {t("Skip to content")}
      </a>
      <Header locale={locale} />
      <main id="main-content">
        <section className="ih-hero">
          <div className="ih-wrap ih-hero-grid">
            <div className="ih-hero-content">
              <p className="ih-kicker">{t("Cross-border payment infrastructure")}</p>
              <h1>{t("The infrastructure for a borderless economy.")}</h1>
              <p className="ih-lead">
                {t(
                  "Connecting currencies, markets, and opportunities through a more seamless financial infrastructure.",
                )}
              </p>
              <div className="ih-actions">
                <BookingLink />
                <a href="#infrastructure" className="ih-button ih-secondary">
                  {t("Explore Our Infrastructure")} <ArrowDown size={16} aria-hidden="true" />
                </a>
              </div>
            </div>
            <NetworkArtwork />
          </div>
        </section>

        <section id="company" className="ih-section ih-wrap ih-split">
          <div>
            <p className="ih-kicker">{t("Who We Are")}</p>
            <h2>{t("The world moves across borders. Payments should too.")}</h2>
          </div>
          <div className="ih-prose">
            <p>
              {t(
                "International payments often require businesses to coordinate local payment methods, currency conversion and settlement across separate providers. Each handoff adds work for the teams that route payments and track delivery.",
              )}
            </p>
            <p>
              {t(
                "Peragus builds B2B infrastructure that connects local payment rails, liquidity providers, stablecoins and blockchain settlement in one workflow. We work with businesses and partners to define the payment routes and integrations their operations require.",
              )}
            </p>
          </div>
        </section>

        <section id="infrastructure" className="ih-section ih-band">
          <div className="ih-wrap">
            <p className="ih-kicker">{t("Our Infrastructure")}</p>
            <h2>{t("Connect the systems that move money.")}</h2>
            <p className="ih-lead">
              {t(
                "Commercial availability depends on the corridor, providers and integrations involved.",
              )}
            </p>
            <div className="ih-capabilities">
              {capabilities.map(({ name, icon: Icon, text, strategy }) => (
                <article key={name}>
                  <Icon aria-hidden="true" />
                  {strategy && <span className="ih-stage">{t("Strategic direction")}</span>}
                  <h3>{t(name)}</h3>
                  <p>{t(text)}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="ih-section ih-wrap">
          <p className="ih-kicker">{t("How It Works")}</p>
          <h2>{t("From payment origin to settlement.")}</h2>
          <p className="ih-lead">{t("A conceptual flow for a cross-border payment.")}</p>
          <ol className="ih-flow">
            {steps.map(({ icon: Icon, name, text }) => (
              <li key={name}>
                <Icon aria-hidden="true" />
                <h3>{t(name)}</h3>
                <p>{t(text)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="who-we-serve" className="ih-section ih-band">
          <div className="ih-wrap ih-split">
            <div>
              <p className="ih-kicker">{t("Who We Serve")}</p>
              <h2>{t("Built for businesses that move money across markets.")}</h2>
            </div>
            <dl className="ih-audiences">
              {audiences.map(([name, text]) => (
                <div key={name}>
                  <dt>{t(name)}</dt>
                  <dd>{t(text)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="roadmap" className="ih-section ih-wrap">
          <p className="ih-kicker">{t("Roadmap 2027")}</p>
          <h2>{t("Building the future of global payments.")}</h2>
          <p className="ih-lead">{t("Our vision and strategic milestones for 2027.")}</p>
          <ol className="ih-timeline">
            {roadmap.map(([date, name, text]) => (
              <li key={date}>
                <p className="ih-date">{date}</p>
                <h3>{t(name)}</h3>
                <p>{t(text)}</p>
              </li>
            ))}
          </ol>
          <p className="ih-roadmap-note">
            {t("These milestones represent Peragus’s strategic plans and targets for 2027.")}
          </p>
        </section>

        <section id="partnerships" className="ih-section ih-band">
          <div className="ih-wrap ih-split">
            <div>
              <p className="ih-kicker">{t("Partnerships")}</p>
              <h2>{t("Let's build the future of financial infrastructure together.")}</h2>
            </div>
            <div className="ih-prose">
              <Building2 aria-hidden="true" />
              <p>
                {t(
                  "We welcome conversations with liquidity providers, fintechs, financial institutions, payment companies, technology integration partners, blockchain networks and financial infrastructure providers.",
                )}
              </p>
              <div className="ih-actions">
                <a href="#commercial-inquiry" className="ih-button">
                  {t("Become a Partner")} <ArrowRight size={17} aria-hidden="true" />
                </a>
                <BookingLink secondary />
              </div>
            </div>
          </div>
        </section>

        <section id="commercial-inquiry" className="ih-section ih-conversion">
          <div className="ih-wrap ih-split">
            <div>
              <p className="ih-kicker">{t("Contact")}</p>
              <h2>{t("Let's build a borderless economy together.")}</h2>
              <p className="ih-lead">
                {t(
                  "Looking for cross-border payment infrastructure or exploring a strategic partnership? Let's discuss how Peragus can connect with your business.",
                )}
              </p>
              <p>{t("Book a 30-minute meeting with the founder of Peragus.")}</p>
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
              <Brand locale={locale} />
              <p>
                {t("Financial infrastructure for cross-border payments, liquidity and settlement.")}
              </p>
            </div>
            <nav aria-label={t("Company links")}>
              {navigation.map(([label, href]) => (
                <a href={href} key={href}>
                  {t(label)}
                </a>
              ))}
            </nav>
            <nav aria-label={t("Client links")}>
              <AccountLinks />
              <a href="mailto:contato@peragus.com.br">
                contato@peragus.com.br <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            </nav>
            <nav aria-label={t("Legal links")}>
              <a href="/legal/termos-de-uso.html">{t("Terms of Use")}</a>
              <a href="/legal/politica-de-privacidade.html">{t("Privacy Policy")}</a>
              <a href="/legal/politica-de-reembolso.html">{t("Refund Policy")}</a>
            </nav>
          </div>
          <p className="ih-copyright">
            © {new Date().getUTCFullYear()} Peragus LTDA · {t("Brazil")}
          </p>
        </div>
      </footer>
    </div>
  );
}
