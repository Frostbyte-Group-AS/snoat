import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  deployPlattform,
  getPlattform,
  getPlattformLogg,
  settPlattformPause,
  type PlattformBygg,
} from "@/lib/api";

/**
 * Snoat selv, som et kort blant prosjektene – kun eierkontoen.
 *
 * Plattformen deployes ikke av Snoat-pipelinen (den kan ikke bygge og restarte
 * seg selv), men av selvoppdateringen på verten, som ser etter ny commit på
 * main hvert minutt (`infra/selvoppdatering/`). Kortet viser det den har
 * skrevet: hva som kjører, byggene og loggene, og kan bestille en deploy eller
 * sette automatikken på pause.
 */
export function PlattformKort() {
  const { t } = useTranslation();
  const [apen, setApen] = useState(false);
  const status = useQuery({
    queryKey: ["plattform"],
    queryFn: getPlattform,
    // Raskere mens noe bygger, så kortet går over til «Live» når det er ferdig.
    refetchInterval: (query) =>
      query.state.data?.kjorer || query.state.data?.ventendeBestillinger ? 5_000 : 30_000,
  });

  const data = status.data;
  if (!data?.aktivert) return null;

  const siste = data.bygg[0];
  const merke =
    data.kjorer || data.ventendeBestillinger > 0
      ? { tekst: t("plattform.status_building"), klasse: "bg-sun text-ink" }
      : siste && (siste.status === "feilet" || siste.status === "rullet_tilbake")
        ? { tekst: t("plattform.status_failed"), klasse: "bg-error text-paper" }
        : data.pause
          ? { tekst: t("plattform.status_paused"), klasse: "bg-ash text-ink" }
          : { tekst: t("plattform.status_live"), klasse: "bg-ink text-paper" };

  const kjorerMain = data.deployetCommit !== null && data.deployetCommit === data.mainCommit;

  return (
    <article
      onClick={() => setApen(true)}
      className="ink-card lift flex min-w-0 cursor-pointer flex-col gap-[14px] px-[23px] py-[25px] hover:bg-sun-soft"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-[10px]">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center bg-ink font-body text-[13px] font-bold leading-none text-paper"
          >
            S
          </span>
          <h3 className="truncate font-body text-[20px] font-normal text-ink">snoat</h3>
        </div>
        <span
          className={`shrink-0 border-2 border-line px-[8px] py-[2px] font-body text-[12px] font-bold uppercase tracking-[0.08em] ${merke.klasse}`}
        >
          {merke.tekst}
        </span>
      </div>

      <p className="font-body text-[14px] font-light text-ink/70">{t("plattform.desc")}</p>

      <hr className="hairline" />

      <div className="mt-auto flex flex-col gap-[4px] font-body text-[14px] text-ink">
        <span className="truncate">
          <code className="font-mono text-[13px]">{data.deployetCommit?.slice(0, 7) ?? "–"}</code>{" "}
          {siste?.commit === data.deployetCommit ? siste?.melding : ""}
        </span>
        <span className="font-light text-ink/70">
          {kjorerMain
            ? t("plattform.on_main")
            : t("plattform.behind_main", { main: data.mainCommit?.slice(0, 7) ?? "–" })}
        </span>
      </div>

      {apen && <PlattformDialog onClose={() => setApen(false)} />}
    </article>
  );
}

function PlattformDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [valgt, setValgt] = useState<string | null>(null);
  const status = useQuery({ queryKey: ["plattform"], queryFn: getPlattform });
  const data = status.data;

  const deploy = useMutation({
    mutationFn: (commit: string | null) => deployPlattform(commit),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plattform"] }),
  });
  const pause = useMutation({
    mutationFn: (verdi: boolean) => settPlattformPause(verdi),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plattform"] }),
  });

  const opptatt = Boolean(data?.kjorer || data?.ventendeBestillinger);

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex cursor-default items-center justify-center bg-ink/40 px-5"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className="ink-card-lg anim-pop max-h-[calc(100dvh-40px)] w-full max-w-[720px] overflow-y-auto px-[30px] py-[32px]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="font-display text-[28px] font-bold text-ink">{t("plattform.title")}</h2>
        <span className="swoosh anim-draw mt-[6px] mb-[18px]" aria-hidden="true" />

        <p className="font-body text-[15px] font-light leading-[1.5] text-ink">
          {t("plattform.explain", { repo: data?.repo ?? "" })}
        </p>

        {data?.pause && (
          <p className="mt-[12px] border-2 border-line px-[14px] py-[10px] font-body text-[14px] text-ink">
            {t("plattform.paused_note")}
          </p>
        )}
        {data?.feiletCommit && data.feiletCommit === data.mainCommit && (
          <p className="mt-[12px] border-2 border-error px-[14px] py-[10px] font-body text-[14px] text-error">
            {t("plattform.failed_note", { commit: data.feiletCommit.slice(0, 7) })}
          </p>
        )}

        <div className="mt-[18px] flex flex-wrap gap-[12px]">
          <button
            type="button"
            disabled={opptatt || deploy.isPending}
            onClick={() => {
              if (window.confirm(t("plattform.deploy_confirm"))) deploy.mutate(null);
            }}
            className="btn-ink h-[42px] px-[20px] font-display text-[15px]"
          >
            {opptatt ? t("plattform.status_building") : t("plattform.deploy_main")}
          </button>
          <button
            type="button"
            disabled={pause.isPending}
            onClick={() => pause.mutate(!data?.pause)}
            className="btn-outline h-[42px] px-[20px] font-display text-[15px]"
          >
            {data?.pause ? t("plattform.resume") : t("plattform.pause")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-outline ml-auto h-[42px] px-[20px] font-display text-[15px]"
          >
            {t("dashboard.close_notice")}
          </button>
        </div>

        {(deploy.isError || pause.isError) && (
          <p role="alert" className="mt-[12px] font-body text-[14px] text-error">
            {(deploy.error ?? pause.error)?.message}
          </p>
        )}

        <h3 className="mt-[24px] font-display text-[20px] font-bold text-ink">
          {t("plattform.builds")}
        </h3>
        <ul className="mt-[10px] flex flex-col">
          {(data?.bygg ?? []).map((bygg) => (
            <ByggRad
              key={bygg.id}
              bygg={bygg}
              valgt={valgt === bygg.id}
              kjorer={bygg.commit === data?.deployetCommit}
              onVelg={() => setValgt(valgt === bygg.id ? null : bygg.id)}
              onRullTilbake={
                bygg.status === "ok" && bygg.commit !== data?.deployetCommit && !opptatt
                  ? () => {
                      if (
                        window.confirm(
                          t("plattform.rollback_confirm", { commit: bygg.commit.slice(0, 7) }),
                        )
                      ) {
                        deploy.mutate(bygg.commit);
                      }
                    }
                  : null
              }
            />
          ))}
          {data?.bygg.length === 0 && (
            <li className="font-body text-[14px] font-light text-ink/70">
              {t("plattform.no_builds")}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function ByggRad({
  bygg,
  valgt,
  kjorer,
  onVelg,
  onRullTilbake,
}: {
  bygg: PlattformBygg;
  valgt: boolean;
  kjorer: boolean;
  onVelg: () => void;
  onRullTilbake: (() => void) | null;
}) {
  const { t, i18n } = useTranslation();
  const logg = useQuery({
    queryKey: ["plattform-logg", bygg.id, bygg.status],
    queryFn: () => getPlattformLogg(bygg.id),
    enabled: valgt,
    refetchInterval: valgt && bygg.status === "bygger" ? 4_000 : false,
  });
  const tid = new Intl.DateTimeFormat(i18n.language.startsWith("en") ? "en-GB" : "nb-NO", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(bygg.startet));

  return (
    <li className="border-t-2 border-line py-[10px] first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px] font-body text-[14px] text-ink">
        <span className="w-[110px] shrink-0 font-bold uppercase tracking-[0.06em] text-[12px]">
          {t(`plattform.build_${bygg.status}`)}
          {kjorer ? ` · ${t("plattform.running")}` : ""}
        </span>
        <code className="font-mono text-[13px]">{bygg.commit.slice(0, 7)}</code>
        <span className="min-w-0 flex-1 truncate">{bygg.melding}</span>
        <span className="font-light text-ink/70">{tid}</span>
        <button type="button" onClick={onVelg} className="underline-offset-4 hover:underline">
          {valgt ? t("plattform.hide_log") : t("plattform.show_log")}
        </button>
        {onRullTilbake && (
          <button
            type="button"
            onClick={onRullTilbake}
            className="underline-offset-4 hover:underline"
          >
            {t("plattform.rollback")}
          </button>
        )}
      </div>
      {bygg.feil && <p className="mt-[4px] font-mono text-[12px] text-error">{bygg.feil}</p>}
      {valgt && (
        <pre className="mt-[8px] max-h-[360px] overflow-auto bg-ink px-[12px] py-[10px] font-mono text-[12px] leading-[1.45] text-paper">
          {logg.data?.logg ?? (logg.isError ? logg.error.message : t("plattform.loading_log"))}
        </pre>
      )}
    </li>
  );
}
