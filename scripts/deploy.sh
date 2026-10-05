#!/usr/bin/env bash
set -euo pipefail

# Snoat Production Deploy Script
# Deployer kode fra lokalt arbeidsområde til VPS og starter plattformen på nytt.

# Snoat-plattformen kjører i VM-en `snoat` (10.10.10.10) på Proxmox-verten bak
# edge.snoat.com (Hetzner, fra 2026-10-04). VM-en har ingen offentlig IP – SSH
# går med hopp gjennom verten, og verten videresender 80/443 til VM-en.
# Verten nås på vertsnavnet, ikke IP-en, så en ny server bare er en DNS-endring.
#
# Den gamle serveren 38.87.117.167 (LuxVPS) kjører fortsatt parallelt til DNS er
# flyttet. Deploy dit med:
#   SNOAT_VPS_IP=38.87.117.167 SNOAT_SSH_JUMP= SNOAT_PUBLIC_IP=38.87.117.167 ./scripts/deploy.sh
DEFAULT_VPS_IP="10.10.10.10"
VPS_IP="${SNOAT_VPS_IP:-$DEFAULT_VPS_IP}"
VPS_USER="${SNOAT_VPS_USER:-root}"
# Tom streng = ingen hopp (`SNOAT_SSH_JUMP=` for gammel server).
SNOAT_DOMAIN="${SNOAT_DOMAIN:-snoat.com}"
EDGE_HOST="${SNOAT_EDGE_HOST:-edge.${SNOAT_DOMAIN}}"
SSH_JUMP="${SNOAT_SSH_JUMP-root@${EDGE_HOST}}"
# IP-en domenet skal treffe. Verifiseringen går hit med --resolve, slik at den
# tester serveren vi nettopp deployet til. Sett SNOAT_PUBLIC_IP for å teste en
# server før DNS-en for kantverten er flyttet.
PUBLIC_IP="${SNOAT_PUBLIC_IP:-$(dig +short "$EDGE_HOST" A | tail -n1)}"
if [[ -z "$PUBLIC_IP" ]]; then
  echo "FEIL: fant ingen IP for $EDGE_HOST. Sett SNOAT_PUBLIC_IP." >&2
  exit 1
fi
TARGET_DIR="/opt/snoat"
LOG_FILE="/tmp/snoat-deploy.log"

# Nøkkelen serveren faktisk kjenner. Uten `IdentitiesOnly=yes` tilbyr ssh alle
# nøkler i agenten i tur og orden – har du flere (f.eks. id_ed25519_supabase),
# rekker serveren å avvise nok forsøk til at du havner på passordprompt selv om
# riktig nøkkel ligger i authorized_keys.
#
# Arrayet starter med ett element med vilje: `"${TOM_ARRAY[@]}"` under `set -u` er
# en «unbound variable»-feil i bash 3.2, som fortsatt er standard-bash på macOS.
SSH_OPTS=(-o ConnectTimeout=20)
if [[ -n "${SNOAT_SSH_KEY:-}" ]]; then
  if [[ -f "$SNOAT_SSH_KEY" ]]; then
    SSH_OPTS+=(-i "$SNOAT_SSH_KEY" -o IdentitiesOnly=yes)
  else
    echo "ADVARSEL: fant ikke spesifisert SSH-nøkkel $SNOAT_SSH_KEY – lar ssh velge selv." >&2
  fi
elif [[ -f "$HOME/.ssh/id_ed25519" ]]; then
  SSH_OPTS+=(-i "$HOME/.ssh/id_ed25519")
elif [[ -f "$HOME/.ssh/id_rsa" ]]; then
  SSH_OPTS+=(-i "$HOME/.ssh/id_rsa")
fi
if [[ -n "$SSH_JUMP" ]]; then
  SSH_OPTS+=(-J "$SSH_JUMP")
fi

# Tøm loggfilen
echo "--- Start deployment av Snoat $(date) ---" > "$LOG_FILE"

# Progress-funksjon for å vise en pen progress bar på en enkelt linje
show_progress() {
  local percent=$1
  local message=$2
  local width=40
  local filled=$(( percent * width / 100 ))
  local empty=$(( width - filled ))
  
  # Bygg progress bar-strengen
  local bar=""
  for ((i=0; i<filled; i++)); do bar="${bar}█"; done
  for ((i=0; i<empty; i++)); do bar="${bar}░"; done
  
  # Print progress (over skriver forrige linje med \r og tømmer resten av linjen med \e[K)
  printf "\r\e[K[%s] %d%% - %s" "$bar" "$percent" "$message"
}

# Hjelpefunksjon for å kjøre kommandoer med logging
run_step() {
  local percent=$1
  local msg=$2
  shift 2
  
  show_progress "$percent" "$msg"
  
  # Kjør kommandoen og omdiriger utdata til loggfilen
  if ! "$@" >> "$LOG_FILE" 2>&1; then
    echo -e "\n\n\e[31m[FEIL] Deployment feilet under: $msg\e[0m"
    echo "--------------------------------------------------"
    echo "Siste 25 linjer fra loggfilen ($LOG_FILE):"
    echo "--------------------------------------------------"
    tail -n 25 "$LOG_FILE"
    echo "--------------------------------------------------"
    exit 1
  fi
}

