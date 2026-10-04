# VPS-er på Proxmox (kun eierkontoen)

Snoat kan lage VPS-er – LXC-containere på Proxmox-verten Snoat selv kjører på.
Funksjonen finnes **bare for eierkontoen** (`SNOAT_OWNER_ACCOUNTS`). For alle
andre er Snoat et Vercel-alternativ og ingenting mer: `/api/vps/*` svarer 403,
`snoat_vps_*` finnes ikke i MCP (skjult i `tools/list`, avvist i `tools/call`),
og dashboardet viser ikke fanen. Grensen sitter i backend.

**Hvor eieren lager en VPS:** «Nytt prosjekt» på dashboardet spør først «Hva
vil du lage?» – *Nettside eller app* eller *VPS* (bare eierkontoen; alle andre
går rett til app-skjemaet). VPS-valget er en veiviser med ett spørsmål per
skjerm (`components/NewVpsForm.tsx`): navn → operativsystem → størrelse → se
over. Velges *Egendefinert* som størrelse, kommer CPU, RAM og disk som egne
steg med glidebryter og måler for hva som er ledig. Oversikten har «Endre» på
hver rad. Samme veiviser står under Innstillinger → VPS-er, og VPS-ene vises
som kort under prosjektene (`components/VpsOverview.tsx`).

## Hvor ting bor

| Hva | Hvor |
| --- | --- |
| Proxmox-vert | `88.99.100.186` (`pve`), Hetzner, 256 GB RAM |
| Snoat-plattformen | VM 100 `snoat`, `10.10.10.10`, 48 GB RAM |
| VPS-ene | LXC i poolen `snoat-vps`, VMID 2000+, IP `10.10.10.100–250` på `vmbr1` (NAT) |
| SSH inn | `ssh -p 22000+(vmid-2000) root@88.99.100.186` |
| API-bruker | `snoat@pve`, token `snoat@pve!backend`, rettigheter bare i poolen |
| Avstemming | `snoat-vps-avstem.service` på verten (`/usr/local/sbin/snoat-vps-avstem`) |

Backend snakker med `https://10.10.10.1:8006` og verifiserer sertifikatet mot
Proxmox' egen CA (`SNOAT_PROXMOX_CA_PEM_B64`) og navnet `pve`.
Node-sertifikatet har ikke den interne IP-en i SAN, så vanlig vertsnavnsjekk
ville feilet. Å slå av verifiseringen er ikke et alternativ.

## Minnemodellen

Kravet: en VPS skal kunne bruke alt ledig minne, men VPS-ene skal til sammen
aldri kunne ta minnet resten av serveren lever av.

| Begrep | Satt av | Blir |
| --- | --- | --- |
| **Reservert** | `ram-reservert-mb=N` i kommentaren på poolen `snoat-vps` | det som alltid er igjen til Snoat-VM-en, Proxmox og kjernen |
| **Gruppetak** | avstemmingen | `memory.max` på `/sys/fs/cgroup/lxc` = verts-RAM − reservert |
| **Maks per VPS** | Proxmox `memory` | standard = verts-RAM, altså «ingen egen grense» – gruppetaket gjelder |
| **Garantert per VPS** | `snoat-ram-min-mb=N` i VPS-ens beskrivelse | `memory.low` på VPS-en, og summen på forelderen |

Med 251,6 GiB og 56 GiB reservert er gruppetaket 195,6 GiB.

**Hvorfor LXC og ikke KVM:** en container bruker bare minnet prosessene faktisk
bruker, og sidebufferen kan kjernen ta tilbake. En KVM-gjest holder på minnet den
en gang har rørt, og kan bare tilnærme dette med ballong. Docker virker i
containerne med `nesting=1` (målt 2026-10-04 med `hello-world`).

**Hvorfor en avstemmingstjeneste:** API-tokenet er ikke root. Proxmox lar bare
`root@pam` skrive rå `lxc.*`-nøkler, hookscripts og andre feature-flagg enn
`nesting`. Backend skriver derfor ønsket tilstand gjennom API-et (poolkommentar
og beskrivelse). Tjenesten på verten oversetter den til cgroups og iptables hvert
15. sekund og skriver status til `/run/snoat-vps/status.json`.

