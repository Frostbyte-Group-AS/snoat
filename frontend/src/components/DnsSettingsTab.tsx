import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Project } from "@/lib/database.types";
import { getDomainStatus, type DomainCheck, type DomainStatus } from "@/lib/api";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
  isSaving,
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
        <div className="border-2 border-line bg-sun px-[23px] py-[20px]">
          <h2 className="font-display text-[20px] font-bold text-ink">
            {t("project_plan.gated_dns_title")}
          </h2>
          <p className="mt-[6px] font-body text-[16px] font-normal text-ink">
            {t("project_plan.gated_dns_desc")}
          </p>
        </div>
      )}

      {/* Domenekonfigurasjon. Snoat-adressen sto tidligere i et eget kort her;
          den og det egne domenet er nå lenker øverst på prosjektsiden, der man
          leter etter dem. */}
      <div className="ink-card-lg anim-rise flex flex-col gap-6 p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[22px] font-bold text-ink">
              {t("dns.connect_title")}
            </h2>
            <p className="mt-1 font-body text-[16px] text-ink/70">{t("dns.connect_desc")}</p>
          </div>

          {project.custom_domain && status && (
            <span
              key={String(status.ready)}
              className={`anim-pop inline-flex shrink-0 items-center border-2 px-[10px] py-[3px] font-body text-[12px] font-bold uppercase leading-none tracking-[0.1em] transition-colors ${
                status.ready ? "border-line bg-ink text-paper" : "border-line bg-paper text-ink"
              }`}
            >
              {status.ready
                ? t("dns.badge_connected", "Koblet til")
                : t("dns.badge_waiting", "Venter")}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-4 md:flex-row md:items-center justify-between">
          <div className="flex flex-1 flex-col gap-2 max-w-md">
            <label className="font-body text-[15px] text-ink/70">{t("dns.domain_label")}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                disabled={isFreePlan}
                placeholder={isFreePlan ? t("project_plan.gated_dns_title") : "dittdomene.no"}
                className="field-ink flex-1 px-[14px] py-[12px] font-mono text-[14px] outline-none placeholder:text-ink/40 disabled:cursor-not-allowed disabled:opacity-50"
              />
              {/* Lagre-knappen lagrer, og bare det. Den tømte tidligere domenet
                  når feltet var tomt, slik at ett klikk kunne koble fra et
                  domene som virket – uten å spørre. Frakobling har nå sin egen
                  knapp under, med bekreftelse. */}
              <button
                type="button"
                onClick={() => cleanDomain && onSaveDomain(cleanDomain)}
                disabled={isFreePlan || isSaving || !cleanDomain || isSavedDomain}
                className={`shrink-0 rounded-[12px] px-4 py-3 font-body text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  isSaving
                    ? "bg-muted text-ink/70 cursor-wait"
                    : isSavedDomain && cleanDomain
                      ? "bg-sun text-ink"
                      : "bg-ink text-paper hover:bg-sun hover:text-ink"
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
                  if (
                    window.confirm(
                      t("dns.disconnect_confirm", {
                        domain: project.custom_domain,
                        defaultValue:
                          "Koble fra {{domain}}? Siden slutter å svare på dette domenet til det kobles til igjen.",
                      }),
                    )
                  ) {
                    onSaveDomain(null);
                  }
                }}
                disabled={isSaving}
                className="self-start font-body text-xs text-ink/70 underline underline-offset-4 transition-colors hover:text-error disabled:opacity-50"
              >
                {t("dns.disconnect", "Koble fra {{domain}}", { domain: project.custom_domain })}
              </button>
            )}
          </div>

          {mode === "subdomain" && (
            <div className="flex flex-col gap-2 md:w-48">
              <label className="font-body text-[15px] text-ink/70">
                {t("dns.subdomain_label")}
              </label>
              <input
                type="text"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                placeholder="app"
                className="field-ink px-[14px] py-[12px] font-mono text-[14px] outline-none placeholder:text-ink/40"
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="font-body text-[15px] text-ink/70">{t("dns.domain_type")}</span>
            <div className="inline-flex rounded-[12px] bg-muted p-1">
              <button
                type="button"
                onClick={() => setMode("root")}
                className={`rounded-none px-4 py-2 font-body text-[15px] transition-all ${
                  mode === "root" ? "bg-paper text-ink font-semibold" : "text-ink/70 hover:text-ink"
                }`}
              >
                {t("dns.mode_root", { domain: displayDomain })}
              </button>
              <button
                type="button"
                onClick={() => setMode("subdomain")}
                className={`rounded-none px-4 py-2 font-body text-[15px] transition-all ${
                  mode === "subdomain"
                    ? "bg-paper text-ink font-semibold"
                    : "text-ink/70 hover:text-ink"
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
          className="ink-card-lg anim-rise [--anim-delay:90ms] px-6 md:px-8"
        >
          {project.custom_domain && (
            <AccordionItem value="status" className="border-outline-variant/30">
              <AccordionTrigger className="py-5 hover:no-underline">
                <span className="flex items-center gap-3">
                  <span className="font-display text-[26px] font-bold text-ink">
                    {t("dns.status_title", "Tilkobling")}
                  </span>
                  {status && (
                    <span className="font-body text-xs text-ink/70">
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
                <span className="font-display text-[26px] font-bold text-ink">
                  {t("dns.records_title")}
                </span>
                <span className="font-body text-xs text-ink/70">{records.length}</span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="stagger flex flex-col gap-4">
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
    <div className="lift flex flex-col gap-3 rounded-[12px] border border-hair bg-muted p-5 hover:border-line">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="rounded-none bg-sun px-3 py-1 font-mono text-xs font-bold text-ink">
            {record.type}
          </span>
          <span className="font-body text-xs text-ink/70">{record.description}</span>
        </div>

        <span className="font-mono text-xs text-ink/60">TTL: {record.ttl}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
        {/* Host / Navn */}
        <div className="flex items-center justify-between gap-3 rounded-[12px] bg-paper px-4 py-3">
          <div className="flex flex-col min-w-0">
            <span className="font-body text-[10px] tracking-wider text-ink/60 uppercase">
              {t("dns.name_host")}
            </span>
            <code className="font-mono text-sm text-ink truncate">{record.host}</code>
          </div>
          <CopyButton value={record.host} label={t("dns.name_host")} />
        </div>

        {/* Verdi / Peker til */}
        <div className="flex items-center justify-between gap-3 rounded-[12px] bg-paper px-4 py-3">
          <div className="flex flex-col min-w-0">
            <span className="font-body text-[10px] tracking-wider text-ink/60 uppercase">
              {t("dns.value_target")}
            </span>
            <code className="font-mono text-sm text-ink truncate">{record.value}</code>
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
      className={`btn-outline shrink-0 px-[12px] py-[6px] font-body text-[13px] ${
        copied ? "bg-sun" : ""
      }`}
    >
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
        <p className="font-body text-[16px] text-error">
          {t("dns.status_error", "Kunne ikke hente status akkurat nå.")}
        </p>
      )}

      {status && (
        <div className="flex flex-col divide-y divide-outline-variant/30">
          <DomainCheckRow label={t("dns.check_dns", "DNS peker hit")} check={status.dns} />
          <DomainCheckRow label={t("dns.check_route", "Rute aktiv")} check={status.route} />
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
        className="btn-outline self-start px-[14px] py-[7px] font-body text-[14px] disabled:cursor-wait"
      >
        {query.isFetching ? "…" : t("dns.status_recheck", "Sjekk på nytt")}
      </button>
    </div>
  );
}

function DomainCheckRow({ label, check }: { label: string; check: DomainCheck }) {
  // Tilstanden bæres av en 20 px rute, ikke av et ikon – og aldri av farge
  // alene: fylt svart, tomt med ramme og rød ramme har tre ulike former, så en
  // fargeblind leser ser forskjellen uten å måtte skille grønt fra rødt.
  const presentation = {
    ok: { glyph: "✓", box: "bg-ink text-paper border-line" },
    pending: { glyph: "·", box: "bg-paper text-ink border-line" },
    failed: { glyph: "✕", box: "bg-paper text-error border-error" },
  }[check.state];

  return (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span
        aria-hidden="true"
        className={`mt-[2px] flex h-[20px] w-[20px] shrink-0 items-center justify-center border-2 font-body text-[12px] font-bold leading-none ${presentation.box}`}
      >
        {presentation.glyph}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="font-body text-[15px] text-ink">{label}</span>
        <span className="font-body text-[13px] text-ink/70">{check.detail}</span>
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