echo "==> Starter deployment av Snoat til $VPS_IP (domene: $SNOAT_DOMAIN)"
if [[ "$VPS_IP" != "$DEFAULT_VPS_IP" ]]; then
  echo -e "\e[33m    MERK: dette er ikke standardserveren ($DEFAULT_VPS_IP).\e[0m"
fi

# 1. Synkroniserer filer med rsync
# 0. Selvoppdateringen (infra/selvoppdatering/) deployer main av seg selv hvert
# minutt. En deploy for hånd må ikke krangle med den: står den midt i et bygg,
# stopper vi her, og mens vi holder på er automatikken på pause – ellers kunne
# den rullet ut main over det vi er i ferd med å deployere.
#
# Er det vi deployer en ren main, får selvoppdateringen vite det til slutt
# (deployet-commit), og pausen oppheves – med mindre den sto der fra før.
# Er det noe annet – en gren, ucommittede endringer – blir pausen stående, så
# testdeployen ikke byttes ut et minutt senere. Gjenoppta fra Snoat-kortet i
# dashboardet eller med `rm /var/lib/snoat-selvoppdatering/pause` på serveren.
SELV_DIR="/var/lib/snoat-selvoppdatering"
git fetch --quiet origin main 2>/dev/null || true
LOKAL_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
REN_MAIN=false
if [[ -n "$LOKAL_COMMIT" && "$LOKAL_COMMIT" == "$(git rev-parse origin/main 2>/dev/null || true)" \
  && -z "$(git status --porcelain 2>/dev/null)" ]]; then
  REN_MAIN=true
fi

SELV_FOR="$(ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" "SELV_DIR='${SELV_DIR}' bash -s" <<'EOF'
  set -euo pipefail
  if [ ! -f "$SELV_DIR/status.json" ]; then echo "ikke-installert"; exit 0; fi
  if jq -e '.kjorer == true' "$SELV_DIR/status.json" >/dev/null 2>&1; then echo "kjorer"; exit 0; fi
  if [ -e "$SELV_DIR/pause" ]; then echo "pause-fra-for"; exit 0; fi
  date -u +%Y-%m-%dT%H:%M:%SZ >"$SELV_DIR/pause"
  echo "satt-pause"
EOF
)" || SELV_FOR="ukjent"

if [[ "$SELV_FOR" == "kjorer" ]]; then
  echo -e "\e[31m[STOPP] Selvoppdateringen bygger akkurat nå. Vent til den er ferdig (Snoat-kortet i dashboardet).\e[0m"
  exit 1
fi

run_step 15 "Synkroniserer prosjektfiler..." \
  rsync -avz -e "ssh ${SSH_OPTS[*]}" \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '.env' \
    --exclude 'frontend/.env' \
    --exclude 'frontend/.output' \
    --exclude 'backend/dist' \
    --exclude 'backend/vendor' \
    --exclude '.snoat' \
    --exclude '.claude' \
    --exclude '.snoat-selvoppdatering' \
    ./ "${VPS_USER}@${VPS_IP}:${TARGET_DIR}"

# 2. Oppdaterer .env på VPS via SSH
run_step 30 "Konfigurerer miljøvariabler (.env)..." \
  ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" "SNOAT_DOMAIN='${SNOAT_DOMAIN}' bash -s" <<'EOF'
    set -euo pipefail
    cd /opt/snoat
    node scripts/bootstrap-env.mjs
EOF

# 2b. Stopper før vi rører tjenestene hvis hemmelighetene mangler.
#
# bootstrap-env.mjs bruker preserved(), som beholder VPS-ens eksisterende
# verdier. Nye variabler får derfor tom streng her, ikke defaultverdien fra
# skriptet – de må settes manuelt på serveren én gang. Uten SMTP-legitimasjon
# kan GoTrue ikke sende bekreftelsesmail, og med autoconfirm av betyr det at
# ingen kan registrere seg i det hele tatt.
run_step 40 "Sjekker at hemmeligheter finnes på VPS..." \
  ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" 'bash -s' <<'EOF'
    set -euo pipefail
    cd /opt/snoat
    missing=""
    for key in RESEND_API_KEY SMTP_ADMIN_EMAIL; do
      grep -qE "^${key}=.+" .env || missing="${missing} ${key}"
    done
    if [ -n "$missing" ]; then
      echo "Mangler i /opt/snoat/.env:${missing}"
      echo "Sett dem på VPS-en og kjør deploy på nytt."
      exit 1
    fi
EOF

