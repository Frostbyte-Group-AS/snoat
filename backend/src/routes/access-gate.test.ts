import assert from "node:assert/strict";
import { describe, it } from "node:test";
import bcrypt from "bcryptjs";

/** Samme grunn til stubbing som `access-cookie.test.ts` – modulen drar med
 * seg `config.ts` og `lib/supabase.ts` (som ikke kobler til noe ved import). */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";

const { cookieValues, createAccessGate, ipBucketKey, safeReturnPath } = await import("./access-gate.js");
const { ACCESS_CHECK_PATH, ACCESS_GATE_PATH, ACCESS_HEADERS } = await import("../lib/caddy.js");
const { accessCookieName, accessVersion } = await import("../lib/access-cookie.js");
const ACCESS_COOKIE_NAME = accessCookieName(false);

describe("safeReturnPath – åpen redirect skal være umulig", () => {
  it("slipper gjennom en vanlig sti", () => {
    assert.equal(safeReturnPath("/dashboard"), "/dashboard");
    assert.equal(safeReturnPath("/dashboard/foo?x=1&y=2"), "/dashboard/foo?x=1&y=2");
  });

  it("gir / for tomt, manglende eller for langt", () => {
    assert.equal(safeReturnPath(null), "/");
    assert.equal(safeReturnPath(undefined), "/");
    assert.equal(safeReturnPath(""), "/");
    assert.equal(safeReturnPath("/" + "a".repeat(3000)), "/");
  });

  it("avviser en absolutt URL til et annet domene", () => {
    assert.equal(safeReturnPath("https://evil.example/phish"), "/");
    assert.equal(safeReturnPath("http://evil.example"), "/");
  });

  it("avviser protokollrelative stier (//evil.example)", () => {
    assert.equal(safeReturnPath("//evil.example"), "/");
    assert.equal(safeReturnPath("///evil.example"), "/");
  });

  it("avviser en backslash-variant nettlesere kan normalisere til protokollrelativ", () => {
    assert.equal(safeReturnPath("/\\evil.example"), "/");
  });

  it("avviser et skjema uten skråstrek foran (javascript:, data:)", () => {
    assert.equal(safeReturnPath("javascript:alert(1)"), "/");
    assert.equal(safeReturnPath("data:text/html,x"), "/");
  });

  it("avviser kontrolltegn (header-smugling i redirect-svaret)", () => {
    assert.equal(safeReturnPath("/ok\r\nSet-Cookie: x=1"), "/");
    assert.equal(safeReturnPath("/ok\nX-Evil: 1"), "/");
    assert.equal(safeReturnPath("/ok\tx"), "/");
  });

  it("sender aldri tilbake til passordsiden selv", () => {
    assert.equal(safeReturnPath(ACCESS_GATE_PATH), "/");
    assert.equal(safeReturnPath(`${ACCESS_GATE_PATH}?retur=/x`), "/");
  });
});

const PASSORD = "riktig-passord-123";
const HASH = bcrypt.hashSync(PASSORD, 4);
const PROJECT = "11111111-1111-4111-8111-111111111111";
const VERSION = accessVersion(HASH);

let ipTeller = 0;

/** Headerne Caddy-ruten setter. Ny IP per test, så rate-limiten ikke lekker mellom dem. */
function caddyHeaders(host = "app.snoat.com", extra: Record<string, string> = {}): Record<string, string> {
  ipTeller += 1;
  return {
    [ACCESS_HEADERS.project]: PROJECT,
    [ACCESS_HEADERS.version]: VERSION,
    [ACCESS_HEADERS.host]: host,
    [ACCESS_HEADERS.uri]: "/side?x=1",
    [ACCESS_HEADERS.clientIp]: `10.0.0.${ipTeller}`,
    ...extra,
  };
}

function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

