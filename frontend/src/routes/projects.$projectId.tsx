import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SnoatLogo } from "@/components/SnoatLogo";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Mark } from "@/components/Mark";
import { DeploymentStatusBadge } from "@/components/DeploymentStatusBadge";
import { DnsSettingsTab } from "@/components/DnsSettingsTab";
import { AnalyticsTab } from "@/components/AnalyticsTab";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useAuth, displayName, avatarUrl } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import {
  createCheckout,
  deployProject,
  getPricing,
  stopProject,
  updateCustomDomain,
} from "@/lib/api";
import { useApiErrorMessage } from "@/lib/errors";
import { useFormatters } from "@/lib/format";
import { useRequestedMarket } from "@/lib/market";
import type { Deployment, Project, SubscriptionTier } from "@/lib/database.types";

export const Route = createFileRoute("/projects/$projectId")({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => {
    return {
      tab: typeof search.tab === "string" ? search.tab : undefined,
    };
  },
  component: ProjectDetailPage,
});

type Tab = "deployments" | "terminal" | "analytics" | "dns" | "mcp" | "env" | "settings";

/** Fanene i prosjektvisningen, i den rekkefølgen de vises. */
const TABS: ReadonlyArray<{ id: Tab; labelKey: string }> = [
  { id: "deployments", labelKey: "project.tab_deployments" },
  { id: "terminal", labelKey: "project.tab_terminal" },
  { id: "analytics", labelKey: "project.tab_analytics" },
  { id: "dns", labelKey: "project.tab_dns" },
  { id: "env", labelKey: "project.tab_env" },
  { id: "settings", labelKey: "project.tab_settings" },
];

