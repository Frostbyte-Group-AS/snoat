# Proxmox-verten

Filer som ligger på Proxmox-verten (`88.99.100.186`), ikke i Snoat-stacken.
Se `CONTEXT_FOR_AI/14_vps.md` for hvorfor de finnes.

| Fil | Installeres som |
| --- | --- |
| `snoat-vps-avstem` | `/usr/local/sbin/snoat-vps-avstem` (755) |
| `snoat-vps-avstem.service` | `/etc/systemd/system/snoat-vps-avstem.service` |

```bash
scp infra/proxmox/snoat-vps-avstem root@88.99.100.186:/usr/local/sbin/
scp infra/proxmox/snoat-vps-avstem.service root@88.99.100.186:/etc/systemd/system/
ssh root@88.99.100.186 'systemctl daemon-reload && systemctl enable --now snoat-vps-avstem && cat /run/snoat-vps/status.json'
```

Oppsettet av poolen, API-brukeren og malene (gjort 2026-10-04):

```bash
pveam download local debian-12-standard_12.12-1_amd64.tar.zst
pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst
pvesh create /pools --poolid snoat-vps --comment "VPS-er Snoat lager for eierkontoen. ram-reservert-mb=57344"
pveum role add SnoatVPS --privs "VM.Allocate VM.Audit VM.Config.CPU VM.Config.Memory VM.Config.Disk VM.Config.Network VM.Config.Options VM.PowerMgmt VM.Console Datastore.AllocateSpace Datastore.Audit Pool.Audit Pool.Allocate Sys.Audit SDN.Use"
pveum user add snoat@pve
pveum acl modify /pool/snoat-vps --users snoat@pve --roles SnoatVPS
pveum acl modify /storage/local --users snoat@pve --roles SnoatVPS
pveum acl modify /nodes/pve --users snoat@pve --roles PVEAuditor
pveum acl modify /sdn/zones/localnetwork/vmbr1 --users snoat@pve --roles PVESDNUser
pveum user token add snoat@pve backend --privsep 0   # verdien går rett i Snoats .env
```
