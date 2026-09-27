/**
 * Verten må være github.com.
 *
 * Uten sjekken kunne en webhook for `github.com/eier/app` trigget en deployment
 * av `gitlab.com/eier/app` – samme `owner/repo`, helt annen kode. Vi snakker kun
 * med api.github.com, så GitHub Enterprise-verter hører ikke hjemme her.
 */
function isGithubHost(host: string): boolean {
  const name = host.split("@").pop()!.split(":")[0]!.toLowerCase();
  return name === "github.com" || name === "www.github.com";
}

/**
 * Normaliserer et repository til `owner/repo` med små bokstaver.
 *
 * Godtar både en klone-URL og `full_name` fra en webhook-payload, og det er
 * hele poenget: `projects.repo_url` skrives like ofte av et menneske som av
 * repo-velgeren, så den finnes i alle varianter – med og uten `.git`, med og
 * uten skråstrek til slutt, med `/tree/main` hengende på, med vilkårlig store
 * bokstaver. Webhooken kjenner bare `full_name`. Denne normalformen er det som
 * lar de to møtes.
 *
 * Returnerer `null` for verdier vi ikke kjenner igjen. Da matcher vi ingenting,
 * i stedet for å gjette og deploye feil prosjekt.
 */
export function repoIdentity(value: string): string | null {
  // Query og fragment først: «…/app?tab=readme» skal ikke bli en del av navnet.
  let rest = value.trim().split(/[?#]/)[0]!;

  const schemeEnd = rest.indexOf("://");
  if (schemeEnd !== -1) {
    const hostAndPath = rest.slice(schemeEnd + 3);
    const pathStart = hostAndPath.indexOf("/");
    if (pathStart === -1) return null;
    if (!isGithubHost(hostAndPath.slice(0, pathStart))) return null;
    rest = hostAndPath.slice(pathStart + 1);
  }

  const segments = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  const [owner, repo] = segments;
  if (!owner || !repo) return null;

  return `${owner}/${repo}`.toLowerCase();
}

/**
 * Rene hjelpere for å følge et repo som er flyttet eller omdøpt på GitHub.
 * Brukes av `routes/webhooks.ts`; skilt ut hit så de kan testes uten GitHub
 * eller database.
 */

/**
 * Prosjektene som KAN peke på `fullName` under et gammelt eiernavn: samme
 * reponavn, annen eier. Bare kandidater – webhooken bekrefter hver av dem mot
 * GitHubs `repository.id` før noe skrives.
 */
export function moveCandidates<T extends { repo_url: string }>(projects: T[], fullName: string): T[] {
  const wanted = repoIdentity(fullName);
  if (!wanted) return [];
  const name = wanted.split("/")[1];
  return projects.filter((project) => {
    const identity = repoIdentity(project.repo_url);
    return identity !== null && identity !== wanted && identity.split("/")[1] === name;
  });
}

/**
 * Det gamle `owner/repo` fra et `repository`-event (`renamed`/`transferred`),
 * eller `null` hvis eventet ikke endrer navnet.
 */
export function previousFullName(payload: {
  action?: string;
  repository?: { full_name?: string };
  changes?: {
    repository?: { name?: { from?: string } };
    owner?: { from?: { user?: { login?: string }; organization?: { login?: string } } };
  };
}): string | null {
  if (payload.action !== "renamed" && payload.action !== "transferred") return null;
  const [owner, name] = (payload.repository?.full_name ?? "").split("/");
  if (!owner || !name) return null;

  const oldOwner =
    payload.changes?.owner?.from?.organization?.login ?? payload.changes?.owner?.from?.user?.login ?? owner;
  const oldName = payload.changes?.repository?.name?.from ?? name;
  const previous = `${oldOwner}/${oldName}`;

  return repoIdentity(previous) === repoIdentity(`${owner}/${name}`) ? null : previous;
}