function ProjectDetailPage() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<Tab>((search.tab as Tab) || "deployments");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) void navigate({ to: "/login" });
  }, [loading, user, navigate]);

  // Fetch Project
  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from("projects")
        .select("*")
        .eq("id", projectId)
        .single();
      if (error) throw error;
      return data as Project;
    },
    enabled: Boolean(user && projectId),
  });

  // Fetch Deployments for this project
  const deploymentsQuery = useQuery({
    queryKey: ["deployments", projectId],
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from("deployments")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Deployment[];
    },
    enabled: Boolean(user && projectId),
    refetchInterval: (query) => {
      const latest = query.state.data?.[0];
      const isBuilding = latest?.status === "queued" || latest?.status === "building";
      return isBuilding ? 2000 : false;
    },
  });

  const project = projectQuery.data;
  const deployments = deploymentsQuery.data ?? [];
  const latestDeployment = deployments[0] ?? null;
  const isBuilding =
    latestDeployment?.status === "queued" || latestDeployment?.status === "building";
  /** Brukeren har slått av appen. Backend nullstiller feltet ved neste deployment. */
  const isStopped = Boolean(project?.stopped_at);

  const deployMutation = useMutation({
    mutationFn: () => deployProject(projectId),
    onSuccess: async () => {
      setError(null);
      setActiveTab("terminal");
      await queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const stopMutation = useMutation({
    mutationFn: () => stopProject(projectId),
    onSuccess: async () => {
      setError(null);
      // `project` må med: det er `projects.stopped_at` som gjør stoppen synlig.
      // Uten denne invalideringen sto siden igjen og sa «Live» om en app som var
      // borte – det var nettopp derfor knappen så ut som den ikke gjorde noe.
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const domainMutation = useMutation({
    mutationFn: (domain: string | null) => updateCustomDomain(projectId, domain),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  if (loading || projectQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="font-body text-[16px] text-ink/70">Laster prosjekt…</p>
      </div>
    );
  }

  if (projectQuery.isError || !project) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-4">
        <h1 className="font-display text-[22px] font-bold text-ink">Prosjektet ble ikke funnet</h1>
        <p className="mt-2 font-body text-[16px] text-ink/70">
          Prosjektet kan ha blitt slettet eller du har ikke tilgang.
        </p>
        <Link to="/dashboard" className="btn-ink mt-6 px-6 py-2.5 font-body text-[15px]">
          {t("project.back_to_projects")}
        </Link>
      </div>
    );
  }

  const repoLabel = project.repo_url
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "");

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      {/* Top Navigation */}
      <header className="sticky top-0 z-40 bg-ink/40">
        <div className="mx-auto flex max-w-[1334px] items-center justify-between px-5 py-4 lg:px-0">
          <div className="flex items-center gap-6">
            <Link to="/" className="inline-flex">
              <SnoatLogo />
            </Link>
            <span className="h-4 w-px bg-muted" />
            <Link
              to="/dashboard"
              className="flex items-center gap-1.5 font-body text-[15px] text-ink/70 transition-colors hover:text-ink"
            >
              <span aria-hidden="true">←</span>
              {t("project.back_to_projects")}
            </Link>
          </div>

          <div className="flex items-center gap-4">
            <LanguageSwitcher />
            {user && (
              <div className="flex items-center gap-3">
                {avatarUrl(user) ? (
                  <img
                    src={avatarUrl(user)!}
                    alt=""
                    className="h-8 w-8 rounded-none object-cover"
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-none bg-muted font-body text-[15px] text-ink">
                    {displayName(user)[0]?.toUpperCase()}
                  </div>
                )}
                <span className="hidden font-body text-[16px] text-ink md:inline">
                  {displayName(user)}
                </span>
                <button
                  type="button"
                  onClick={() => void signOut().then(() => navigate({ to: "/" }))}
                  className="font-body text-[15px] text-ink/70 transition-colors hover:text-ink"
                >
                  {t("project.logout")}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-[1334px] flex-grow px-5 py-[48px] lg:px-0">
        {/* Project Header */}
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-[32px] font-bold text-ink">{project.name}</h1>
              <DeploymentStatusBadge
                status={latestDeployment?.status ?? null}
                stopped={isStopped}
                stopping={stopMutation.isPending}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4 text-[16px]">
              <a
                href={project.repo_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-ink/70 transition-colors hover:text-ink"
              >
                {repoLabel}
              </a>

              {/* Begge adressene appen svarer på, ikke bare Snoat-adressen. Har
                  kunden koblet til et eget domene, er det som regel det hen
                  faktisk bruker – og fram til nå måtte hen inn i DNS-fanen for å
                  se om det virket. Lenkene skjules når appen er stoppet: en
                  lenke som ser levende ut, men gir 502, er verre enn ingen. */}
              {latestDeployment?.url && !isStopped ? (
                <>
                  <a
                    href={latestDeployment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-ink transition-opacity hover:opacity-80 font-medium"
                  >
                    {latestDeployment.url.replace(/^https?:\/\//, "")}
                  </a>

                  {project.custom_domain && (
                    <a
                      href={`https://${project.custom_domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-ink transition-opacity hover:opacity-80 font-medium"
                    >
                      {project.custom_domain}
                    </a>
                  )}
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-ink/60">
                  {t("project.no_live_url")}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Skjules når appen allerede er stoppet – det er ingenting igjen å
                stoppe, og en knapp som ikke gjør noe er akkurat det som fikk
                stoppen til å se ødelagt ut. */}
            {latestDeployment?.status === "success" && !isStopped && (
              <button
                type="button"
                onClick={() => stopMutation.mutate()}
                disabled={stopMutation.isPending}
                className="btn-outline border-error px-[16px] py-[10px] font-body text-[15px] text-error hover:bg-error hover:text-paper"
              >
                {stopMutation.isPending ? t("project_details.stopping") : t("project.stop_project")}
              </button>
            )}

            <button
              type="button"
              onClick={() => deployMutation.mutate()}
              disabled={deployMutation.isPending || isBuilding || stopMutation.isPending}
              className="btn-ink px-6 py-2.5 font-body text-[15px] disabled:opacity-50"
            >
              {isBuilding
                ? t("project.deploying")
                : isStopped
                  ? t("project.start_project")
                  : t("project.redeploy")}
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-6 border-2 border-error px-[18px] py-[14px] font-body text-[16px] text-error"
          >
            {error}
          </div>
        )}

        {/* Sliding Segmented Tab Control */}
        <SegmentedTabBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          isBuilding={isBuilding}
          t={t}
        />

        {/* Animated Tab Content Transition */}
        <div key={activeTab} className="animate-in fade-in-50 slide-in-from-top-1 duration-200">
          {activeTab === "deployments" && (
            <DeploymentsTab
              project={project}
              deployments={deployments}
              onOpenTerminal={() => setActiveTab("terminal")}
            />
          )}

          {activeTab === "terminal" && (
            <TerminalTab latestDeployment={latestDeployment} isBuilding={isBuilding} />
          )}

          {activeTab === "analytics" && <AnalyticsTab project={project} />}

          {activeTab === "dns" && (
            <DnsSettingsTab
              project={project}
              onSaveDomain={(domain) => domainMutation.mutate(domain)}
              isSaving={domainMutation.isPending}
            />
          )}

          {activeTab === "env" && <EnvTab project={project} />}

          {activeTab === "settings" && <SettingsTab project={project} />}
        </div>
      </main>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Component: Sliding Segmented Tab Bar
// -----------------------------------------------------------------------------
function SegmentedTabBar({
  activeTab,
  setActiveTab,
  isBuilding,
  t,
}: {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  isBuilding: boolean;
  t: (key: string) => string;
}) {
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  /**
   * Pillen posisjoneres i piksler etter den aktive knappen. Vi tar med topp og
   * høyde også: med fem faner brekker raden på mobil, og en indikator som kun
   * kjenner `left` ville blitt liggende igjen på første linje.
   */
  const [indicator, setIndicator] = useState({ left: 0, top: 0, width: 0, height: 0 });

  useEffect(() => {
    const update = () => {
      const activeEl = tabRefs.current[activeTab];
      if (!activeEl) return;
      setIndicator({
        left: activeEl.offsetLeft,
        top: activeEl.offsetTop,
        width: activeEl.offsetWidth,
        height: activeEl.offsetHeight,
      });
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [activeTab]);

  return (
    <div className="relative mb-8 inline-flex flex-wrap items-center border-2 border-ink">
      {/* Den aktive fanen er en svart flate som glir på plass. */}
      {indicator.width > 0 && (
        <div
          className="pointer-events-none absolute bg-ink transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          style={{
            left: `${indicator.left}px`,
            top: `${indicator.top}px`,
            width: `${indicator.width}px`,
            height: `${indicator.height}px`,
          }}
        />
      )}

      {TABS.map((tab) => (
        <button
          key={tab.id}
          ref={(el) => {
            tabRefs.current[tab.id] = el;
          }}
          type="button"
          onClick={() => setActiveTab(tab.id)}
          className={`relative z-10 flex items-center gap-2 px-[20px] py-[10px] font-body text-[15px] transition-colors duration-200 ${
            activeTab === tab.id ? "font-bold text-paper" : "text-ink hover:bg-sun"
          }`}
        >
          {t(tab.labelKey)}
          {tab.id === "terminal" && isBuilding && (
            <span
              aria-hidden="true"
              className={`ml-1 h-2 w-2 animate-pulse ${activeTab === tab.id ? "bg-sun" : "bg-ink"}`}
            />
          )}
        </button>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helper & Hook: Build Duration
// -----------------------------------------------------------------------------
export function useBuildDuration(deployment: Deployment | null): string | null {
  const isBuilding = deployment?.status === "queued" || deployment?.status === "building";
  const [elapsed, setElapsed] = useState<number>(() => {
    if (!isBuilding || !deployment?.created_at) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(deployment.created_at).getTime()) / 1000));
  });

  useEffect(() => {
    if (!isBuilding || !deployment?.created_at) return;

    const calculate = () => {
      const start = new Date(deployment.created_at).getTime();
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };

    calculate();
    const interval = setInterval(calculate, 1000);
    return () => clearInterval(interval);
  }, [isBuilding, deployment?.created_at]);

  if (!deployment) return null;

  if (isBuilding) {
    if (elapsed < 60) return `${elapsed}s`;
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}m ${s < 10 ? "0" : ""}${s}s`;
  }

  if (deployment.logs) {
    const match = deployment.logs.match(/(?:Ferdig på|Feilet etter)\s+([\d.]+)s/i);
    if (match?.[1]) {
      const secVal = parseFloat(match[1]);
      if (!isNaN(secVal)) {
        if (secVal < 60) return `${match[1]}s`;
        const totalSecs = Math.round(secVal);
        const m = Math.floor(totalSecs / 60);
        const s = totalSecs % 60;
        return `${m}m ${s < 10 ? "0" : ""}${s}s`;
      }
    }
  }

  return null;
}

export function getDeploymentDuration(deployment: Deployment): string | null {
  if (deployment.status === "queued" || deployment.status === "building") return null;
  if (deployment.logs) {
    const match = deployment.logs.match(/(?:Ferdig på|Feilet etter)\s+([\d.]+)s/i);
    if (match?.[1]) {
      const secVal = parseFloat(match[1]);
      if (!isNaN(secVal)) {
        if (secVal < 60) return `${match[1]}s`;
        const totalSecs = Math.round(secVal);
        const m = Math.floor(totalSecs / 60);
        const s = totalSecs % 60;
        return `${m}m ${s < 10 ? "0" : ""}${s}s`;
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Component: Build Stage Box Card
// -----------------------------------------------------------------------------
function BuildStageCard({ deployment }: { deployment: Deployment | null }) {
  if (!deployment) return null;

  const isBuilding = deployment.status === "queued" || deployment.status === "building";
  const isSuccess = deployment.status === "success";
  const isFailed = deployment.status === "failed";
  const buildDuration = useBuildDuration(deployment);

  // Parse current stage line from logs
  let stageText = "Klargjør repository og miljø...";
  if (deployment.logs) {
    const lines = deployment.logs
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      stageText = lastLine.replace(/^\[.*\]\s*/, "");
    }
  }

  return (
    <div className="flex flex-col gap-3 transition-all">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Tilstanden som en 28 px rute: fylt gul mens noe skjer, fylt svart
              når det gikk bra, rød ramme når det feilet, grå når den hviler.
              Formen skiller dem, ikke bare fargen. */}
          <span
            aria-hidden="true"
            className={`flex h-7 w-7 shrink-0 items-center justify-center border-2 font-body text-[14px] font-bold leading-none ${
              isBuilding
                ? "animate-pulse border-ink bg-sun text-ink"
                : isSuccess
                  ? "border-ink bg-ink text-paper"
                  : isFailed
                    ? "border-error bg-paper text-error"
                    : "border-ash bg-ash text-ink"
            }`}
          >
            {isBuilding ? "·" : isSuccess ? "✓" : isFailed ? "✕" : "–"}
          </span>

          <div className="flex flex-col">
            <span className="font-body text-[15px] text-ink font-semibold">
              {isBuilding
                ? "Bygging og publisering pågår"
                : isSuccess
                  ? "Bygging fullført"
                  : isFailed
                    ? "Bygging feilet"
                    : "Status"}
            </span>
            <span className="font-body text-xs text-ink/70">
              {isBuilding
                ? stageText
                : isSuccess
                  ? buildDuration
                    ? `Kjører og svarer på forespørsler • Byggetid: ${buildDuration}`
                    : "Kjører og svarer på forespørsler"
                  : isFailed
                    ? buildDuration
                      ? `Feilet etter ${buildDuration}. Sjekk terminalen for detaljert feillogg.`
                      : "Sjekk terminalen for detaljert feillogg"
                    : "Ingen aktiv bygging"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tab 1: Deployments
// -----------------------------------------------------------------------------
function DeploymentsTab({
  project,
  deployments,
  onOpenTerminal,
}: {
  project: Project;
  deployments: Deployment[];
  onOpenTerminal: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormatters();
  const latest = deployments[0];
  const latestBuildDuration = useBuildDuration(latest ?? null);
  const isBuilding = latest?.status === "queued" || latest?.status === "building";

  const latestSuccessId = deployments.find((d) => d.status === "success")?.id;

  return (
    <div className="flex flex-col gap-8">
      {/* Latest Deployment Summary Card */}
      <div className="ink-card-lg p-6 md:p-8 flex flex-col gap-6">
        <h2 className="font-display text-[22px] font-bold text-ink">
          {t("project_details.latest_deployment")}
        </h2>
        {latest ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-[12px] bg-muted p-4">
              <div className="flex items-center gap-3">
                <DeploymentStatusBadge
                  status={latest.status}
                  isLive={latest.id === latestSuccessId}
                />
                <span className="font-mono text-sm text-ink/70">
                  {latest.commit_hash
                    ? latest.commit_hash.slice(0, 7)
                    : t("project_details.manual_build")}
                </span>
              </div>
              <div className="flex items-center gap-4">
                {latestBuildDuration && (
                  <span className="inline-flex items-center gap-1.5 font-mono text-sm text-ink bg-sun px-3 py-1 rounded-none font-medium">
                    {isBuilding
                      ? t("project_details.building_duration", { duration: latestBuildDuration })
                      : t("project_details.build_duration", { duration: latestBuildDuration })}
                  </span>
                )}
                <span className="font-body text-[16px] text-ink/70">
                  {format.dateTime(latest.created_at)}
                </span>
              </div>
            </div>

            {/* Build Stage & Progress Card */}
            <BuildStageCard deployment={latest} />

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onOpenTerminal}
                className="btn-outline flex items-center gap-2 px-4 py-2 font-body text-[15px]"
              >
                {t("project_details.view_logs")}
              </button>
            </div>
          </div>
        ) : (
          <p className="font-body text-[16px] text-ink/70">{t("project_details.no_deployments")}</p>
        )}
      </div>

      {/* Deployment History Table */}
      <div className="ink-card-lg p-6 md:p-8">
        <h2 className="mb-6 font-display text-[22px] font-bold text-ink">
          {t("project.deployment_history")}
        </h2>

        {deployments.length === 0 ? (
          <p className="font-body text-[16px] text-ink/70">{t("project_details.no_history")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-hair">
            {deployments.map((d) => {
              const duration = getDeploymentDuration(d);
              const isLive = d.id === latestSuccessId;
              return (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
                >
                  <div className="flex items-center gap-4">
                    <DeploymentStatusBadge status={d.status} isLive={isLive} />
                    <span className="font-mono text-sm text-ink">
                      {d.commit_hash
                        ? d.commit_hash.slice(0, 7)
                        : t("project_details.manual_deploy")}
                    </span>
                  </div>
                  <div className="flex items-center gap-6">
                    {duration && (
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-ink/70 bg-muted px-2.5 py-1 rounded-none">
                        {duration}
                      </span>
                    )}
                    <span className="font-body text-[16px] text-ink/70">
                      {format.dateTime(d.created_at)}
                    </span>
                    {d.url && isLive && (
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-body text-[15px] text-ink hover:underline"
                      >
                        {t("project.visit")}
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tab 2: Terminal / Logs
// -----------------------------------------------------------------------------
function TerminalTab({
  latestDeployment,
  isBuilding,
}: {
  latestDeployment: Deployment | null;
  isBuilding: boolean;
}) {
  const { t } = useTranslation();
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const logs = latestDeployment?.logs ?? t("project.no_logs_available");
  const isSuccess = latestDeployment?.status === "success";
  const isFailed = latestDeployment?.status === "failed";

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(logs);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="ink-card-lg overflow-hidden p-0">
      {/* Terminal Bar Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-muted px-6 py-4 border-b border-hair">
        <div className="flex items-center gap-3">
          <span className="font-body text-[15px] text-ink">{t("project.terminal_title")}</span>
          {isBuilding ? (
            <span className="flex items-center gap-1.5 text-xs text-ink bg-sun px-2.5 py-0.5 rounded-none animate-pulse font-mono">
              <span className="h-2 w-2 rounded-none bg-ink animate-ping" />
              {t("project_details.process_running")}
            </span>
          ) : isSuccess ? (
            <span className="flex items-center gap-1.5 text-xs text-ink font-mono font-medium">
              {t("project_details.process_success")}
            </span>
          ) : isFailed ? (
            <span className="flex items-center gap-1.5 border-2 border-error px-[8px] py-[1px] font-mono text-[12px] font-bold text-error">
              {t("project_details.process_failed")}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer font-body text-[15px] text-ink/70 select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded-none accent-primary"
            />
            {t("project.terminal_autoscroll")}
          </label>

          <button
            type="button"
            onClick={copyToClipboard}
            className="btn-outline px-3 py-1.5 font-body text-[15px] text-ink/70 hover:text-ink"
          >
            {copied ? t("project.terminal_copied") : t("project.terminal_copy")}
          </button>
        </div>
      </div>

      {/* Terminal View Output */}
      <div
        ref={logContainerRef}
        className="h-[500px] overflow-y-auto bg-[#070a12] p-6 font-mono text-sm leading-relaxed text-emerald-400 select-text flex flex-col justify-between"
      >
        <pre className="whitespace-pre-wrap break-words">{logs}</pre>
        {!isBuilding && latestDeployment && (
          <div className="mt-6 pt-4 border-t border-emerald-500/20 text-xs font-mono text-emerald-300/80 flex items-center justify-between">
            <span>
              {isSuccess
                ? t("project_details.process_finished_code0")
                : t("project_details.process_finished_code1")}
            </span>
            <span className="opacity-60">{t("project_details.terminal_session_ended")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tab 3: Environment Variables & Import Modal
// -----------------------------------------------------------------------------
function parseEnvText(text: string): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let val = trimmed.slice(eqIndex + 1).trim();

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (key) {
      result.push({ key, value: val });
    }
  }
  return result;
}

function EnvImportModal({
  isOpen,
  onClose,
  onImport,
}: {
  isOpen: boolean;
  onClose: () => void;
  onImport: (imported: Array<{ key: string; value: string }>) => void;
}) {
  const { t } = useTranslation();
  const [activeMode, setActiveMode] = useState<"file" | "paste">("file");
  const [pasteText, setPasteText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsedVars, setParsedVars] = useState<Array<{ key: string; value: string }>>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setPasteText("");
      setFileName(null);
      setParsedVars([]);
      setIsDragOver(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleFileRead = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const parsed = parseEnvText(content || "");
      setParsedVars(parsed);
    };
    reader.readAsText(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileRead(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileRead(file);
  };

  const handlePasteChange = (text: string) => {
    setPasteText(text);
    setParsedVars(parseEnvText(text));
  };

  const handleSubmit = () => {
    if (parsedVars.length > 0) {
      onImport(parsedVars);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 animate-in fade-in-0 duration-200 p-4">
      <div className="w-full max-w-lg rounded-[12px] bg-paper p-6 md:p-8 animate-in fade-in-0 zoom-in-95 duration-200 border border-hair flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-[22px] font-bold text-ink">
              {t("project.env_import_title")}
            </h2>
            <p className="mt-1 font-body text-[16px] text-ink/70">{t("project.env_import_desc")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-ink/70 hover:text-ink transition-colors rounded-none hover:bg-muted"
          ></button>
        </div>

        {/* Mode Selector */}
        <div className="inline-flex items-center gap-1.5 rounded-[12px] bg-muted p-1">
          <button
            type="button"
            onClick={() => setActiveMode("file")}
            className={`flex-1 flex items-center justify-center gap-2 rounded-none py-2 font-body text-[15px] transition-all ${
              activeMode === "file"
                ? "bg-paper text-ink font-semibold"
                : "text-ink/70 hover:text-ink"
            }`}
          >
            {t("project.env_tab_file")}
          </button>

          <button
            type="button"
            onClick={() => setActiveMode("paste")}
            className={`flex-1 flex items-center justify-center gap-2 rounded-none py-2 font-body text-[15px] transition-all ${
              activeMode === "paste"
                ? "bg-paper text-ink font-semibold"
                : "text-ink/70 hover:text-ink"
            }`}
          >
            {t("project.env_tab_paste")}
          </button>
        </div>

        {/* Mode Content */}
        <div key={activeMode} className="animate-in fade-in-50 duration-200">
          {activeMode === "file" ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              className={`relative flex flex-col items-center justify-center gap-3 rounded-[12px] border-2 border-dashed p-8 text-center transition-all cursor-pointer ${
                isDragOver
                  ? "border-ink bg-sun scale-[1.01]"
                  : "border-hair bg-muted hover:border-ink hover:bg-muted"
              }`}
            >
              <input
                type="file"
                accept=".env,.env.*,text/plain"
                onChange={handleFileChange}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <div>
                <p className="font-body text-[15px] text-ink">
                  {fileName ? fileName : t("project.env_dropzone")}
                </p>
                {parsedVars.length > 0 && (
                  <p className="mt-1 font-body text-xs text-ink font-medium">
                    {t("project.env_vars_found", { count: parsedVars.length })}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <textarea
                rows={6}
                value={pasteText}
                onChange={(e) => handlePasteChange(e.target.value)}
                placeholder={t("project.env_paste_placeholder")}
                className="field-ink w-full p-[14px] font-mono text-[14px] outline-none placeholder:text-ink/40"
              />
              {parsedVars.length > 0 && (
                <p className="font-body text-xs text-ink font-medium">
                  {t("project.env_vars_found", { count: parsedVars.length })}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Modal Actions */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-outline px-5 py-2.5 font-body text-[15px]"
          >
            {t("project.cancel")}
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={parsedVars.length === 0}
            className="btn-ink px-6 py-2.5 font-body text-[15px] disabled:opacity-50"
          >
            {t("project.env_import_submit", { count: parsedVars.length })}
          </button>
        </div>
      </div>
    </div>
  );
}

function EnvTab({ project }: { project: Project }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [envVars, setEnvVars] = useState<Array<{ id: string; key: string; value: string }>>(() => {
    const vars = project.env_vars ?? {};
    const entries = Object.entries(vars).map(([key, value]) => ({
      id: Math.random().toString(36).substring(2, 9),
      key,
      value,
    }));
    return entries.length > 0
      ? entries
      : [{ id: Math.random().toString(36).substring(2, 9), key: "", value: "" }];
  });

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const saveEnvVars = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    const envRecord: Record<string, string> = {};
    for (const { key, value } of envVars) {
      if (key.trim()) {
        envRecord[key.trim()] = value;
      }
    }

    try {
      const { error } = await getSupabase()
        .from("projects")
        .update({ env_vars: envRecord })
        .eq("id", project.id);

      if (error) throw error;
      setMessage(t("project.env_vars_saved"));
      await queryClient.invalidateQueries({ queryKey: ["project", project.id] });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("project.env_vars_save_error"));
    } finally {
      setSaving(false);
    }
  };

  const addEnvPair = () => {
    setEnvVars((prev) => [
      ...prev,
      { id: Math.random().toString(36).substring(2, 9), key: "", value: "" },
    ]);
  };

  const removeEnvPair = (id: string) => {
    setEnvVars((prev) => prev.filter((item) => item.id !== id));
  };

  const updateEnvPair = (id: string, field: "key" | "value", val: string) => {
    setEnvVars((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: val } : item)));
  };

  const handleImportedVars = (imported: Array<{ key: string; value: string }>) => {
    const filteredExisting = envVars.filter((item) => item.key.trim() !== "");
    const map = new Map<string, string>();
    for (const { key, value } of filteredExisting) {
      map.set(key.trim(), value);
    }
    for (const { key, value } of imported) {
      map.set(key.trim(), value);
    }
    const merged = Array.from(map.entries()).map(([key, value]) => ({
      id: Math.random().toString(36).substring(2, 9),
      key,
      value,
    }));
    setEnvVars(
      merged.length > 0
        ? merged
        : [{ id: Math.random().toString(36).substring(2, 9), key: "", value: "" }],
    );
    setMessage(t("project.env_vars_imported", { count: imported.length }));
  };

  return (
    <>
      <form onSubmit={saveEnvVars} className="ink-card-lg p-6 md:p-8 flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-[22px] font-bold text-ink">
              {t("project.settings_env_vars")}
            </h2>
            <p className="font-body text-[16px] text-ink/70">
              {t("project.settings_env_vars_desc")}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setIsImportModalOpen(true)}
            className="btn-outline flex items-center gap-2 px-4 py-2.5 font-body text-[15px] text-ink bg-sun hover:bg-sun"
          >
            {t("project.env_import_btn")}
          </button>
        </div>

        {message && (
          <div className="rounded-[12px] bg-sun p-4 font-body text-[16px] text-ink animate-in fade-in-0 duration-200">
            {message}
          </div>
        )}

        <div className="flex flex-col gap-3">
          {envVars.map((pair) => (
            <div
              key={pair.id}
              className="flex items-center gap-3 animate-in fade-in-50 slide-in-from-top-2 duration-300"
            >
              <input
                type="text"
                placeholder={t("project_details.env_key_placeholder")}
                value={pair.key}
                onChange={(e) => updateEnvPair(pair.id, "key", e.target.value)}
                className="field-ink w-1/2 px-[14px] py-[12px] font-mono text-[14px] outline-none"
              />
              <input
                type="text"
                placeholder={t("project_details.env_value_placeholder")}
                value={pair.value}
                onChange={(e) => updateEnvPair(pair.id, "value", e.target.value)}
                className="field-ink w-1/2 px-[14px] py-[12px] font-mono text-[14px] outline-none"
              />
              {envVars.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeEnvPair(pair.id)}
                  className="p-2 text-ink/70 hover:text-error transition-colors"
                ></button>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-4">
          <button
            type="button"
            onClick={addEnvPair}
            className="btn-outline px-4 py-2 font-body text-[15px] transition-all active:scale-[0.98]"
          >
            {t("project_details.env_add_var")}
          </button>

          <button
            type="submit"
            disabled={saving}
            className="btn-ink px-6 py-3 font-body text-[15px] disabled:opacity-50"
          >
            {saving ? t("project.saving") : t("project.save_changes")}
          </button>
        </div>
      </form>

      {/* Import .env Modal */}
      <EnvImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImport={handleImportedVars}
      />
    </>
  );
}

// -----------------------------------------------------------------------------
// Component: Project Plan & Billing Card (Collapsible Menu)
// -----------------------------------------------------------------------------
function ProjectPlanCard({ project }: { project: Project }) {
  const { t } = useTranslation();
  const format = useFormatters();
  const errorMessage = useApiErrorMessage();
  const market = useRequestedMarket();
  const search = Route.useSearch() as { checkout?: string };
  const [upgradingPlan, setUpgradingPlan] = useState<"pro" | "business" | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const currentPlan: SubscriptionTier = project.plan ?? "free";

  // Samme katalog som betalingssiden og landingssiden. Boksene under sa
  // tidligere «0 kr», «199 kr» og «799 kr» rett i JSX-en – tre steder å glemme
  // ved neste prisendring, og null mulighet for en annen valuta.
  const pricing = useQuery({
    queryKey: ["pricing", market],
    queryFn: () => getPricing(market),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  /** Prisen for en plan, eller tom streng til katalogen er hentet. */
  const priceOf = (plan: SubscriptionTier): string => {
    const offer = pricing.data?.plans.find((candidate) => candidate.id === plan);
    if (!offer) return "";
    return offer.price === 0
      ? t("project_plan.free_price")
      : format.money(offer.price, offer.currency);
  };

  const handleUpgrade = async (plan: "pro" | "business") => {
    setUpgradingPlan(plan);
    setCheckoutError(null);
    try {
      const { url } = await createCheckout(plan, market, project.id);
      window.location.href = url;
    } catch (err) {
      setCheckoutError(errorMessage(err));
      setUpgradingPlan(null);
    }
  };

  const planSpecs = {
    free: { ram: "256 MB", cpu: "0.5 vCPU", name: "Free", badgeBg: "bg-muted text-ink/70" },
    pro: { ram: "1 GB", cpu: "1 vCPU", name: "Pro", badgeBg: "bg-sun text-ink font-semibold" },
    business: {
      ram: "8 GB",
      cpu: "4 vCPU",
      name: "Business",
      badgeBg: "bg-sun text-ink font-semibold",
    },
  };

  const currentSpecs = planSpecs[currentPlan] ?? planSpecs.free;

  return (
    <div className="ink-card-lg p-6 md:p-8 flex flex-col gap-6">
      <Accordion
        type="single"
        collapsible
        defaultValue={search.checkout ? "plan-menu" : undefined}
        className="w-full"
      >
        <AccordionItem value="plan-menu" className="border-b-0">
          <AccordionTrigger className="hover:no-underline p-0 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-body text-[13px] text-ink/70 uppercase tracking-wider">
                {t("project_plan.section_label")}
              </span>
              <span className="h-4 w-px bg-muted hidden md:inline" />
              <div className="flex items-center gap-2">
                <span className="font-display text-[22px] font-bold text-ink">
                  {t("project_plan.current_plan_title")}:
                </span>
                <span
                  className={`px-3.5 py-1 rounded-none font-body text-[15px] ${currentSpecs.badgeBg}`}
                >
                  {currentSpecs.name}
                </span>
              </div>
            </div>
          </AccordionTrigger>

          <AccordionContent className="flex flex-col gap-6 pt-6">
            {search.checkout === "ok" && (
              <div className="rounded-[12px] bg-sun p-4 font-body text-[16px] text-ink border border-ink flex items-center gap-3">
                {t("project_plan.checkout_success")}
              </div>
            )}

            {search.checkout === "avbrutt" && (
              <div className="rounded-[12px] bg-muted p-4 font-body text-[16px] text-ink/70 border border-hair">
                {t("project_plan.checkout_canceled", { plan: currentSpecs.name })}
              </div>
            )}

            {checkoutError && (
              <div
                role="alert"
                className="border-2 border-error px-[18px] py-[14px] font-body text-[16px] text-error"
              >
                {checkoutError}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
              {/* Free Plan Box */}
              <div
                className={`rounded-[12px] p-5 border flex flex-col justify-between ${currentPlan === "free" ? "border-ink bg-sun" : "border-hair bg-muted"}`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-display text-[26px] font-bold text-ink">Free</span>
                    {currentPlan === "free" && (
                      <span className="text-xs font-body px-2.5 py-0.5 rounded-none bg-sun text-ink font-semibold">
                        {t("project_plan.active")}
                      </span>
                    )}
                  </div>
                  <p className="font-body text-[14px] text-ink/70 mb-4">
                    {t("project_plan.free_desc")}
                  </p>
                  <ul className="flex flex-col gap-2 font-body text-[14px] text-ink/70">
                    <li className="flex items-center gap-2">
                      <Mark on size={18} /> {t("project_plan.free_f1")}
                    </li>
                    <li className="flex items-center gap-2">
                      <Mark on size={18} /> {t("project_plan.free_f2")}
                    </li>
                    <li className="flex items-center gap-2">
                      <Mark on size={18} /> {t("project_plan.free_f3")}
                    </li>
                    <li className="flex items-center gap-2 text-ink/40">
                      <Mark on={false} size={18} /> {t("project_plan.free_f4")}
                    </li>
                  </ul>
                </div>
                <div className="mt-6 pt-4 border-t border-hair">
                  <span className="font-display text-[26px] font-bold text-ink">
                    {priceOf("free")}
                  </span>
                  <span className="font-body text-[14px] text-ink/70">
                    {" "}
                    {t("project_plan.per_month")}
                  </span>
                </div>
              </div>

              {/* Pro Plan Box */}
              <div
                className={`rounded-[12px] p-5 border flex flex-col justify-between ${currentPlan === "pro" ? "border-ink bg-sun" : "border-hair bg-muted hover:border-ink"} transition-all`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-display text-[26px] font-bold text-ink">Pro</span>
                    {currentPlan === "pro" && (
                      <span className="text-xs font-body px-2.5 py-0.5 rounded-none bg-ink text-on-primary font-semibold">
                        {t("project_plan.active")}
                      </span>
                    )}
                  </div>
                  <p className="font-body text-[14px] text-ink/70 mb-4">
                    {t("project_plan.pro_desc")}
                  </p>
                  <ul className="flex flex-col gap-2 font-body text-[14px] text-ink/70">
                    <li className="flex items-center gap-2 font-medium text-ink">
                      <Mark on size={18} /> {t("project_plan.pro_f1")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-ink">
                      <Mark on size={18} /> {t("project_plan.pro_f2")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-ink">
                      <Mark on size={18} /> {t("project_plan.pro_f3")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-ink">
                      <Mark on size={18} /> {t("project_plan.pro_f4")}
                    </li>
                  </ul>
                </div>
                <div className="mt-6 pt-4 border-t border-hair flex items-center justify-between">
                  <div>
                    <span className="font-display text-[26px] font-bold text-ink">
                      {priceOf("pro")}
                    </span>
                    <span className="font-body text-[14px] text-ink/70">
                      {" "}
                      {t("project_plan.per_month")}
                    </span>
                  </div>
                  {currentPlan !== "pro" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleUpgrade("pro");
                      }}
                      disabled={upgradingPlan !== null}
                      className="btn-ink px-4 py-2 font-body text-[15px] disabled:opacity-50"
                    >
                      {upgradingPlan === "pro"
                        ? t("project_plan.loading")
                        : currentPlan === "business"
                          ? t("project_plan.change")
                          : t("project_plan.upgrade")}
                    </button>
                  )}
                </div>
              </div>

              {/* Business Plan Box */}
              <div
                className={`rounded-[12px] p-5 border flex flex-col justify-between ${currentPlan === "business" ? "border-ink bg-sun" : "border-hair bg-muted hover:border-ink"} transition-all`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-display text-[26px] font-bold text-ink">Business</span>
                    {currentPlan === "business" && (
                      <span className="text-xs font-body px-2.5 py-0.5 rounded-none bg-sun text-on-secondary font-semibold">
                        {t("project_plan.active")}
                      </span>
                    )}
                  </div>
                  <p className="font-body text-[14px] text-ink/70 mb-4">
                    {t("project_plan.business_desc")}
                  </p>
                  <ul className="flex flex-col gap-2 font-body text-[14px] text-ink/70">
                    <li className="flex items-center gap-2 font-medium text-ink">
                      <Mark on size={18} /> {t("project_plan.business_f1")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-ink">
                      <Mark on size={18} /> {t("project_plan.business_f2")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-ink">
                      <Mark on size={18} /> {t("project_plan.business_f3")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-ink">
                      <Mark on size={18} /> {t("project_plan.business_f4")}
                    </li>
                  </ul>
                </div>
                <div className="mt-6 pt-4 border-t border-hair flex items-center justify-between">
                  <div>
                    <span className="font-display text-[26px] font-bold text-ink">
                      {t("project_plan.contact_price", "Skreddersydd")}
                    </span>
                  </div>
                  <a
                    href="mailto:post@frostbytes.no?subject=Foresp%C3%B8rsel%20om%20Business-plan%20p%C3%A5%20Snoat"
                    className="secondary-btn px-4 py-2 font-body text-[15px] inline-block text-center"
                  >
                    {t("project_plan.contact_us", "Kontakt oss")}
                  </a>
                </div>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tab 4: Settings
// -----------------------------------------------------------------------------
function SettingsTab({ project }: { project: Project }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [buildCommand, setBuildCommand] = useState(project.build_command ?? "");
  const [staticOutputDir, setStaticOutputDir] = useState(project.static_output_dir ?? "");
  const [spaFallback, setSpaFallback] = useState(project.static_spa_fallback);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const { error } = await getSupabase()
        .from("projects")
        .update({
          build_command: buildCommand.trim() || null,
          static_output_dir: staticOutputDir.trim() || null,
          static_spa_fallback: spaFallback,
        })
        .eq("id", project.id);

      if (error) throw error;
      setMessage(t("project.settings_saved"));
      await queryClient.invalidateQueries({ queryKey: ["project", project.id] });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("project.settings_save_error"));
    } finally {
      setSaving(false);
    }
  };

  const deleteProject = async () => {
    if (!window.confirm(t("project.settings_delete_confirm"))) return;
    try {
      const { error } = await getSupabase().from("projects").delete().eq("id", project.id);
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      void navigate({ to: "/dashboard" });
    } catch (err) {
      alert(err instanceof Error ? err.message : t("project.delete_project_error"));
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Project Plan & Subscription Card */}
      <ProjectPlanCard project={project} />

      {/* General Settings */}
      <form onSubmit={saveSettings} className="ink-card-lg p-6 md:p-8 flex flex-col gap-6">
        <h2 className="font-display text-[22px] font-bold text-ink">
          {t("project.project_settings")}
        </h2>

        {message && (
          <div className="rounded-[12px] bg-sun p-4 font-body text-[16px] text-ink">{message}</div>
        )}

        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="advanced" className="border-b-0">
            <AccordionTrigger className="hover:no-underline text-[15px] font-body py-0 pb-4">
              {t("project.advanced_build_settings", "Avanserte byggeinnstillinger")}
            </AccordionTrigger>
            <AccordionContent className="flex flex-col gap-6 pt-2">
              <label className="flex flex-col gap-2">
                <span className="font-body text-[15px] text-ink">
                  {t("project.settings_build_cmd")}
                </span>
                <input
                  type="text"
                  value={buildCommand}
                  onChange={(e) => setBuildCommand(e.target.value)}
                  placeholder={t("project_details.build_cmd_placeholder")}
                  className="field-ink max-w-lg px-[14px] py-[12px] font-body text-[16px] outline-none"
                />
              </label>

              <label className="flex flex-col gap-2">
                <span className="font-body text-[15px] text-ink">
                  {t("project.static_output_dir")}
                </span>
                <input
                  type="text"
                  value={staticOutputDir}
                  onChange={(e) => setStaticOutputDir(e.target.value)}
                  placeholder={t("project.static_output_dir_placeholder")}
                  className="field-ink max-w-lg px-[14px] py-[12px] font-body text-[16px] outline-none"
                />
                <span
                  className="font-body text-[14px] text-ink/70 max-w-lg"
                  dangerouslySetInnerHTML={{ __html: t("project.static_output_dir_help") }}
                />
              </label>

              {staticOutputDir.trim() !== "" && (
                <label className="flex items-start gap-3 max-w-lg">
                  <input
                    type="checkbox"
                    checked={spaFallback}
                    onChange={(e) => setSpaFallback(e.target.checked)}
                    className="mt-1 h-5 w-5 rounded-none accent-primary"
                  />
                  <span className="flex flex-col gap-1">
                    <span className="font-body text-[15px] text-ink">
                      {t("project.spa_fallback")}
                    </span>
                    <span
                      className="font-body text-[14px] text-ink/70"
                      dangerouslySetInnerHTML={{ __html: t("project.spa_fallback_help") }}
                    />
                  </span>
                </label>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <div className="pt-2">
          <button
            type="submit"
            disabled={saving}
            className="btn-ink px-6 py-3 font-body text-[15px] disabled:opacity-50"
          >
            {saving ? t("project.saving") : t("project.save_changes")}
          </button>
        </div>
      </form>

      {/* Danger Zone */}
      <div className="ink-card-lg p-6 md:p-8 border-error/20">
        <h2 className="mb-2 font-display text-[22px] font-bold text-error">
          {t("project.settings_danger_zone")}
        </h2>
        <p className="mb-6 font-body text-[16px] text-ink/70">
          {t("project.delete_project_warning")}
        </p>

        <button
          type="button"
          onClick={deleteProject}
          className="btn-outline border-error px-[24px] py-[12px] font-body text-[15px] text-error hover:bg-error hover:text-paper"
        >
          {t("project.settings_delete_project")}
        </button>
      </div>
    </div>
  );
}
