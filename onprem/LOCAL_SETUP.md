# 🏠 Local / On-Premises Hosting Runbook

This directory provides a **local-machine alternative** to the GCP Terraform
deployment under `terraform/`. Instead of provisioning a Google Cloud VM, it
sets up the same DevSecOps stack — **SonarQube**, **DefectDojo**, and
**Wazuh SIEM** — directly on an office machine you own, with the service ports
locked down to your LAN.

The GCP path on `main`/`terraform/` is untouched and still works. This is just a
second way to host the same tools when you want them on-premises.

---

## What you get

| Service | URL (on your LAN) | Purpose |
|---|---|---|
| SonarQube | `http://<machine-ip>:9000` | Static code analysis + quality gate |
| DefectDojo | `http://<machine-ip>:8080` | Vulnerability management |
| Wazuh | `https://<machine-ip>` | SIEM / host monitoring |

`<machine-ip>` is the office machine's LAN IP (e.g. `192.168.1.50`).
`setup.sh` prints the exact URLs at the end.

---

## Prerequisites

- **OS:** Ubuntu 24.04 LTS (apt-based). The scripts are written for it.
- **Access:** a user with `sudo`.
- **Specs:** SonarQube + Elasticsearch are memory-hungry. Match the GCP VM that
  ran this (an `e2-standard-4`): **~4 vCPU and 16 GB RAM** minimum, plus ~100 GB
  free disk. The script also creates an 8 GB swapfile.
- **Network:** a static (or DHCP-reserved) LAN IP for the machine is strongly
  recommended so the URLs stay stable.

---

## Step-by-step

### 1. Get the code and switch to this branch

```bash
git clone <this-repo-url>
cd <repo>
git checkout local-onprem-setup
```

### 2. Create your `.env`

```bash
cp onprem/.env.example onprem/.env
```

Open `onprem/.env` and fill in the values:

- `SONARQUBE_ADMIN_PASSWORD` — the admin password the setup sets on first boot.
- `DD_DATABASE_PASSWORD`, `DD_SECRET_KEY`, `DD_CREDENTIAL_AES_256_KEY` — generate
  each with:
  ```bash
  openssl rand -base64 32
  ```
- `GRAFANA_*` — your Grafana Cloud values (see the Grafana note below). These are
  for reference; the pipeline reads them from GitHub Secrets.

`onprem/.env` is gitignored — it never gets committed.

### 3. Set your LAN subnet in the firewall script

Edit `onprem/firewall.sh` and set `LAN_CIDRS` at the top to your **actual office
subnet** (e.g. `192.168.10.0/24`). The defaults (`192.168.0.0/16`, `10.0.0.0/8`)
cover common private ranges but are broader than most offices need.

### 4. Apply the firewall

```bash
sudo bash onprem/firewall.sh
```

This allows SSH (22) from anywhere and the service ports only from your LAN, then
enables `ufw`.

> ⚠️ **Before enabling ufw on a remote machine**, make sure port 22 is allowed
> from where you SSH in (it is, by default). If your admins are all on the LAN,
> tighten the SSH rule too.

### 5. Run the setup

```bash
sudo bash onprem/setup.sh
```

This installs Docker, tunes the kernel, creates swap, brings up SonarQube and
DefectDojo, bootstraps the SonarQube `DevSecOps_Gate` quality gate, installs
Wazuh single-node, and loads the custom VAPT rules/decoders. It is **idempotent**
— re-run it any time; completed steps are skipped.

When it finishes it prints the service URLs.

---

## First-login / default credentials

- **SonarQube** — user `admin`, password = the `SONARQUBE_ADMIN_PASSWORD` you set
  in `onprem/.env` (the setup changes it away from the default `admin/admin` on
  first boot).
- **DefectDojo** — on first startup DefectDojo generates an `admin` password in
  its own container logs. Retrieve it with:
  ```bash
  cd onprem/django-DefectDojo
  docker compose logs initializer | grep "Admin password:"
  ```
- **Wazuh** — the dashboard `admin` password is saved to
  `/root/wazuh-passwords.txt` on the machine during install.

---

## How this maps to the GCP setup

| GCP (`terraform/`) | On-prem (`onprem/`) |
|---|---|
| VM startup-script in `main.tf` | `setup.sh` |
| GCP firewall rules (0.0.0.0/0) | `firewall.sh` (ufw, LAN-only) |
| SonarQube `docker run` | `docker-compose.yml` service |
| DefectDojo cloned + its own compose | **same** — `setup.sh` clones `django-DefectDojo` and runs its `--profile postgres-redis` compose |
| Wazuh custom rules via SSH (`wazuh.tf`) | local `cp` into `/var/ossec/...` in `setup.sh` |

### DefectDojo approach (why no DefectDojo service in `docker-compose.yml`)

The GCP startup-script does **not** hand-write a DefectDojo compose file. It
clones the official [`DefectDojo/django-DefectDojo`](https://github.com/DefectDojo/django-DefectDojo)
repo and runs that project's own compose with the `postgres-redis` profile, using
generated secrets. We keep that exact approach so DefectDojo stays upstream-managed
and easy to upgrade. `setup.sh` clones it into `onprem/django-DefectDojo` and
writes the generated secrets to `onprem/defectdojo.env` (both gitignored). Our
`onprem/docker-compose.yml` therefore defines only SonarQube.

---

## Grafana Cloud (unchanged)

Grafana stays a **SaaS** service hosted by Grafana Cloud — there is nothing to
self-host on-prem. The CI/CD pipeline still pushes metrics, logs, and traces to
your Grafana Cloud stack. Those values live in **GitHub Secrets**
(`GRAFANA_API_KEY`, `GRAFANA_PROMETHEUS_URL`, `GRAFANA_LOKI_URL`,
`GRAFANA_TEMPO_URL`) exactly as documented in
[`PIPELINE_README.md`](../PIPELINE_README.md). The `.env.example` lists them only
for local reference. Do not touch the `terraform/grafana*.tf` files for the local
path.

---

## Troubleshooting

- **SonarQube takes a while / shows "starting"** — it boots an embedded
  Elasticsearch and can take a few minutes on first run. `setup.sh` waits for
  `"status":"UP"` before bootstrapping the quality gate. Watch it with
  `docker logs -f sonarqube`.
- **SonarQube container exits with a `max_map_count` / `vm.max_map_count` error** —
  the kernel tuning in `setup.sh` fixes this; make sure you ran the whole script
  (not just compose). You can re-apply with `sudo sysctl -w vm.max_map_count=262144`.
- **ufw locked you out over SSH** — always keep the port 22 rule. If you are
  remote and got locked out, you will need local/console access to run
  `sudo ufw allow 22/tcp`. Allow your SSH source before enabling ufw.
- **Can reach a service locally but not from another LAN machine** — check that
  `LAN_CIDRS` in `firewall.sh` actually includes the client's subnet, then re-run
  `sudo bash onprem/firewall.sh`.
- **Wazuh install issues** — the installer logs to the terminal; the install
  files and a `wazuh-passwords.txt` land under `/root/wazuh-install-files/` and
  `/root/`. To re-run the Wazuh step from scratch, remove
  `/root/wazuh-install-files` first (destructive — only if the install failed).
- **DefectDojo admin password** — see the first-login section above; it is in the
  `initializer` container logs.
