import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SnoatLogo } from "@/components/SnoatLogo";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { DeploymentStatusBadge } from "@/components/DeploymentStatusBadge";
import { DnsSettingsTab } from "@/components/DnsSettingsTab";
import { AnalyticsTab } from "@/components/AnalyticsTab";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useAuth, displayName, avatarUrl } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { createCheckout, deployProject, getPricing, stopProject, updateCustomDomain } from "@/lib/api";
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

type Tab = "deployments" | "terminal" | "analytics" | "dns" | "env" | "settings";

/** Fanene i prosjektvisningen, i den rekkefølgen de vises. */
const TABS: ReadonlyArray<{ id: Tab; icon: string; labelKey: string }> = [
  { id: "deployments", icon: "history", labelKey: "project.tab_deployments" },
  { id: "terminal", icon: "terminal", labelKey: "project.tab_terminal" },
  { id: "analytics", icon: "analytics", labelKey: "project.tab_analytics" },
  { id: "dns", icon: "dns", labelKey: "project.tab_dns" },
  { id: "env", icon: "key", labelKey: "project.tab_env" },
  { id: "settings", icon: "settings", labelKey: "project.tab_settings" },
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
  const isBuilding = latestDeployment?.status === "queued" || latestDeployment?.status === "building";
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
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="font-body text-body-md text-on-surface-variant">Laster prosjekt…</p>
      </div>
    );
  }

  if (projectQuery.isError || !project) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
        <h1 className="font-headline text-headline-md text-on-surface">Prosjektet ble ikke funnet</h1>
        <p className="mt-2 font-body text-body-md text-on-surface-variant">
          Prosjektet kan ha blitt slettet eller du har ikke tilgang.
        </p>
        <Link to="/dashboard" className="primary-btn mt-6 px-6 py-2.5 font-label text-label-md">
          {t("project.back_to_projects")}
        </Link>
      </div>
    );
  }

  const repoLabel = project.repo_url
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "");

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top Navigation */}
      <header className="sticky top-0 z-40 bg-background/80 shadow-[0_8px_30px_-20px_oklch(0_0_0/0.9)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-container-max items-center justify-between px-margin-mobile py-4 md:px-gutter">
          <div className="flex items-center gap-6">
            <Link to="/" className="inline-flex">
              <SnoatLogo />
            </Link>
            <span className="h-4 w-px bg-surface-variant/40" />
            <Link
              to="/dashboard"
              className="flex items-center gap-1.5 font-label text-label-md text-on-surface-variant transition-colors hover:text-on-surface"
            >
              <span className="material-symbols-outlined icon-sm">arrow_back</span>
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
                    className="h-8 w-8 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-variant font-label text-label-md text-on-surface">
                    {displayName(user)[0]?.toUpperCase()}
                  </div>
                )}
                <span className="hidden font-body text-body-md text-on-surface md:inline">
                  {displayName(user)}
                </span>
                <button
                  type="button"
                  onClick={() => void signOut().then(() => navigate({ to: "/" }))}
                  className="font-label text-label-md text-on-surface-variant transition-colors hover:text-on-surface"
                >
                  {t("project.logout")}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-container-max flex-grow px-margin-mobile py-stack-lg md:px-gutter">
        {/* Project Header */}
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-headline-lg text-on-background">{project.name}</h1>
              <DeploymentStatusBadge
                status={latestDeployment?.status ?? null}
                stopped={isStopped}
                stopping={stopMutation.isPending}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4 text-body-md">
              <a
                href={project.repo_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-on-surface-variant transition-colors hover:text-on-surface"
              >
                <span className="material-symbols-outlined icon-sm">code</span>
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
                    className="inline-flex items-center gap-1.5 text-primary transition-opacity hover:opacity-80 font-medium"
                  >
                    <span className="material-symbols-outlined icon-sm">link</span>
                    {latestDeployment.url.replace(/^https?:\/\//, "")}
                  </a>

                  {project.custom_domain && (
                    <a
                      href={`https://${project.custom_domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-primary transition-opacity hover:opacity-80 font-medium"
                    >
                      <span className="material-symbols-outlined icon-sm">link</span>
                      {project.custom_domain}
                    </a>
                  )}
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-on-surface-variant/60">
                  <span className="material-symbols-outlined icon-sm">link_off</span>
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
                className="ghost-btn px-4 py-2.5 font-label text-label-md text-error hover:bg-error/10"
              >
                {stopMutation.isPending ? t("project_details.stopping") : t("project.stop_project")}
              </button>
            )}

            <button
              type="button"
              onClick={() => deployMutation.mutate()}
              disabled={deployMutation.isPending || isBuilding || stopMutation.isPending}
              className="primary-btn px-6 py-2.5 font-label text-label-md disabled:opacity-50"
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
          <div role="alert" className="mb-6 rounded-xl bg-error/10 p-4 font-body text-body-md text-error">
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

          {activeTab === "analytics" && (
            <AnalyticsTab project={project} />
          )}

          {activeTab === "dns" && (
            <DnsSettingsTab
              project={project}
              onSaveDomain={(domain) => domainMutation.mutate(domain)}
              isSaving={domainMutation.isPending}
            />
          )}

          {activeTab === "env" && (
            <EnvTab project={project} />
          )}

          {activeTab === "settings" && (
            <SettingsTab project={project} />
          )}
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
    <div className="relative mb-8 inline-flex flex-wrap items-center gap-1.5 rounded-2xl bg-surface-container p-1.5 shadow-[inset_0_1px_0_0_oklch(1_0_0/5%)]">
      {/* Sliding Active Pill Highlight */}
      {indicator.width > 0 && (
        <div
          className="absolute rounded-xl bg-surface shadow-[0_4px_16px_-4px_oklch(0_0_0/60%),0_1px_0_0_oklch(1_0_0/8%)_inset] transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] pointer-events-none"
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
          className={`relative z-10 flex items-center gap-2 rounded-xl px-5 py-2.5 font-label text-label-md transition-colors duration-200 active:scale-[0.98] ${
            activeTab === tab.id
              ? "text-primary font-semibold"
              : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          <span className="material-symbols-outlined icon-sm">{tab.icon}</span>
          {t(tab.labelKey)}
          {tab.id === "terminal" && isBuilding && (
            <span className="ml-1 flex h-2 w-2 rounded-full bg-primary animate-pulse" />
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
    const lines = deployment.logs.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      stageText = lastLine.replace(/^\[.*\]\s*/, "");
    }
  }

  return (
    <div className="flex flex-col gap-3 transition-all">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {isBuilding ? (
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
              <span className="material-symbols-outlined icon-sm text-primary animate-spin">progress_activity</span>
            </div>
          ) : isSuccess ? (
            <div className="flex h-7 w-7 items-center justify-center text-secondary">
              <span className="material-symbols-outlined icon-md">check</span>
            </div>
          ) : isFailed ? (
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-error/15">
              <span className="material-symbols-outlined icon-sm text-error">cancel</span>
            </div>
          ) : (
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-variant/40">
              <span className="material-symbols-outlined icon-sm text-on-surface-variant">info</span>
            </div>
          )}

          <div className="flex flex-col">
            <span className="font-label text-label-md text-on-surface font-semibold">
              {isBuilding ? "Bygging og publisering pågår" : isSuccess ? "Bygging fullført" : isFailed ? "Bygging feilet" : "Status"}
            </span>
            <span className="font-body text-xs text-on-surface-variant">
              {isBuilding
                ? stageText
                : isSuccess
                ? (buildDuration ? `Kjører og svarer på forespørsler • Byggetid: ${buildDuration}` : "Kjører og svarer på forespørsler")
                : isFailed
                ? (buildDuration ? `Feilet etter ${buildDuration}. Sjekk terminalen for detaljert feillogg.` : "Sjekk terminalen for detaljert feillogg")
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
      <div className="floating-card p-6 md:p-8 flex flex-col gap-6">
        <h2 className="font-headline text-headline-md text-on-surface">{t("project_details.latest_deployment")}</h2>
        {latest ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-surface-container p-4">
              <div className="flex items-center gap-3">
                <DeploymentStatusBadge
                  status={latest.status}
                  isLive={latest.id === latestSuccessId}
                />
                <span className="font-mono text-sm text-on-surface-variant">
                  {latest.commit_hash ? latest.commit_hash.slice(0, 7) : t("project_details.manual_build")}
                </span>
              </div>
              <div className="flex items-center gap-4">
                {latestBuildDuration && (
                  <span className="inline-flex items-center gap-1.5 font-mono text-sm text-primary bg-primary/10 px-3 py-1 rounded-full font-medium">
                    <span className="material-symbols-outlined icon-sm">timer</span>
                    {isBuilding ? t("project_details.building_duration", { duration: latestBuildDuration }) : t("project_details.build_duration", { duration: latestBuildDuration })}
                  </span>
                )}
                <span className="font-body text-body-md text-on-surface-variant">
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
                className="ghost-btn flex items-center gap-2 px-4 py-2 font-label text-label-md"
              >
                <span className="material-symbols-outlined icon-sm">terminal</span>
                {t("project_details.view_logs")}
              </button>
            </div>
          </div>
        ) : (
          <p className="font-body text-body-md text-on-surface-variant">{t("project_details.no_deployments")}</p>
        )}
      </div>

      {/* Deployment History Table */}
      <div className="floating-card p-6 md:p-8">
        <h2 className="mb-6 font-headline text-headline-md text-on-surface">
          {t("project.deployment_history")}
        </h2>

        {deployments.length === 0 ? (
          <p className="font-body text-body-md text-on-surface-variant">{t("project_details.no_history")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-surface-variant/20">
            {deployments.map((d) => {
              const duration = getDeploymentDuration(d);
              const isLive = d.id === latestSuccessId;
              return (
                <div key={d.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-4">
                    <DeploymentStatusBadge status={d.status} isLive={isLive} />
                    <span className="font-mono text-sm text-on-surface">
                      {d.commit_hash ? d.commit_hash.slice(0, 7) : t("project_details.manual_deploy")}
                    </span>
                  </div>
                  <div className="flex items-center gap-6">
                    {duration && (
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-on-surface-variant bg-surface-container px-2.5 py-1 rounded-md">
                        <span className="material-symbols-outlined icon-sm text-on-surface-variant/70">timer</span>
                        {duration}
                      </span>
                    )}
                    <span className="font-body text-body-md text-on-surface-variant">
                      {format.dateTime(d.created_at)}
                    </span>
                    {d.url && isLive && (
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-label text-label-md text-primary hover:underline"
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
    <div className="floating-card overflow-hidden p-0">
      {/* Terminal Bar Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-surface-container px-6 py-4 border-b border-surface-variant/20">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined icon-sm text-primary">terminal</span>
          <span className="font-label text-label-md text-on-surface">{t("project.terminal_title")}</span>
          {isBuilding ? (
            <span className="flex items-center gap-1.5 text-xs text-primary bg-primary/10 px-2.5 py-0.5 rounded-full animate-pulse font-mono">
              <span className="h-2 w-2 rounded-full bg-primary animate-ping" />
              {t("project_details.process_running")}
            </span>
          ) : isSuccess ? (
            <span className="flex items-center gap-1.5 text-xs text-secondary font-mono font-medium">
              <span className="material-symbols-outlined icon-sm">check</span>
              {t("project_details.process_success")}
            </span>
          ) : isFailed ? (
            <span className="flex items-center gap-1.5 text-xs text-error bg-error/15 px-2.5 py-0.5 rounded-full font-mono font-medium">
              <span className="material-symbols-outlined icon-sm">error</span>
              {t("project_details.process_failed")}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer font-label text-label-md text-on-surface-variant select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded accent-primary"
            />
            {t("project.terminal_autoscroll")}
          </label>

          <button
            type="button"
            onClick={copyToClipboard}
            className="ghost-btn px-3 py-1.5 font-label text-label-md text-on-surface-variant hover:text-on-surface"
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

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md animate-in fade-in-0 duration-200 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-surface p-6 md:p-8 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200 border border-surface-variant/30 flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-headline text-headline-md text-on-surface">{t("project.env_import_title")}</h2>
            <p className="mt-1 font-body text-body-md text-on-surface-variant">
              {t("project.env_import_desc")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-on-surface-variant hover:text-on-surface transition-colors rounded-lg hover:bg-surface-variant/50"
          >
            <span className="material-symbols-outlined icon-sm">close</span>
          </button>
        </div>

        {/* Mode Selector */}
        <div className="inline-flex items-center gap-1.5 rounded-xl bg-surface-container p-1 shadow-[inset_0_1px_0_0_oklch(1_0_0/5%)]">
          <button
            type="button"
            onClick={() => setActiveMode("file")}
            className={`flex-1 flex items-center justify-center gap-2 rounded-lg py-2 font-label text-label-md transition-all ${
              activeMode === "file"
                ? "bg-surface text-primary font-semibold shadow-sm"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            <span className="material-symbols-outlined icon-sm">upload_file</span>
            {t("project.env_tab_file")}
          </button>

          <button
            type="button"
            onClick={() => setActiveMode("paste")}
            className={`flex-1 flex items-center justify-center gap-2 rounded-lg py-2 font-label text-label-md transition-all ${
              activeMode === "paste"
                ? "bg-surface text-primary font-semibold shadow-sm"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            <span className="material-symbols-outlined icon-sm">content_paste</span>
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
              className={`relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-all cursor-pointer ${
                isDragOver
                  ? "border-primary bg-primary/10 scale-[1.01]"
                  : "border-surface-variant/40 bg-surface-container/50 hover:border-primary/60 hover:bg-surface-container"
              }`}
            >
              <input
                type="file"
                accept=".env,.env.*,text/plain"
                onChange={handleFileChange}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <span className="material-symbols-outlined icon-lg text-primary">cloud_upload</span>
              <div>
                <p className="font-label text-label-md text-on-surface">
                  {fileName ? fileName : t("project.env_dropzone")}
                </p>
                {parsedVars.length > 0 && (
                  <p className="mt-1 font-body text-xs text-primary font-medium">
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
                className="w-full rounded-xl bg-surface-container p-4 font-mono text-sm text-on-surface outline-none focus:ring-2 ring-primary/60 placeholder:text-on-surface-variant/30"
              />
              {parsedVars.length > 0 && (
                <p className="font-body text-xs text-primary font-medium">
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
            className="ghost-btn px-5 py-2.5 font-label text-label-md"
          >
            {t("project.cancel")}
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={parsedVars.length === 0}
            className="primary-btn px-6 py-2.5 font-label text-label-md disabled:opacity-50"
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
    setEnvVars((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: val } : item)),
    );
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
      <form onSubmit={saveEnvVars} className="floating-card p-6 md:p-8 flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-headline text-headline-md text-on-surface">{t("project.settings_env_vars")}</h2>
            <p className="font-body text-body-md text-on-surface-variant">
              {t("project.settings_env_vars_desc")}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setIsImportModalOpen(true)}
            className="ghost-btn flex items-center gap-2 px-4 py-2.5 font-label text-label-md text-primary bg-primary/10 hover:bg-primary/20"
          >
            <span className="material-symbols-outlined icon-sm">file_upload</span>
            {t("project.env_import_btn")}
          </button>
        </div>

        {message && (
          <div className="rounded-xl bg-primary/10 p-4 font-body text-body-md text-primary animate-in fade-in-0 duration-200">
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
                className="w-1/2 rounded-xl bg-surface-container px-4 py-3 font-mono text-sm text-on-surface outline-none focus:ring-2 ring-primary/60 transition-all"
              />
              <input
                type="text"
                placeholder={t("project_details.env_value_placeholder")}
                value={pair.value}
                onChange={(e) => updateEnvPair(pair.id, "value", e.target.value)}
                className="w-1/2 rounded-xl bg-surface-container px-4 py-3 font-mono text-sm text-on-surface outline-none focus:ring-2 ring-primary/60 transition-all"
              />
              {envVars.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeEnvPair(pair.id)}
                  className="p-2 text-on-surface-variant hover:text-error transition-colors"
                >
                  <span className="material-symbols-outlined icon-sm">delete</span>
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-4">
          <button
            type="button"
            onClick={addEnvPair}
            className="ghost-btn px-4 py-2 font-label text-label-md transition-all active:scale-[0.98]"
          >
            {t("project_details.env_add_var")}
          </button>

          <button
            type="submit"
            disabled={saving}
            className="primary-btn px-6 py-3 font-label text-label-md disabled:opacity-50"
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
    return offer.price === 0 ? t("project_plan.free_price") : format.money(offer.price, offer.currency);
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
    free: { ram: "256 MB", cpu: "0.5 vCPU", name: "Free", badgeBg: "bg-surface-variant text-on-surface-variant" },
    pro: { ram: "1 GB", cpu: "1 vCPU", name: "Pro", badgeBg: "bg-primary/15 text-primary font-semibold" },
    business: { ram: "8 GB", cpu: "4 vCPU", name: "Business", badgeBg: "bg-secondary/20 text-secondary font-semibold" },
  };

  const currentSpecs = planSpecs[currentPlan] ?? planSpecs.free;

  return (
    <div className="floating-card p-6 md:p-8 flex flex-col gap-6">
      <Accordion type="single" collapsible defaultValue={search.checkout ? "plan-menu" : undefined} className="w-full">
        <AccordionItem value="plan-menu" className="border-b-0">
          <AccordionTrigger className="hover:no-underline p-0 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-label text-label-sm text-on-surface-variant uppercase tracking-wider">
                {t("project_plan.section_label")}
              </span>
              <span className="h-4 w-px bg-surface-variant/40 hidden md:inline" />
              <div className="flex items-center gap-2">
                <span className="font-headline text-headline-md text-on-surface">
                  {t("project_plan.current_plan_title")}:
                </span>
                <span className={`px-3.5 py-1 rounded-full font-label text-label-md ${currentSpecs.badgeBg}`}>
                  {currentSpecs.name}
                </span>
              </div>
            </div>
          </AccordionTrigger>

          <AccordionContent className="flex flex-col gap-6 pt-6">
            {search.checkout === "ok" && (
              <div className="rounded-xl bg-secondary/15 p-4 font-body text-body-md text-secondary border border-secondary/20 flex items-center gap-3">
                <span className="material-symbols-outlined icon-md">check_circle</span>
                {t("project_plan.checkout_success")}
              </div>
            )}

            {search.checkout === "avbrutt" && (
              <div className="rounded-xl bg-surface-container p-4 font-body text-body-md text-on-surface-variant border border-surface-variant/30">
                {t("project_plan.checkout_canceled", { plan: currentSpecs.name })}
              </div>
            )}

            {checkoutError && (
              <div role="alert" className="rounded-xl bg-error/10 p-4 font-body text-body-md text-error">
                {checkoutError}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
              {/* Free Plan Box */}
              <div className={`rounded-2xl p-5 border flex flex-col justify-between ${currentPlan === "free" ? "border-primary/40 bg-primary/5 shadow-sm" : "border-surface-variant/30 bg-surface-container/40"}`}>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-headline text-headline-sm text-on-surface">Free</span>
                    {currentPlan === "free" && (
                      <span className="text-xs font-label px-2.5 py-0.5 rounded-full bg-primary/15 text-primary font-semibold">{t("project_plan.active")}</span>
                    )}
                  </div>
                  <p className="font-body text-body-sm text-on-surface-variant mb-4">{t("project_plan.free_desc")}</p>
                  <ul className="flex flex-col gap-2 font-body text-body-sm text-on-surface-variant">
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined icon-sm text-primary">check</span> {t("project_plan.free_f1")}
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined icon-sm text-primary">check</span> {t("project_plan.free_f2")}
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined icon-sm text-primary">check</span> {t("project_plan.free_f3")}
                    </li>
                    <li className="flex items-center gap-2 text-on-surface-variant/50">
                      <span className="material-symbols-outlined icon-sm text-on-surface-variant/40">close</span> {t("project_plan.free_f4")}
                    </li>
                  </ul>
                </div>
                <div className="mt-6 pt-4 border-t border-surface-variant/20">
                  <span className="font-display text-headline-sm text-on-surface">{priceOf("free")}</span>
                  <span className="font-body text-body-sm text-on-surface-variant"> {t("project_plan.per_month")}</span>
                </div>
              </div>

              {/* Pro Plan Box */}
              <div className={`rounded-2xl p-5 border flex flex-col justify-between ${currentPlan === "pro" ? "border-primary bg-primary/10 shadow-sm" : "border-surface-variant/30 bg-surface-container/40 hover:border-primary/50"} transition-all`}>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-headline text-headline-sm text-on-surface">Pro</span>
                    {currentPlan === "pro" && (
                      <span className="text-xs font-label px-2.5 py-0.5 rounded-full bg-primary text-on-primary font-semibold">{t("project_plan.active")}</span>
                    )}
                  </div>
                  <p className="font-body text-body-sm text-on-surface-variant mb-4">{t("project_plan.pro_desc")}</p>
                  <ul className="flex flex-col gap-2 font-body text-body-sm text-on-surface-variant">
                    <li className="flex items-center gap-2 font-medium text-on-surface">
                      <span className="material-symbols-outlined icon-sm text-primary">check</span> {t("project_plan.pro_f1")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-on-surface">
                      <span className="material-symbols-outlined icon-sm text-primary">check</span> {t("project_plan.pro_f2")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-on-surface">
                      <span className="material-symbols-outlined icon-sm text-primary">check</span> {t("project_plan.pro_f3")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-on-surface">
                      <span className="material-symbols-outlined icon-sm text-primary">check</span> {t("project_plan.pro_f4")}
                    </li>
                  </ul>
                </div>
                <div className="mt-6 pt-4 border-t border-surface-variant/20 flex items-center justify-between">
                  <div>
                    <span className="font-display text-headline-sm text-on-surface">{priceOf("pro")}</span>
                    <span className="font-body text-body-sm text-on-surface-variant"> {t("project_plan.per_month")}</span>
                  </div>
                  {currentPlan !== "pro" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleUpgrade("pro");
                      }}
                      disabled={upgradingPlan !== null}
                      className="primary-btn px-4 py-2 font-label text-label-md disabled:opacity-50"
                    >
                      {upgradingPlan === "pro" ? t("project_plan.loading") : currentPlan === "business" ? t("project_plan.change") : t("project_plan.upgrade")}
                    </button>
                  )}
                </div>
              </div>

              {/* Business Plan Box */}
              <div className={`rounded-2xl p-5 border flex flex-col justify-between ${currentPlan === "business" ? "border-secondary bg-secondary/10 shadow-sm" : "border-surface-variant/30 bg-surface-container/40 hover:border-secondary/50"} transition-all`}>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-headline text-headline-sm text-on-surface">Business</span>
                    {currentPlan === "business" && (
                      <span className="text-xs font-label px-2.5 py-0.5 rounded-full bg-secondary text-on-secondary font-semibold">{t("project_plan.active")}</span>
                    )}
                  </div>
                  <p className="font-body text-body-sm text-on-surface-variant mb-4">{t("project_plan.business_desc")}</p>
                  <ul className="flex flex-col gap-2 font-body text-body-sm text-on-surface-variant">
                    <li className="flex items-center gap-2 font-medium text-on-surface">
                      <span className="material-symbols-outlined icon-sm text-secondary">check</span> {t("project_plan.business_f1")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-on-surface">
                      <span className="material-symbols-outlined icon-sm text-secondary">check</span> {t("project_plan.business_f2")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-on-surface">
                      <span className="material-symbols-outlined icon-sm text-secondary">check</span> {t("project_plan.business_f3")}
                    </li>
                    <li className="flex items-center gap-2 font-medium text-on-surface">
                      <span className="material-symbols-outlined icon-sm text-secondary">check</span> {t("project_plan.business_f4")}
                    </li>
                  </ul>
                </div>
                <div className="mt-6 pt-4 border-t border-surface-variant/20 flex items-center justify-between">
                  <div>
                    <span className="font-display text-headline-sm text-on-surface">{t("project_plan.contact_price", "Skreddersydd")}</span>
                  </div>
                  <a
                    href="mailto:post@frostbytes.no?subject=Foresp%C3%B8rsel%20om%20Business-plan%20p%C3%A5%20Snoat"
                    className="secondary-btn px-4 py-2 font-label text-label-md inline-block text-center"
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
      <form onSubmit={saveSettings} className="floating-card p-6 md:p-8 flex flex-col gap-6">
        <h2 className="font-headline text-headline-md text-on-surface">{t("project.project_settings")}</h2>

        {message && (
          <div className="rounded-xl bg-primary/10 p-4 font-body text-body-md text-primary">
            {message}
          </div>
        )}

        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="advanced" className="border-b-0">
            <AccordionTrigger className="hover:no-underline text-label-md font-label py-0 pb-4">
              {t("project.advanced_build_settings", "Avanserte byggeinnstillinger")}
            </AccordionTrigger>
            <AccordionContent className="flex flex-col gap-6 pt-2">
              <label className="flex flex-col gap-2">
                <span className="font-label text-label-md text-on-surface">{t("project.settings_build_cmd")}</span>
                <input
                  type="text"
                  value={buildCommand}
                  onChange={(e) => setBuildCommand(e.target.value)}
                  placeholder={t("project_details.build_cmd_placeholder")}
                  className="rounded-xl bg-surface-container px-4 py-3 font-body text-body-md text-on-surface outline-none ring-primary/60 focus:ring-2 max-w-lg"
                />
              </label>

              <label className="flex flex-col gap-2">
                <span className="font-label text-label-md text-on-surface">{t("project.static_output_dir")}</span>
                <input
                  type="text"
                  value={staticOutputDir}
                  onChange={(e) => setStaticOutputDir(e.target.value)}
                  placeholder={t("project.static_output_dir_placeholder")}
                  className="rounded-xl bg-surface-container px-4 py-3 font-body text-body-md text-on-surface outline-none ring-primary/60 focus:ring-2 max-w-lg"
                />
                <span className="font-body text-body-sm text-on-surface-variant max-w-lg" dangerouslySetInnerHTML={{ __html: t("project.static_output_dir_help") }} />
              </label>

              {staticOutputDir.trim() !== "" && (
                <label className="flex items-start gap-3 max-w-lg">
                  <input
                    type="checkbox"
                    checked={spaFallback}
                    onChange={(e) => setSpaFallback(e.target.checked)}
                    className="mt-1 h-5 w-5 rounded accent-primary"
                  />
                  <span className="flex flex-col gap-1">
                    <span className="font-label text-label-md text-on-surface">
                      {t("project.spa_fallback")}
                    </span>
                    <span className="font-body text-body-sm text-on-surface-variant" dangerouslySetInnerHTML={{ __html: t("project.spa_fallback_help") }} />
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
            className="primary-btn px-6 py-3 font-label text-label-md disabled:opacity-50"
          >
            {saving ? t("project.saving") : t("project.save_changes")}
          </button>
        </div>
      </form>

      {/* Danger Zone */}
      <div className="floating-card p-6 md:p-8 border-error/20">
        <h2 className="mb-2 font-headline text-headline-md text-error">{t("project.settings_danger_zone")}</h2>
        <p className="mb-6 font-body text-body-md text-on-surface-variant">
          {t("project.delete_project_warning")}
        </p>

        <button
          type="button"
          onClick={deleteProject}
          className="ghost-btn px-6 py-3 font-label text-label-md bg-error/10 text-error hover:bg-error/20"
        >
          {t("project.settings_delete_project")}
        </button>
      </div>
    </div>
  );
}
