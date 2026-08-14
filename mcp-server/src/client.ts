/**
 * Client wrapper for Snoat Backend API.
 */
export class SnoatClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey: string, baseUrl: string = "http://api.snoat.localhost") {
    this.apiKey = apiKey.trim();
    // Fjern avsluttende skråstrek dersom den finnes
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(url, {
      ...options,
      headers,
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const errorMsg = data?.message || res.statusText || `HTTP Feil ${res.status}`;
      throw new Error(`Snoat API-feil (${res.status}): ${errorMsg}`);
    }

    return data as T;
  }

  async listProjects() {
    return this.request<{ projects: any[] }>("/api/projects");
  }

  async getProject(projectId: string) {
    return this.request<{ project: any; latest_deployment: any }>(`/api/projects/${projectId}`);
  }

  async createProject(params: {
    name: string;
    repoUrl: string;
    externalRef?: string;
    githubInstallationId?: number;
    buildCommand?: string;
    envVars?: Record<string, string>;
    staticOutputDir?: string;
    staticSpaFallback?: boolean;
  }) {
    return this.request<{ project: any; created: boolean }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async updateProject(
    projectId: string,
    params: {
      buildCommand?: string;
      envVars?: Record<string, string>;
      staticOutputDir?: string;
      staticSpaFallback?: boolean;
    }
  ) {
    return this.request<{ project: any }>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }

  async stopProject(projectId: string) {
    return this.request<{ stopped: boolean }>(`/api/projects/${projectId}/stop`, {
      method: "POST",
    });
  }

  async deleteProject(projectId: string) {
    return this.request<{ deleted: boolean }>(`/api/projects/${projectId}`, {
      method: "DELETE",
    });
  }

  async setCustomDomain(projectId: string, customDomain: string | null) {
    return this.request<{ success: boolean; custom_domain: string | null; route?: any }>(
      `/api/projects/${projectId}/domain`,
      {
        method: "PATCH",
        body: JSON.stringify({ custom_domain: customDomain }),
      }
    );
  }

  async getDomainStatus(projectId: string) {
    return this.request<any>(`/api/projects/${projectId}/domain/status`);
  }

  async triggerDeployment(projectId: string) {
    return this.request<{ deployment: any }>(`/api/projects/${projectId}/deploy`, {
      method: "POST",
    });
  }

  async getDeployments(projectId: string) {
    return this.request<{ deployments: any[] }>(`/api/projects/${projectId}/deployments`);
  }

  async getDeploymentLogs(deploymentId: string) {
    return this.request<{ deployment: any }>(`/api/deployments/${deploymentId}`);
  }

  async getAnalytics(projectId: string, from?: string, to?: string, unit?: string) {
    const query = new URLSearchParams();
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (unit) query.set("unit", unit);
    const queryString = query.toString() ? `?${query.toString()}` : "";
    return this.request<any>(`/api/projects/${projectId}/analytics${queryString}`);
  }
}
