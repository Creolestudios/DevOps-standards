# cs-devtest credential broker (on-prem)

A small Node.js/Express service that runs on the on-prem DevSecOps server and
holds the privileged **SonarQube admin token** and **DefectDojo API key**
server-side. Clients (developer laptops via the `cs-devtest` CLI, and CI on a
self-hosted LAN runner) call the broker instead of carrying those credentials.

See [`../BROKER_DESIGN.md`](../BROKER_DESIGN.md) for the full design.

## What it does

- Performs all admin-level SonarQube and DefectDojo work (project/user/permission
  provisioning, scan import, findings fetch).
- Returns only least-privilege artifacts: a **project-scoped scanner token** and
  import/findings summaries. The admin token and API key never leave the server.
- Is stateless — all state lives in SonarQube and DefectDojo.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sonar/provision` | Ensure project (private) + optional user/permissions, mint a project-scoped scanner token. |
| `POST` | `/defectdojo/import` | `multipart/form-data` scan upload; resolve-or-create product + engagement and import. |
| `GET`  | `/defectdojo/findings` | Read-only: resolve product/engagement by name and return the engagement's findings JSON. |
| `GET`  | `/healthz` | `200` when both upstreams are reachable, `503` (with per-field status) otherwise. |
| `GET`  | `/config` | Non-secret config: `{ "sonarHostUrl": "..." }`. |

### `POST /sonar/provision`

Request (JSON):

```json
{ "projectKey": "my-app", "projectName": "My App", "gitEmail": "dev@creole.com", "consumerId": null }
```

- The CLI sends `gitEmail`; CI sends `consumerId` and omits `gitEmail`.
- The minted token is named `cs-devtest-<projectKey>-<cid>` where
  `cid = sha256(consumerId || gitEmail || "anon").slice(0,12)`, so consumers
  never revoke each other's tokens.

Response (200):

```json
{
  "hostUrl": "http://192.168.1.50:9000",
  "projectKey": "my-app",
  "scannerToken": "sqp_…",
  "dashboardUrl": "http://192.168.1.50:9000/dashboard?id=my-app",
  "userSetup": "ok"
}
```

### `POST /defectdojo/import`

`multipart/form-data`: `file` (required, ≤20 MB), `repo` (required), `branch`
(required), `commit` (required hex sha), `scanType` (optional, one of
`SonarQube Scan` / `ZAP Scan`), `scanDate` (optional `YYYY-MM-DD`).

### `GET /defectdojo/findings`

Query: `repo` (required), `branch` (required), `limit` (optional 1–500). Returns
`404` if no product/engagement exists for that repo/branch yet.

## Configuration (environment)

All values come from `onprem/.env` (see [`../.env.example`](../.env.example)).
**Placeholders only — never commit real secrets.**

| Var | Default | Purpose |
|---|---|---|
| `BROKER_PORT` | `8900` | Listen port. |
| `SONAR_INTERNAL_URL` | `http://sonarqube:9000` | Broker → SonarQube (service name on `devsecops-net`). |
| `SONAR_PUBLIC_URL` | `http://localhost:9000` | SonarQube URL handed back to clients. |
| `SONARQUBE_ADMIN_PASSWORD` | — | Used at startup to mint the broker's admin token. |
| `SONAR_ADMIN_TOKEN` | — | Optional. If set, used directly (skips the mint step). |
| `DEFECTDOJO_URL` | `http://host.docker.internal:8080` | Broker → DefectDojo. |
| `DD_ADMIN_USER` / `DD_ADMIN_PASSWORD` | `admin` / — | Used to obtain the DefectDojo API key. |
| `DEFECTDOJO_API_KEY` | — | Optional. If set, used directly (skips token-auth). |
| `DD_PRODUCT_TYPE_NAME` | `cs-devtest` | Product type created/used on import. |
| `BROKER_UPSTREAM_TIMEOUT_MS` | `15000` | Per-request upstream timeout. |

### How it obtains its own credentials

- **SonarQube:** at startup it authenticates as `admin:$SONARQUBE_ADMIN_PASSWORD`
  and mints an admin user token named `cs-devtest-broker`, held in memory. Startup
  retries while SonarQube is "not up yet" and is fatal only once SonarQube is UP
  and the password is genuinely rejected (or no credential is configured).
- **DefectDojo:** it calls `/api/v2/api-token-auth/` lazily with
  `DD_ADMIN_USER`/`DD_ADMIN_PASSWORD`, caching the key. DefectDojo being down does
  not block startup; `/defectdojo/*` returns `503` until it recovers.

## Access model

The broker runs on `devsecops-net`, publishes port **8900**, and performs **no**
application-layer IP check — its container cannot see real client IPs. LAN-only
access is enforced at the network layer by the `DOCKER-USER` iptables rules that
`onprem/setup.sh` applies (§4 of the design). On a trusted office LAN this means
any host on the subnet can call the broker; it is not for public exposure.

## Run

Built and started by `onprem/setup.sh` via `onprem/docker-compose.yml`
(`--profile broker up -d broker`). Locally for development:

```bash
npm install
npm start      # reads config from the environment
npm test       # node:test unit tests (upstream calls stubbed)
```
