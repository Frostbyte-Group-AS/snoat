import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SnoatLogo } from "@/components/SnoatLogo";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Mark } from "@/components/Mark";
import { DeploymentStatusBadge } from "@/components/DeploymentStatusBadge";
import { BranchPicker } from "@/components/BranchPicker";
import { DnsSettingsTab } from "@/components/DnsSettingsTab";
import { AccessPasswordCard, DevSitesCard } from "@/components/DevSitesCard";
import { SiteToggle } from "@/components/SiteToggle";
import { AnalyticsTab } from "@/components/AnalyticsTab";
import { ErrorsTab } from "@/components/ErrorsTab";
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
  deleteProject as deleteProjectRequest,
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

type Tab = "deployments" | "terminal" | "analytics" | "errors" | "dns" | "mcp" | "env" | "settings";

/** Fanene i prosjektvisningen, i den rekkefølgen de vises. */
const TABS: ReadonlyArray<{ id: Tab; labelKey: string }> = [
  { id: "deployments", labelKey: "project.tab_deployments" },
  { id: "terminal", labelKey: "project.tab_terminal" },
  { id: "analytics", labelKey: "project.tab_analytics" },
  { id: "errors", labelKey: "project.tab_errors" },
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
  /**
   * Helsesveipet på backend (`services/helse.ts`) fant at containeren er borte,
   * selv om siste deployment er `success` (`projects.container_died_at`, 0015).
   * En app stemplet «Live» som ikke svarer, skal ikke stå som det.
   */
  const isUnhealthy = Boolean(project?.container_died_at);
  // En dev-side er en prosjektrad med en forelder (migrasjon 0013). Den styres
  // med en av/på-bryter i stedet for Stopp/Start, se kommentaren ved bryteren.
  const isDevSite = Boolean(project?.parent_project_id);

  // Hovedprosjektet en dev-side hører til. Brukes til å si hvor man er – uten
  // det heter en dev-side bare «eierfullstack-dev», og man må kunne
  // navnekonvensjonen for å se sammenhengen.
  const parentProject = useQuery({
    queryKey: ["project", project?.parent_project_id],
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from("projects")
        .select("id, name")
        .eq("id", project!.parent_project_id!)
        .single();
      if (error) throw error;
      return data as { id: string; name: string };
    },
    enabled: Boolean(project?.parent_project_id),
  });

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
      {/* Samme topprad som dashboardet (`DashboardNav`): papir, hårstrek under,
          ingen skygge og ingen blur.

          Den lå tidligere på `bg-ink/40` – en halvgjennomsiktig svart flate som
          ble grå over innholdet og skiftet farge når siden rullet under den.
          Deretter på `bg-paper/95`, som er det samme problemet i mildere form:
          fem prosent gjennomsiktighet er nok til at fargen på headeren avhenger
          av hva som ligger bak den. En sticky flate skal ha én farge. */}
      <header className="sticky top-0 z-50 border-b-2 border-line bg-paper">
        <div className="mx-auto flex max-w-[1334px] items-center justify-between px-5 py-4 lg:px-0">
          <div className="flex items-center gap-6">
            <Link to="/" className="anim-slide-in inline-flex">
              <SnoatLogo />
            </Link>
            <span className="h-4 w-px bg-hair" />
            <Link
              to="/dashboard"
              className="anim-slide-in [--anim-delay:60ms] group flex items-center gap-1.5 font-body text-[15px] text-ink/70 transition-colors hover:text-ink"
            >
              {/* Pila trekker seg et hakk tilbake når man peker på lenken – den
                  eneste retningsangivelsen vi har uten ikoner. */}
              <span
                aria-hidden="true"
                className="inline-block transition-transform duration-200 group-hover:-translate-x-1"
              >
                ←
              </span>
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
          <div className="anim-rise">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-[32px] font-bold text-ink">{project.name}</h1>
              <DeploymentStatusBadge
                status={latestDeployment?.status ?? null}
                stopped={isStopped}
                stopping={stopMutation.isPending}
                unhealthy={isUnhealthy}
              />
              {/* Hvilken gren står vi i? Merkelappen er gul mens det bygges –
                  det er nettopp da spørsmålet «er dette produksjon eller dev?»
                  stilles, og svaret lå tidligere bare inne i loggteksten. */}
              <BranchChip
                branch={latestDeployment?.branch ?? project.branch}
                tone={isBuilding ? "loud" : "quiet"}
              />
              {isDevSite && parentProject.data && (
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: parentProject.data.id }}
                  className="font-body text-[15px] text-ink/70 underline decoration-hair underline-offset-[4px] hover:text-ink hover:decoration-ink"
                >
                  {t("project.dev_branch_of", { project: parentProject.data.name })}
                </Link>
              )}
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
                  se om det virket. Lenkene skjules når appen er stoppet, eller
                  når helsesveipet har funnet at den er nede: en lenke som ser
                  levende ut, men gir 502, er verre enn ingen. */}
              {latestDeployment?.url && !isStopped && !isUnhealthy ? (
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

          <div className="anim-rise [--anim-delay:90ms] flex items-center gap-4">
            {/* På en dev-side er av/på det man gjør oftest: den skal stå når man
                jobber og ligge nede resten av tiden, uten å telle mot
                plangrensen. En bryter viser dessuten *tilstanden* – to knapper
                der den ene forsvinner gjorde ikke det, og et stopp så ødelagt ut
                fordi knappen bare var borte.

                Hovedprosjekter beholder Stopp-knappen. Å slå av produksjonen skal
                kreve at man leser hva knappen heter, ikke bare treffe en bryter. */}
            {isDevSite ? (
              <SiteToggle project={project} busy={isBuilding || deployMutation.isPending} />
            ) : (
              latestDeployment?.status === "success" &&
              !isStopped && (
                <button
                  type="button"
                  onClick={() => stopMutation.mutate()}
                  disabled={stopMutation.isPending}
                  className="btn-outline border-error px-[16px] py-[10px] font-body text-[15px] text-error hover:bg-error hover:text-paper"
                >
                  {stopMutation.isPending
                    ? t("project_details.stopping")
                    : t("project.stop_project")}
                </button>
              )
            )}

            {/* På en avslått dev-side ville denne knappen hett «Start» og gjort
                nøyaktig det bryteren ved siden av gjør. To kontroller for samme
                handling er verre enn én, så den viker – bryteren er veien
                tilbake på. */}
            {!(isDevSite && isStopped) && (
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
            )}
          </div>
        </div>

        {/* Feltet ligger der hele tiden og folder seg ut når det er noe å si.
            Stod den i en `&&`, dyttet den hele fanelinja nedover i ett hopp. */}
        <div className="collapse-grid" data-open={error ? "true" : "false"} inert={!error}>
          <div>
            <div
              role="alert"
              className="mb-6 border-2 border-error px-[18px] py-[14px] font-body text-[16px] text-error"
            >
              {error}
            </div>
          </div>
        </div>

        {/* Sliding Segmented Tab Control */}
        <SegmentedTabBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          isBuilding={isBuilding}
          t={t}
        />

        {/* Animated Tab Content Transition */}
        <div key={activeTab} className="anim-rise">
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

          {activeTab === "errors" && <ErrorsTab project={project} />}

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

/**
 * Grenen et bygg kom fra, som en liten merkelapp.
 *
 * Den finnes fordi produksjonen og dev-grenen er to prosjektrader som ser helt
 * like ut i dashboardet: samme repo, samme byggelogg, samme terminal. Uten
 * grennavnet ved siden av bygget var det ingen måte å se om man leste
 * produksjonsbygget eller dev-bygget – man måtte lete etter «Gren: …» inne i
 * loggteksten.
 *
 * `null` når vi ikke vet (rader fra før migrasjon 0014). Da skriver vi
 * ingenting, framfor å gjette på prosjektets gjeldende gren – den kan ha vært
 * en annen da bygget kjørte.
 */
function BranchChip({
  branch,
  tone = "quiet",
}: {
  branch: string | null | undefined;
  tone?: "quiet" | "loud";
}) {
  if (!branch) return null;

  return (
    <span
      title={branch}
      className={`inline-flex max-w-[220px] shrink-0 items-center truncate border-2 px-[8px] py-[1px] font-mono text-[12px] ${
        tone === "loud" ? "border-line bg-sun text-ink" : "border-hair text-ink/70"
      }`}
    >
      {branch}
    </span>
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
    <div className="relative mb-8 inline-flex flex-wrap items-center border-2 border-line">
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
          className={`relative z-10 flex items-center gap-2 px-[20px] py-[10px] font-body text-[15px] transition-colors duration-200 active:scale-[0.98] ${
            activeTab === tab.id ? "font-bold text-paper" : "text-ink hover:bg-sun"
          }`}
        >
          {t(tab.labelKey)}
          {tab.id === "terminal" && isBuilding && (
            <span
              aria-hidden="true"
              className={`anim-breathe ml-1 h-2 w-2 ${activeTab === tab.id ? "bg-sun" : "bg-ink"}`}
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

// -----------------------------------------------------------------------------
// Component: Build Stage Box Card
// -----------------------------------------------------------------------------
function BuildStageCard({ deployment }: { deployment: Deployment | null }) {
  // Hooken må stå over den tidlige returen. Første render av prosjektsiden har
  // ingen deployment, den neste har det – og da ville rekkefølgen på hooks endret
  // seg mellom to renders av samme komponent.
  const buildDuration = useBuildDuration(deployment);

  if (!deployment) return null;

  const isBuilding = deployment.status === "queued" || deployment.status === "building";
  const isSuccess = deployment.status === "success";
  const isFailed = deployment.status === "failed";

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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Tilstanden som en 28 px rute: fylt gul mens noe skjer, fylt svart
              når det gikk bra, rød ramme når det feilet, grå når den hviler.
              Formen skiller dem, ikke bare fargen.

              Mens det bygges løper `anim-trace` rundt ramma – samme virkemiddel
              som statusmerket, og her er flaten stor nok til at bevegelsen
              faktisk leses på avstand. */}
          <span
            aria-hidden="true"
            className={`relative isolate flex h-7 w-7 shrink-0 items-center justify-center border-2 font-body text-[14px] font-bold leading-none ${
              isBuilding
                ? "border-line bg-sun text-ink"
                : isSuccess
                  ? "border-line bg-ink text-paper"
                  : isFailed
                    ? "border-error bg-paper text-error"
                    : "border-ash bg-ash text-ink"
            }`}
          >
            {isBuilding ? <span aria-hidden className="anim-trace" /> : null}
            {isBuilding ? "·" : isSuccess ? "✓" : isFailed ? "✕" : "–"}
          </span>

          <div className="flex flex-col">
            <span className="flex flex-wrap items-center gap-2 font-body text-[15px] text-ink font-semibold">
              {isBuilding
                ? "Bygging og publisering pågår"
                : isSuccess
                  ? "Bygging fullført"
                  : isFailed
                    ? "Bygging feilet"
                    : "Status"}
              {/* Grenen står i samme linje som «Bygging … pågår», ikke bare i
                  loggen: det er her blikket er mens man venter. */}
              <BranchChip branch={deployment.branch} tone={isBuilding ? "loud" : "quiet"} />
            </span>
            {/* `key` på steglinja gjør at teksten toner inn på nytt hver gang
                bygget bytter steg, i stedet for å bytte ord uten forvarsel. */}
            <span key={stageText} className="anim-fade font-body text-xs text-ink/70">
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
  // Helsesveipet retter avviket på *prosjektet*, ikke på en enkelt deployment –
  // det gjelder derfor bare den ene raden databasen fortsatt kaller «success».
  // Eldre rader er «Fullført» uansett, det betyr noe helt annet der.
  const isUnhealthy = Boolean(project.container_died_at);

  return (
    <div className="flex flex-col gap-8">
      {/* Latest Deployment Summary Card */}
      <div className="ink-card-lg anim-rise p-6 md:p-8 flex flex-col gap-6">
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
                  unhealthy={latest.id === latestSuccessId && isUnhealthy}
                />
                <span className="font-mono text-sm text-ink/70">
                  {latest.commit_hash
                    ? latest.commit_hash.slice(0, 7)
                    : t("project_details.manual_build")}
                </span>
                <BranchChip branch={latest.branch} tone={isBuilding ? "loud" : "quiet"} />
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
      <div className="ink-card-lg anim-rise [--anim-delay:90ms] p-6 md:p-8">
        <h2 className="mb-6 font-display text-[22px] font-bold text-ink">
          {t("project.deployment_history")}
        </h2>

        {deployments.length === 0 ? (
          <p className="font-body text-[16px] text-ink/70">{t("project_details.no_history")}</p>
        ) : (
          <div className="stagger flex flex-col divide-y divide-hair">
            {deployments.map((d) => (
              <DeploymentRow
                key={d.id}
                deployment={d}
                isLive={d.id === latestSuccessId}
                unhealthy={d.id === latestSuccessId && isUnhealthy}
              />
            ))}
          </div>
        )}
      </div>

      {/* Dev-grenene står her, ved siden av byggene, og ikke nederst i
          Innstillinger der de sto før. En dev-gren spinnes opp midt i arbeidet
          for å vise noe fram – da skal den være der man allerede er, ikke bak
          to klikk i et konfigurasjonspanel.

          Bare på hovedprosjekter: databasen håndhever dybde 1, så kortet på en
          dev-side kunne bare sagt nei. */}
      {!project.parent_project_id && <DevSitesCard project={project} />}
    </div>
  );
}

/**
 * Én rad i byggehistorikken.
 *
 * Egen komponent fordi raden trenger `useBuildDuration()`, og en hook kan ikke
 * kalles inne i en `.map`. Det er verdt det: raden leste før varigheten ut av
 * loggteksten («Ferdig på …»), og den linja finnes først når bygget er ferdig.
 * Lista viste altså ingenting mens det faktisk skjedde noe – nøyaktig det
 * tidspunktet man står og ser på den. Nå teller sekundene her også, i gult, så
 * det pågående bygget er like tydelig i historikken som i terminalen.
 */
function DeploymentRow({
  deployment,
  isLive,
  unhealthy = false,
}: {
  deployment: Deployment;
  isLive: boolean;
  /** Bare sann for raden `isLive` gjelder – se `DeploymentsTab`. */
  unhealthy?: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormatters();
  const isBuilding = deployment.status === "queued" || deployment.status === "building";
  const duration = useBuildDuration(deployment);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-4">
        <DeploymentStatusBadge status={deployment.status} isLive={isLive} unhealthy={unhealthy} />
        <span className="font-mono text-sm text-ink">
          {deployment.commit_hash
            ? deployment.commit_hash.slice(0, 7)
            : t("project_details.manual_deploy")}
        </span>
        {/* Grenen per rad, ikke bare på det siste bygget: et prosjekt kan ha
            bygget fra flere grener over tid, og en liste der alle radene ser
            like ut er en liste man ikke kan bruke til å finne ut hva som
            skjedde. */}
        <BranchChip branch={deployment.branch} tone={isBuilding ? "loud" : "quiet"} />
      </div>
      <div className="flex flex-wrap items-center gap-6">
        {duration && (
          <span
            className={`inline-flex items-center gap-1 rounded-none px-2.5 py-1 font-mono text-xs ${
              isBuilding ? "bg-sun text-ink" : "bg-muted text-ink/70"
            }`}
          >
            {isBuilding ? t("project_details.building_duration", { duration }) : duration}
          </span>
        )}
        <span className="font-body text-[16px] text-ink/70">
          {format.dateTime(deployment.created_at)}
        </span>
        {deployment.url && isLive && !unhealthy && (
          <a
            href={deployment.url}
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
    <div className="ink-card-lg terminal-shell anim-rise overflow-hidden p-0">
      {/* Terminal Bar Header */}
      <div className="terminal-bar flex flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-body text-[15px]">{t("project.terminal_title")}</span>
          {/* Terminalen viser bare den *siste* deploymenten, og loggteksten er
              lang: står grenen bare som «Gren: dev» et sted inne i den, må man
              rulle for å finne ut hvilket bygg man ser på. Her står den. */}
          {latestDeployment?.branch && (
            <span className="terminal-dim font-mono text-xs">
              {t("project.terminal_branch", { branch: latestDeployment.branch })}
            </span>
          )}
          {isBuilding ? (
            <span className="flex items-center gap-1.5 rounded-none bg-sun px-2.5 py-0.5 font-mono text-xs text-ink">
              <span aria-hidden="true" className="anim-breathe h-2 w-2 rounded-none bg-ink" />
              {t("project_details.process_running")}
            </span>
          ) : isSuccess ? (
            <span className="anim-fade flex items-center gap-1.5 font-mono text-xs font-medium">
              {t("project_details.process_success")}
            </span>
          ) : isFailed ? (
            <span className="anim-pop flex items-center gap-1.5 border-2 border-error px-[8px] py-[1px] font-mono text-[12px] font-bold text-error">
              {t("project_details.process_failed")}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <label className="terminal-dim flex cursor-pointer select-none items-center gap-2 font-body text-[15px]">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded-none"
            />
            {t("project.terminal_autoscroll")}
          </label>

          <button
            type="button"
            onClick={copyToClipboard}
            className="terminal-btn px-3 py-1.5 font-body text-[15px]"
          >
            {copied ? t("project.terminal_copied") : t("project.terminal_copy")}
          </button>
        </div>
      </div>

      {/* Terminal View Output */}
      <div
        ref={logContainerRef}
        className="terminal-body flex h-[500px] select-text flex-col justify-between overflow-y-auto p-6 font-mono text-sm leading-relaxed"
      >
        <pre className="whitespace-pre-wrap break-words">
          {logs}
          {/* Blinkende blokk mens bygget kjører: loggen kan stå stille i flere
              sekunder under et npm-installasjonssteg, og uten markøren ser den
              død ut. */}
          {isBuilding && <span aria-hidden="true" className="terminal-caret" />}
        </pre>
        {!isBuilding && latestDeployment && (
          <div className="terminal-rule terminal-dim anim-fade mt-6 flex items-center justify-between border-t pt-4 font-mono text-xs">
            <span>
              {isSuccess
                ? t("project_details.process_finished_code0")
                : t("project_details.process_finished_code1")}
            </span>
            <span className="opacity-70">{t("project_details.terminal_session_ended")}</span>
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
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="ink-card anim-pop flex w-full max-w-lg flex-col gap-6 p-6 md:p-8">
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
        <div key={activeMode} className="anim-fade">
          {activeMode === "file" ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              className={`relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[12px] border-2 border-dashed p-8 text-center transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
                isDragOver
                  ? "border-line bg-sun scale-[1.02]"
                  : "border-hair bg-muted hover:border-line hover:bg-sun-soft"
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
                  <p className="anim-rise mt-1 font-body text-xs font-medium text-ink">
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
                <p className="anim-rise font-body text-xs font-medium text-ink">
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
      <form onSubmit={saveEnvVars} className="ink-card-lg anim-rise flex flex-col gap-6 p-6 md:p-8">
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

        <div className="collapse-grid" data-open={message ? "true" : "false"} inert={!message}>
          <div>
            <div className="rounded-[12px] bg-sun p-4 font-body text-[16px] text-ink">
              {message}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {envVars.map((pair) => (
            <div key={pair.id} className="anim-rise flex items-center gap-3">
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
    <div className="ink-card-lg anim-rise flex flex-col gap-6 p-6 md:p-8">
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
              <div className="anim-rise flex items-center gap-3 rounded-[12px] border border-line bg-sun p-4 font-body text-[16px] text-ink">
                {t("project_plan.checkout_success")}
              </div>
            )}

            {search.checkout === "avbrutt" && (
              <div className="anim-rise rounded-[12px] border border-hair bg-muted p-4 font-body text-[16px] text-ink/70">
                {t("project_plan.checkout_canceled", { plan: currentSpecs.name })}
              </div>
            )}

            {checkoutError && (
              <div
                role="alert"
                className="anim-rise border-2 border-error px-[18px] py-[14px] font-body text-[16px] text-error"
              >
                {checkoutError}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
              {/* Free Plan Box */}
              <div
                className={`lift flex flex-col justify-between rounded-[12px] border p-5 ${currentPlan === "free" ? "border-line bg-sun" : "border-hair bg-muted"}`}
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
                      <Mark on={false} size={18} /> {t("project_plan.free_f5")}
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
                className={`lift flex flex-col justify-between rounded-[12px] border p-5 ${currentPlan === "pro" ? "border-line bg-sun" : "border-hair bg-muted hover:border-line"}`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-display text-[26px] font-bold text-ink">Pro</span>
                    {currentPlan === "pro" && (
                      <span className="text-xs font-body px-2.5 py-0.5 rounded-none bg-ink font-semibold text-paper">
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
                className={`lift flex flex-col justify-between rounded-[12px] border p-5 ${currentPlan === "business" ? "border-line bg-sun" : "border-hair bg-muted hover:border-line"}`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-display text-[26px] font-bold text-ink">Business</span>
                    {currentPlan === "business" && (
                      <span className="text-xs font-body px-2.5 py-0.5 rounded-none bg-sun font-semibold text-ink">
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
                    className="btn-outline px-4 py-2 text-center font-body text-[15px]"
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

  const [branch, setBranch] = useState(project.branch ?? "");
  const [buildCommand, setBuildCommand] = useState(project.build_command ?? "");
  const [staticOutputDir, setStaticOutputDir] = useState(project.static_output_dir ?? "");
  const [spaFallback, setSpaFallback] = useState(project.static_spa_fallback);
  /*
   * Kjøremodusen var tidligere IMPLISITT i om katalogfeltet var tomt, og feltet
   * lå inne i trekkspillet «Avanserte byggeinnstillinger». Det gjorde det
   * umulig å finne: for å velge om appen kjører som server eller som filer
   * måtte man åpne et avansert panel og skjønne at en tom tekstboks betydde
   * «server».
   *
   * Nå er valget en egen tilstand med to synlige alternativer. Katalogen er en
   * FØLGE av valget, ikke selve valget. `null` i databasen betyr fortsatt
   * server – kontrakten mot backend er uendret.
   */
  const [runtimeMode, setRuntimeMode] = useState<"server" | "static">(
    project.static_output_dir ? "static" : "server",
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (runtimeMode === "static" && staticOutputDir.trim() === "") {
      setMessage(t("project.runtime_static_dir_required"));
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const { error } = await getSupabase()
        .from("projects")
        .update({
          // Tomt felt = NULL = repoets standardgren. Verdien valideres av
          // check-constrainten `projects_branch_check` her, og av
          // `assertSafeBranch()` når backend kloner – dashboardet skriver raden
          // selv, uten å gå gjennom API-et.
          branch: branch.trim() || null,
          build_command: buildCommand.trim() || null,
          // Server-modus nullstiller katalogen. Uten det ville en bruker som
          // byttet fra statisk til server fått en rad som fortsatt sa
          // «serveres fra disk», og backend ville aldri startet en container.
          static_output_dir: runtimeMode === "static" ? staticOutputDir.trim() : null,
          static_spa_fallback: runtimeMode === "static" ? spaFallback : false,
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
      // Gjennom API-et, ikke `getSupabase().delete()`. En sletting rett i
      // databasen fjerner raden, men lar containeren kjøre og Caddy-ruten stå –
      // og med dev-sider ville den dessuten etterlatt deres containere også,
      // siden `on delete cascade` bare rører rader. `DELETE /api/projects/:id`
      // river ned alt, dev-sidene først.
      await deleteProjectRequest(project.id);
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

      {/* Passordet foran appen gjelder alle prosjekter og hører hjemme her.
          Dev-grenene gjør det ikke lenger: de sto nederst på denne siden, under
          plan og passord, og der fant ingen dem. Kortet står nå i
          Deployments-fanen. */}
      <AccessPasswordCard project={project} />

      {/* General Settings */}
      <form
        onSubmit={saveSettings}
        className="ink-card-lg anim-rise [--anim-delay:90ms] flex flex-col gap-6 p-6 md:p-8"
      >
        <h2 className="font-display text-[22px] font-bold text-ink">
          {t("project.project_settings")}
        </h2>

        <div className="collapse-grid" data-open={message ? "true" : "false"} inert={!message}>
          <div>
            <div className="rounded-[12px] bg-sun p-4 font-body text-[16px] text-ink">
              {message}
            </div>
          </div>
        </div>

        {/* Grenen er ikke en avansert innstilling – den avgjør hvilken kode som
            står på nett. Derfor ligger den over trekkspillet, ikke inni det. */}
        <BranchPicker repo={project.repo_url} value={branch} onChange={setBranch} />

        {/* Kjøremodus hører her av samme grunn som grenen: den avgjør om appen
            i det hele tatt kommer opp. En Next-app med output: "export" som
            står i server-modus bygger grønt og svarer 502 på alt. */}
        <fieldset className="flex flex-col gap-3">
          <legend className="font-body text-[15px] text-ink">{t("project.runtime_mode")}</legend>

          {(["server", "static"] as const).map((mode) => (
            <label key={mode} className="flex max-w-lg cursor-pointer items-start gap-3">
              <input
                type="radio"
                name="runtime-mode"
                value={mode}
                checked={runtimeMode === mode}
                onChange={() => {
                  setRuntimeMode(mode);
                  // Fyller inn den vanligste katalogen med én gang, slik at
                  // valget er komplett og SYNLIG i stedet for at vi gjetter
                  // den i det stille ved lagring.
                  if (mode === "static" && staticOutputDir.trim() === "") {
                    setStaticOutputDir("out");
                  }
                }}
                className="mt-1 h-5 w-5 accent-primary"
              />
              <span className="flex flex-col gap-1">
                <span className="font-body text-[15px] text-ink">
                  {t(`project.runtime_${mode}`)}
                </span>
                <span
                  className="font-body text-[14px] text-ink/70"
                  dangerouslySetInnerHTML={{ __html: t(`project.runtime_${mode}_help`) }}
                />
              </span>
            </label>
          ))}

          {/* Katalogen og SPA-valget er følger av «Statiske filer». De folder
              seg ut i stedet for å dukke opp, av samme grunn som SPA-boksen
              gjorde det før: et hopp midt i skjemaet er vanskelig å følge. */}
          <div
            className="collapse-grid max-w-lg"
            data-open={runtimeMode === "static" ? "true" : "false"}
            inert={runtimeMode !== "static"}
          >
            <div className="flex flex-col gap-4 pt-2 pl-8">
              <label className="flex flex-col gap-2">
                <span className="font-body text-[15px] text-ink">
                  {t("project.static_output_dir")}
                </span>
                <input
                  type="text"
                  value={staticOutputDir}
                  onChange={(e) => setStaticOutputDir(e.target.value)}
                  placeholder="out"
                  className="field-ink max-w-xs px-[14px] py-[12px] font-body text-[16px] outline-none"
                />
                <span
                  className="font-body text-[14px] text-ink/70"
                  dangerouslySetInnerHTML={{ __html: t("project.static_output_dir_help") }}
                />
              </label>

              <label className="flex items-start gap-3">
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
            </div>
          </div>
        </fieldset>

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
      <div className="ink-card-lg anim-rise [--anim-delay:180ms] border-error/20 p-6 md:p-8">
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
