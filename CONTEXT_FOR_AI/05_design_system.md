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

### 1. Mørk strek, ikke skygge
Flater defineres av **2 px ramme i `#242424`**. Det finnes ikke én `box-shadow`
i systemet. (Dette er motsatt av forrige generasjon, som forbød borders og
løste alt med skygge.) `@layer base` setter `border-color: var(--border)`, som
er `--color-line` — en `border`-klasse uten fargeangivelse blir altså mørk grå.

**Streken er ikke ren svart, og det er med vilje.** Ett kort med `#000`-ramme
ser knivskarpt ut; et dashboard som viser tjue av dem samtidig skjærer i
kanten. `#242424` er 86 % svart: 7,9:1 mot papir — godt over AA — men uten den
harde eggen. Skillet mellom de to er meningsbærende:

| Token | Verdi | Brukes til |
| --- | --- | --- |
| `--color-ink` | `#000000` | **Tekst og fylte flater.** Overskrifter, brødtekst, svart knappeflate, statusmerket «Live». |
| `--color-line` | `#242424` | **Alle streker.** Kortrammer, feltrammer, konturknapper, fokusring. Tailwind: `border-line`. |

Bruk aldri `border-ink`. Den finnes ikke lenger i kodebasen; alle 43 treffene
ble byttet til `border-line` da streken ble myknet. Den eneste ramma som
fortsatt er ren svart er `.btn-ink` sin egen — en fylt svart knapp med lysere
kant får en synlig glorie rundt seg. Ved hover snur knappen til papir, og da
tar `.btn-ink:hover` over med `--color-line`.

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
| `--color-ink` | `#000000` | Tekst og fylte flater |
| `--color-line` | `#242424` | **Alle rammer og streker** |
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
| `.ink-switch` + `.ink-switch-thumb` | Av/på-bryter: firkantet spor 52 × 28, fylt svart tommel |
| `.hairline` | Den eneste skillelinja: svart 10 % |
| `.numeral` | Konturtall (`#1`…`#6`): 86 px, transparent fyll, 2,3 px svart kontur |
| `.swoosh` | Den håndtegnede gule understrekingen, 74 × 10 px |

### Av/på-bryteren

Firkantet, som alle handlinger (regel 2): en bryter er noe man gjør, ikke noe man
leser. Sporet har samme 2 px-strek som knapper og felt, og tommelen er et fylt
`--color-ink`-kvadrat. Ingen sirkler, ingen skygge.

Fargene er hentet fra rollene de allerede har: `--color-sun` er «aktiv/pågår» i
hele designet, `--color-ash` er «hvilende tilstand, inaktiv indikator». Bryteren
trenger derfor ingen egne farger.

⚠️ **Gult mot grått er ikke nok alene.** Rundt 8 % av menn ser den forskjellen
dårlig, så tommelens *posisjon* er den egentlige indikatoren – og `SiteToggle`
setter i tillegg en tekstetikett («På»/«Av») ved siden av. Kopierer du bryteren
til et nytt sted, ta med etiketten.

Markup-en er en `button` med `role="switch"` og `aria-checked`, ikke en checkbox:
en checkbox betyr «dette blir sant når jeg lagrer», og her skjer det med én gang.
CSS-en henger på `aria-checked`, så tilstanden i DOM-en *er* tilstanden man ser –
det finnes ingen egen `data-state` å holde i takt.

`data-busy="true"` pulserer tommelen mens operasjonen pågår. Uten den ser
bryteren ut som den ikke tok imot klikket, for tilstanden i databasen endrer seg
først når stoppet eller bygget er ferdig.

**Radix-`Switch`-en i `components/ui/switch.tsx` brukes ikke.** Den er fra det
gamle designsystemet – runde spor, `--primary` – og ligger igjen sammen med resten
av det ubrukte shadcn-inventaret.

### Terminalen

| Utility | Hva |
| --- | --- |
| `.terminal-shell` | Setter `color-scheme`, så rullefeltet følger loggen |
| `.terminal-bar` | Verktøyraden over loggen |
| `.terminal-body` | Selve loggflata |
| `.terminal-btn` | Kopier-knappen — `btn-outline` er låst til svart på papir |
| `.terminal-dim`, `.terminal-rule` | Dempet tekst og skillelinje i loggen |
| `.terminal-caret` | Blokkmarkøren som blinker mens bygget kjører |

### Bevegelse

| Utility | Hva |
| --- | --- |
| `.anim-rise` | Toner inn og stiger 14 px. Standard for innhold som dukker opp |
| `.anim-fade` / `.anim-pop` / `.anim-slide-in` | Toning, skalering fra 0,96 og innglidning fra venstre |
| `.anim-grow` / `.anim-widen` | Søyler og stolper som vokser fram (`transform`, ikke `height`) |
| `.anim-breathe` | Pusten på «pågår»-tilstander. Erstatter `animate-pulse` |
| `.anim-draw` | Den gule håndstreken som tegner seg selv (`clip-path`) |
| `.stagger` | Barna kommer inn radvis, 45 ms mellom hver, samlet fra og med det 12. |
| `.lift` | Kortet løftes 3 px ved hover |
| `.collapse-grid` | Utfelling: `grid-template-rows` 0fr → 1fr, styrt av `data-open` |
| `.skeleton` | Lasteflate med vandrende gult lys |
| `<Reveal>` | Toner inn ved rulling. `data-reveal` i base-laget, satt av en `IntersectionObserver` |

