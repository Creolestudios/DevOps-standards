]633;E;sed -n '1,41p' LOCAL_SETUP.md;a9ca7d11-eabd-4f41-9d18-cbd9340c50c8]633;C# 🏠 Local / On-Premises Hosting Runbook

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
| Broker | `http://<machine-ip>:8900` | Credential broker (holds admin token + API key server-side) |
| Wazuh | `https://<machine-ip>` | SIEM / host monitoring |

`<machine-ip>` is the office machine's LAN IP (e.g. `192.168.2.50`).
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

### 1. Get the code (outside the web root)

Clone into `/opt/devsecops`, **not** under `/var/www` or any directory a web
server publishes — `onprem/.env` holds every admin password.

```bash
sudo git clone -b local-onprem-setup https://github.com/Creolestudios/DevOps-standards.git /opt/devsecops
cd /opt/devsecops
```

### 2. Generate `onprem/.env`

```bash
sudo bash onprem/gen-env.sh
```

This creates `onprem/.env` (mode `600`) with random strong passwords and keys,
`LAN_CIDRS` set to this machine's subnet, and `SONAR_PUBLIC_URL` set to
`http://<machine-ip>:9000`. Review it:

```bash
sudo nano onprem/.env
```

- `LAN_CIDRS` — the **only** place the office subnet is configured. Add every
  subnet that needs access (Wi-Fi, VPN), space-separated.
- `EXTRA_LAN_PORTS` — extra host ports to keep open to the LAN, e.g. `"80"` if
  colleagues use an Apache site on this machine. Everything else is closed.

