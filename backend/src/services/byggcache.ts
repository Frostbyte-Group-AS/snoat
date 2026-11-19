import { config } from "../config.js";
import { docker } from "../lib/docker.js";
import { logger } from "../lib/logger.js";

/**
 * Holder Docker-byggcachen under `SNOAT_BUILD_CACHE_MAX_GB`.
 *
 * Hvert bygg (Snoat selv og hver kundeapp via nixpacks) legger lag i
 * BuildKit-cachen, og Docker rydder den aldri av seg selv. 19. november 2026 var
 * den 179 GB på Snoat-VM-en, disken på Proxmox-verten var full nok til at
 * `maksNyDiskGb()` ga 0 GB, og det gikk ikke å lage nye VPS-er.
 *
 * Det nyeste i cachen beholdes, så vanlige bygg er like raske som før. Dinglende
 * images (uten tag, erstattet av et nyere bygg) fjernes også; taggede images –
 * også de en eldre deployment kan rulles tilbake til – røres ikke.
 */

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_MS = 10 * 60 * 1000;

/** Spørreparametrene til `POST /build/prune`. */
export function buildPruneQuery(maxGb: number): Record<string, string> {
  const bytes = String(Math.floor(maxGb * 1024 ** 3));
  return {
    // API 1.48+ (Docker 28+). Eldre daemoner ignorerer den.
    "max-used-space": bytes,
    // Før 1.48. Nyere daemoner ignorerer den.
    "keep-storage": bytes,
  };
}

async function pruneBuildCache(maxGb: number): Promise<number> {
  // `docker.pruneBuilder()` i dockerode sender ikke med noen parametre, og uten
  // dem tømmer Docker hele cachen. Derfor rett mot modemet.
  type PruneResult = { SpaceReclaimed?: number } | null;
  const result = await new Promise<PruneResult>((resolve, reject) => {
    docker.modem.dial(
      {
        path: "/build/prune?",
        method: "POST",
        options: { _query: buildPruneQuery(maxGb) },
        statusCodes: { 200: true, 500: "server error" },
      },
      (err: unknown, data: unknown) =>
        err ? reject(err) : resolve(data as PruneResult),
    );
  });
  return result?.SpaceReclaimed ?? 0;
}

export async function cleanBuildCache(): Promise<void> {
  const cacheBytes = await pruneBuildCache(config.SNOAT_BUILD_CACHE_MAX_GB);
  const images = await docker.pruneImages({ filters: { dangling: ["true"] } });
  const imageBytes = images.SpaceReclaimed ?? 0;

  logger.info(
    {
      byggcacheGb: +(cacheBytes / 1024 ** 3).toFixed(1),
      imagesGb: +(imageBytes / 1024 ** 3).toFixed(1),
      maksGb: config.SNOAT_BUILD_CACHE_MAX_GB,
    },
    "Byggcache ryddet",
  );
}

export function startBuildCacheSweep(): void {
  const run = () => {
    void cleanBuildCache().catch((error: unknown) => {
      logger.warn({ err: error }, "Kunne ikke rydde byggcachen");
    });
  };
  // Ikke rett etter oppstart: da bygger selvoppdateringen kanskje fortsatt.
  setTimeout(run, FIRST_RUN_MS).unref();
  setInterval(run, INTERVAL_MS).unref();
}