async function logInn(
  gate: ReturnType<typeof createAccessGate>,
  host = "app.snoat.com",
): Promise<string> {
  const res = await gate.request(ACCESS_GATE_PATH, {
    method: "POST",
    headers: { ...caddyHeaders(host), "content-type": "application/x-www-form-urlencoded" },
    body: form({ password: PASSORD, retur: "/side?x=1" }),
  });
  assert.equal(res.status, 303);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`^${ACCESS_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  assert.ok(match, setCookie);
  return match[1]!;
}

describe("passordsiden og adgangssjekken", () => {
  const gate = createAccessGate(async (projectId) => (projectId === PROJECT ? HASH : null));

  it("sjekken gir 401 med passordsiden uten cookie – og ingen nettleserdialog", async () => {
    const res = await gate.request(ACCESS_CHECK_PATH, { headers: caddyHeaders() });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), null);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-frame-options"), "DENY");

    const html = await res.text();
    assert.match(html, /Passord kreves/);
    assert.match(html, /name="retur" value="\/side\?x=1"/);
    // Ingen prosjekt-ID eller andre detaljer om hva som er bak.
    assert.ok(!html.includes(PROJECT));
    assert.ok(!html.includes("app.snoat.com"));
  });

  it("riktig passord gir en host-only, HttpOnly, Secure, SameSite=Lax-cookie og 303 tilbake", async () => {
    const res = await gate.request(ACCESS_GATE_PATH, {
      method: "POST",
      headers: {
        ...caddyHeaders(),
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://app.snoat.com",
      },
      body: form({ password: `  ${PASSORD} `, retur: "/side?x=1" }),
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/side?x=1");

    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${ACCESS_COOKIE_NAME}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Domain=/i);
  });

  it("cookien slipper gjennom sjekken på samme vert, men ikke på en annen", async () => {
    const token = await logInn(gate);
    const ok = await gate.request(ACCESS_CHECK_PATH, {
      headers: { ...caddyHeaders(), cookie: `${ACCESS_COOKIE_NAME}=${token}` },
    });
    assert.equal(ok.status, 204);

    const annen = await gate.request(ACCESS_CHECK_PATH, {
      headers: { ...caddyHeaders("annen.snoat.com"), cookie: `${ACCESS_COOKIE_NAME}=${token}` },
    });
    assert.equal(annen.status, 401);
  });

  it("et nytt passord (ny versjon i ruten) gjør gamle cookies ugyldige", async () => {
    const token = await logInn(gate);
    const res = await gate.request(ACCESS_CHECK_PATH, {
      headers: {
        ...caddyHeaders("app.snoat.com", { [ACCESS_HEADERS.version]: accessVersion("$2b$12$nytt") }),
        cookie: `${ACCESS_COOKIE_NAME}=${token}`,
      },
    });
    assert.equal(res.status, 401);
  });

  it("feil passord gir 401 med passordsiden og ingen cookie", async () => {
    const res = await gate.request(ACCESS_GATE_PATH, {
      method: "POST",
      headers: { ...caddyHeaders(), "content-type": "application/x-www-form-urlencoded" },
      body: form({ password: "feil", retur: "/" }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(res.headers.get("www-authenticate"), null);
    assert.match(await res.text(), /Feil passord/);
  });

  it("et prosjekt uten hash slipper aldri noen inn", async () => {
    const res = await gate.request(ACCESS_GATE_PATH, {
      method: "POST",
      headers: {
        ...caddyHeaders("app.snoat.com", { [ACCESS_HEADERS.project]: "22222222-2222-4222-8222-222222222222" }),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ password: PASSORD, retur: "/" }),
    });
    assert.equal(res.status, 401);
  });

  it("en planted cookie med samme navn (cookie-tossing) stenger ikke den ekte ute", async () => {
    const token = await logInn(gate);
    const res = await gate.request(ACCESS_CHECK_PATH, {
      headers: { ...caddyHeaders(), cookie: `${ACCESS_COOKIE_NAME}=1.falsk; ${ACCESS_COOKIE_NAME}=${token}` },
    });
    assert.equal(res.status, 204);
  });

  it("den gamle cookien uten __Host-prefiks slipper ikke inn i produksjon", async () => {
    const token = await logInn(gate);
    const res = await gate.request(ACCESS_CHECK_PATH, {
      headers: { ...caddyHeaders(), cookie: `snoat_adgang=${token}` },
    });
    assert.equal(res.status, 401);
  });

  it("lokalt (.snoat.localhost) uten Secure og uten prefiks", async () => {
    const res = await gate.request(ACCESS_GATE_PATH, {
      method: "POST",
      headers: { ...caddyHeaders("app.snoat.localhost"), "content-type": "application/x-www-form-urlencoded" },
      body: form({ password: PASSORD, retur: "/" }),
    });
    assert.equal(res.status, 303);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^snoat_adgang=/);
    assert.doesNotMatch(cookie, /Secure/);
  });

  it("avviser et for stort skjema før det leses", async () => {
    const res = await gate.request(ACCESS_GATE_PATH, {
      method: "POST",
      headers: { ...caddyHeaders(), "content-type": "application/x-www-form-urlencoded" },
      body: form({ password: "x".repeat(20_000), retur: "/" }),
    });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("avviser et skjema sendt fra en annen opprinnelse", async () => {
    const res = await gate.request(ACCESS_GATE_PATH, {
      method: "POST",
      headers: {
        ...caddyHeaders(),
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: form({ password: PASSORD, retur: "/" }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("åpen redirect via retur blir til /", async () => {
    const res = await gate.request(ACCESS_GATE_PATH, {
      method: "POST",
      headers: { ...caddyHeaders(), "content-type": "application/x-www-form-urlencoded" },
      body: form({ password: PASSORD, retur: "//evil.example/x" }),
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
  });

  it("begrenser antall forsøk per IP og prosjekt – også når vertsnavnet varieres", async () => {
    const base = caddyHeaders("rate.snoat.com");
    const statuser: number[] = [];
    const headers = { ...base, "content-type": "application/x-www-form-urlencoded" };
    for (let i = 0; i < 10; i += 1) {
      const res = await gate.request(ACCESS_GATE_PATH, {
        method: "POST",
        // Et eget domene svarer på `*.domenet`: ny Host per forsøk skal ikke gi ny bøtte.
        headers: { ...headers, [ACCESS_HEADERS.host]: `x${i}.kunde.no` },
        body: form({ password: "feil", retur: "/" }),
      });
      statuser.push(res.status);
    }
    assert.deepEqual(statuser.slice(0, 8), Array(8).fill(401));
    assert.deepEqual(statuser.slice(8), [429, 429]);

    // Selv riktig passord stoppes mens grensen gjelder.
    const res = await gate.request(ACCESS_GATE_PATH, {
      method: "POST",
      headers,
      body: form({ password: PASSORD, retur: "/" }),
    });
    assert.equal(res.status, 429);
  });

  it("uten headerne fra Caddy finnes siden ikke, og sjekken sier nei", async () => {
    const side = await gate.request(ACCESS_GATE_PATH);
    assert.equal(side.status, 404);
    const sjekk = await gate.request(ACCESS_CHECK_PATH);
    assert.equal(sjekk.status, 401);
  });
});

describe("ipBucketKey", () => {
  it("lar IPv4 være som den er", () => {
    assert.equal(ipBucketKey("203.0.113.7"), "203.0.113.7");
    assert.equal(ipBucketKey("::ffff:203.0.113.7"), "203.0.113.7");
  });

  it("samler IPv6 per /64", () => {
    const a = ipBucketKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    const b = ipBucketKey("2001:db8:1:2::1");
    const c = ipBucketKey("2001:0db8:0001:0002:ffff::");
    assert.equal(a, "2001:db8:1:2::/64");
    assert.equal(b, a);
    assert.equal(c, a);
    assert.notEqual(ipBucketKey("2001:db8:1:3::1"), a);
    assert.equal(ipBucketKey("::1"), "0:0:0:0::/64");
  });
});

describe("cookieValues", () => {
  it("finner alle verdier med navnet, og bare dem", () => {
    assert.deepEqual(cookieValues("a=1; x=2; a=3; ab=4", "a"), ["1", "3"]);
    assert.deepEqual(cookieValues(undefined, "a"), []);
    assert.deepEqual(cookieValues("a", "a"), []);
  });
});
