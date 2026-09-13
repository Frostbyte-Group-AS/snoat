# 13. Artikler og SEO

`/articles` er en tospråklig artikkelsamling bygget for søk. Denne filen
beskriver hvordan den er satt sammen, hvilke beslutninger som ligger under, og
hvilke artikler som er skrevet og planlagt.

---

## Kodekart

| Fil | Ansvar |
| --- | --- |
| `frontend/src/content/articles/types.ts` | Innholdsmodellen: `Article` og `Block`. |
| `frontend/src/content/articles/index.ts` | Registeret. Sortering, oppslag, lesetid, «Les også». |
| `frontend/src/content/articles/<slug>.ts` | Én artikkel per fil. |
| `frontend/src/content/articles/ui.ts` | Tekstene rundt artikkelen, per språk. `headingId()`. |
| `frontend/src/content/articles/jsonld.ts` | Strukturert data: `BlogPosting`, `BreadcrumbList`, `FAQPage`, `Blog`. |
| `frontend/src/components/ArticleBody.tsx` | Rendrer blokkene med klassene fra «Ink & Sun». |
| `frontend/src/components/SiteChrome.tsx` | `SiteHeader`, `SiteFooter`, `SHELL` – delt med landingssiden. |
| `frontend/src/routes/articles.index.tsx` | `/articles` – listesiden med språkfilter. |
| `frontend/src/routes/articles.$slug.tsx` | `/articles/<slug>` – artikkelen. |
| `frontend/src/lib/seo.ts` | `SITE_URL`, `absoluteUrl()`, `PUBLISHER`. Én kilde for absolutte URL-er. |
| `frontend/src/routes/sitemap[.]xml.ts` | Leser registeret, så nye artikler er med automatisk. |

## Slik legger du til en artikkel

1. Lag `frontend/src/content/articles/<slug>.ts` som eksporterer ett
   `Article`-objekt.
2. Legg importen og objektet inn i `ALL` i `index.ts`.
3. Ferdig. Ruten, sitemap-en, «Les også» og strukturert data følger av seg selv.

Sluggen er URL-en og **endres aldri etter publisering** – en endret slug er en
død lenke og et tapt søkeresultat. Skal en tittel endres, endre `title`.

## Beslutningene som ligger under

### 1. Artiklene er data, ikke i18n-nøkler

`lib/i18n.ts` rendrer serversiden med `lng: "en"` for å unngå
hydration-mismatch. En artikkel skrevet som oversettelsesnøkler ville derfor
blitt **servert på engelsk til søkeroboten uansett hvilket språk den var ment å
ha**. Hver artikkel bærer i stedet sitt eget `lang`, sin egen URL og sin egen
tekst, og rendres identisk på server og klient.

Tekstene *rundt* artikkelen (datolinja, «Les også», FAQ-overskriften) slås opp i
`ARTICLE_UI` på artikkelens språk – ikke på grensesnittspråket. En norsk
artikkel skal ikke stå med «5 min read» over seg.

Listesiden er unntaket: den viser begge språk samtidig og følger derfor
grensesnittspråket via i18n, med et `NO`/`EN`-merke på hvert kort.

### 2. Blokker, ikke markdown

`Block` er en diskriminert union (`p`, `h2`, `list`, `table`, `code`, `faq`,
`cta` …). Det finnes ingen markdown-parser og ingen `dangerouslySetInnerHTML`
noe sted. Det eneste som tolkes er tre inline-mønstre i teksten – `` `kode` ``,
`**fet**` og `[tekst](/bane)` – og hvert treff blir et React-element.

Interne lenker i prosa er `<a href>` og ikke `<Link>`: `to` er typet mot
rutetreet og krever en literal rutebane, mens en lenke i en innholdsfil er en
vilkårlig streng. Kostnaden er en full sidelasting ved klikk.

### 3. Språkfilteret starter på «alle»

Filteret på listesiden er klient-side og har `all` som utgangstilstand, slik at
den serverrendrede HTML-en inneholder lenken til **hver** artikkel. Et filter
som fjernet halve lista fra markupen ville skjult halvparten av sidene for en
søkerobot – de interne lenkene er hele grunnen til at oversikten finnes.

### 4. FAQ-en er alltid utfelt

En FAQ bak et trekkspill uten JavaScript er en tom seksjon for Google. Blokka
rendres derfor som en `<dl>` som alltid står åpen, og den samme teksten mater
`FAQPage`-grafen. Vi lager **aldri** en `FAQPage` av en artikkel uten
FAQ-blokk – strukturert data som ikke finnes i teksten er brudd på Googles
retningslinjer, ikke en snarvei.

