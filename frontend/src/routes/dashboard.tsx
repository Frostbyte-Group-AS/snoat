import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DashboardNav } from "@/components/DashboardNav";

import { DeploymentStatusBadge } from "@/components/DeploymentStatusBadge";
import { useDeploymentsRealtime } from "@/hooks/useDeploymentsRealtime";
import {
  deployProject,
  getGithubStatus,
  listGithubRepos,
  type GithubRepo,
  type GithubStatus,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Deployment, Project, ProjectWithLatestDeployment } from "@/lib/database.types";
import { appDomainSuffix } from "@/lib/platform";
import { getSupabase } from "@/lib/supabase";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [{ title: "Mine prosjekter — Snoat" }, { name: "robots", content: "noindex" }],
  }),
  component: DashboardPage,
});

async function fetchProjects(): Promise<ProjectWithLatestDeployment[]> {
  const { data, error } = await getSupabase()
    .from("projects")
    .select("*, deployments(*)")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const { deployments, ...project } = row as Project & { deployments: Deployment[] };
    const latest = [...(deployments ?? [])].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    )[0];
    return { ...project, latestDeployment: latest ?? null };
  });
}

function DashboardPage() {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) void navigate({ to: "/login" });
  }, [loading, user, navigate]);

  const projects = useQuery({
    queryKey: ["projects", user?.id],
    queryFn: fetchProjects,
    enabled: Boolean(user),
  });

  useDeploymentsRealtime(Boolean(user));

  const [creating, setCreating] = useState(false);
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("github");
    if (!result) return;

    setGithubNotice(
      result === "connected" ? t("dashboard.github_connected") : t("dashboard.github_failed"),
    );
    void queryClient.invalidateQueries({ queryKey: ["github-status"] });
    window.history.replaceState(null, "", window.location.pathname);
  }, [queryClient, t]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="font-body text-[17px] font-light text-ink/70">{t("login.loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <DashboardNav />

      <main className="mx-auto w-full max-w-[1334px] flex-grow px-5 py-[48px] lg:px-0">
        <div className="mb-[36px] flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[36px] font-bold leading-[1.15] text-ink lg:text-[45px]">
              {t("dashboard.title")}
            </h1>
            <span className="swoosh mt-[8px]" aria-hidden="true" />
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="btn-ink h-[48px] px-[26px] font-display text-[16px]"
          >
            {t("dashboard.new_project")}
          </button>
        </div>

        {githubNotice && (
          <div
            role="status"
            className="mb-[36px] flex items-center justify-between gap-4 border-2 border-ink bg-sun px-[18px] py-[14px] duration-300 animate-in fade-in-50 slide-in-from-top-2"
          >
            <p className="font-body text-[16px] font-normal text-ink">{githubNotice}</p>
            <button
              type="button"
              onClick={() => setGithubNotice(null)}
              aria-label={t("dashboard.close_notice")}
              className="shrink-0 font-body text-[15px] font-bold text-ink underline-offset-[4px] hover:underline"
            >
              {t("dashboard.close_notice")}
            </button>
          </div>
        )}

        {projects.isLoading && (
          <p className="font-body text-[17px] font-light text-ink/70">{t("dashboard.loading")}</p>
        )}

        {projects.isError && (
          <div className="ink-card-lg px-[30px] py-[32px]">
            <h2 className="font-display text-[24px] font-bold text-ink">
              {t("dashboard.error_title")}
            </h2>
            <p className="mt-[10px] font-body text-[16px] font-normal text-error">
              {projects.error.message}
            </p>
          </div>
        )}

        {projects.isSuccess && projects.data.length === 0 && (
          <EmptyState onCreate={() => setCreating(true)} />
        )}

        {projects.isSuccess && projects.data.length > 0 && (
          <div className="grid grid-cols-1 gap-[31px] md:grid-cols-2 lg:grid-cols-3">
            {projects.data.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </main>

      {creating && <NewProjectDialog userId={user.id} onClose={() => setCreating(false)} />}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="ink-card-lg flex flex-col items-center px-[30px] py-[64px] text-center">
      <p className="numeral text-[86px]" aria-hidden="true">
        #1
      </p>
      <span className="swoosh mt-[6px]" aria-hidden="true" />
      <h2 className="mt-[18px] font-display text-[28px] font-bold text-ink">
        {t("dashboard.empty_title")}
      </h2>
      <p className="mt-[12px] max-w-[520px] font-body text-[17px] font-light leading-[1.55] text-ink">
        {t("dashboard.empty_desc")}
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="btn-ink mt-[26px] h-[48px] px-[26px] font-display text-[16px]"
      >
        {t("dashboard.empty_cta")}
      </button>
    </div>
  );
}

function ProjectFavicon({
  url,
  repoUrl,
  name,
}: {
  url: string | null;
  repoUrl: string;
  name: string;
}) {
  const [imgSrc, setImgSrc] = useState<string | null>(() => {
    if (url) {
      return `${url.replace(/\/$/, "")}/favicon.ico`;
    }
    const owner = repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").split("/")[0];
    return owner ? `https://github.com/${owner}.png?size=64` : null;
  });
  const [failed, setFailed] = useState(false);

  const handleNextFallback = () => {
    if (url && imgSrc?.includes("/favicon.ico")) {
      const owner = repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").split("/")[0];
      if (owner) {
        setImgSrc(`https://github.com/${owner}.png?size=64`);
        return;
      }
    }
    setFailed(true);
  };

  // Uten favicon står prosjektets forbokstav i en svart rute. Det er samme
  // grep som avataren i toppraden, og holder rutenettet visuelt i takt.
  if (!imgSrc || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center bg-ink font-body text-[13px] font-bold leading-none text-paper"
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      src={imgSrc}
      alt=""
      className="h-6 w-6 shrink-0 border-2 border-ink object-contain"
      onError={handleNextFallback}
    />
  );
}

function ProjectCard({ project }: { project: ProjectWithLatestDeployment }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const deployment = project.latestDeployment;
  const repoLabel = project.repo_url
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "");

  const isBuilding = deployment?.status === "queued" || deployment?.status === "building";
  /** Appen er slått av. Statusen ligger på prosjektet, ikke på deploymenten. */
  const isStopped = Boolean(project.stopped_at);

  // En stoppet app har ingen adresse som svarer. Lenken skjules derfor, i stedet
  // for å sende brukeren til en 502.
  const displayUrl =
    deployment?.url && !isStopped ? deployment.url.replace(/^https?:\/\//, "") : null;
  const activeUrl = deployment?.url && !isStopped ? deployment.url : null;

  const deploy = useMutation({
    mutationFn: () => deployProject(project.id),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      void navigate({
        to: "/projects/$projectId",
        params: { projectId: project.id },
        search: { tab: "terminal" },
      });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  return (
    <article
      onClick={() => {
        void navigate({
          to: "/projects/$projectId",
          params: { projectId: project.id },
        });
      }}
      className="ink-card flex min-w-0 cursor-pointer flex-col gap-[14px] px-[23px] py-[25px] transition-colors hover:bg-sun-soft"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-[10px]">
          <ProjectFavicon url={activeUrl} repoUrl={project.repo_url} name={project.name} />
          <h3 className="max-w-[160px] truncate font-body text-[20px] font-normal text-ink sm:max-w-[200px]">
            {project.name}
          </h3>
        </div>
        <DeploymentStatusBadge status={deployment?.status ?? null} stopped={isStopped} />
      </div>

      {error && (
        <p role="alert" className="font-body text-[15px] font-normal text-error">
          {error}
        </p>
      )}

      {/* Adressen står som ren tekst med hårstrek under – lenkeikonet er borte,
          og en understreket URL leses uansett som en lenke. */}
      <div className="min-w-0">
        {deployment?.url ? (
          <a
            href={deployment.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="block max-w-full truncate font-mono text-[13px] text-ink underline decoration-hair underline-offset-[4px] hover:decoration-ink"
          >
            {displayUrl}
          </a>
        ) : (
          <span className="block font-mono text-[13px] text-ink/50">{t("dashboard.no_url")}</span>
        )}
      </div>

      <hr className="hairline" />

      <div className="mt-auto flex items-center justify-between gap-3">
        {project.repo_url ? (
          <a
            href={project.repo_url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={repoLabel}
            className="min-w-0 truncate font-mono text-[13px] text-ink/70 underline-offset-[4px] hover:text-ink hover:underline"
          >
            {repoLabel}
          </a>
        ) : (
          <span />
        )}

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              deploy.mutate();
            }}
            disabled={deploy.isPending || isBuilding}
            className="btn-ink h-[38px] shrink-0 px-[16px] font-display text-[14px]"
          >
            {isBuilding
              ? t("dashboard.deploying")
              : isStopped
                ? t("dashboard.start")
                : deployment
                  ? t("dashboard.redeploy")
                  : t("dashboard.deploy")}
          </button>
        </div>
      </div>
    </article>
  );
}

function slugFromRepoUrl(repoUrl: string): string {
  const last =
    repoUrl
      .trim()
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
      .pop() ?? "";
  return last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function RepoPicker({
  status,
  repos,
  isLoading,
  error,
  search,
  onSearch,
  selectedUrl,
  onSelect,
}: {
  status: GithubStatus | undefined;
  repos: GithubRepo[];
  isLoading: boolean;
  error: Error | null;
  search: string;
  onSearch: (value: string) => void;
  selectedUrl: string;
  onSelect: (repo: GithubRepo) => void;
}) {
  const { t } = useTranslation();
  if (!status?.connected) {
    return (
      <div className="border-2 border-ink px-[18px] py-[20px] text-center">
        <p className="mb-[16px] font-body text-[16px] font-light leading-[1.5] text-ink">
          {t("dashboard.new_project_modal.connect_github_prompt")}
        </p>
        <a
          href={status?.installUrl ?? "#"}
          className="btn-ink h-[44px] px-[22px] font-display text-[15px]"
        >
          {t("dashboard.new_project_modal.connect_github")}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder={t("dashboard.new_project_modal.search_placeholder")}
        className="field-ink h-[46px] px-[14px] font-body text-[16px] font-normal outline-none placeholder:text-ink/40"
      />

      <div className="max-h-56 overflow-y-auto border-2 border-ink">
        {isLoading && (
          <p className="px-[14px] py-[14px] font-body text-[16px] font-light text-ink/70">
            {t("dashboard.new_project_modal.loading_repos")}
          </p>
        )}

        {error && (
          <p role="alert" className="px-[14px] py-[14px] font-body text-[16px] text-error">
            {error.message}
          </p>
        )}

        {!isLoading && !error && repos.length === 0 && (
          <p className="px-[14px] py-[14px] font-body text-[16px] font-light text-ink/70">
            {t("dashboard.new_project_modal.no_repos")}{" "}
            <a
              href={status.installUrl ?? "#"}
              className="text-ink underline underline-offset-[4px]"
            >
              {t("dashboard.new_project_modal.grant_access")}
            </a>
            .
          </p>
        )}

        {repos.map((repo) => {
          const selected = repo.cloneUrl === selectedUrl;
          return (
            <button
              key={repo.id}
              type="button"
              onClick={() => onSelect(repo)}
              aria-pressed={selected}
              className={`flex w-full items-center justify-between gap-3 border-b border-hair px-[14px] py-[11px] text-left transition-colors last:border-b-0 ${
                selected ? "bg-sun" : "hover:bg-sun-soft"
              }`}
            >
              <span className="truncate font-mono text-[14px] text-ink">{repo.fullName}</span>
              {repo.private && (
                <span className="shrink-0 border border-ink px-[6px] py-[1px] font-body text-[11px] uppercase tracking-[0.08em] text-ink">
                  {t("dashboard.new_project_modal.private")}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NewProjectDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [search, setSearch] = useState("");
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [pasteUrl, setPasteUrl] = useState(false);

  const status = useQuery({ queryKey: ["github-status"], queryFn: getGithubStatus });
  const repos = useQuery({
    queryKey: ["github-repos"],
    queryFn: listGithubRepos,
    enabled: status.data?.connected === true,
  });

  const showPicker = status.data?.configured === true && !pasteUrl;

  const filtered = (repos.data?.repos ?? []).filter((repo) =>
    repo.fullName.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const effectiveName = nameTouched ? name : slugFromRepoUrl(repoUrl);

  const selectRepo = (repo: GithubRepo) => {
    setRepoUrl(repo.cloneUrl);
    setInstallationId(repo.installationId);
  };

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await getSupabase().from("projects").insert({
        user_id: userId,
        name: effectiveName,
        repo_url: repoUrl.trim(),
        github_installation_id: installationId,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-5 duration-200 animate-in fade-in-0"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-title"
      onClick={onClose}
    >
      <div
        className="ink-card-lg w-full max-w-[560px] px-[30px] py-[32px] duration-250 animate-in fade-in-0 slide-in-from-bottom-2 zoom-in-95"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="new-project-title" className="font-display text-[28px] font-bold text-ink">
          {t("dashboard.new_project_modal.title")}
        </h2>
        <span className="swoosh mt-[6px]" aria-hidden="true" />
        <p className="mt-[14px] font-body text-[16px] font-light leading-[1.5] text-ink">
          {t("dashboard.new_project_modal.desc")}
        </p>

        <form onSubmit={handleSubmit} className="mt-[24px] flex flex-col gap-[16px]">
          <div className="flex flex-col gap-[8px]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-body text-[15px] font-normal text-ink">
                {t("dashboard.new_project_modal.github_repo")}
              </span>
              {status.data?.configured && (
                <button
                  type="button"
                  onClick={() => {
                    setPasteUrl(!pasteUrl);
                    setRepoUrl("");
                    setInstallationId(null);
                  }}
                  className="font-body text-[15px] font-normal text-ink underline underline-offset-[4px] hover:decoration-sun hover:decoration-[3px]"
                >
                  {pasteUrl
                    ? t("dashboard.new_project_modal.choose_list")
                    : t("dashboard.new_project_modal.paste_url")}
                </button>
              )}
            </div>

            {showPicker ? (
              <RepoPicker
                status={status.data}
                repos={filtered}
                isLoading={repos.isLoading}
                error={repos.error}
                search={search}
                onSearch={setSearch}
                selectedUrl={repoUrl}
                onSelect={selectRepo}
              />
            ) : (
              <input
                type="url"
                required
                value={repoUrl}
                onChange={(event) => {
                  setRepoUrl(event.target.value);
                  setInstallationId(null);
                }}
                placeholder="https://github.com/brukernavn/repo"
                className="field-ink h-[46px] px-[14px] font-mono text-[14px] outline-none placeholder:text-ink/40"
              />
            )}

            {!installationId && repoUrl && (
              <span className="font-body text-[14px] font-light text-ink/70">
                {t("dashboard.new_project_modal.public_repo_note")}
              </span>
            )}
          </div>

          <label className="flex flex-col gap-[8px]">
            <span className="font-body text-[15px] font-normal text-ink">
              {t("dashboard.new_project_modal.project_name")}
            </span>
            <input
              type="text"
              required
              value={effectiveName}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
              pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
              title="Små bokstaver, tall og bindestrek."
              placeholder="min-app"
              className="field-ink h-[46px] px-[14px] font-mono text-[14px] outline-none placeholder:text-ink/40"
            />
            <span className="font-body text-[14px] font-light text-ink/70">
              {t("dashboard.new_project_modal.subdomain_preview", {
                name: effectiveName || "<navn>",
                suffix: appDomainSuffix,
              })}
            </span>
          </label>

          {create.isError && (
            <p
              role="alert"
              className="border-2 border-error px-[14px] py-[10px] font-body text-[15px] text-error"
            >
              {create.error.message}
            </p>
          )}

          <div className="mt-[8px] flex justify-end gap-[12px]">
            <button
              type="button"
              onClick={onClose}
              className="btn-outline h-[46px] px-[20px] font-display text-[15px]"
            >
              {t("dashboard.new_project_modal.cancel")}
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="btn-ink h-[46px] px-[24px] font-display text-[15px]"
            >
              {create.isPending
                ? t("dashboard.new_project_modal.creating")
                : t("dashboard.new_project_modal.create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
