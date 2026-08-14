import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Project } from "@/lib/database.types";
import { getDomainStatus, type DomainCheck, type DomainStatus } from "@/lib/api";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { projectHostname, snoatServerIp } from "@/lib/platform";

/** Hvor lenge «Kopiert!» vises på knappen. */
const COPY_RESET_MS = 2000;

type DomainMode = "root" | "subdomain";

interface DnsRecord {
  id: string;
  type: "A" | "CNAME";
  host: string;
  value: string;
  ttl: string;
  description: string;
}

export function DnsSettingsTab({
  project,
  onSaveDomain,
  isSaving
}: {
  project: Project;
  onSaveDomain: (domain: string | null) => void;
  isSaving: boolean;
}) {
  const { t } = useTranslation();
  const [domain, setDomain] = useState(project.custom_domain || "");
  const [mode, setMode] = useState<DomainMode>("root");
  const [subdomain, setSubdomain] = useState("app");

  // `useState` leser bare startverdien ved første render. Monteres fanen før
  // prosjektet er ferdig lastet – eller lastes prosjektet på nytt etter en
  // lagring – ble feltet stående tomt selv om prosjektet har et domene. Da viste
  // knappen «Fjern», og ett klikk nullet domenet uten at noen hadde bedt om det.
  // Vi følger derfor den lagrede verdien når den endrer seg.
  useEffect(() => {
    setDomain(project.custom_domain || "");
  }, [project.custom_domain]);

  const snoatHostname = projectHostname(project.name);
  const cleanDomain = normalizeDomain(domain);
  const displayDomain = cleanDomain || "dittdomene.no";
  const sub = normalizeHost(subdomain) || "app";

  const hasDomain = Boolean(cleanDomain);
  const isSavedDomain = project.custom_domain === cleanDomain;

  const records: DnsRecord[] =
    mode === "root"
      ? [
          {
            id: "root-a",
            type: "A",
            host: "@",
            value: snoatServerIp,
            ttl: "3600",
            description: t("dns.root_a_desc", { domain: displayDomain }),
          },
          {
            id: "www-cname",
            type: "CNAME",
            host: "www",
            value: snoatHostname,
            ttl: "3600",
            description: t("dns.www_cname_desc", { domain: displayDomain }),
          },
        ]
      : [
          {
            id: "sub-cname",
            type: "CNAME",
            host: sub,
            value: snoatHostname,
            ttl: "3600",
            description: t("dns.sub_cname_desc", { sub, domain: displayDomain }),
          },
        ];

  const isFreePlan = (project.plan ?? "free") === "free";

  const statusQuery = useQuery({
    queryKey: ["domain-status", project.id],
    queryFn: () => getDomainStatus(project.id),
    enabled: Boolean(project.custom_domain),
    // DNS-propagering tar minutter til timer. Vi henter på nytt i bakgrunnen så
    // panelet blir grønt av seg selv, uten at kunden må lure på om hen skal
    // laste siden på nytt. Når alt stemmer er det ingenting mer å vente på.
    refetchInterval: (q) => (q.state.data?.ready ? false : 30_000),
  });

  const status = statusQuery.data;

  // Detaljene er bare interessante mens noe mangler. Virker domenet, foldes alt
  // sammen og fanen viser én linje som sier nettopp det – det er hele poenget
  // med å dele den opp.
  const defaultOpen = status?.ready ? [] : ["status", "records"];

  return (
    <div className="flex flex-col gap-6">
      {/* Sperre for Free-plan */}
      {isFreePlan && (
        <div className="floating-card p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-primary/30 bg-primary/5">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary">
              <span className="material-symbols-outlined icon-md">lock</span>
            </div>
            <div>
              <h2 className="font-headline text-headline-sm text-on-surface">{t("project_plan.gated_dns_title")}</h2>
              <p className="font-body text-body-md text-on-surface-variant mt-0.5">{t("project_plan.gated_dns_desc")}</p>
            </div>
          </div>
        </div>
      )}

      {/* Domenekonfigurasjon. Snoat-adressen sto tidligere i et eget kort her;
          den og det egne domenet er nå lenker øverst på prosjektsiden, der man
          leter etter dem. */}
      <div className="floating-card p-6 md:p-8 flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-headline text-headline-md text-on-surface">{t("dns.connect_title")}</h2>
            <p className="mt-1 font-body text-body-md text-on-surface-variant">
              {t("dns.connect_desc")}
            </p>
          </div>

          {project.custom_domain && status && (
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 font-label text-xs ${
                status.ready ? "bg-secondary/15 text-secondary" : "bg-surface-variant/40 text-on-surface-variant"
              }`}
            >
              <span className="material-symbols-outlined icon-sm">
                {status.ready ? "check_circle" : "hourglass_top"}
              </span>
              {status.ready
                ? t("dns.badge_connected", "Koblet til")
                : t("dns.badge_waiting", "Venter")}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-4 md:flex-row md:items-center justify-between">
          <div className="flex flex-1 flex-col gap-2 max-w-md">
            <label className="font-label text-label-md text-on-surface-variant">{t("dns.domain_label")}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                disabled={isFreePlan}
                placeholder={isFreePlan ? t("project_plan.gated_dns_title") : "dittdomene.no"}
                className="flex-1 rounded-xl bg-surface-container px-4 py-3 font-mono text-sm text-on-surface outline-none ring-primary/60 placeholder:text-on-surface-variant/40 focus:ring-2 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              {/* Lagre-knappen lagrer, og bare det. Den tømte tidligere domenet
                  når feltet var tomt, slik at ett klikk kunne koble fra et
                  domene som virket – uten å spørre. Frakobling har nå sin egen
                  knapp under, med bekreftelse. */}
              <button
                type="button"
                onClick={() => cleanDomain && onSaveDomain(cleanDomain)}
                disabled={isFreePlan || isSaving || !cleanDomain || isSavedDomain}
                className={`shrink-0 rounded-xl px-4 py-3 font-label text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  isSaving
                    ? "bg-surface-variant/40 text-on-surface-variant cursor-wait"
                    : isSavedDomain && cleanDomain
                      ? "bg-secondary/15 text-secondary"
                      : "bg-primary text-on-primary hover:bg-primary/90"
                }`}
              >
                {isSaving
                  ? t("common.saving", "Lagrer...")
                  : isSavedDomain && cleanDomain
                    ? t("common.saved", "Lagret")
                    : t("common.save", "Lagre")}
              </button>
            </div>

            {project.custom_domain && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(t("dns.disconnect_confirm", {
                    domain: project.custom_domain,
                    defaultValue: "Koble fra {{domain}}? Siden slutter å svare på dette domenet til det kobles til igjen.",
                  }))) {
                    onSaveDomain(null);
                  }
                }}
                disabled={isSaving}
                className="self-start font-label text-xs text-on-surface-variant underline underline-offset-4 transition-colors hover:text-error disabled:opacity-50"
              >
                {t("dns.disconnect", "Koble fra {{domain}}", { domain: project.custom_domain })}
              </button>
            )}
          </div>

          {mode === "subdomain" && (
            <div className="flex flex-col gap-2 md:w-48">
              <label className="font-label text-label-md text-on-surface-variant">{t("dns.subdomain_label")}</label>
              <input
                type="text"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                placeholder="app"
                className="rounded-xl bg-surface-container px-4 py-3 font-mono text-sm text-on-surface outline-none ring-primary/60 placeholder:text-on-surface-variant/40 focus:ring-2"
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="font-label text-label-md text-on-surface-variant">{t("dns.domain_type")}</span>
            <div className="inline-flex rounded-xl bg-surface-container p-1 shadow-[inset_0_1px_0_0_oklch(1_0_0/5%)]">
              <button
                type="button"
                onClick={() => setMode("root")}
                className={`rounded-lg px-4 py-2 font-label text-label-md transition-all ${
                  mode === "root" ? "bg-surface text-primary font-semibold shadow-sm" : "text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {t("dns.mode_root", { domain: displayDomain })}
              </button>
              <button
                type="button"
                onClick={() => setMode("subdomain")}
                className={`rounded-lg px-4 py-2 font-label text-label-md transition-all ${
                  mode === "subdomain" ? "bg-surface text-primary font-semibold shadow-sm" : "text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {t("dns.mode_subdomain", { sub, domain: displayDomain })}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Detaljene, sammenfoldet. Tidligere lå tilstand og oppføringer utbrettet
          under hverandre og fylte skjermen med informasjon som bare er relevant
          mens man setter opp domenet. */}
      {hasDomain && (
        <Accordion
          type="multiple"
          defaultValue={defaultOpen}
          key={String(status?.ready)}
          className="floating-card px-6 md:px-8"
        >
          {project.custom_domain && (
            <AccordionItem value="status" className="border-outline-variant/30">
              <AccordionTrigger className="py-5 hover:no-underline">
                <span className="flex items-center gap-3">
                  <span className="font-headline text-headline-sm text-on-surface">
                    {t("dns.status_title", "Tilkobling")}
                  </span>
                  {status && (
                    <span className="font-body text-xs text-on-surface-variant">
                      {status.ready
                        ? t("dns.status_ready", "Domenet er koblet til og svarer.")
                        : t("dns.status_waiting", "Slik ligger det an akkurat nå.")}
                    </span>
                  )}
                </span>
              </AccordionTrigger>
              <AccordionContent className="pb-6">
                <DomainStatusPanel query={statusQuery} />
              </AccordionContent>
            </AccordionItem>
          )}

          <AccordionItem value="records" className="border-none">
            <AccordionTrigger className="py-5 hover:no-underline">
              <span className="flex items-center gap-3">
                <span className="font-headline text-headline-sm text-on-surface">
                  {t("dns.records_title")}
                </span>
                <span className="font-body text-xs text-on-surface-variant">
                  {records.length}
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="flex flex-col gap-4">
                {records.map((record) => (
                  <RecordRow key={record.id} record={record} />
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Komponent: Enkel, ren oppføringslinje i listen
// -----------------------------------------------------------------------------
function RecordRow({ record }: { record: DnsRecord }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface-container p-5 shadow-[inset_0_1px_0_0_oklch(1_0_0/5%)] border border-surface-variant/20 hover:border-primary/40 transition-colors">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="rounded-lg bg-primary/15 px-3 py-1 font-mono text-xs font-bold text-primary">
            {record.type}
          </span>
          <span className="font-body text-xs text-on-surface-variant">{record.description}</span>
        </div>

        <span className="font-mono text-xs text-on-surface-variant/60">TTL: {record.ttl}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
        {/* Host / Navn */}
        <div className="flex items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 shadow-[inset_0_1px_0_0_oklch(1_0_0/6%)]">
          <div className="flex flex-col min-w-0">
            <span className="font-label text-[10px] tracking-wider text-on-surface-variant/70 uppercase">{t("dns.name_host")}</span>
            <code className="font-mono text-sm text-on-surface truncate">{record.host}</code>
          </div>
          <CopyButton value={record.host} label={t("dns.name_host")} />
        </div>

        {/* Verdi / Peker til */}
        <div className="flex items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 shadow-[inset_0_1px_0_0_oklch(1_0_0/6%)]">
          <div className="flex flex-col min-w-0">
            <span className="font-label text-[10px] tracking-wider text-on-surface-variant/70 uppercase">{t("dns.value_target")}</span>
            <code className="font-mono text-sm text-primary truncate">{record.value}</code>
          </div>
          <CopyButton value={record.value} label={t("dns.value_target")} />
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Komponent: Tydelig Kopieringsknapp
// -----------------------------------------------------------------------------
function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Fallback
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`${t("dns.copy")} ${label}`}
      className={`ghost-btn shrink-0 flex items-center gap-1.5 px-3 py-1.5 font-label text-xs transition-colors rounded-lg ${
        copied ? "bg-secondary/15 text-secondary font-semibold" : "bg-surface-container text-on-surface-variant hover:text-on-surface"
      }`}
    >
      <span className="material-symbols-outlined icon-sm">
        {copied ? "check" : "content_copy"}
      </span>
      {copied ? t("dns.copied") : t("dns.copy")}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Component: Faktisk tilstand for det egne domenet
// -----------------------------------------------------------------------------

/**
 * De tre tingene som må stemme før et eget domene svarer, målt hver for seg.
 *
 * Tidligere kunne fanen bare gjenta hvilke records kunden skulle sette, og lot
 * hen kjøre `dig` selv for å finne ut om det hadde virket. Verst var tilfellet
 * der sertifikatet var utstedt, men Caddy manglet ruten: da svarte domenet over
 * HTTPS med «ingen applikasjon er rutet til dette domenet», og ingenting i
 * dashbordet forklarte hvorfor. Hver linje her har sin egen tilstand, så det er
 * mulig å se nøyaktig hvilket ledd som mangler.
 */
function DomainStatusPanel({ query }: { query: UseQueryResult<DomainStatus> }) {
  const { t } = useTranslation();
  const status = query.data;

  return (
    <div className="flex flex-col gap-4">
      {query.isError && (
        <p className="font-body text-body-md text-error">
          {t("dns.status_error", "Kunne ikke hente status akkurat nå.")}
        </p>
      )}

      {status && (
        <div className="flex flex-col divide-y divide-outline-variant/30">
          <DomainCheckRow
            label={t("dns.check_dns", "DNS peker hit")}
            check={status.dns}
          />
          <DomainCheckRow
            label={t("dns.check_route", "Rute aktiv")}
            check={status.route}
          />
          <DomainCheckRow
            label={t("dns.check_certificate", "Sertifikat")}
            check={status.certificate}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => query.refetch()}
        disabled={query.isFetching}
        className="self-start inline-flex items-center gap-1.5 rounded-xl bg-surface-container px-3 py-2 font-label text-sm text-on-surface-variant transition-all hover:text-on-surface disabled:opacity-50 disabled:cursor-wait"
      >
        <span className={`material-symbols-outlined icon-sm ${query.isFetching ? "animate-spin" : ""}`}>
          refresh
        </span>
        {t("dns.status_recheck", "Sjekk på nytt")}
      </button>
    </div>
  );
}

function DomainCheckRow({ label, check }: { label: string; check: DomainCheck }) {
  // Ikonet bærer tilstanden, men aldri alene: fargeblinde skal se forskjell på
  // «venter» og «feilet» uten å skille grønt fra rødt, så formen skiller også.
  const presentation = {
    ok: { icon: "check_circle", tone: "text-secondary" },
    pending: { icon: "hourglass_top", tone: "text-on-surface-variant" },
    failed: { icon: "error", tone: "text-error" },
  }[check.state];

  return (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span className={`material-symbols-outlined icon-sm mt-0.5 ${presentation.tone}`}>
        {presentation.icon}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="font-label text-label-md text-on-surface">{label}</span>
        <span className="font-body text-xs text-on-surface-variant">{check.detail}</span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Hjelpefunksjoner for domenenavn
// -----------------------------------------------------------------------------
function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/^\.+|\.+$/g, "")
    .replace(/[^a-z0-9.-]/g, "");
}

function normalizeHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
}
