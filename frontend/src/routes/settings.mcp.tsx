import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DashboardNav } from "@/components/DashboardNav";
import {
  createApiKey,
  disconnectMcpClient,
  fetchApiKeys,
  fetchMcpConnections,
  mcpConnectorUrl,
  revokeApiKey,
  type ApiKeyItem,
  type McpConnection,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

/**
 * «AI-tilkobling» – kontoens MCP-innstillinger.
 *
 * Ligger under `/settings` og ikke inne i et prosjekt, som den gjorde før. Det
 * var misvisende: tilgangen gjelder hele kontoen, så en fane inne i «mittvel» ga
 * inntrykk av at Claude bare fikk se det ene prosjektet – og den samme fanen sto
 * dessuten identisk under hvert prosjekt.
 *
 * Siden har én hovedhandling: kopier én URL. Alt annet er sekundært, og
 * API-nøkler ligger sammenrullet nederst, for klienter som ikke støtter OAuth.
 */
export const Route = createFileRoute("/settings/mcp")({
  head: () => ({
    meta: [{ title: "AI-tilkobling — Snoat" }, { name: "robots", content: "noindex" }],
  }),
  component: McpSettingsPage,
});

function McpSettingsPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const connectorUrl = mcpConnectorUrl();

  useEffect(() => {
    if (!loading && !user) void navigate({ to: "/login" });
  }, [loading, user, navigate]);

  const connections = useQuery({
    queryKey: ["mcp-connections"],
    queryFn: async () => (await fetchMcpConnections()).connections,
    enabled: !!user,
  });

  const disconnect = useMutation({
    mutationFn: (clientId: string) => disconnectMcpClient(clientId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-connections"] }),
  });

  return (
    <div className="min-h-screen bg-background">
      <DashboardNav />

      <main className="mx-auto flex max-w-container-max flex-col gap-8 px-margin-mobile py-10 md:px-gutter">
        <ConnectCard connectorUrl={connectorUrl} />

        <ConnectionsCard
          connections={connections.data}
          loading={connections.isLoading}
          onDisconnect={(clientId) => disconnect.mutate(clientId)}
          disconnecting={disconnect.isPending}
        />

        <CommandLineCard connectorUrl={connectorUrl} />
      </main>
    </div>
  );
}

/**
 * Kopier-knapp som sier at den virket.
 *
 * Tilbakemeldingen står i to sekunder. Uten den er det umulig å se forskjell på
 * «jeg trykket» og «det skjedde noe», og brukeren trykker igjen.
 */
function CopyButton({
  value,
  label,
  copiedLabel,
  className = "primary-btn",
}: {
  value: string;
  label: string;
  copiedLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={`${className} flex flex-shrink-0 items-center gap-2 px-5 py-3 font-label text-label-md`}
    >
      <span className="material-symbols-outlined icon-sm">{copied ? "check" : "content_copy"}</span>
      {copied ? copiedLabel : label}
    </button>
  );
}

/** Hovedkortet: URL-en, og de fire trinnene i Claude. */
function ConnectCard({ connectorUrl }: { connectorUrl: string }) {
  const { t } = useTranslation();

  const steps = [t("mcp.step_open"), t("mcp.step_add"), t("mcp.step_paste"), t("mcp.step_approve")];

  return (
    <section className="flex flex-col gap-6 rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/10 via-surface-container to-background p-6 shadow-lg md:p-8">
      <div className="flex flex-col gap-2">
        <span className="inline-flex w-fit items-center gap-2 rounded-full bg-primary/20 px-3 py-1 font-label text-label-sm font-semibold text-primary">
          <span className="material-symbols-outlined icon-sm">smart_toy</span>
          {t("mcp.eyebrow")}
        </span>
        <h1 className="font-display text-headline-md text-on-background">{t("mcp.title")}</h1>
        <p className="max-w-2xl font-body text-body-md text-on-surface-variant">{t("mcp.intro")}</p>
      </div>

      <div className="flex flex-col gap-3">
        <label
          htmlFor="connector-url"
          className="font-label text-label-md font-semibold text-on-surface"
        >
          {t("mcp.url_label")}
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="connector-url"
            type="text"
            readOnly
            value={connectorUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-xl border border-primary/40 bg-surface px-4 py-3 font-mono text-body-md text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <CopyButton
            value={connectorUrl}
            label={t("mcp.url_copy")}
            copiedLabel={t("mcp.url_copied")}
          />
        </div>
      </div>

      <ol className="flex flex-col gap-4">
        {steps.map((step, index) => (
          <li key={step} className="flex items-start gap-4">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/20 font-label text-label-md font-semibold text-primary">
              {index + 1}
            </span>
            <span className="pt-0.5 font-body text-body-md text-on-surface">{step}</span>
          </li>
        ))}
      </ol>

      <p className="font-body text-body-sm text-on-surface-variant">{t("mcp.no_key_needed")}</p>
    </section>
  );
}

/** Hvem har tilgang akkurat nå – og knappen som fjerner den. */
function ConnectionsCard({
  connections,
  loading,
  onDisconnect,
  disconnecting,
}: {
  connections: McpConnection[] | undefined;
  loading: boolean;
  onDisconnect: (clientId: string) => void;
  disconnecting: boolean;
}) {
  const { t, i18n } = useTranslation();
  const formatDate = (value: string) =>
    new Date(value).toLocaleDateString(i18n.language === "no" ? "nb-NO" : "en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });

  return (
    <section className="flex flex-col gap-5 rounded-3xl border border-surface-variant/30 bg-surface-container p-6 md:p-8">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-title-lg text-on-background">
          {t("mcp.connections_title")}
        </h2>
        <p className="font-body text-body-sm text-on-surface-variant">
          {t("mcp.connections_subtitle")}
        </p>
      </div>

      {loading ? (
        <p className="font-body text-body-md text-on-surface-variant">{t("mcp.loading")}</p>
      ) : !connections || connections.length === 0 ? (
        <p className="font-body text-body-md italic text-on-surface-variant/70">
          {t("mcp.connections_empty")}
        </p>
      ) : (
        <ul className="divide-y divide-surface-variant/20 border-y border-surface-variant/20">
          {connections.map((connection) => (
            <li
              key={connection.clientId}
              className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center"
            >
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-2 font-label text-label-lg font-semibold text-on-surface">
                  <span className="material-symbols-outlined icon-sm text-primary">link</span>
                  {connection.clientName}
                </span>
                <span className="font-body text-body-xs text-on-surface-variant">
                  {t("mcp.connected_at", { date: formatDate(connection.connectedAt) })}
                  {" · "}
                  {connection.lastUsedAt
                    ? t("mcp.last_used", { date: formatDate(connection.lastUsedAt) })
                    : t("mcp.never_used")}
                </span>
              </div>

              <button
                type="button"
                onClick={() => {
                  if (confirm(t("mcp.disconnect_confirm", { client: connection.clientName }))) {
                    onDisconnect(connection.clientId);
                  }
                }}
                disabled={disconnecting}
                className="ghost-btn self-start px-4 py-2.5 font-label text-label-md text-error disabled:opacity-60 sm:self-auto"
              >
                {t("mcp.disconnect")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Kommandolinje-klienter, sammenrullet.
 *
 * Claude Code, Cursor og egne skript kan sende en Authorization-header selv, og
 * for dem er en API-nøkkel enklere enn en nettleserflyt. Men det er
 * mindretallet, så det ligger bak en `<details>`: nøkkelen var tidligere det
 * første kunden møtte, og da ble den også det de fleste valgte – uten å trenge
 * den.
 */
function CommandLineCard({ connectorUrl }: { connectorUrl: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<string | null>(null);

  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: async () => (await fetchApiKeys()).keys,
  });

  const create = useMutation({
    mutationFn: () => createApiKey("MCP-klient"),
    onSuccess: (data) => {
      setNewKey(data.token);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) => revokeApiKey(keyId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  const claudeCodeCommand = `claude mcp add --transport http snoat ${connectorUrl}`;

  return (
    <details className="group rounded-3xl border border-surface-variant/30 bg-surface-container p-6 md:p-8">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-title-lg text-on-background">
            {t("mcp.advanced_title")}
          </h2>
          <p className="font-body text-body-sm text-on-surface-variant">
            {t("mcp.advanced_subtitle")}
          </p>
        </div>
        <span className="material-symbols-outlined text-on-surface-variant transition-transform group-open:rotate-180">
          expand_more
        </span>
      </summary>

      <div className="mt-6 flex flex-col gap-8">
        {/* Claude Code klarer OAuth selv – der trengs ingen nøkkel. */}
        <div className="flex flex-col gap-3">
          <h3 className="font-label text-label-lg font-semibold text-on-surface">
            {t("mcp.claude_code_title")}
          </h3>
          <p className="font-body text-body-sm text-on-surface-variant">
            {t("mcp.claude_code_body")}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <code className="w-full overflow-x-auto rounded-xl border border-surface-variant/40 bg-surface px-4 py-3 font-mono text-body-sm text-on-surface">
              {claudeCodeCommand}
            </code>
            <CopyButton
              value={claudeCodeCommand}
              label={t("mcp.url_copy")}
              copiedLabel={t("mcp.url_copied")}
              className="secondary-btn"
            />
          </div>
        </div>

        {/* API-nøkler, for klienter uten OAuth-støtte. */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex flex-col gap-1">
              <h3 className="font-label text-label-lg font-semibold text-on-surface">
                {t("mcp.keys_title")}
              </h3>
              <p className="max-w-xl font-body text-body-sm text-on-surface-variant">
                {t("mcp.keys_body")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={create.isPending}
              className="secondary-btn flex-shrink-0 px-5 py-3 font-label text-label-md disabled:opacity-60"
            >
              {create.isPending ? t("mcp.keys_creating") : t("mcp.keys_create")}
            </button>
          </div>

          {newKey && (
            <div className="flex flex-col gap-3 rounded-2xl border border-primary bg-primary/10 p-5">
              <p className="font-body text-body-sm text-on-surface">{t("mcp.keys_once_warning")}</p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  readOnly
                  value={newKey}
                  onFocus={(event) => event.currentTarget.select()}
                  className="w-full rounded-xl border border-primary/40 bg-surface px-4 py-3 font-mono text-body-sm text-on-surface focus:outline-none"
                />
                <CopyButton
                  value={newKey}
                  label={t("mcp.url_copy")}
                  copiedLabel={t("mcp.url_copied")}
                  className="secondary-btn"
                />
              </div>
            </div>
          )}

          {keys.isLoading ? (
            <p className="font-body text-body-sm text-on-surface-variant">{t("mcp.loading")}</p>
          ) : !keys.data || keys.data.length === 0 ? (
            <p className="font-body text-body-sm italic text-on-surface-variant/70">
              {t("mcp.keys_empty")}
            </p>
          ) : (
            <ul className="divide-y divide-surface-variant/20 border-y border-surface-variant/20">
              {keys.data.map((key: ApiKeyItem) => (
                <li
                  key={key.id}
                  className="flex flex-col justify-between gap-2 py-3 sm:flex-row sm:items-center"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-label text-label-md text-on-surface">{key.name}</span>
                    <span className="font-mono text-body-xs text-on-surface-variant">
                      {key.token_prefix}…
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(t("mcp.keys_revoke_confirm"))) revoke.mutate(key.id);
                    }}
                    disabled={revoke.isPending}
                    className="ghost-btn self-start px-4 py-2 font-label text-label-md text-error disabled:opacity-60 sm:self-auto"
                  >
                    {t("mcp.keys_revoke")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}
