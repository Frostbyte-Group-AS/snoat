import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchApiKeys, createApiKey, revokeApiKey, type ApiKeyItem } from "@/lib/api";
import type { Project } from "@/lib/database.types";

interface McpSettingsTabProps {
  project: Project;
}

export function McpSettingsTab({ project }: McpSettingsTabProps) {
  const queryClient = useQueryClient();
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [keyName] = useState("Snoat MCP Server");

  // Hent eksisterende API-nøkler
  const keysQuery = useQuery({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const res = await fetchApiKeys();
      return res.keys;
    },
  });

  const createMutation = useMutation({
    mutationFn: () => createApiKey(keyName),
    onSuccess: (data) => {
      setNewApiKey(data.token);
      setCopiedKey(false);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => revokeApiKey(keyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const activeKeyDisplay = newApiKey || "snoat_ak_... (Opprett en nøkkel for å få koden)";

  const getClaudeConfig = () => JSON.stringify({
    mcpServers: {
      snoat: {
        command: "npx",
        args: ["-y", "@snoat/mcp-server"],
        env: {
          SNOAT_API_KEY: newApiKey || "DIN_API_NØKKEL_HER"
        }
      }
    }
  }, null, 2);

  const copyConfigToClipboard = () => {
    void navigator.clipboard.writeText(getClaudeConfig());
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  const copyKeyToClipboard = (key: string) => {
    void navigator.clipboard.writeText(key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  return (
    <div className="space-y-8">
      {/* Intro Card */}
      <div className="rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/10 via-surface-container to-background p-6 md:p-8 shadow-lg">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-primary/20 px-3 py-1 text-label-sm font-semibold text-primary">
              <span className="material-symbols-outlined icon-sm">smart_toy</span>
              Model Context Protocol (MCP)
            </div>
            <h2 className="font-display text-headline-md text-on-background">
              Koble AI til din Snoat-konto
            </h2>
            <p className="font-body text-body-md text-on-surface-variant max-w-2xl">
              Opprett en personlig MCP-server for å styre prosjekter, utløse deployments og lese logger direkte fra Claude Desktop eller Cursor.
            </p>
          </div>

          <div className="flex-shrink-0">
            <button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              className="primary-btn flex items-center gap-2.5 px-6 py-3.5 font-label text-label-lg shadow-md hover:shadow-primary/20"
            >
              <span className="material-symbols-outlined">key</span>
              {createMutation.isPending ? "Oppretter nøkkel…" : "Opprett ny MCP-nøkkel"}
            </button>
          </div>
        </div>
      </div>

      {/* Nyutstedt Nøkkel Banner */}
      {newApiKey && (
        <div className="rounded-2xl border border-primary bg-primary/10 p-6 space-y-6 animate-in fade-in-50 duration-300">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-primary font-semibold font-label text-title-md">
              <span className="material-symbols-outlined">check_circle</span>
              Din MCP-nøkkel er klar!
            </div>
            <p className="text-body-sm text-on-surface-variant">
              Kopier nøkkelen din nå, den vises kun én gang. Bruk knappen under for å kopiere oppsettet til Claude Desktop.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="text"
              readOnly
              value={newApiKey}
              className="w-full rounded-xl border border-primary/40 bg-surface px-4 py-3 font-mono text-body-md text-on-surface focus:outline-none"
            />
            <button
              type="button"
              onClick={() => copyKeyToClipboard(newApiKey)}
              className="secondary-btn flex items-center gap-2 px-5 py-3 font-label text-label-md flex-shrink-0"
            >
              <span className="material-symbols-outlined icon-sm">
                {copiedKey ? "check" : "content_copy"}
              </span>
              {copiedKey ? "Kopiert!" : "Kopier nøkkel"}
            </button>
          </div>

          <div className="pt-4 border-t border-primary/20 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h4 className="font-semibold text-on-surface">Claude Desktop Oppsett</h4>
              <p className="text-sm text-on-surface-variant">Limes inn i <code className="font-mono text-xs">claude_desktop_config.json</code></p>
            </div>
            <button
              type="button"
              onClick={copyConfigToClipboard}
              className="primary-btn flex items-center gap-2 px-5 py-3 font-label text-label-md flex-shrink-0"
            >
              <span className="material-symbols-outlined icon-sm">
                {copiedConfig ? "check" : "terminal"}
              </span>
              {copiedConfig ? "Konfigurasjon kopiert!" : "Kopier Claude-konfigurasjon"}
            </button>
          </div>
        </div>
      )}

      {/* Aktive API-nøkler Liste */}
      <div className="rounded-3xl border border-surface-variant/30 bg-surface-container p-6 md:p-8 space-y-6">
        <h3 className="font-display text-title-lg text-on-background">
          Dine aktive API-nøkler
        </h3>

        {keysQuery.isLoading ? (
          <p className="font-body text-body-md text-on-surface-variant">Laster API-nøkler…</p>
        ) : !keysQuery.data || keysQuery.data.length === 0 ? (
          <p className="font-body text-body-md text-on-surface-variant/70 italic">
            Du har ingen aktive API-nøkler ennå. Trykk på "Opprett ny MCP-nøkkel" ovenfor for å komme i gang.
          </p>
        ) : (
          <div className="divide-y divide-surface-variant/20 border-y border-surface-variant/20">
            {keysQuery.data.map((key: ApiKeyItem) => (
              <div key={key.id} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 font-label text-label-lg font-semibold text-on-surface">
                    <span className="material-symbols-outlined icon-sm text-primary">vpn_key</span>
                    {key.name}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-4 text-body-xs text-on-surface-variant font-mono">
                    <span>Prefiks: {key.token_prefix}...</span>
                    <span>Opprettet: {new Date(key.created_at).toLocaleDateString("no-NO")}</span>
                    {key.last_used_at && (
                      <span>Sist brukt: {new Date(key.last_used_at).toLocaleDateString("no-NO")}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm("Er du sikker på at du vil slette denne nøkkelen? AI-klienten vil miste tilgangen.")) {
                      revokeMutation.mutate(key.id);
                    }
                  }}
                  disabled={revokeMutation.isPending}
                  className="text-error hover:bg-error/10 p-2 rounded-lg transition-colors"
                  title="Slett nøkkel"
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
