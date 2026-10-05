import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { listVps, type Vps } from "@/lib/api";

/**
 * VPS-ene på dashboardet, under prosjektene – kun eierkontoen.
 *
 * De ble tidligere bare vist under Innstillinger → VPS-er, og var i praksis
 * usynlige. Her står de der man ser alt annet man har satt opp. Kortet går inn
 * til VPS-siden; SSH-kommandoen kan kopieres rett fra kortet.
 */
export function VpsOverview({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: ["vps"], queryFn: listVps, enabled, refetchInterval: 15_000 });
  const vps = list.data?.vps ?? [];
  if (!enabled || vps.length === 0) return null;

  return (
    <section className="mt-[56px]">
      <h2 className="font-display text-[26px] font-bold text-ink">{t("vps.overview_title")}</h2>
      <span className="swoosh mt-[6px] mb-[24px]" aria-hidden="true" />
      <div className="stagger grid grid-cols-1 gap-[31px] md:grid-cols-2 lg:grid-cols-3">
        {vps.map((v) => (
          <VpsCard key={v.vmid} vps={v} />
        ))}
      </div>
    </section>
  );
}

function VpsCard({ vps }: { vps: Vps }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [kopi, setKopi] = useState<"klar" | "kopiert" | "feilet">("klar");
  const tall = new Intl.NumberFormat(i18n.language.startsWith("en") ? "en-GB" : "nb-NO", {
    maximumFractionDigits: 1,
  });
  const gb = (mb: number | null) => (mb === null ? "–" : `${tall.format(mb / 1024)} GB`);
  const kjorer = vps.status === "running";

  return (
    <article
      onClick={() => void navigate({ to: "/settings/vps" })}
      className="ink-card lift flex min-w-0 cursor-pointer flex-col gap-[14px] px-[23px] py-[25px] hover:bg-sun-soft"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-[10px]">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center bg-ink font-body text-[13px] font-bold leading-none text-paper"
          >
            {vps.name.slice(0, 1).toUpperCase()}
          </span>
          <h3 className="truncate font-body text-[20px] font-normal text-ink">{vps.name}</h3>
        </div>
        <span
          // Samme språk som DeploymentStatusBadge: svart = kjører (som «Live»),
          // grå = hviler.
          className={`shrink-0 border-2 border-line px-[8px] py-[2px] font-body text-[12px] font-bold uppercase tracking-[0.08em] ${
            kjorer ? "bg-ink text-paper" : "bg-ash text-ink"
          }`}
        >
          {kjorer ? t("vps.status_running") : t("vps.status_stopped")}
        </span>
      </div>

      <p className="font-body text-[14px] font-light text-ink/70">
        {vps.cores ?? "–"} CPU · RAM {gb(vps.memoryUsedMb)}
        {vps.memoryMinMb > 0 ? ` (min ${gb(vps.memoryMinMb)})` : ""} · disk {vps.diskUsedGb ?? "–"}/
        {vps.diskGb ?? "–"} GB
      </p>

      <hr className="hairline" />

      {vps.ssh ? (
        <button
          type="button"
          title={t("vps.form.copy")}
          onClick={(event) => {
            event.stopPropagation();
            if (!navigator.clipboard) {
              setKopi("feilet");
              return;
            }
            navigator.clipboard.writeText(vps.ssh?.command ?? "").then(
              () => {
                setKopi("kopiert");
                setTimeout(() => setKopi("klar"), 1500);
              },
              () => setKopi("feilet"),
            );
          }}
          className="mt-auto flex items-center justify-between gap-3 text-left"
        >
          <code className="min-w-0 truncate font-mono text-[13px] text-ink">{vps.ssh.command}</code>
          <span className="shrink-0 font-body text-[13px] text-ink/70">
            {kopi === "kopiert"
              ? t("vps.form.copied")
              : kopi === "feilet"
                ? t("vps.wizard.copy_failed")
                : t("vps.form.copy")}
          </span>
        </button>
      ) : (
        <span className="mt-auto font-mono text-[13px] text-ink/50">{vps.ip ?? "–"}</span>
      )}
    </article>
  );
}
