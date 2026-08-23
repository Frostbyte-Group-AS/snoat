# 05. Design System & Styling — «Ink & Sun»

Snoat er redesignet fra bunnen av. Kilden er Figma-fila
[Website Hosting Landing Page (Community)](https://www.figma.com/design/m3BEhOsDc9QQoKLFAllvHt/Website-Hosting-Landing-Page--Community-),
node `0:1683`, hentet gjennom Figma MCP. Alle verdiene i denne filen er målt
der, ikke gjettet.

> **Det gamle systemet er borte.** Mørkt tema, isblå primærfarge, `oklch`-paletten,
> `.floating-card`, lagdelte skygger, Space Grotesk/DM Sans og Material Symbols
> finnes ikke lenger i kodebasen. Ser du dem i en gammel gren eller et gammelt
> utdrag: det er ikke lenger gjeldende.

## Skalafaktoren — les denne først

Figma-artboardet er **937 px bredt**, men er en nedskalert **1440 px**
desktop-layout. Skalafaktoren er derfor

```
1440 / 937 = 1,5368
```

Den er verifisert mot noder som treffer runde tall etter oppskalering:
52,042 → 80 · 39,031 → 60 · 20,926 → 32 · 15,613 → 24 · 1,301 → 2 · 7,806 → 12.

**Alle px-verdier i `styles.css` og på landingssiden er Figma-tallet ganget med
1,5368.** Skal du hente en ny verdi fra fila, gjør det samme – ikke les tallet
rått ut av Figma-panelet.

Der kilden er slurvete – hero-teksten står på 68 px, rutenettet på 64 og
footeren på 61, altså tre «samme» venstremarg – er alt samlet på **én rail**:
innholdsbredden **1334 px sentrert** (`--container-container-max`), som er den
bredeste faktiske blokken i designet.

## ⚠️ Tre regler som bærer hele uttrykket

### 1. Svart strek, ikke skygge
Flater defineres av **2 px ramme i ren svart**. Det finnes ikke én `box-shadow`
i systemet. (Dette er motsatt av forrige generasjon, som forbød borders og
løste alt med skygge.) `@layer base` setter `border-color: var(--border)`, som
er `#000000` — en `border`-klasse uten fargeangivelse blir altså svart.

### 2. Firkantet handling, rundet innhold
- **Knapper og skjemafelt: `border-radius: 0`.**
- **Kort: 12 / 16 / 18 px** (Figma 7,806 / 10,123 / 11,059 × 1,5368).

Kontrasten er poenget: en handling kan aldri forveksles med innhold.

### 3. Én aksentfarge
`#FFED88` er **gul markør**, aldri en knapp og aldri en flate å lese lang tekst
på. Den brukes til håndstreken, til aktiv/pågående tilstand og til å løfte ett
enkelt element.

## Farger

| Token | Verdi | Rolle |
| --- | --- | --- |
| `--color-ink` | `#000000` | Tekst, rammer, primærknapp |
| `--color-ink-soft` | `#171717` | Streken i illustrasjonene |
| `--color-paper` | `#FFFFFF` | Bakgrunn, kortflate |
| `--color-sun` | `#FFED88` | Aksent, markør, «pågår» |
| `--color-sun-soft` | `#FFF8D1` | Hover/fokus på felt og rader |
| `--color-ash` | `#D9D9D9` | Hvilende tilstand, inaktiv indikator |
| `--color-hair` | `rgba(0,0,0,.1)` | Eneste skillelinje |
| `--error` | `#D81E06` | **Kun feil.** Aldri dekor. |

De semantiske shadcn-navnene lever videre, men peker inn i denne paletten:
`--primary` er svart (handling), `--secondary` er gul (markør), `--muted` er
`#F5F5F5` (rolig innerflate).

**Rødt er en bevisst utvidelse av det tofargede designet.** Et dashboard må
kunne si «dette feilet» før brukeren rekker å lese teksten. Det er den eneste
funksjonelle fargen vi har lagt til, og den brukes ingen andre steder.

## Ingen ikoner

Plattformen har **null ikoner**. Ikke Material Symbols, ikke `lucide-react`,
ikke merkevaremerker i knappene. Der et ikon sto, står nå typografi:

| Var | Er nå |
| --- | --- |
| Ikon over korttittel | Den gule håndstreken (`.swoosh`) |
| `check` / `close` i lister | `<Mark on />` – svart skive med `✓`/`✕` som tekst |
| Statusikon (bygger/live/feilet) | 20–28 px rute der **fyllet** bærer tilstanden |
| Chevron i trekkspill | `+` / `–` i en rute |
| Flaggbilder i språkvelgeren | `NO` / `EN` som tekst |
| `arrow_back` | `←` |
| Kopi-, lenke- og repo-ikoner | Etiketten alene, den sa det allerede |

Tilstand skal aldri bæres av farge alene. `DeploymentStatusBadge` og
`DomainCheckRow` skiller **fylt svart / hvit med ramme / rød ramme / grå** –
fire ulike former, ikke fire nyanser.

## Typografi

- **`--font-display` / `--font-body`:** `"Helvetica Neue", Helvetica, Arial, sans-serif`.
  Figma spesifiserer Helvetica Bold/Regular/Light. Arial er metrisk kompatibel
  og dekker Windows og Linux uten webfont-nedlasting.
- **`--font-meta`:** `Clash Display` (Fontshare), lastet i `__root.tsx`. Brukes
  **kun i footeren**, akkurat som i malen.
- **`--font-mono`:** tekniske verdier – IP-er, domener, kommandoer, repo-navn,
  miljøvariabler.

Vektene er meningsbærende: **overskrifter er Bold (700)**, **korttitler er
Regular (400)** og **brødtekst på markedsflater er Light (300)**. En korttittel
i bold er feil selv om den ser «viktigere» ut.

Typeskalaen (1440 px, `clamp()` ned mot mobil):

| Token | 1440 px | Bruk |
| --- | --- | --- |
| `text-display` | 80 | Hero-H1 |
| `text-headline-lg` | 60 | Seksjonsoverskrift |
| `text-headline-md` | 45 | CTA-overskrift, dashboard-H1 |
| `text-title-lg` | 31,6 | Korttittel i funksjonsrutenettet |
| `text-title-md` | 28,7 | Korttittel i løftekortene |
| `text-body-lg` | 32 | Hero- og seksjonsbrødtekst |
| `text-body-md` | 24 | Sitat/faktatekst |
| `text-body-sm` | 21 | Brødtekst i kort |
| `text-label-md` | 15 | Etiketter, prislinjer |

Dashboardet bruker en tettere skala satt direkte i px (14–24). Markedsskalaen
er for markedsflater; et prosjektpanel med 32 px brødtekst er ikke lesbart.

## Byggeklosser (`styles.css`)

| Utility | Hva |
| --- | --- |
| `.ink-card` | Hvit flate, 2 px svart ramme, radius 12 |
| `.ink-card-lg` | Samme, 2,6 px ramme, radius 16 |
| `.ink-card-xl` | Samme, 2 px ramme, radius 18 (prisekort) |
| `.btn-ink` | Svart fylt, hvit tekst, radius 0. Hover inverterer. |
| `.btn-outline` | Hvit med svart ramme, radius 0. Hover inverterer. |
| `.btn-sun` | Gul fylt med svart ramme |
| `.btn-quiet` | Uten flate; hover legger på gult |
| `.field-ink` | Skjemafelt: radius 0, 2 px ramme, gul-svak ved fokus |
| `.hairline` | Den eneste skillelinja: svart 10 % |
| `.numeral` | Konturtall (`#1`…`#6`): 86 px, transparent fyll, 2,3 px svart kontur |
| `.swoosh` | Den håndtegnede gule understrekingen, 74 × 10 px |

## Illustrasjoner

`frontend/public/illustrations/` inneholder de to SVG-ene fra malen
(`hero-launch.svg`, `growth-chart.svg`) og `swoosh.svg`. De er tegnet i
`#171717` og `#FFED88`, altså samme palett som resten. De er **dekor** og skal
alltid ha `alt=""` og `aria-hidden`.

## Landingssidens seksjoner

Rekkefølgen følger malen: header → hero → tre løfter → «Sikker hosting» →
seks nummererte funksjoner → «Hvorfor Snoat» → planer → avslutnings-CTA →
footer.

To bevisste avvik fra malen:

1. **Ikonene i de tre løftekortene er erstattet av håndstreken** (se over).
2. **Malens kundesitat er byttet mot etterprøvbare fakta.** Vi dikter ikke opp
   en anmeldelse fra en kunde som ikke finnes. Layouten – overskrift og tekst
   til venstre, innrammet kort til høyre – er beholdt.

Prisekortene bygges av **reelle grenser** fra `/api/pricing` (`PlanOption.limits`),
ikke av håndskrevne funksjonslister. Da kan ikke prissiden komme i utakt med
`PLAN_LIMITS` i backend. Midtkortet er større og løftet 20 px, som i malen.

## Mønstre i dashboardet

### Kopiering til utklippstavle
Hele feltet er knappen, verdien står i `font-mono`, og knappen sier «Kopiert»
i klartekst – ikke med et ikon som bytter form. Feiler `navigator.clipboard`
(usikker kontekst), skal knappen si det, aldri se ut som om den lyktes.

### Segmentert fanelinje
Fanene ligger i en boks med 2 px svart ramme. Den aktive fanen er en **svart
flate som glir på plass** (`transition-all` + `cubic-bezier(0.2,0.8,0.2,1)`),
og etiketten blir hvit. Indikatoren posisjoneres i piksler og **må lese både
`offsetTop`/`offsetHeight` og `offsetLeft`/`offsetWidth`** – med seks faner
brekker raden på mobil, og en indikator som bare kjenner `left` blir liggende
igjen på første linje. Posisjonen regnes på nytt ved `resize`.

### Statusmerker
Firkantet, 2 px ramme, versaler med `tracking`. Fyllet er tilstanden:
svart = live, gul = pågår, hvit = venter, rød ramme = feilet, grå = hviler.

## Oppsummering for utvikling

1. **Bruk ramme, ikke skygge.** Det finnes ingen `box-shadow` i systemet.
2. **Knapper og felt er firkantede. Kort er rundet.**
3. **Ingen ikoner.** Trenger du et symbol, er svaret typografi eller en rute.
4. **Gul er markør, svart er handling, rød er feil.** Ingen fjerde farge.
5. **Nye mål hentes fra Figma og ganges med 1,5368.**