### 5. Én kilde til absolutte URL-er

`canonical`, `og:url`, hreflang og `sitemap.xml` leser alle `SITE_URL` fra
`lib/seo.ts`, som kommer fra `VITE_SITE_URL` med `https://snoat.com` som
standard. Står sitemap-en på ett domene og canonical på et annet, sier vi to
ting til søkeroboten om hvor siden bor.

⚠️ **Sett `VITE_SITE_URL` på staging.** Ellers utpeker et testmiljø seg selv som
snoat.com i canonical-taggen.

### 6. hreflang bare på ekte oversettelsespar

`translationOf` peker fra den engelske artikkelen til den norske. Er feltet
tomt, skrives ingen `alternate`-lenker. To artikler om samme tema er ikke
samme dokument, og en feilaktig hreflang er verre enn ingen.

Parene i dag:

| Engelsk | Norsk |
| --- | --- |
| `vercel-alternative-europe` | `alternativ-til-vercel-norge` |
| `gdpr-compliant-hosting-europe` | `webhosting-norge-gdpr` |

### 7. Lesetid regnes ut, ikke skrives

`readingMinutes()` teller ord i den faktiske teksten (220 ord i minuttet,
minimum 2). Et håndsatt «5 min» blir feil i det noen redigerer avsnittet under
det. Kodeblokker teller ikke – en kommando er ikke prosa.

## Redaksjonelle regler

Disse er ikke stil, de er troverdighet. Artiklene selger en plattform til folk
som skal dokumentere valget sitt for en jurist.

1. **Ingen oppdiktede tall.** Ingen konkurrentpriser (de endres, og artikkelen
   blir feil), ingen målte latenstall vi ikke har målt, ingen kundesitater. Der
   vi trenger et tall, brukes noe etterprøvbart: planbegrensningene fra
   `services/plans.ts`, eller fysikkens gulv (lys i fiber ≈ 200 000 km/s).
2. **Si hva vi ikke har.** Artiklene navngir manglende ISO 27001, én region,
   ingen Normen-godkjenning og ingen globalt kantnettverk. En sjekkliste med
   bare kryss blir ikke lest som en sjekkliste.
3. **Presist om datasuverenitet.** Kildekode, applikasjonsdata, database og
   trafikklogger ligger i Norge. Plattformen bruker to eksterne tjenester til
   sin *egen* drift – e-postleverandør og Stripe – og de er navngitt i
   artiklene framfor å bli utelatt fra et «100 %»-løfte.
4. **Juridiske påstander merkes.** Alle etterlevelsesartikler åpner med at
   dette ikke er juridisk rådgivning, og henviser til personvernombud eller
   advokat der svaret endrer en beslutning.

## Publisert (12)

| Slug | Språk | Kategori | Hovedsøkeord |
| --- | --- | --- | --- |
| `vercel-alternative-europe` | EN | Sammenligning | vercel alternative europe |
| `alternativ-til-vercel-norge` | NO | Sammenligning | alternativ til vercel |
| `gdpr-compliant-hosting-europe` | EN | Regelverk | gdpr compliant hosting |
| `webhosting-norge-gdpr` | NO | Regelverk | webhosting norge, gdpr hosting |
| `cloud-act-schrems-ii-explained` | EN | Regelverk | cloud act eu, schrems ii hosting |
| `datasuverenitet-norsk-sky` | NO | Regelverk | datasuverenitet, norsk sky |
| `deploy-nextjs-without-vercel` | EN | Veiledning | deploy next.js without vercel |
| `deploye-next-js-i-norge` | NO | Veiledning | deploye next.js, hoste next.js norge |
| `vercel-pricing-alternative` | EN | Sammenligning | vercel pricing alternative |
| `european-paas-comparison` | EN | Sammenligning | european paas |
| `hosting-offentlig-sektor-kommune` | NO | Regelverk | hosting offentlig sektor |
| `gratis-hosting-nettside-norge` | NO | Plattform | gratis hosting norge |

## Backlog: foreslåtte artikler

Rekkefølgen er omtrent prioritert innenfor hver gruppe. Ta én av gangen og
skriv den ferdig – tolv halve artikler rangerer dårligere enn tre hele.

### Sammenligninger og kjøpsintensjon

