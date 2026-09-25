/**
 * Fletting av miljøvariabler: sett noen nøkler og fjern andre, uten å røre resten.
 *
 * `envVars` på `PATCH /projects/:id` erstatter hele settet. Det er riktig for
 * dashboardet, som har alle verdiene i klartekst i skjemaet. Gjennom MCP er det
 * en felle: verdiene kommer maskert tilbake («re_5… ••• (skjult, 36 tegn)»), så
 * en assistent som vil endre én variabel har ingen måte å sende de andre
 * tilbake på. Det eneste den kan gjøre er å overskrive alle hemmelighetene med
 * maskeringsteksten – eller la være. Fletting på serveren, mot verdiene som
 * faktisk ligger i basen, fjerner det valget.
 */

/** Samme regel som POSIX-skall: bokstav eller understrek først, så også tall. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Rikelig for en PEM-nøkkel eller et JWT, lite nok til å stoppe et uhell. */
const MAX_VALUE_LENGTH = 32_768;

export class EnvVarError extends Error {}

export interface EnvVarPatch {
  set?: unknown;
  unset?: unknown;
}

export interface EnvVarMergeResult {
  envVars: Record<string, string>;
  added: string[];
  changed: string[];
  removed: string[];
  /** Nøkler i `unset` som ikke fantes. Ikke en feil – målet er nådd uansett. */
  missing: string[];
}

function assertKey(key: string): void {
  if (!ENV_KEY.test(key)) {
    throw new EnvVarError(
      `Ugyldig nøkkel «${key}»: bruk bokstaver, tall og understrek, og ikke tall først.`,
    );
  }
}

function parseSet(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EnvVarError("«setEnvVars» må være et objekt med nøkkel → verdi.");
  }

  const parsed: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    assertKey(key);
    if (typeof raw !== "string") {
      throw new EnvVarError(`Verdien for «${key}» må være en streng.`);
    }
    if (raw.length > MAX_VALUE_LENGTH) {
      throw new EnvVarError(`Verdien for «${key}» er lengre enn ${MAX_VALUE_LENGTH} tegn.`);
    }
    parsed[key] = raw;
  }
  return parsed;
}

function parseUnset(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string")) {
    throw new EnvVarError("«unsetEnvVars» må være en liste med nøkler.");
  }
  for (const key of value) assertKey(key);
  return [...new Set(value as string[])];
}

/**
 * Fletter en endring inn i det eksisterende settet. Rører aldri nøkler som ikke
 * er nevnt. En nøkkel i både `set` og `unset` er en motsigelse og avvises, i
 * stedet for at rekkefølgen i koden avgjør hva kunden mente.
 */
export function mergeEnvVars(
  existing: Record<string, unknown> | null | undefined,
  patch: EnvVarPatch,
): EnvVarMergeResult {
  const set = parseSet(patch.set);
  const unset = parseUnset(patch.unset);

  const conflict = unset.filter((key) => key in set);
  if (conflict.length > 0) {
    throw new EnvVarError(
      `Nøkkelen ${conflict.map((k) => `«${k}»`).join(", ")} står både i setEnvVars og unsetEnvVars.`,
    );
  }

  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    envVars[key] = typeof value === "string" ? value : String(value ?? "");
  }

  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of Object.entries(set)) {
    if (!(key in envVars)) added.push(key);
    else if (envVars[key] !== value) changed.push(key);
    envVars[key] = value;
  }

  const removed: string[] = [];
  const missing: string[] = [];
  for (const key of unset) {
    if (key in envVars) {
      delete envVars[key];
      removed.push(key);
    } else {
      missing.push(key);
    }
  }

  return { envVars, added, changed, removed, missing };
}
