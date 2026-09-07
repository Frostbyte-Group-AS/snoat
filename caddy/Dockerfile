# ---------------------------------------------------------------------------
# Caddy med `replace_response`
#
# Stock-imaget holder for alt annet vi gjør, men feilsporingen trenger én ting
# det ikke har: å skrive en script-tag inn i HTML-svarene til appene på vei ut.
# Uten den måtte hver enkelt app fått kode limt inn i kildekoden sin, og da er
# vi tilbake til noe som må slås på, holdes oppdatert, og som kan brekke et
# bygg. Poenget med Snoat-analytikk er at den bare er der; feilsporingen skal
# oppføre seg likt.
#
# `replace-response` er en offisiell Caddy-modul (caddyserver/), ikke en
# tredjeparts fork. Den kjører i strømmemodus hos oss – se `injectHandlers()`
# i backend/src/lib/caddy.ts – slik at et 200 MB nedlastingssvar ikke blir
# bufret i minnet for å lete etter en `</head>` som aldri kommer.
#
# ## Hvorfor versjonen står tre steder
#
# `xcaddy build <versjon>` kompilerer Caddy fra kilde, og den versjonen må være
# den samme som runtime-imaget under – ellers kjører vi en binær bygget mot ett
# sett moduler i et image som har med seg et annet. Bump alle tre samtidig:
# byggesteget, `xcaddy build`-argumentet og runtime-imaget.
# ---------------------------------------------------------------------------
FROM caddy:2.11.4-builder-alpine AS builder

RUN xcaddy build v2.11.4 \
      --with github.com/caddyserver/replace-response

FROM caddy:2.11.4-alpine

# Kun binæren byttes. Alt annet – brukeren, entrypoint, CA-sertifikatene,
# katalogoppsettet under /data og /config – er stock-imaget sitt, slik at
# oppgraderinger ikke krever at vi vedlikeholder en kopi av det.
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Sanity: at binæren faktisk har modulen med seg. Feiler byggingen her, er det
# fordi xcaddy ikke fikk hentet modulen – langt bedre å oppdage under bygg enn
# som en «unknown handler: replace_response» når Caddy nekter å starte i prod
# og hele plattformen står.
RUN caddy list-modules | grep -q '^http.handlers.replace_response$'
