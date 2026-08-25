import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

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

/**
 * «AI-tilkobling» – kontoens egen custom connector.
 *
 * Snoat er en **hostet MCP-server**, og det er hele poenget med denne siden:
 * kunden legger den til som en *custom connector* i Claude. Det finnes ingen
 * pakke å installere, ingen JSON-fil å redigere og ingen lokal prosess som må
 * kjøre – den forrige generasjonen (`mcp-server/`, en stdio-server distribuert
 * som npm-pakke) er fjernet fra kodebasen.
 *
 * Connectoren er **per bruker**. URL-en er den samme for alle, men tilgangen
 * oppstår først når nettopp denne kontoen godkjenner den i samtykkeflyten, og
 * tokenet som utstedes er bundet til brukeren. To personer som limer inn samme
 * URL får hver sin connector, mot hver sin konto.
 *
 * Siden ligger under `/settings` og rendres inne i `routes/settings.tsx`, som
 * eier rammen, overskriften og innloggingssjekken. Her står bare innholdet.
 */
export const Route = createFileRoute("/settings/mcp")({
  head: () => ({
    meta: [{ title: "AI-tilkobling — Snoat" }, { name: "robots", content: "noindex" }],
  }),
  component: McpSettingsPage,
});

function McpSettingsPage() {
  const queryClient = useQueryClient();
  const connectorUrl = mcpConnectorUrl();

  const connections = useQuery({
    queryKey: ["mcp-connections"],
    queryFn: async () => (await fetchMcpConnections()).connections,
  });

  const disconnect = useMutation({
    mutationFn: (clientId: string) => disconnectMcpClient(clientId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-connections"] }),
  });

  return (
    <div className="flex flex-col gap-[31px]">
      <ConnectCard connectorUrl={connectorUrl} />

      <ConnectionsCard
        connections={connections.data}
        loading={connections.isLoading}
        onDisconnect={(clientId) => disconnect.mutate(clientId)}
        disconnecting={disconnect.isPending}
      />

      <CommandLineCard connectorUrl={connectorUrl} />
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
  className = "btn-ink",
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
      className={`${className} flex-shrink-0 px-[20px] py-[12px] font-body text-[15px]`}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

/** Hovedkortet: URL-en, og trinnene i Claude. */
function ConnectCard({ connectorUrl }: { connectorUrl: string }) {
  const { t } = useTranslation();

  const steps = [t("mcp.step_open"), t("mcp.step_add"), t("mcp.step_paste"), t("mcp.step_approve")];

  return (
    <section className="ink-card-lg anim-rise flex flex-col gap-6 px-[30px] py-[32px]">
      <div className="flex flex-col gap-2">
        <span className="w-fit bg-sun px-[8px] py-[2px] font-body text-[12px] font-bold uppercase tracking-[0.1em] text-ink">
          {t("mcp.eyebrow")}
        </span>
        <h2 className="font-display text-[28px] font-bold text-ink">{t("mcp.title")}</h2>
        <p className="max-w-2xl font-body text-[16px] text-ink/70">{t("mcp.intro")}</p>
      </div>

      <div className="flex flex-col gap-3">
        <label htmlFor="connector-url" className="font-body text-[15px] font-bold text-ink">
          {t("mcp.url_label")}
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="connector-url"
            type="text"
            readOnly
            value={connectorUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="field-ink w-full px-[14px] py-[12px] font-mono text-[15px] outline-none"
          />
          <CopyButton
            value={connectorUrl}
            label={t("mcp.url_copy")}
            copiedLabel={t("mcp.url_copied")}
          />
        </div>
      </div>

      <ol className="stagger flex flex-col gap-4">
        {steps.map((step, index) => (
          <li key={step} className="flex items-start gap-4">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center bg-ink font-body text-[14px] font-bold text-paper"
            >
              {index + 1}
            </span>
            <span className="pt-0.5 font-body text-[16px] text-ink">{step}</span>
          </li>
        ))}
      </ol>

      <p className="border-2 border-hair px-[16px] py-[12px] font-body text-[14px] text-ink/70">
        {t("mcp.no_key_needed")}
      </p>
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
    <section className="ink-card anim-rise [--anim-delay:90ms] flex flex-col gap-5 px-[30px] py-[28px]">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[22px] font-bold text-ink">
          {t("mcp.connections_title")}
        </h2>
        <p className="font-body text-[14px] text-ink/70">{t("mcp.connections_subtitle")}</p>
      </div>

      {loading ? (
        <p className="font-body text-[16px] text-ink/70">{t("mcp.loading")}</p>
      ) : !connections || connections.length === 0 ? (
        <p className="font-body text-[16px] italic text-ink/60">{t("mcp.connections_empty")}</p>
      ) : (
        <ul className="stagger divide-y divide-hair border-y border-hair">
          {connections.map((connection) => (
            <li
              key={connection.clientId}
              className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center"
            >
              <div className="flex flex-col gap-1">
                <span className="font-body text-[17px] font-bold text-ink">
                  {connection.clientName}
                </span>
                <span className="font-body text-[13px] text-ink/70">
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
                className="btn-outline self-start border-error px-[16px] py-[10px] font-body text-[15px] text-error hover:bg-error hover:text-paper sm:self-auto"
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
    <details className="group ink-card anim-rise [--anim-delay:180ms] px-[30px] py-[28px]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-[22px] font-bold text-ink">{t("mcp.advanced_title")}</h2>
          <p className="font-body text-[14px] text-ink/70">{t("mcp.advanced_subtitle")}</p>
        </div>
        <span
          aria-hidden="true"
          className="flex h-[28px] w-[28px] shrink-0 items-center justify-center border-2 border-line font-body text-[18px] font-bold leading-none text-ink"
        >
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">–</span>
        </span>
      </summary>

      <div className="mt-6 flex flex-col gap-8">
        {/* Claude Code klarer OAuth selv – der trengs ingen nøkkel. */}
        <div className="flex flex-col gap-3">
          <h3 className="font-body text-[16px] font-bold text-ink">{t("mcp.claude_code_title")}</h3>
          <p className="font-body text-[14px] text-ink/70">{t("mcp.claude_code_body")}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <code className="w-full overflow-x-auto border-2 border-hair px-[14px] py-[12px] font-mono text-[14px] text-ink">
              {claudeCodeCommand}
            </code>
            <CopyButton
              value={claudeCodeCommand}
              label={t("mcp.url_copy")}
              copiedLabel={t("mcp.url_copied")}
              className="btn-outline"
            />
          </div>
        </div>

        {/* API-nøkler, for klienter uten OAuth-støtte. */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex flex-col gap-1">
              <h3 className="font-body text-[16px] font-bold text-ink">{t("mcp.keys_title")}</h3>
              <p className="max-w-xl font-body text-[14px] text-ink/70">{t("mcp.keys_body")}</p>
            </div>
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={create.isPending}
              className="btn-outline flex-shrink-0 px-[20px] py-[12px] font-body text-[15px]"
            >
              {create.isPending ? t("mcp.keys_creating") : t("mcp.keys_create")}
            </button>
          </div>

          {newKey && (
            <div className="flex flex-col gap-3 border-2 border-line bg-sun px-[18px] py-[16px]">
              <p className="font-body text-[14px] font-bold text-ink">
                {t("mcp.keys_once_warning")}
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  readOnly
                  value={newKey}
                  onFocus={(event) => event.currentTarget.select()}
                  className="field-ink w-full px-[14px] py-[12px] font-mono text-[14px] outline-none"
                />
                <CopyButton
                  value={newKey}
                  label={t("mcp.url_copy")}
                  copiedLabel={t("mcp.url_copied")}
                  className="btn-ink"
                />
              </div>
            </div>
          )}

          {keys.isLoading ? (
            <p className="font-body text-[14px] text-ink/70">{t("mcp.loading")}</p>
          ) : !keys.data || keys.data.length === 0 ? (
            <p className="font-body text-[14px] italic text-ink/60">{t("mcp.keys_empty")}</p>
          ) : (
            <ul className="divide-y divide-hair border-y border-hair">
              {keys.data.map((key: ApiKeyItem) => (
                <li
                  key={key.id}
                  className="flex flex-col justify-between gap-2 py-3 sm:flex-row sm:items-center"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-body text-[15px] text-ink">{key.name}</span>
                    <span className="font-mono text-[13px] text-ink/70">{key.token_prefix}…</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(t("mcp.keys_revoke_confirm"))) revoke.mutate(key.id);
                    }}
                    disabled={revoke.isPending}
                    className="btn-outline self-start border-error px-[16px] py-[8px] font-body text-[15px] text-error hover:bg-error hover:text-paper sm:self-auto"
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