# 2c. Tak på hva en byggejobb får lov til å ta av maskinen.
#
# BuildKit er innebygd i dockerd, og byggesteg kjøres av containerd. Begge ligger
# som *søsken* til containerne under `system.slice` – ikke over dem – så uten et
# tak konkurrerer et `next build` med lik vekt mot Caddy, og vinner, fordi det
# har titalls kjørbare tråder mot proxyens få. Resultatet var at snoat.com og
# alle hostede tjenester ble utilgjengelige under bygging uten at én eneste
# container faktisk stoppet: ingen OOM-drap, ingen restarter, bare sult.
#
# CPUQuota=250% av fire kjerner lar byggingen bruke to og en halv og etterlater
# halvannen til plattformen. MemoryHigh presser kjernen til å ta minne tilbake
# fra byggingen før verten begynner å swappe.
#
# Fordi containerne ligger i egne scopes, rammer taket kun byggingen – appene som
# kjører merker ingenting. `set-property` skriver en varig drop-in og trer i kraft
# umiddelbart, uten å restarte dockerd, så ingen apper mister kontakten.
run_step 45 "Setter ressurstak for bygging..." \
  ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" 'bash -s' <<'EOF'
    set -euo pipefail
    # Regnet ut fra maskinen: 80 % av kjernene og 75 % av minnet til bygging.
    # De faste tallene (250 % / 6G) var for den gamle boksen med 4 kjerner og
    # 16 GB, og ville kvalt byggingen på en større maskin.
    cpu_quota=$(( $(nproc) * 80 ))
    mem_high=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) * 3 / 4 / 1024 ))
    systemctl set-property docker.service CPUQuota=${cpu_quota}% CPUWeight=20 MemoryHigh=${mem_high}M
    systemctl set-property containerd.service CPUQuota=${cpu_quota}% CPUWeight=20
EOF

# 3. Bygger Docker-containere på VPS
run_step 50 "Bygger containere (dette kan ta litt tid)..." \
  ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" "cd /opt/snoat && docker compose build frontend backend"

# 3b. En restart av backend avbryter app-bygg som pågår. Vent til de er ferdige
# (høyst 20 min), som selvoppdateringen gjør – se vent_paa_appbygg der.
run_step 65 "Venter på app-bygg som pågår..." \
  ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" 'bash -s' <<'EOF'
    cd /opt/snoat
    for i in $(seq 1 120); do
      aktive=$(docker compose exec -T db psql -U postgres -tAc "select count(*) from deployments where status in ('queued','building')" 2>/dev/null | tr -d '[:space:]')
      { [ -z "$aktive" ] || [ "$aktive" = "0" ]; } && exit 0
      echo "Venter på ${aktive} app-bygg…"
      sleep 10
    done
    echo "ADVARSEL: app-bygg pågår fortsatt etter 20 min – fortsetter."
EOF

# 4. Starter tjenestene
run_step 70 "Starter tjenester (Caddy, Supabase, API, Frontend)..." \
  ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" "cd /opt/snoat && docker compose up -d --remove-orphans"

# 5. Restarter proxy og backend
run_step 85 "Restarter proxy og API..." \
  ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" "cd /opt/snoat && docker compose restart caddy && docker compose restart backend"

# 6. Verifiserer at produksjon faktisk fikk konfigurasjonen vi deployet.
#
# Et rent statuskall holder ikke: auth svarer 200 også når endringene aldri tok,
# og da rapporterer deployen suksess på en no-op. Vi leser derfor tilbake den
# faktiske konfigurasjonen og sammenligner med det vi mener å ha deployet.
verify_production() {
  local settings
  settings=$(curl -fsS --retry 3 --retry-delay 2 \
    --resolve "api.${SNOAT_DOMAIN}:443:${PUBLIC_IP}" "https://api.${SNOAT_DOMAIN}/auth/v1/settings")
  echo "$settings"

  if echo "$settings" | grep -q '"mailer_autoconfirm":true'; then
    echo "FEIL: produksjon kjører med mailer_autoconfirm=true."
    echo "E-postadresser blir bekreftet uten at noen beviser eierskap – se"
    echo "CONTEXT_FOR_AI/08_security_model.md. Sett ENABLE_EMAIL_AUTOCONFIRM=false"
    echo "i /opt/snoat/.env og deploy på nytt."
    return 1
  fi
}

run_step 95 "Verifiserer deployment..." verify_production

# Se steg 0.
if [[ "$SELV_FOR" == "satt-pause" || "$SELV_FOR" == "pause-fra-for" ]]; then
  if [[ "$REN_MAIN" == true ]]; then
    ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" \
      "echo '${LOKAL_COMMIT}' > '${SELV_DIR}/deployet-commit' && rm -f '${SELV_DIR}/feilet-commit'"
    if [[ "$SELV_FOR" == "satt-pause" ]]; then
      ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" "rm -f '${SELV_DIR}/pause'"
    fi
  else
    echo -e "\n\e[33mDette var ikke en ren main, så selvoppdateringen står på pause.\e[0m"
    echo "Gjenoppta fra Snoat-kortet i dashboardet, eller: rm ${SELV_DIR}/pause på serveren."
  fi
fi

# Ferdig!
show_progress 100 "Deployment ferdig!"
echo -e "\n\n\e[32m==> Deploy ferdig! Sjekk https://${SNOAT_DOMAIN}\e[0m"

# Vis tjenestestatus til slutt
echo -e "\nTjenestestatus på VPS:"
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" "cd /opt/snoat && docker compose ps"