**Forbilder:** Kubernetes' `system-reserved`/allocatable (reserver til systemet,
resten til arbeidslasten) og requests/limits (`memory.min`/`memory.max`). Incus/LXD
`limits.memory.enforce=soft` (bruk ledig minne, skyves tilbake ved press).
systemd-slicer med `MemoryMax` på en foreldregruppe. Samme mekanisme
(cgroup v2-hierarki), bare satt opp for Proxmox' faste `lxc`-forelder.

### Målt 2026-10-04

- Gruppetaket satt til 1500 MB, VPS-en med eget tak på 2048 MB prøvde å bruke
  1,8 GB: `oom_kill 1` i `/sys/fs/cgroup/lxc/memory.events`. Resten av verten
  merket ingenting.
- ⚠️ **`memory.high` brukes ikke.** Uten swap blir en gruppe over `high`
  strupet i stedet for å få OOM, og prosessene i den henger (også `pct exec`
  inn i containeren hang). Taket er `memory.max` alene. Sidebuffer tas uansett
  tilbake når gruppen nærmer seg taket.

## Endre reservasjonen

Fra dashboardet (Innstillinger → VPS-er), MCP (`snoat_vps_set_ram_pool`) eller
`PATCH /api/vps/ram {"reservertMb": 57344}`. Endringen avvises hvis det nye taket
blir lavere enn det VPS-ene allerede bruker eller er garantert, og trer i kraft
innen 15 sekunder.

Reservasjonen må dekke Snoat-VM-en (48 GB) pluss Proxmox og kjernen (noen GB).
Øker VM-ens RAM, må reservasjonen økes like mye.

## API og MCP

| REST (`/api/vps`) | MCP |
| --- | --- |
| `GET /tilgang` → `{eier, konfigurert}` (alltid 200) | – |
| `GET /` → VPS-er, RAM-pool, maler | `snoat_vps_list` |
| `POST /` `{name, template?, cores?, diskGb?, memoryMaxMb?, memoryMinMb?, sshPublicKeys?}` | `snoat_vps_create` |
| `POST /:vmid/{start,shutdown,stop,reboot}` | `snoat_vps_power` |
| `PATCH /:vmid` `{cores?, memoryMaxMb?, memoryMinMb?}` | `snoat_vps_update` |
| `DELETE /:vmid` `{confirmName}` | `snoat_vps_delete` (krever også `confirmPermanentDeletion`) |
| `GET /ram`, `PATCH /ram {reservertMb}` | `snoat_vps_get_ram_pool`, `snoat_vps_set_ram_pool` |
| `GET /ressurser` → CPU, RAM-pool, disk og grenser for en ny VPS | `snoat_vps_resources` |

**Grenser som håndheves i `createVps`** (menyen viser dem, men backend er
kontrollen – MCP går rett hit):

- **CPU:** høyst vertens tråder (12). Kjerner er et tak, ikke en reservasjon –
  VPS-ene deler CPU-en.
- **Garantert RAM:** summen av alle garantier kan ikke passere det felles taket
  (`vps.ram_guarantee_exceeded`). Gjelder også `PATCH /:vmid`.
- **Disk:** ledig plass på `local` minus det andre VPS-er er lovet men ikke har
  skrevet ennå (diskene er tynne filer), minus 50 GB holdt av til Snoat-VM-en,
  høyst 300 GB (`vps.disk_full`). Snoat-VM-ens egen disk er også tynn (250 GB
  maks), så marginen er et kompromiss, ikke en garanti.

Maler: `debian-12`, `debian-13`, `ubuntu-24.04`. Må være lastet ned på verten
(`pveam download local <mal>`). Nøklene i `SNOAT_VPS_DEFAULT_SSH_KEYS_B64` legges
alltid inn, og det finnes ikke noe root-passord.

## Gjenstår

- HTTP inn til en VPS: i dag bare SSH. Det naturlige neste steget er en
  Caddy-rute `<vps>.snoat.com` → `10.10.10.x:<port>` (Snoat-VM-en når VPS-nettet
  direkte).
- KVM-VPS-er ligger utenfor `lxc`-cgroupen og dermed utenfor gruppetaket. Kommer
  de, må reservasjonen regnes med dem eller de må få ballong-min/maks.
