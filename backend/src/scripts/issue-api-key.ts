/**
 * Utsteder en API-nøkkel til en eksisterende Snoat-bruker, og setter valgfritt
 * kontoen på byråplanen.
 *
 * Kjøres på serveren, av et menneske:
 *
 *   docker compose exec backend node dist/scripts/issue-api-key.js \
 *     --email daniel@frostbytes.no --name leadlab-produksjon --plan agency
 *
 * Lokalt: `npx tsx src/scripts/issue-api-key.ts --email … --name …`
 *
 * Det finnes med vilje **ingen** HTTP-endepunkt for dette. Et endepunkt som
 * utsteder legitimasjon må selv beskyttes av legitimasjon, og den første
 * nøkkelen har ingen å bli beskyttet av – så den må komme fra noe som allerede
 * har service-role-nøkkelen, altså denne prosessen. Å utstede nøkler er dessuten
 * en handling som skjer én gang per integrasjon, ikke noe som trenger et API.
 *
 * Nøkkelen skrives til stdout én gang og kan aldri hentes fram igjen: databasen
 * har bare sha256-hashen. Mister du den, trekk den tilbake og utsted en ny.
 */

import { generateApiKey } from "../lib/api-keys.js";
import { supabase } from "../lib/supabase.js";
import type { SubscriptionTier } from "../types.js";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(`--${flag}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/**
 * Finner brukeren på e-post.
 *
 * GoTrue har ingen «hent bruker på e-post» i admin-APIet, så vi blar gjennom
 * listen. Med noen hundre brukere er det én til to sider; skulle det bli mange
 * tusen, er det denne løkken som må byttes ut mot et SQL-oppslag mot `auth.users`.
 */
async function findUserByEmail(email: string): Promise<{ id: string; email: string }> {
  const needle = email.toLowerCase();

  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(`Kunne ikke liste brukere: ${error.message}`);

    const hit = data.users.find((user) => user.email?.toLowerCase() === needle);
    if (hit) return { id: hit.id, email: hit.email! };

    if (data.users.length < 200) break;
  }

  fail(`Fant ingen bruker med e-post «${email}». Registrer kontoen i dashboardet først.`);
}

async function main(): Promise<void> {
  const email = arg("email");
  const name = arg("name");
  const plan = arg("plan") as SubscriptionTier | undefined;

  if (!email || !name) {
    fail("Bruk: --email <e-post> --name <nøkkelnavn> [--plan agency]");
  }

  const user = await findUserByEmail(email);

  if (plan) {
    if (!["free", "pro", "business", "agency"].includes(plan)) {
      fail(`Ukjent plan «${plan}». Gyldige: free, pro, business, agency.`);
    }

    // `source: 'invoice'` er ikke kosmetikk: den forteller Stripe-webhooken at
    // dette abonnementet ikke er dens, slik at en senere webhook ikke skriver
    // over en manuelt satt plan. Se `services/billing.ts`.
    const { error } = await supabase.from("subscriptions").upsert(
      { user_id: user.id, plan, status: "active", source: "invoice" },
      { onConflict: "user_id" },
    );

    if (error) fail(`Kunne ikke sette planen: ${error.message}`);
  }

  const key = generateApiKey();

  const { error } = await supabase.from("api_keys").insert({
    user_id: user.id,
    name,
    token_prefix: key.tokenPrefix,
    token_hash: key.tokenHash,
  });

  if (error) fail(`Kunne ikke lagre nøkkelen: ${error.message}`);

  console.log(`
  ✓ API-nøkkel utstedt

    Bruker:  ${user.email} (${user.id})
    Navn:    ${name}${plan ? `\n    Plan:    ${plan}` : ""}

    ${key.token}

  Nøkkelen vises kun nå – databasen lagrer bare hashen. Legg den i mottakerens
  miljø som SNOAT_API_KEY og send den aldri over en kanal du ikke ville sendt
  et passord i.
`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
