import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import {
  ApiError,
  getSudoAccess,
  getSudoOversikt,
  type SudoBruker,
  type SudoProsjekt,
} from "@/lib/api";
import { useFormatters } from "@/lib/format";

/**
 * Sudo – alle brukere og alle prosjekter på plattformen.
 *
 * Fanen vises bare når `/api/sudo/tilgang` sier `sudo: true`, men det er backend
 * som håndhever grensen: `/api/sudo` svarer 403 for alle andre, og for eierkontoen
 * selv når kallet kommer med API-nøkkel eller via MCP. Se `routes/sudo.ts`.
 */
export const Route = createFileRoute("/settings/sudo")({
  head: () => ({
    meta: [{ title: "Sudo — Snoat" }, { name: "robots", content: "noindex" }],
  }),
  component: SudoPage,
});

function feiltekst(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

function SudoPage() {
  const { t } = useTranslation();
  const access = useQuery({ queryKey: ["sudo-access"], queryFn: getSudoAccess });
  const oversikt = useQuery({
    queryKey: ["sudo"],
    queryFn: getSudoOversikt,
    enabled: Boolean(access.data?.sudo),
    refetchInterval: 30_000,
  });

  if (access.isLoading)
    return <p className="font-body text-[16px] text-ink/70">{t("sudo.loading")}</p>;
  if (!access.data?.sudo) return null;

  const data = oversikt.data;
  const eierIder = new Set(data?.brukere.filter((b) => b.eier).map((b) => b.id));
  const andres = data?.prosjekter.filter((p) => !eierIder.has(p.brukerId)) ?? [];
  const egne = data?.prosjekter.filter((p) => eierIder.has(p.brukerId)) ?? [];

  return (
    <div className="flex flex-col gap-[31px]">
      <section className="ink-card-lg anim-rise flex flex-col gap-3 px-[30px] py-[32px]">
        <span className="w-fit bg-sun px-[8px] py-[2px] font-body text-[12px] font-bold uppercase tracking-[0.1em] text-ink">
          {t("sudo.eyebrow")}
        </span>
        <h2 className="font-display text-[28px] font-bold text-ink">{t("sudo.title")}</h2>
        <p className="max-w-2xl font-body text-[16px] text-ink/70">{t("sudo.intro")}</p>
      </section>

      {oversikt.error && (
        <p className="border-2 border-line px-[16px] py-[12px] font-body text-[15px] text-ink">
          {feiltekst(oversikt.error)}
        </p>
      )}
      {oversikt.isLoading && (
        <p className="font-body text-[16px] text-ink/70">{t("sudo.loading")}</p>
      )}

      {data && (
        <>
          <section className="ink-card-lg px-[30px] py-[28px]">
            <dl className="grid grid-cols-2 gap-4 font-body text-[15px] sm:grid-cols-4">
              {[
                [t("sudo.stat_users"), data.brukere.length],
                [t("sudo.stat_projects"), data.prosjekter.length],
                [t("sudo.stat_others"), andres.length],
                [t("sudo.stat_running"), data.prosjekter.filter((p) => p.kjorer === true).length],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1">
                  <dt className="text-ink/60">{label}</dt>
                  <dd className="font-display text-[28px] font-bold text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <BrukerListe brukere={data.brukere} />

          <ProsjektListe
            tittel={t("sudo.others_title")}
            tom={t("sudo.others_empty")}
            prosjekter={andres}
            visEier
          />
          <ProsjektListe tittel={t("sudo.mine_title")} prosjekter={egne} />
        </>
      )}
    </div>
  );
}

function BrukerListe({ brukere }: { brukere: SudoBruker[] }) {
  const { t } = useTranslation();
  const format = useFormatters();

  return (
    <section className="ink-card-lg flex flex-col gap-4 px-[30px] py-[28px]">
      <h3 className="font-display text-[22px] font-bold text-ink">{t("sudo.users_title")}</h3>
      <ul className="flex flex-col gap-3">
        {brukere.map((b) => (
          <li
            key={b.id}
            className="flex flex-col gap-1 border-2 border-line px-[18px] py-[14px] font-body text-[15px] text-ink"
          >
            <span className="flex flex-wrap items-center gap-2 font-bold">
              {b.epost ?? b.id}
              {b.brukernavn && <span className="font-normal text-ink/60">@{b.brukernavn}</span>}
              {b.eier && (
                <span className="bg-sun px-[6px] py-[1px] text-[12px] uppercase tracking-[0.1em]">
                  {t("sudo.owner")}
                </span>
              )}
              <span className="border-2 border-line px-[6px] py-[1px] text-[12px] uppercase tracking-[0.1em]">
                {b.plan}
                {b.planStatus && b.planStatus !== "active" ? ` · ${b.planStatus}` : ""}
              </span>
            </span>
            <span className="text-ink/70">
              {b.antallProsjekter} {t("sudo.projects")} · {b.antallKjorende} {t("sudo.running")} ·{" "}
              {b.antallOmdirigeringer} {t("sudo.redirects")}
            </span>
            <span className="text-[14px] text-ink/60">
              {t("sudo.signed_up")} {format.date(b.opprettet)} · {t("sudo.last_login")}{" "}
              {b.sistInnlogget ? format.dateTime(b.sistInnlogget) : t("sudo.never")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProsjektListe({
  tittel,
  tom,
  prosjekter,
  visEier = false,
}: {
  tittel: string;
  tom?: string;
  prosjekter: SudoProsjekt[];
  visEier?: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormatters();

  if (prosjekter.length === 0 && !tom) return null;

  const status = (p: SudoProsjekt) =>
    p.stoppet
      ? t("sudo.status_stopped")
      : p.statisk
        ? t("sudo.static")
        : p.kjorer === null
          ? t("sudo.status_unknown")
          : p.kjorer
            ? t("sudo.status_running")
            : t("sudo.status_down");

  return (
    <section className="ink-card-lg flex flex-col gap-4 px-[30px] py-[28px]">
      <h3 className="font-display text-[22px] font-bold text-ink">
        {tittel} <span className="font-normal text-ink/60">({prosjekter.length})</span>
      </h3>
      {prosjekter.length === 0 && <p className="font-body text-[15px] text-ink/70">{tom}</p>}
      <ul className="flex flex-col gap-3">
        {prosjekter.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-1 border-2 border-line px-[18px] py-[14px] font-body text-[15px] text-ink"
          >
            <span className="flex flex-wrap items-center gap-2 font-bold">
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 hover:underline"
              >
                {p.navn}
              </a>
              <span className="font-normal text-ink/60">· {status(p)}</span>
              {p.devSide && (
                <span className="border-2 border-line px-[6px] py-[1px] text-[12px] uppercase tracking-[0.1em]">
                  {t("sudo.dev")}
                </span>
              )}
            </span>
            {visEier && <span className="text-ink/80">{p.epost ?? p.brukerId}</span>}
            <span className="break-all text-[14px] text-ink/70">
              {p.repoUrl}
              {p.branch ? ` (${p.branch})` : ""}
              {p.customDomain ? ` · ${p.customDomain}` : ""}
            </span>
            <span className="text-[14px] text-ink/60">
              {t("sudo.last_deploy")}:{" "}
              {p.sisteDeploy
                ? `${p.sisteDeploy.status} · ${format.dateTime(p.sisteDeploy.tidspunkt)}`
                : t("sudo.no_deploys")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