Forsinkelsen på `.anim-*` settes med `--anim-delay`, enten som Tailwind-variant
(`[--anim-delay:120ms]`) eller som inline `style` når den regnes ut.

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

## Bevegelse

Bevegelse følger samme prinsipp som flatene: få virkemidler, brukt likt overalt.

1. **Én kurve.** `--ease-snoat: cubic-bezier(0.2, 0.8, 0.2, 1)` — rask start,
   mykt anslag. Tre varigheter (`--dur-fast` 0,16 s, `--dur-base` 0,28 s,
   `--dur-slow` 0,48 s), ikke tjue.
2. **Alt som dukker opp, stiger og toner inn.** Aldri et hopp.
3. **Alt som endrer størrelse, animerer størrelsen — med `.collapse-grid`.**
   `transition: height` på en boks med `height: auto` gjør *ingenting*: vokser
   innholdet, er den beregnede verdien fortsatt `auto`, og det finnes ingen
   verdiendring å animere. (`interpolate-size: allow-keywords` hjelper bare når
   man går til eller fra et nøkkelord — det er verifisert i Chrome, ikke antatt.)
   Derfor er utfelling alltid `grid-template-rows: 0fr → 1fr` på et rutenett med
   én rad, som virker i alle nettlesere. Bokser som «dukker opp» — feilmeldinger,
   lagret-kvitteringer, varselet etter GitHub-tilkobling — ligger derfor i DOM-en
   hele tiden med `data-open` og `inert`, i stedet for bak en `&&` som får resten
   av siden til å hoppe.
4. **Alt som kan trykkes, gir etter.** Knappene har
   `transform: translateY(1px) scale(0.985)` på `:active`. Uten skygge er det
   den eneste tilbakemeldingen en firkantet knapp kan gi.
5. **Vi animerer `transform` og `opacity`.** Grafens søyler vokser med
   `scaleY`, ikke med `height`, slik at de ikke tvinger fram ny layout per
   ramme.
6. **`prefers-reduced-motion` slår av alt.** Varigheten nulles, animasjonene
   fjernes ikke — grensesnittet skal fortsatt vise sluttilstanden.
7. **Uten JavaScript vises alt.** `__root.tsx` legger en `<noscript>`-regel som
   overstyrer starttilstanden til `[data-reveal]`. Ellers ville landingssiden
   vært usynlig for en leser uten JS.

Tilstandsbytter markeres med `key`: statusmerket, byggesteget og DNS-merket får
`key` på verdien sin, slik at «I kø» → «Bygger» → «Live» leses som tre
hendelser i stedet for tekst som stille ble byttet ut.

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

### Terminalen følger systemets mørk/lys-innstilling

Appen er lys. Byggeloggen er **det eneste unntaket**: den leses som en
terminal, ikke som en side, og en kullsvart boks midt i et lyst dashboard ser
ut som en feil. Loggen var tidligere hardkodet til `#070a12` med grønn tekst —
en farge som ikke fantes noe annet sted i paletten.

Fargene ligger som tokens i `:root`, og én mediespørring snur hele terminalen:

| Token | Lyst system | Mørkt system |
| --- | --- | --- |
| `--terminal-surface` | `#f6f6f2` | `#121212` |
| `--terminal-bar` | `#ecece6` | `#1d1d1d` |
| `--terminal-text` | `#1c1c1c` | `#ededea` |
| `--terminal-dim` | svart 62 % | hvit 62 % |
| `--terminal-line` | svart 12 % | hvit 14 % |
| `--terminal-scheme` | `light` | `dark` |

`--terminal-scheme` settes som `color-scheme` på `.terminal-shell`, slik at
rullefeltet inne i loggen følger med — en mørk logg med hvitt rullefelt ser
ødelagt ut. Avkryssingsboksen «autorull» får `accent-color` fra samme token.

**Ingenting annet i appen snur.** Det er ikke et mørkt tema; det er én flate
som respekterer at brukeren har sagt hva slags terminal hen vil ha.

### Statusmerker
Firkantet, 2 px ramme, versaler med `tracking`. Fyllet er tilstanden:
svart = live, gul = pågår, hvit = venter, rød ramme = feilet, grå = hviler.

## Oppsummering for utvikling

1. **Bruk ramme, ikke skygge.** Det finnes ingen `box-shadow` i systemet.
2. **Knapper og felt er firkantede. Kort er rundet.**
3. **Ingen ikoner.** Trenger du et symbol, er svaret typografi eller en rute.
4. **Gul er markør, svart er handling, rød er feil.** Ingen fjerde farge.
5. **Nye mål hentes fra Figma og ganges med 1,5368.**