Prefer to fill it by hand? `cp onprem/.env.example onprem/.env` and replace every
`CHANGE_ME`. `setup.sh` validates the file and stops with a clear error if a
placeholder is left, the SonarQube password fails SonarQube's policy (12+
characters, upper, lower, digit, special), or a value contains characters that
break the env file (space, quotes, `$`, backtick, `\`, `#`).

### 3. Apply the firewall

```bash
sudo bash onprem/firewall.sh
```

Allows SSH (22) from anywhere and the service ports only from `LAN_CIDRS`, then
enables `ufw`.

> ⚠️ **Before enabling ufw on a remote machine**, make sure port 22 is allowed
> from where you SSH in (it is, by default).

### 4. Run the setup

```bash
sudo bash onprem/setup.sh
```

This disables suspend, raises (never lowers) the kernel limits, adds swap only
if there is none, installs Docker, restricts the Docker-published ports to the
LAN (re-applied at every boot by `devsecops-docker-user.service`), brings up
SonarQube, DefectDojo and the broker, bootstraps the `DevSecOps_Gate` quality
gate, installs Wazuh single-node, and loads the custom VAPT rules/decoders.

A first run takes roughly 20–40 minutes. It is **idempotent** — re-run it any
time. It exits `0` when everything is up, `1` on a hard error, and `2` when it
finished with warnings (listed at the end).

---

## First-login / default credentials

| Service | User | Password |
|---|---|---|
| SonarQube | `admin` | `SONARQUBE_ADMIN_PASSWORD` in `onprem/.env` |
| DefectDojo | `DD_ADMIN_USER` (`admin`) | `DD_ADMIN_PASSWORD` in `onprem/.env` |
| Wazuh | `admin` | `sudo cat /root/wazuh-passwords.txt` |

View the `.env` values with `sudo cat /opt/devsecops/onprem/.env`.

### Developer dashboard logins

When a developer runs `cs-devtest` in a repo for the first time, the broker
creates their SonarQube account (login = their `git config user.email`) with a
random password and returns it **once**. The CLI prints it and saves it to
`~/.cs-devtest/sonar-dashboard.env` (mode `600`), and the pre-commit hook prints
the URL, username and password after every SonarQube scan, as it did on `main`.

If the account already existed and the password is not saved on that machine
(new laptop, deleted file), the hook says so. An admin can reset it in
SonarQube under **Administration → Security → Users**.

---

## The credential broker (zero secrets for consumers)

The on-prem stack runs a small **credential broker** on port **8900**. It holds
the SonarQube admin token and the DefectDojo API key **server-side**. Developer
laptops (via the `cs-devtest` CLI) and CI call the broker instead of carrying
those privileged credentials, so a consuming repo stores **zero** cs-devtest
DevSecOps secrets.

### GitHub Secrets you no longer need

These six repo secrets were required before and can now be **removed** from every
consuming repository:

1. `SONAR_HOST_URL`
2. `SONAR_TOKEN`
3. `DEFECTDOJO_URL`
4. `DEFECTDOJO_API_KEY`
5. `DEFECTDOJO_ENGAGEMENT_ID`
6. `DEFECTDOJO_PRODUCT_ID`

**Net-new secrets required: none.** The only new value is
`CS_DEVTEST_BROKER_URL`, which is a non-secret LAN URL — store it as a repo/org
**Variable** (Settings → Variables), not a Secret. (`POSTMAN_API_KEY`,
`COLLECTION_UID`, and `GRAFANA_*` are your own third-party credentials and are
unchanged — the broker does not manage them.)

### Pointing clients at the broker

The `cs-devtest` CLI connects to `http://192.168.2.50:8900` by default
(`DEFAULT_BROKER_URL` in `lib/sonarqube.js`), so developers need no DNS or
`/etc/hosts` setup. Keep the server's IP static (it is set in netplan). If the
server moves to a new IP, update `DEFAULT_BROKER_URL` and publish a new
`cs-devtest` version; until then a machine can point elsewhere by setting the
`CS_DEVTEST_BROKER_URL` environment variable.

### Self-hosted LAN runner for CI

GitHub's `ubuntu-latest` cloud runners live on the public internet and **cannot
reach** `http://192.168.x.x:8900`. The `run-scans` job in
`security-pipeline.yml` therefore uses `runs-on: [self-hosted, lan]` and must run
on a self-hosted GitHub Actions runner **inside the office LAN**. Provision that
runner with **Docker**, **Node.js ≥ 18**, and **`jq`** installed — unlike
`ubuntu-latest`, a self-hosted box is not guaranteed to ship them.

### Firewalling of Docker ports

`ufw` does not filter Docker-published ports. The LAN restriction for `8900`,
`9000`, `8080` and `8443` lives in `onprem/docker-user-rules.sh` (`DOCKER-USER`
iptables chain). `setup.sh` runs it and installs
`devsecops-docker-user.service`, which re-applies it whenever Docker starts, so
the restriction survives reboots. Both firewalls read `LAN_CIDRS` from
`onprem/.env`.

---

## How this maps to the GCP setup

| GCP (`terraform/`) | On-prem (`onprem/`) |
|---|---|
| VM startup-script in `main.tf` | `setup.sh` |
| GCP firewall rules (0.0.0.0/0) | `firewall.sh` (ufw, LAN-only) |
| SonarQube `docker run` | `docker-compose.yml` service |
| DefectDojo cloned + its own compose | **same** — `setup.sh` clones `django-DefectDojo` and runs its compose plus `defectdojo.override.yml` |
| Wazuh custom rules via SSH (`wazuh.tf`) | local `cp` into `/var/ossec/...` in `setup.sh` |

### DefectDojo approach (why no DefectDojo service in `docker-compose.yml`)

The GCP startup-script does **not** hand-write a DefectDojo compose file. It
clones the official [`DefectDojo/django-DefectDojo`](https://github.com/DefectDojo/django-DefectDojo)
repo and runs that project's own compose. We keep that approach so DefectDojo
stays upstream-managed and easy to upgrade. `setup.sh` clones it into
`onprem/django-DefectDojo` (gitignored) and writes `django-DefectDojo/.env` from
`onprem/.env`. That file sets the database URL to match the Postgres password
(upstream defaults it to `defectdojo`), and `COMPOSE_FILE` so
`onprem/defectdojo.override.yml` is always applied. The override passes the
admin password to the initializer and puts nginx on `devsecops-net` as
`defectdojo`. Our `onprem/docker-compose.yml` defines SonarQube and the broker.

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
  `LAN_CIDRS` in `onprem/.env` includes the client's subnet, then re-run
  `sudo bash onprem/firewall.sh && sudo bash onprem/docker-user-rules.sh`.
- **Wazuh install issues** — the installer logs to the terminal. If it failed
  part-way, remove the partial install with `sudo bash /root/wazuh-install.sh -u`
  and re-run `setup.sh` (it only skips Wazuh once `wazuh-manager` is installed).
- **DefectDojo login fails** — `DD_ADMIN_PASSWORD` only applies on the first
  initialization. If DefectDojo was initialized earlier, reset the password with
  `cd onprem/django-DefectDojo && sudo docker compose exec uwsgi ./manage.py changepassword admin`,
  then put the same value in `onprem/.env` and run
  `sudo docker restart cs-devtest-broker`.