| Tittel | Språk | Søkeord |
| --- | --- | --- |
| Netlify alternative in Europe | EN | netlify alternative europe |
| Heroku alternative in Europe, after the free tier | EN | heroku alternative europe |
| Alternativ til Heroku for norske team | NO | heroku alternativ norge |
| Webhotell, VPS eller plattform – hva trenger du egentlig? | NO | webhotell vs vps |
| Hva koster det å hoste en nettside i Norge? | NO | hva koster webhosting |
| Hosting for byrå: mange kundesider på én konto | NO | hosting for byrå |
| Kubernetes or a managed platform for a three-person team? | EN | kubernetes vs paas |
| Hoste WordPress eller bygge en moderne webapp? | NO | alternativ til wordpress |

### Personvern og regelverk

| Tittel | Språk | Søkeord |
| --- | --- | --- |
| Er Google Analytics lovlig i Norge? | NO | google analytics gdpr norge |
| Is Google Analytics GDPR compliant in 2026? | EN | google analytics gdpr |
| Trafikkstatistikk uten cookie-banner | NO | cookiefri analyse, analytics uten cookies |
| Cookie-free analytics: what server logs can and cannot tell you | EN | cookieless analytics |
| NIS2 og hosting: hva som endres for leverandøren din | NO | nis2 hosting |
| The EU Data Act and cloud switching: the end of egress fees | EN | eu data act cloud switching |
| DPIA for en nettløsning: mal og eksempel | NO | dpia mal nettside |
| Databehandleravtale for hosting – hva den må inneholde | NO | databehandleravtale hosting |
| DORA og skytjenester for fintech | NO | dora skytjenester |

### Tekniske veiledninger

| Tittel | Språk | Søkeord |
| --- | --- | --- |
| Slik peker du domenet ditt mot en ny leverandør | NO | peke domene, a-record cname |
| Automatisk HTTPS: hvordan Let's Encrypt egentlig virker | NO | gratis ssl sertifikat |
| Utrulling uten nedetid forklart: blue-green mot rullerende | NO | zero downtime deploy |
| Zero-downtime deploys with a reverse proxy and containers | EN | zero downtime docker deploy |
| Miljøvariabler og hemmeligheter: hvor de ikke skal ligge | NO | håndtere secrets |
| Nixpacks eller Dockerfile – når trenger du egen Dockerfile? | NO | nixpacks |
| Slik setter du opp testmiljø per gren | NO | staging miljø per gren |
| Passordbeskytt en side under utvikling | NO | passordbeskytte nettside |
| Flerleietaker-app med kundens eget domene | NO | multi tenant egne domener |
| Byggetiden: hvorfor bygget er tregt, og hva som faktisk hjelper | NO | raskere build |
| Deploy Astro on European infrastructure | EN | deploy astro |
| Deploy SvelteKit without a platform runtime | EN | deploy sveltekit self hosted |
| Deploy Nuxt outside Vercel | EN | deploy nuxt self hosted |
| Self-hosted Supabase versus hosted: what actually changes | EN | self host supabase |
| Migrating Postgres to a new host without downtime | EN | migrate postgres no downtime |
| Måle TTFB fra Norge: en metode, ikke en påstand | NO | ttfb måling latens |

### Plattform og posisjon

| Tittel | Språk | Søkeord |
| --- | --- | --- |
| Hvorfor vi ikke måler båndbredde (ennå) | NO | båndbredde hosting |
| Hva «norsk drift» betyr når noe går ned klokka 03 | NO | drift beredskap hosting |
| Koble en AI-assistent til hostingen (MCP) | NO | mcp hosting ai |
| Connect Claude or Cursor to your hosting via MCP | EN | mcp server hosting |

## Kjente hull

- **Ingen `og:image`.** Delinger på sosiale medier og i Slack får et kort uten
  bilde. Løsningen er 1200 × 630-bilder per artikkel eller ett generisk – begge
  krever en rasterfil, og `public/` har bare SVG i dag.
- **Ingen RSS/Atom-feed.** Billig å legge til som en server-rute ved siden av
  `sitemap.xml`, og verdt det hvis artiklene skal følges.
- **Ingen forfatterside.** Strukturert data oppgir organisasjonen som forfatter,
  ikke en person. Det er riktig i dag, men en navngitt forfatter med profil er
  et E-E-A-T-signal om noen skal stå fram.
- **`robots.txt` er statisk** og peker på `https://snoat.com/sitemap.xml`.
  Endres produksjonsdomenet, må fila endres for hånd.
