import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFormatters } from "@/lib/format";
import type { Project } from "@/lib/database.types";
import {
  getProjectAnalytics,
  type AnalyticsDimension,
  type AnalyticsDimensionItem,
} from "@/lib/api";

/**
 * Statistikkfanen.
 *
 * Tallene kommer fra Caddys access-logg, ikke fra et sporingsskript i kundens
 * app. Det er derfor ingenting å sette opp her, ingen kodesnutt å lime inn, og
 * ingen cookies – og derfor kan fanen også vise ting et sporingsskript aldri
 * ser: responstid, feilrate og båndbredde.
 */

type TimeRangeKey = "24h" | "7d" | "30d" | "ytd" | "all";

const TIME_RANGES: Array<{ key: TimeRangeKey; label: string }> = [
  { key: "24h", label: "Siste 24t" },
  { key: "7d", label: "Siste 7 dager" },
  { key: "30d", label: "Siste 30 dager" },
  { key: "ytd", label: "Hittil i år" },
  { key: "all", label: "Alt" },
];

const DIMENSION_TABS: Array<{ key: AnalyticsDimension; label: string }> = [
  { key: "path", label: "Mest besøkt" },
  { key: "referrer", label: "Trafikkilder" },
  { key: "browser", label: "Nettlesere" },
  { key: "device", label: "Enheter" },
  { key: "country", label: "Land" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Oppløsningen utledes av hvor langt vinduet er, ikke av hvilken knapp som ble
 * trykket. «Alt» på et prosjekt som er tre dager gammelt skal tegnes per dag,
 * ikke per måned.
 */
function resolveRange(
  key: TimeRangeKey,
  createdAt: string,
): { from: number; to: number; unit: string } {
  const to = Date.now();
  const created = new Date(createdAt).getTime();

  const from =
    key === "24h"
      ? to - DAY_MS
      : key === "7d"
        ? to - 7 * DAY_MS
        : key === "30d"
          ? to - 30 * DAY_MS
          : key === "ytd"
            ? new Date(new Date().getFullYear(), 0, 1).getTime()
            : Number.isFinite(created)
              ? created
              : to - 365 * DAY_MS;

  const span = to - from;
  const unit = span <= 2 * DAY_MS ? "hour" : span <= 92 * DAY_MS ? "day" : "month";

  return { from, to, unit };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function KpiCard({
  label,
  value,
  suffix,
  loading,
}: {
  label: string;
  value: string;
  suffix: string;
  loading: boolean;
}) {
  return (
    <div className="ink-card flex flex-col justify-between px-[23px] py-[25px]">
      <span className="font-body text-[15px] font-normal uppercase tracking-[0.08em] text-ink/70">
        {label}
      </span>
      <div className="mt-[14px] flex items-baseline gap-[8px]">
        <span className="font-display text-[36px] font-bold leading-none text-ink">
          {loading ? "…" : value}
        </span>
        <span className="font-body text-[13px] font-normal text-ink/70">{suffix}</span>
      </div>
    </div>
  );
}

export function AnalyticsTab({ project }: { project: Project }) {
  // Tallene formateres etter visningsspråket, ikke etter «nb-NO» uansett hvem
  // som leser. «1 234» og «1,234» er samme tall, men bare det ene er lesbart
  // for den som har valgt engelsk.
  const format = useFormatters();
  const [selectedRange, setSelectedRange] = useState<TimeRangeKey>("30d");
  const [dimension, setDimension] = useState<AnalyticsDimension>("path");

  // Vinduet regnes ut én gang per valg, ikke på hver render. Uten dette flytter
  // `to` seg for hver eneste tegning, og React Query får en ny queryFn i ett kjør.
  const range = useMemo(
    () => resolveRange(selectedRange, project.created_at),
    [selectedRange, project.created_at],
  );

  // Ett kall dekker nøkkeltall, graf og alle dimensjonene. Fanebytte nedenfor
  // koster derfor ingen nettverkstrafikk i det hele tatt.
  const query = useQuery({
    queryKey: ["analytics", project.id, selectedRange],
    queryFn: () => getProjectAnalytics(project.id, range.from, range.to, range.unit),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const totals = query.data?.totals;
  const series = query.data?.series ?? [];
  const items: AnalyticsDimensionItem[] = query.data?.dims?.[dimension] ?? [];

  const maxValue = Math.max(10, ...series.map((p) => Math.max(p.pageviews, p.visits)));
  const maxHits = Math.max(1, items[0]?.hits ?? 1);

  const viewsPerVisit =
    totals && totals.visits > 0 ? (totals.pageviews / totals.visits).toFixed(1) : "0.0";
  const errorRate =
    totals && totals.requests > 0
      ? ((totals.errors_5xx / totals.requests) * 100).toFixed(2)
      : "0.00";

  // `format.locale` og ikke «nb-NO»: aksen skal si «7 Aug» til en som leser
  // engelsk. Formatteringsvalgene varierer med bøttestørrelsen, så denne bygges
  // per kall i stedet for å ligge i `Formatters`.
  const labelFor = (iso: string) =>
    new Date(iso).toLocaleDateString(format.locale, {
      day: "numeric",
      month: "short",
      ...(range.unit === "hour" ? { hour: "2-digit" } : {}),
      ...(range.unit === "month" ? { day: undefined, year: "2-digit" } : {}),
    });

  // Hvor mange søyler som får en dato under seg, slik at aksen ikke overlapper.
  const labelEvery = Math.max(1, Math.ceil(series.length / 8));

  // Land fylles bare når GeoIP-databasen er installert. Er den ikke det, er en
  // tom fane bare forvirrende – da skjuler vi den heller.
  const tabs = DIMENSION_TABS.filter(
    (tab) => tab.key !== "country" || (query.data?.dims?.country?.length ?? 0) > 0,
  );

  return (
    <div className="flex flex-col gap-8">
      {/* Overskrift og tidsfilter */}
      <div className="ink-card-lg p-6 md:p-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-[26px] font-bold text-ink">Trafikkanalyse</h2>
          <span className="swoosh mt-[6px]" aria-hidden="true" />
          <p className="mt-1 font-body text-[16px] text-ink/70">
            Måles automatisk for {project.name}. Ingen sporingskode i appen din, ingen cookies,
            ingen IP-adresser lagret.
          </p>
        </div>

        <div className="inline-flex border-2 border-ink">
          {TIME_RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setSelectedRange(r.key)}
              className={`border-r-2 border-ink px-[14px] py-[7px] font-body text-[13px] transition-colors last:border-r-0 md:text-[15px] ${
                selectedRange === r.key
                  ? "bg-ink font-bold text-paper"
                  : "bg-paper text-ink hover:bg-sun"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Nøkkeltall */}
      <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Unike besøkende"
          value={format.number(query.data?.visitors ?? 0)}
          suffix="personer"
          loading={query.isLoading}
        />
        <KpiCard
          label="Sidevisninger"
          value={format.number(totals?.pageviews ?? 0)}
          suffix="visninger"
          loading={query.isLoading}
        />
        <KpiCard
          label="Visninger per besøk"
          value={viewsPerVisit}
          suffix="sider / besøk"
          loading={query.isLoading}
        />
        <KpiCard
          label="Responstid"
          value={formatDuration(totals?.avg_duration_ms ?? 0)}
          suffix="i snitt"
          loading={query.isLoading}
        />
      </div>

      {/* Driftstall – dette ser en logg, men aldri et sporingsskript. */}
      <div className="grid grid-cols-2 gap-[16px] lg:grid-cols-4">
        {[
          { label: "Forespørsler", value: format.number(totals?.requests ?? 0) },
          { label: "Båndbredde", value: formatBytes(totals?.bytes_out ?? 0) },
          { label: "Serverfeil (5xx)", value: `${errorRate} %` },
          { label: "Robottrafikk", value: format.number(totals?.bot_requests ?? 0) },
        ].map((stat) => (
          <div key={stat.label} className="border-2 border-ink px-[16px] py-[14px]">
            <p className="truncate font-mono text-[15px] font-bold text-ink">
              {query.isLoading ? "…" : stat.value}
            </p>
            <p className="truncate font-body text-[12px] uppercase tracking-[0.08em] text-ink/70">
              {stat.label}
            </p>
          </div>
        ))}
      </div>

      {/* Graf */}
      <div className="ink-card-lg p-6 md:p-8 flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h3 className="font-display text-[22px] font-bold text-ink">Besøk over tid</h3>
          <div className="flex items-center gap-4 text-xs font-body">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-none bg-ink" />
              <span className="text-ink/70">Sidevisninger</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-none bg-sun" />
              <span className="text-ink/70">Besøk</span>
            </div>
          </div>
        </div>

        <div className="h-64 w-full relative flex items-end gap-2 pt-6 pb-8">
          {query.isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center font-body text-[16px] text-ink/70">
              Laster statistikk…
            </div>
          ) : series.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-4">
              <span className="swoosh mb-[10px]" aria-hidden="true" />
              <p className="font-body text-[16px] text-ink/70">
                Ingen registrerte besøk i valgt periode.
              </p>
              <p className="font-body text-xs text-ink/60 mt-1">
                Målingen er allerede aktiv – tallene kommer så snart noen besøker siden.
              </p>
            </div>
          ) : (
            <div className="flex h-full w-full items-end gap-1.5">
              {series.map((point, idx) => (
                <div
                  key={point.t}
                  className="group relative flex-1 h-full flex flex-col justify-end items-center"
                >
                  <div className="absolute -top-12 z-20 hidden group-hover:flex flex-col items-center rounded-none bg-mutedest px-3 py-1.5 text-xs font-mono pointer-events-none whitespace-nowrap">
                    <span className="text-ink font-semibold">{labelFor(point.t)}</span>
                    <span className="text-ink">{format.number(point.pageviews)} sidevisninger</span>
                    <span className="text-ink">{format.number(point.visits)} besøk</span>
                  </div>

                  <div className="w-full flex items-end justify-center gap-0.5 h-full">
                    <div
                      className="w-full max-w-[12px] bg-sun rounded-t-sm transition-all group-hover:bg-ink"
                      style={{ height: `${Math.max(2, (point.pageviews / maxValue) * 100)}%` }}
                    />
                    <div
                      className="w-full max-w-[12px] bg-sun rounded-t-sm transition-all group-hover:bg-sun"
                      style={{ height: `${Math.max(0, (point.visits / maxValue) * 100)}%` }}
                    />
                  </div>

                  <span className="absolute -bottom-6 text-[10px] font-mono text-ink/60 truncate max-w-full">
                    {idx % labelEvery === 0 ? labelFor(point.t) : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Dimensjoner */}
      <div className="ink-card-lg p-6 md:p-8 flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h3 className="font-display text-[22px] font-bold text-ink">Målinger og trafikkilder</h3>
          <div className="flex flex-wrap gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setDimension(tab.key)}
                className={`border-2 border-ink px-[12px] py-[6px] font-body text-[13px] transition-colors md:text-[15px] ${
                  dimension === tab.key
                    ? "bg-ink font-bold text-paper"
                    : "bg-paper text-ink hover:bg-sun"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {query.isLoading ? (
          <p className="font-body text-[16px] text-ink/70">Laster målinger…</p>
        ) : items.length === 0 ? (
          <p className="font-body text-[16px] text-ink/70">Ingen data i denne kategorien ennå.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((item, idx) => (
              <div
                key={item.value}
                className="relative overflow-hidden rounded-[12px] bg-muted p-3 flex items-center justify-between gap-3"
              >
                <div
                  className="absolute inset-y-0 left-0 bg-sun rounded-[12px] transition-all duration-500 pointer-events-none"
                  style={{ width: `${Math.round((item.hits / maxHits) * 100)}%` }}
                />

                <div className="relative z-10 flex items-center gap-3 min-w-0">
                  <span className="font-mono text-xs font-semibold text-ink/60 w-5 shrink-0">
                    #{idx + 1}
                  </span>
                  <span className="font-body text-[16px] text-ink font-medium break-all">
                    {item.value}
                  </span>
                </div>

                <div className="relative z-10 flex items-center gap-2 shrink-0">
                  <span className="font-mono text-sm font-bold text-ink">
                    {format.number(item.hits)}
                  </span>
                  <span className="font-body text-xs text-ink/70">visninger</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {dimension === "country" && (
          <p className="font-body text-xs text-ink/60">IP-geolokalisering fra DB-IP</p>
        )}
      </div>
    </div>
  );
}
