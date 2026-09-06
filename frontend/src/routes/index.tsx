import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Mark } from "@/components/Mark";
import { Reveal } from "@/components/Reveal";
import { SnoatLogo } from "@/components/SnoatLogo";
import { getPricing, type PlanOption } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useFormatters } from "@/lib/format";
import { useRequestedMarket } from "@/lib/market";

/**
 * Landingssiden.
 *
 * Layouten er en direkte oversettelse av Figma-node 0:1683 i fila
 * «Website Hosting Landing Page» (m3BEhOsDc9QQoKLFAllvHt), hentet gjennom
 * Figma MCP. Artboardet er 937 px bredt, men er en nedskalert 1440-layout:
 * hver px-verdi under er Figma-tallet ganget med 1440/937 = 1,5368. Der
 * kilden er slurvete – hero-teksten står på 68 px, rutenettet på 64 og
 * footeren på 61, altså tre «samme» venstremarg – er alt samlet på én rail:
 * innholdsbredden 1334 px sentrert, som er den bredeste faktiske blokken i
 * designet.
 *
 * To bevisste avvik fra malen:
 *  - Ikonene er fjernet (uttrykkelig ønske). Der malen har et ikon over en
 *    korttittel, står nå den gule håndstreken – samme visuelle vekt, samme
 *    rytme, ingen ikonografi.
 *  - Malens kundesitat er byttet mot etterprøvbare fakta om plattformen. Vi
 *    dikter ikke opp en anmeldelse fra en kunde som ikke finnes.
 */

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Snoat — Webapp-hosting på 1 klikk på norsk infrastruktur" },
      {
        name: "description",
        content:
          "Webapp-hosting på 1 klikk på norsk infrastruktur. Deploy direkte fra GitHub på sekunder med automatisk HTTPS, isolerte containere og full datasuverenitet.",
      },
      { property: "og:title", content: "Snoat — Webapp-hosting på 1 klikk på norsk infrastruktur" },
      {
        property: "og:description",
        content:
          "Webapp-hosting på 1 klikk på norsk infrastruktur. Deploy direkte fra GitHub på sekunder — data lagret og driftet i Norge.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

/** Innholdsbredden i designet: 1334 px, sentrert. */
const SHELL = "mx-auto w-full max-w-[1334px] px-5 sm:px-8 lg:px-0";

/* -------------------------------------------------------------------------- */
/* Header — Figma 0:1684                                                       */
/* -------------------------------------------------------------------------- */

function SiteHeader({ signedIn }: { signedIn: boolean }) {
  const { t } = useTranslation();

  return (
    <header className="sticky top-0 z-50 bg-paper pt-6 lg:pt-[48px]">
      <div className={SHELL}>
        <div className="mx-auto flex max-w-[1264px] flex-wrap items-center justify-between gap-y-4">
          <Link to="/" className="text-ink" aria-label="Snoat">
            <SnoatLogo size={36} />
          </Link>

          <nav className="hidden items-center gap-[38px] xl:flex xl:gap-[66px]">
            <a
              href="#funksjoner"
              className="font-body text-[20px] font-normal text-ink underline-offset-[6px] hover:underline xl:text-[27px]"
            >
              {t("nav.features")}
            </a>
            <a
              href="#prising"
              className="font-body text-[20px] font-normal text-ink underline-offset-[6px] hover:underline xl:text-[27px]"
            >
              {t("nav.pricing")}
            </a>
            <a
              href="#hvorfor"
              className="font-body text-[20px] font-normal text-ink underline-offset-[6px] hover:underline xl:text-[27px]"
            >
              {t("nav.why")}
            </a>
          </nav>

          <div className="flex items-center gap-4">
            <LanguageSwitcher />
            {signedIn ? (
              <Link
                to="/dashboard"
                className="btn-ink h-[45px] px-[34px] font-body text-[16px] font-normal xl:text-[20.8px]"
              >
                {t("nav.my_projects")}
              </Link>
            ) : (
              <Link
                to="/login"
                className="btn-ink h-[45px] px-[34px] font-body text-[16px] font-normal xl:text-[20.8px]"
              >
                {t("nav.login")}
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero — Figma 0:1698 / 0:1704 / 0:1719 / 0:1922                              */
/* -------------------------------------------------------------------------- */

function Hero({ signedIn }: { signedIn: boolean }) {
  const { t } = useTranslation();

  return (
    <section className={`${SHELL} pt-[56px] lg:pt-[96px]`}>
      <div className="flex flex-col items-start gap-10 lg:flex-row lg:items-start lg:justify-between lg:gap-0">
        {/* Heroen ligger over folden og animerer ved montering. Å vente på en
            rullehendelse for det første man ser, ville bare vært en forsinkelse. */}
        <div className="w-full lg:w-[758px] lg:pt-[50px]">
          <h1 className="anim-rise font-display text-[clamp(2.5rem,5.556vw,5rem)] font-bold leading-[1.15] tracking-[-0.005em] text-ink">
            {t("hero.title")}
          </h1>
          <p className="anim-rise [--anim-delay:100ms] mt-[22px] max-w-[684px] font-body text-[clamp(1.0625rem,2.222vw,2rem)] font-light leading-[1.45] text-ink">
            {t("hero.description")}
          </p>
          <Link
            to={signedIn ? "/dashboard" : "/login"}
            className="btn-ink anim-rise [--anim-delay:200ms] mt-[32px] px-[30px] py-[16px] font-display text-[clamp(1rem,1.42vw,1.275rem)] font-bold"
          >
            {signedIn ? t("hero.cta_go_to_projects") : t("hero.cta_register")}
          </Link>
        </div>

        {/* Figma-noden 0:1922 er 372,75 kvadratisk: 372,75 × 1,5368 = 573 px. */}
        <img
          src="/illustrations/hero-launch.svg"
          alt=""
          aria-hidden="true"
          width={373}
          height={373}
          className="anim-pop [--anim-delay:180ms] w-[320px] max-w-full shrink-0 self-center sm:w-[440px] lg:w-[573px] lg:self-start"
        />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Tre løfter — Figma 0:1721                                                   */
/* -------------------------------------------------------------------------- */

const PROMISES = ["sovereignty", "speed", "security"] as const;

function Promises() {
  const { t } = useTranslation();

  return (
    <section className={`${SHELL} mt-[72px] lg:mt-[80px]`}>
      <div className="grid grid-cols-1 gap-[31px] md:grid-cols-3">
        {PROMISES.map((key, i) => (
          <Reveal
            as="article"
            key={key}
            delay={i * 90}
            className="ink-card lift flex flex-col gap-[14px] px-[23px] py-[25px]"
          >
            <span className="swoosh" aria-hidden="true" />
            <h2 className="font-body text-[22px] font-normal leading-[1.25] text-ink lg:text-[28.7px]">
              {t(`usp.${key}.title`)}
            </h2>
            <p className="font-body text-[16px] font-light leading-[1.55] text-ink lg:text-[19.7px]">
              {t(`usp.${key}.body`)}
            </p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Sikker hosting — Figma 0:1702 / 0:1705 / 0:2085                             */
/* -------------------------------------------------------------------------- */

function SecureSection() {
  const { t } = useTranslation();

  return (
    <section className={`${SHELL} mt-[110px] lg:mt-[150px]`}>
      <Reveal className="flex flex-col items-center gap-10 lg:flex-row lg:items-center lg:justify-between lg:gap-0">
        {/* Figma-noden er 355,836 px, men det er plasseringsboksen: selve
            vektoren er 327,646 bred, siden gruppen har 3,85–3,96 % innrykk.
            504 px = 327,646 × 1,5368 er derfor riktig tegnebredde. Setter man
            547, strekkes illustrasjonen ut over sin egen geometri. */}
        <img
          src="/illustrations/growth-chart.svg"
          alt=""
          aria-hidden="true"
          width={328}
          height={292}
          className="w-[320px] max-w-full shrink-0 sm:w-[440px] lg:w-[504px]"
        />
        <div className="w-full lg:w-[752px]">
          <h2 className="font-display text-[clamp(2rem,4.167vw,3.75rem)] font-bold leading-[1.15] text-ink">
            {t("secure.title_line1")}
            <br className="hidden lg:inline" /> {t("secure.title_line2")}
          </h2>
          <p className="mt-[24px] font-body text-[clamp(1.0625rem,2.222vw,2rem)] font-light leading-[1.45] text-ink lg:text-justify">
            {t("secure.body")}
          </p>
        </div>
      </Reveal>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Funksjoner — Figma 0:1737 (rutenett 3 × 405,9 px, gap 57 / 90,7)            */
/* -------------------------------------------------------------------------- */

const FEATURES = ["deploy", "domains", "sovereignty", "analytics", "ai", "scale"] as const;

function Features() {
  const { t } = useTranslation();

  return (
    <section id="funksjoner" className={`${SHELL} mt-[110px] lg:mt-[150px] scroll-mt-[120px]`}>
      <Reveal>
        <h2 className="text-center font-display text-[clamp(2rem,4.167vw,3.75rem)] font-bold leading-[1.15] text-ink">
          {t("features_section.title")}
        </h2>
      </Reveal>

      <div className="mt-[46px] grid grid-cols-1 gap-x-[57px] gap-y-[46px] md:grid-cols-2 lg:mt-[91px] lg:grid-cols-3 lg:gap-y-[90.7px]">
        {FEATURES.map((key, i) => (
          <Reveal
            as="article"
            key={key}
            delay={(i % 3) * 90}
            className="ink-card-lg lift flex flex-col gap-[18px] px-[30px] py-[32px]"
          >
            <div>
              {/* 56,002 → 86 px, transparent fyll med svart kontur. */}
              <p className="numeral text-[64px] lg:text-[86px]" aria-hidden="true">
                #{i + 1}
              </p>
              <span className="swoosh ml-[9px] mt-[6px]" aria-hidden="true" />
            </div>
            <h3 className="font-body text-[24px] font-normal leading-[1.25] text-ink lg:text-[31.6px]">
              {t(`features.${key}.title`)}
            </h3>
            <p className="font-body text-[17px] font-light leading-[1.55] text-ink lg:text-[21px]">
              {t(`features.${key}.body`)}
            </p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Hvorfor Snoat — Figma 0:1703 / 0:1706 / 0:1768                              */
/* -------------------------------------------------------------------------- */

function WhySection() {
  const { t } = useTranslation();

  const facts = [
    { value: t("why.fact1_value"), label: t("why.fact1_label") },
    { value: t("why.fact2_value"), label: t("why.fact2_label") },
    { value: t("why.fact3_value"), label: t("why.fact3_label") },
  ];

  return (
    <section id="hvorfor" className={`${SHELL} mt-[110px] lg:mt-[150px] scroll-mt-[120px]`}>
      <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:justify-between lg:gap-[57px]">
        <Reveal className="w-full lg:w-[590px] lg:pt-[34px]">
          <h2 className="font-display text-[clamp(2rem,4.167vw,3.75rem)] font-bold leading-[1.15] text-ink">
            {t("why.title")}
          </h2>
          <p className="mt-[24px] font-body text-[clamp(1.0625rem,2.222vw,2rem)] font-light leading-[1.45] text-ink lg:text-justify">
            {t("why.body")}
          </p>
        </Reveal>

        <Reveal
          delay={120}
          className="ink-card-lg flex w-full flex-col justify-center gap-[22px] px-[30px] py-[32px] lg:w-[697px] lg:min-h-[415px]"
        >
          <span className="swoosh mx-auto" aria-hidden="true" />
          <dl className="stagger flex flex-col gap-[22px]">
            {facts.map((fact) => (
              <div key={fact.label} className="text-center">
                <dt className="font-display text-[32px] font-bold leading-[1.1] text-ink lg:text-[40px]">
                  {fact.value}
                </dt>
                <dd className="mt-[4px] font-body text-[17px] font-light text-ink lg:text-[24px]">
                  {fact.label}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-center font-body text-[15px] font-light text-ink lg:text-[24px]">
            {t("why.footnote")}
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Priser — Figma 0:1782                                                       */
/* -------------------------------------------------------------------------- */

function planRows(plan: PlanOption, t: (k: string, o?: Record<string, unknown>) => string) {
  const memory =
    plan.limits.memoryMb >= 1024
      ? `${plan.limits.memoryMb / 1024} GB`
      : `${plan.limits.memoryMb} MB`;

  return [
    {
      on: true,
      text: t(
        plan.limits.maxRunningProjects === 1 ? "pricing.limit_apps" : "pricing.limit_apps_plural",
        {
          count: plan.limits.maxRunningProjects,
        },
      ),
    },
    {
      // Skjules på gratisplanen i stedet for å stå som «0 dev-sider». En rad som
      // sier null leser som et tak man kan fylle opp; det er ikke det den er.
      on: plan.limits.maxRunningDevSites > 0,
      text: t(
        plan.limits.maxRunningDevSites === 1
          ? "pricing.limit_dev_sites"
          : "pricing.limit_dev_sites_plural",
        { count: plan.limits.maxRunningDevSites },
      ),
    },
    { on: true, text: t("pricing.limit_memory", { value: memory }) },
    { on: true, text: t("pricing.limit_cpu", { value: plan.limits.cpus }) },
    { on: true, text: t("pricing.limit_build", { count: plan.limits.buildMinutesPerMonth }) },
    { on: plan.limits.queuePriority > 0, text: t("pricing.limit_queue") },
    { on: true, text: t("pricing.limit_static") },
  ];
}

function PriceCard({ plan, featured }: { plan: PlanOption; featured: boolean }) {
  const { t } = useTranslation();
  const format = useFormatters();

  const rows = planRows(plan, t);
  // Også gratisplanen skrives som penger. «Gratis» ved siden av «199 kr» leser
  // som to ulike enheter; «0 kr» leser som samme skala.
  const price = format.money(plan.price, plan.currency);

  return (
    <article
      className={`ink-card-xl lift flex flex-col ${
        featured
          ? "px-[42px] pb-[40px] pt-[57px] lg:w-[441px] lg:min-h-[605px]"
          : "px-[38px] pb-[36px] pt-[53px] lg:w-[412px] lg:min-h-[566px]"
      }`}
    >
      <p
        className={`font-display font-bold leading-[1.1] tracking-[-0.007em] text-ink ${
          featured ? "text-[54px] lg:text-[76px]" : "text-[48px] lg:text-[66px]"
        }`}
      >
        {price}
      </p>
      <p
        className={`mt-[2px] font-body font-normal text-ink/80 ${
          featured ? "text-[16.6px]" : "text-[15px]"
        }`}
      >
        {t("pricing.per_month")}
      </p>

      <hr className="hairline mt-[24px]" />

      <ul className={`stagger mt-[28px] flex flex-col ${featured ? "gap-[16px]" : "gap-[14px]"}`}>
        {rows.map((row) => (
          <li key={row.text} className="flex items-center gap-[10px]">
            <Mark on={row.on} size={featured ? 25 : 22} />
            <span
              className={`font-body font-normal text-ink ${
                featured ? "text-[16.6px]" : "text-[15px]"
              }`}
            >
              {row.text}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-[32px]">
        <Link
          to="/login"
          className={`btn-ink w-full font-display font-bold ${
            featured ? "h-[41px] text-[16.6px]" : "h-[37px] text-[15px]"
          }`}
        >
          {t("pricing.cta")}
        </Link>
        <p className="mt-[6px] text-center font-body text-[13px] font-normal text-ink">
          {t("pricing.cta_note")}
        </p>
      </div>
    </article>
  );
}

function PricingSection() {
  const { t } = useTranslation();
  const market = useRequestedMarket();

  const pricing = useQuery({
    queryKey: ["pricing", market],
    queryFn: () => getPricing(market),
    // Prislista endrer seg omtrent aldri, og seksjonen ligger under folden.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const plans = pricing.data?.plans ?? [];
  // Midtkortet er større og løftet i malen. Det er alltid mellomplanen.
  const featuredIndex = plans.length === 3 ? 1 : -1;

  return (
    <section id="prising" className={`${SHELL} mt-[110px] lg:mt-[150px] scroll-mt-[120px]`}>
      <Reveal>
        <h2 className="text-center font-display text-[clamp(2.25rem,5.19vw,4.688rem)] font-bold leading-[1.15] text-ink">
          {t("pricing.title")}
        </h2>
      </Reveal>

      <div className="mt-[46px] flex flex-col items-center justify-center gap-[27px] lg:mt-[76px] lg:flex-row lg:items-start">
        {plans.map((plan, i) => (
          <Reveal
            key={plan.id}
            delay={i * 110}
            className={i === featuredIndex ? "lg:-mt-[20px]" : ""}
          >
            <PriceCard plan={plan} featured={i === featuredIndex} />
          </Reveal>
        ))}
      </div>

      {/* Feiler kallet, står seksjonen tom framfor å vise et tall vi ikke vet
          om stemmer. Et gammelt tall på en prisside er verre enn ingen tall. */}
      {pricing.isError && (
        <p className="mt-8 text-center font-body text-[17px] font-light text-ink">
          {t("pricing.unavailable")}
        </p>
      )}

      {pricing.data && (
        <p className="mt-[28px] text-center font-body text-[15px] font-light text-ink/70">
          {t(`pricing.vat_note_${pricing.data.market.id}`)}
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Avslutnings-CTA — Figma 0:1701 / 0:1910                                     */
/* -------------------------------------------------------------------------- */

function ClosingCta() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");

  return (
    <section className={`${SHELL} mt-[110px] lg:mt-[150px]`}>
      <Reveal className="flex flex-col gap-10 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="font-display text-[clamp(1.75rem,3.108vw,2.797rem)] font-bold leading-[1.2] text-ink">
          {t("cta.title_line1")}
          <br className="hidden lg:inline" /> {t("cta.title_line2")}
        </h2>

        <form
          className="field-ink flex w-full items-center justify-between gap-4 p-[16px] lg:h-[91px] lg:w-[576px]"
          onSubmit={(e) => {
            e.preventDefault();
            // Feltet er ikke et nyhetsbrev – det er starten på registreringen,
            // så e-posten følger med inn i innloggingsskjemaet.
            void navigate({ to: "/login", search: email ? { email } : undefined });
          }}
        >
          <label className="sr-only" htmlFor="cta-email">
            {t("cta.placeholder")}
          </label>
          <input
            id="cta-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("cta.placeholder")}
            className="min-w-0 flex-1 bg-transparent font-body text-[18px] font-normal text-ink outline-none placeholder:text-ink/70 lg:text-[27px]"
          />
          <button
            type="submit"
            className="btn-ink h-[48px] shrink-0 px-[24px] font-body text-[16px] font-normal lg:h-[57px] lg:w-[213px] lg:text-[23px]"
          >
            {t("cta.button")}
          </button>
        </form>
      </Reveal>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Footer — Figma 0:1695 – 0:1718 (Clash Display)                              */
/* -------------------------------------------------------------------------- */

function SiteFooter() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();

  return (
    <footer className={`${SHELL} mt-[120px] pb-[72px] lg:mt-[160px] lg:pb-[96px]`}>
      <div className="flex flex-col gap-12 lg:flex-row lg:justify-between">
        <div>
          <SnoatLogo size={40} className="text-ink" />
          <p className="mt-[49px] max-w-[341px] font-meta text-[16px] font-normal leading-[1.5] text-ink lg:text-[20.5px]">
            {t("footer.vision")}
          </p>
        </div>

        <div className="flex gap-[48px] lg:gap-[96px]">
          <nav className="lg:text-right">
            <h2 className="font-meta text-[20px] font-normal text-ink lg:text-[26.9px]">
              {t("footer.col_platform")}
            </h2>
            <ul className="mt-[20px] flex flex-col gap-[16px] lg:mt-[28px] lg:gap-[28px]">
              <li>
                <a
                  href="#funksjoner"
                  className="font-meta text-[18px] font-extralight text-ink hover:underline lg:text-[26.9px]"
                >
                  {t("nav.features")}
                </a>
              </li>
              <li>
                <a
                  href="#prising"
                  className="font-meta text-[18px] font-extralight text-ink hover:underline lg:text-[26.9px]"
                >
                  {t("nav.pricing")}
                </a>
              </li>
              <li>
                <a
                  href="#hvorfor"
                  className="font-meta text-[18px] font-extralight text-ink hover:underline lg:text-[26.9px]"
                >
                  {t("nav.why")}
                </a>
              </li>
            </ul>
          </nav>

          <nav>
            <h2 className="font-meta text-[20px] font-normal text-ink lg:text-[26.9px]">
              {t("footer.col_account")}
            </h2>
            <ul className="mt-[20px] flex flex-col gap-[16px] lg:mt-[28px] lg:gap-[28px]">
              <li>
                <Link
                  to="/login"
                  className="font-meta text-[18px] font-extralight text-ink hover:underline lg:text-[26.9px]"
                >
                  {t("nav.login")}
                </Link>
              </li>
              <li>
                <Link
                  to="/login"
                  className="font-meta text-[18px] font-extralight text-ink hover:underline lg:text-[26.9px]"
                >
                  {t("nav.register")}
                </Link>
              </li>
              <li>
                <Link
                  to="/dashboard"
                  className="font-meta text-[18px] font-extralight text-ink hover:underline lg:text-[26.9px]"
                >
                  {t("nav.my_projects")}
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </div>

      <p className="mt-[70px] font-meta text-[13px] font-light text-ink lg:text-[15.4px]">
        {t("footer.copyright", { year })}
      </p>
    </footer>
  );
}

/* -------------------------------------------------------------------------- */

function Index() {
  const { user, loading } = useAuth();
  const signedIn = !loading && Boolean(user);

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-paper">
      <SiteHeader signedIn={signedIn} />
      <main className="flex-grow">
        <Hero signedIn={signedIn} />
        <Promises />
        <SecureSection />
        <Features />
        <WhySection />
        <PricingSection />
        <ClosingCta />
      </main>
      <SiteFooter />
    </div>
  );
}
