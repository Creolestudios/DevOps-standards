# Credential Broker — Technical Design (On-Prem / Local)

**Branch:** `local-onprem-setup` · **Scope:** LOCAL / on-prem only · **Status:** revised after design review (`onprem/BROKER_DESIGN_REVIEW.md`), no code yet.

This is **Option A — a credential broker**. A small service runs on the on-prem
DevSecOps server and holds the privileged SonarQube admin token and the DefectDojo
API key **server-side**. Clients (developer laptops via the `cs-devtest` CLI, and CI)
call the broker instead of carrying those privileged credentials. The end state:

- The published `cs-devtest` package has **no hardcoded** server IP, admin token, or admin password.
- A consuming repo stores **zero** cs-devtest DevSecOps secrets (SonarQube + DefectDojo).
- Developer laptops hold **no admin token, no admin password, and no secret to reach the broker**. The only credential written locally is a disposable, project-scoped SonarQube scanner token in `sonar-project.properties` (see §9).

> This design has been through four review rounds. Finding-by-finding responses are in §14
> (first review, 12 findings), §15 (second review, 9 findings), §16 (third review, 4
> findings), and §17 (fourth review, 1 HIGH + 1 MEDIUM + 3 NIT). All findings addressed.

---

## 1. Overview

Today the privileged logic and secrets are spread to every consumer. `lib/sonarqube.js`
ships a baked-in SonarQube host (`http://34.100.239.232:9000`), an admin token
(`squ_…`), and an admin password (`Creole@123456`); it creates projects, users, and
permissions **from the client** using that admin token, and writes the admin token into
each repo's `sonar-project.properties`. `lib/hooks.js` prints the admin password twice.
In CI, `templates/github-template/workflows/security-pipeline.yml` and
`run-all-scans.sh` require six GitHub Secrets so every repo can talk to SonarQube and
DefectDojo directly.

The broker inverts this. All admin-level operations move to one server-side service on
the on-prem box. Clients send only **non-secret** inputs (project key, project name, the
developer's git email, scan report files plus repo/branch/commit metadata). The broker
performs the privileged work and returns **only** least-privilege artifacts: a
project-scoped SonarQube analysis token and import/findings summaries. The admin token and
the DefectDojo API key never leave the server.

The broker is a small Node.js (Express) HTTP service, containerized under
`onprem/broker/`, added to `onprem/docker-compose.yml`, joined to the existing
`devsecops-net` network, started by `onprem/setup.sh`, and exposed on port **8900**
restricted to the office LAN by `onprem/firewall.sh`. Node + Express is chosen over Go
or Python because the entire `cs-devtest` codebase is already Node.js and the team
maintains it; a second runtime would add build/review burden for a small service.

---

## 2. Technology stack (locked once approved)

- **Runtime:** Node.js 20 LTS (matches the package's `engines: ">=16"`; 20 is the current LTS).
- **HTTP framework:** Express 4.
- **Multipart upload:** `multer` (memory storage, single file field) for `POST /defectdojo/import`.
- **Outbound HTTP:** Node's built-in `fetch` (Node 18+) — no extra dependency, consistent with the lightweight `http`-module style already in `lib/sonarqube.js`.
- **Container base:** `node:20-alpine`, multi-stage, runs as a non-root user.
- **Config:** environment variables sourced from `onprem/.env` (same file `setup.sh` already uses).
- **Orchestration:** the existing Docker Compose + `devsecops-net` external network.

No database. The broker is stateless; all state (projects, users, engagements) lives in
SonarQube and DefectDojo.

---

## 3. Broker responsibilities and HTTP API

All endpoints accept and return JSON (except the import file field). Base path is `/`.
All responses use a consistent error envelope: `{ "error": { "code": "...", "message": "..." } }`.

### 3.0 Canonical project-key derivation (shared by all callers)

The broker trusts no caller to derive the key the same way. One canonical transform is
defined here and applied in **both** clients *and* re-applied server-side by the broker,
which is authoritative:

```
projectKey = name.toLowerCase().replace(/[^a-z0-9._:-]/g, '-')
```

This matches SonarQube's key charset (`[A-Za-z0-9_.:-]`, lowercased for stability) and
collapses the two divergent client transforms (the CLI's `/[^a-zA-Z0-9_\-.:]/g → '_'`
and the CI script's lowercase + `sed 's/[^a-z0-9._:-]/-/g'`) into one. Because the broker
normalizes whatever `projectKey` it receives before use, a laptop and CI that scan the
same repo always target the **same** SonarQube project even if a client lags on the
transform. `projectName` is kept human-readable (not normalized).

**Upgrade/migration note (changed CLI key).** The CI script already lowercases and maps to
`-`, so it is unaffected. The **CLI** changes: today `lib/sonarqube.js` preserves case and
maps disallowed chars to `_`, so a package named `My_App` currently lands on SonarQube key
`My_App`; under §3.0 it becomes `my_app`. For a **fresh** local setup this is irrelevant
(no prior project). For a repo that was already scanned under the old CLI key, the client
will target a new key, creating a second SonarQube project and leaving the old one's
history behind. This is accepted for fresh on-prem setups (the branch's target case). For
any pre-existing key, the documented remedy is a **one-time project rename in SonarQube**
(`POST /api/projects/update_key` from `My_App` to `my_app`) performed by an admin before
the first post-upgrade scan; this preserves history. See §13(4).

### 3.1 `POST /sonar/provision`

Moves the admin logic currently in `lib/sonarqube.js` server-side.

**Request body (JSON):**
```json
{ "projectKey": "my-app", "projectName": "My App", "gitEmail": "dev@creole.com", "consumerId": null }
```

- The **CLI** sends `gitEmail` (from `git config user.email`) and omits `consumerId`.
- **CI** sends `consumerId` (a stable caller identity, e.g. `"ci"` or the runner name) and omits `gitEmail` — SonarQube user setup is a laptop-only concern (see §3.1 step 3 and §4 identity). Both are optional; see the consumer-identity rule below and §7.

**Consumer identity (drives token naming, prevents cross-consumer clobber).** The broker
derives one stable `consumerId` per caller and uses it to name the minted token so that no
consumer ever revokes another consumer's live token (the fix for the multi-developer / dev
+ CI race). The effective identity is, in order: the request's `consumerId` if present,
else `gitEmail` if present, else the literal `"anon"`. The broker hashes it to a short,
non-reversible tag — `cid = sha256(identity).slice(0,12)` (12 hex chars) — so emails never
appear in SonarQube token names. Two laptops (distinct emails), and a laptop versus CI
(distinct `consumerId`), therefore map to distinct `cid` values and distinct token names.

**Behavior (all idempotent, using the server-side admin token):**
1. Normalize `projectKey` with the §3.0 transform (authoritative); compute `cid` from the consumer-identity rule above.
2. Ensure the SonarQube project exists (`POST /api/projects/create`); treat "already exists" as success. Force `visibility=private` (`POST /api/projects/update_visibility`). — same calls as `ensureProjectExists`.
3. If `gitEmail` is present and valid, ensure a SonarQube user exists for it (`POST /api/users/create`); on "already exists", leave the account alone. SonarQube **requires** a `password` for local-user creation (the current `ensureUserExists` supplies one for exactly this reason), so on create the broker **generates a random high-entropy password server-side** (e.g. 32 bytes base64url from a CSPRNG), submits it to `users/create`, and immediately discards it — it is **never returned to the caller and never logged**. Assign the per-project permissions (`user`, `codeviewer`, `scan`, `issueadmin`, `securityhotspotadmin`) via `POST /api/permissions/add_user`. **Drop `admin`** from the set that `assignUserToProject` currently grants — a developer does not need project-admin to scan or view, and least privilege is the whole point of this change. When `gitEmail` is absent (the CI case), skip this step entirely.
4. Before minting, **revoke only this consumer's prior token for this project** (see Token lifecycle below), then mint a **project-scoped analysis token** via `POST /api/user_tokens/generate` with `type=PROJECT_ANALYSIS_TOKEN` and `projectKey=<key>`, `name=cs-devtest-<projectKey>-<cid>`. This token can analyze only that project and cannot administer the server.

**Response (200):**
```json
{
  "hostUrl": "http://192.168.1.50:9000",
  "projectKey": "my-app",
  "scannerToken": "sqp_1a2b3c…",
  "dashboardUrl": "http://192.168.1.50:9000/dashboard?id=my-app"
}
```

`scannerToken` is a `PROJECT_ANALYSIS_TOKEN`, so SonarQube prefixes it `sqp_` (not the
`squ_` user-token prefix the admin token carries). The admin token is **never** returned.
The hardcoded `Creole@123456` login flow is removed. When the broker creates a user it
**sets a random password it never returns** (step 3 above) — no caller-visible credential
is produced. Dashboard login for developers is handled out of band (SonarQube "forgot
password" / admin-issued), which is acceptable on a LAN-only instance and avoids the broker
echoing passwords. (Alternative considered: have the broker **return** that generated
password so devs can log in immediately. Rejected for the first version — it reintroduces a
secret in the HTTP response and a password-reset concern; scanning only needs the scoped
token, so dashboard login is a separate, lower-priority concern.)

**Implementation note to validate:** a `PROJECT_ANALYSIS_TOKEN` must be able to run the
scan *and* poll `/api/ce/component` + `/api/qualitygates/project_status` for that project.
This is expected on SonarQube Community but must be confirmed during implementation; if a
project-analysis token cannot read those endpoints, fall back to a project-scoped user
token (`squ_`) with only the per-project `scan`+`user` permissions and update §9/§11's
leak assertions to the new value (they already assert on the *admin* token value, so no
change is needed there).

**Token lifecycle (consumer-scoped, bounded, self-pruning).** `POST /api/user_tokens/generate`
fails if a token of the same name already exists. Because the token name is now
deterministic per consumer — `cs-devtest-<projectKey>-<cid>` — the broker must clear the
caller's **own** previous token before re-minting, and must clear **only** that one. On each
provision it revokes the exact-named token (`POST /api/user_tokens/revoke`
`name=cs-devtest-<projectKey>-<cid>`; "not found" is treated as success), then generates the
fresh token under the same name. A `GET /api/user_tokens/search` fallback is used only if the
targeted revoke needs confirmation.

This is deliberately **not** a revoke-all: an earlier draft revoked every
`cs-devtest-<projectKey>-*` token on every provision, which kept one live token per project
globally. That premise ("a scan always re-provisions immediately before it runs") holds for
CI — `run-all-scans.sh` provisions in Step 1 right before the scanner — but is **false for
the CLI**, where `setupSonarProperties()` provisions at `init`/`check-hooks`/`sync` and the
pre-commit hook then reuses the stored token on later commits without re-provisioning (§6.3
adds no provision call). Under revoke-all, a second developer's `init`, or any CI run, would
revoke the first laptop's stored token, and that laptop's next commit would run
`sonar-scanner` with a revoked token → 401 → quality-gate step fails → commit blocked,
silently. Keying the token name on `cid` and revoking only the same name removes that race:
each consumer owns exactly one live token per project and never touches another's.

Net effect: at most one live broker-minted token **per consumer per project** (bounded —
there are only as many as there are active developers + CI identities on a repo), no manual
pruning, and the endpoint still returns a usable token every call. A fresh provision by the
same consumer rotates that consumer's own token and rewrites `sonar-project.properties`,
which is safe because the token is disposable and project-scoped.

### 3.2 `POST /defectdojo/import`

Moves the DefectDojo resolve/import logic currently in `run-all-scans.sh` server-side,
and eliminates the need for consumers to know product/engagement IDs. It handles **every**
scan type the CI script imports today (SonarQube SAST and OWASP ZAP DAST).

**Request (multipart/form-data):**
- `file` — the scan report (e.g. `sonarqube-report.json`, `zap-report.xml`), required.
- `repo` — repository name, required (used to resolve-or-create the product).
- `branch` — required.
- `commit` — required (short or full SHA).
- `scanType` — optional, default `"SonarQube Scan"`; must be in the allowlist (§7) which includes `"SonarQube Scan"` and `"ZAP Scan"`.
- `scanDate` — optional, default = server date.

**Behavior (server-side DefectDojo API key).** Today's `run-all-scans.sh` imports into a
**pre-existing** `DEFECTDOJO_ENGAGEMENT_ID`; it never creates products or engagements, so
there is no existing code to mirror and the create payloads must be specified here. Two
ways to get the product+engagement created on demand:

- **(a) manual GET-then-POST** — `GET /api/v2/products/?name=<repo>`, and if absent `POST /api/v2/products/`, then the same GET/POST on `/api/v2/engagements/`, then `POST /api/v2/import-scan/` with the resolved `engagement` id. This is three or more round-trips and each `POST` has several mandatory fields (`products`: `name`, `description`, `prod_type`; `engagements`: `name`, `product`, `target_start`, `target_end`, `engagement_type`, `status`), any of which returns `400` if omitted.
- **(b) CHOSEN — `import-scan` with `auto_create_context=true`.** `POST /api/v2/import-scan/` creates the product and engagement atomically if they do not exist, driven by name, in a single call.

**Chosen: option (b).** Fewer round-trips, fewer mandatory fields to get right, and
DefectDojo owns the create transactionally (no partial-create race). The import call sends:

```
POST /api/v2/import-scan/   (multipart, server-side API key)
  file                 = <uploaded report>
  scan_type            = <scanType>              # "SonarQube Scan" | "ZAP Scan"
  auto_create_context  = true
  product_name         = <repo>
  engagement_name      = <branch>
  product_type_name    = "cs-devtest"            # created if absent; see DD_PRODUCT_TYPE_NAME below
  scan_date            = <scanDate | server date>
  close_old_findings   = true
  minimum_severity     = "Low"
  tags                 = git-sha:<commit>, branch:<branch>, date:<scanDate>
```

`product_type_name` defaults to the literal `"cs-devtest"` (overridable via
`DD_PRODUCT_TYPE_NAME` in `onprem/.env`); with `auto_create_context=true` DefectDojo
creates the product type, product, and engagement by name if missing, so the broker does
not need to resolve or hardcode the numeric `prod_type` id (id `1` is **not** guaranteed on
every instance). `close_old_findings`, `minimum_severity`, and the tags match the
parameters the current script already sends; the engagement-per-branch model is unchanged
(§13(2)).

**Response (200):**
```json
{
  "productId": 12, "engagementId": 34, "importId": 56,
  "scanType": "SonarQube Scan",
  "findingsCount": 7, "severity": { "Critical": 0, "High": 1, "Medium": 3, "Low": 3 }
}
```

### 3.3 `GET /defectdojo/findings`

Replaces the CI script's Step-6 direct call to
`/api/v2/findings/?engagement=…` (which used the API key client-side). The broker
resolves the engagement server-side and returns the findings for the final report.

**Query:** `repo` (required), `branch` (required), `limit` (optional, default 500, max 500).
**Behavior:** resolve the product and engagement **by name** (`GET /api/v2/products/?name=<repo>` then `GET /api/v2/engagements/?product=<id>&name=<branch>`) — read-only, no create (the `/defectdojo/import` call already created them with `auto_create_context`); then `GET /api/v2/findings/?engagement=<id>&limit=<limit>` with the server-side key; return the DefectDojo findings JSON unchanged so the existing `generate-html.js` consumes it as before.
**Response (200):** the DefectDojo findings list JSON. **404** if no product/engagement exists for that repo/branch yet (e.g. findings fetched before any import).

### 3.4 `GET /healthz`

Liveness + upstream readiness. Returns `200 {"status":"ok","sonar":"up","defectdojo":"up"}`
when the broker can reach both; `503` with the same shape (values `"down"`) when an
upstream is unreachable. Used by `setup.sh` to wait for readiness and by LAN clients to
diagnose connectivity.

### 3.5 `GET /config`

Returns non-secret config so clients can discover the host without baking it in:
```json
{ "sonarHostUrl": "http://192.168.1.50:9000" }
```
Never returns tokens, passwords, or the DefectDojo URL/key.

---

## 4. Auth model — decision

This is the key open decision, and the context is **local/LAN-only**. Three options:

| Option | What the client holds | Pros | Cons |
|---|---|---|---|
| **(a) LAN trust + IP allowlist (firewall)** | **Nothing** | Zero secrets on laptops; reuses `firewall.sh` CIDR; simplest | A machine on the office subnet can call the broker; weak per-user identity |
| (b) Shared `BROKER_TOKEN` | One shared token | Simple bearer check | **Reintroduces a secret** on every laptop + CI — the exact sprawl we are removing |
| (c) mTLS | Client cert + key | Strong mutual auth | Cert issuance/rotation/distribution is heavy for a LAN tool; biggest operational cost |

### Recommendation: **(a) LAN trust + IP allowlist, enforced at the network/firewall layer.**

Reasoning: the stated goal is that **laptops store nothing to reach the broker**. Option
(b) directly contradicts that (it is the "one secret everywhere" pattern we are
eliminating), and option (c)'s certificate lifecycle is disproportionate for an office-LAN
service that is already firewalled. Option (a) achieves the goal and reuses machinery that
already exists: `onprem/firewall.sh` restricts the broker port to `LAN_CIDRS`, so only
machines on the office subnet can even open a connection.

**Where enforcement lives — one network layer, but it must be the layer Docker actually
honors.** The earlier draft added an in-broker Express middleware that re-checked the
client IP against a CIDR list "for defense in depth." That does not work with the broker's
networking: the broker runs on the `devsecops-net` Docker bridge and its port is published
(`8900:8900`), so inbound connections arrive with the **Docker gateway** source IP (e.g.
`172.17.0.1`), not the LAN client's `192.168.x.x`. A CIDR check in the app would therefore
reject every LAN client (`403`), or, if operators widened it to include the bridge range,
become a no-op. Host networking would preserve the real client IP but would break
service-name access to SonarQube on `devsecops-net`. So the access control stays at the
network layer — but there is a sharp caveat about **which** network layer.

**ufw alone does not filter Docker-published ports.** On a default Docker + ufw host,
Docker inserts its own `DNAT`/`FORWARD` rules in the `DOCKER`/`DOCKER-USER` iptables
chains, which are evaluated **before and independently of** ufw's `INPUT` chain. The
`ufw allow from <cidr> to any port 8900` line that `firewall.sh` adds does **not** restrict
a Docker-published port: any host that can route a packet to the machine on `:8900` would
reach the broker regardless of `LAN_CIDRS`. Since the broker holds the admin token and
DefectDojo API key and mints tokens, this is the one control protecting privileged
operations, so it must be enforced where Docker traffic is actually filtered. This same
latent gap already affects the published SonarQube `:9000` and DefectDojo `:8080`.

**Decision: enforce the LAN restriction in the `DOCKER-USER` iptables chain.** For the
broker port (and, closing the pre-existing gap, for `9000`/`8080`) a non-LAN source must be
dropped and LAN sources allowed — **but the DROP must apply only to external ingress, never
to inter-container bridge traffic.** `DOCKER-USER` is the first target in the `FORWARD`
chain and is evaluated for **all** forwarded packets, including the broker's own
container-to-container calls: broker → SonarQube (`http://sonarqube:9000`, source a Docker
bridge `172.x` address, dest port 9000) and broker → DefectDojo (DNAT'd
`host.docker.internal:8080`, source `172.x`, dest port 8080). A rule that matched only
destination port + LAN source CIDR would drop these too — the broker's `172.x` bridge source
matches none of the LAN RETURNs and falls through to the DROP — severing the broker from the
very services it proxies. To prevent that, a **RETURN for the Docker bridge range
(`172.16.0.0/12`, covering `devsecops-net` and the default bridge) is inserted above the
DROP**, so intra-stack traffic is always allowed and only external ingress ever reaches the
DROP.

**Rule order is the trap here.** `iptables -I` inserts at
the *head* of the chain, so the **last** rule inserted is evaluated **first**. The DROP must
therefore be inserted **first** (so it ends up at the bottom of our managed block), and each
RETURN (bridge range + each LAN CIDR) inserted **after** it (so each lands above the DROP).
Using `-A` to append the
DROP is also wrong: Docker seeds `DOCKER-USER` with a trailing `-j RETURN`, after which an
appended DROP never fires. The correct sequence, per port:

```
# managed with an identifying comment so re-runs can delete-by-match (idempotency)
TAG="cs-devtest-broker"
BRIDGE_CIDR="172.16.0.0/12"   # Docker bridge range: devsecops-net + the default bridge
# 1) DROP first -> ends up at the BOTTOM of our rules (only external ingress reaches it)
iptables -I DOCKER-USER -p tcp --dport 8900 -m comment --comment "$TAG" -j DROP
# 2) RETURN for the Docker bridge range -> lands ABOVE the DROP so the broker's OWN
#    container-origin traffic to SonarQube/DefectDojo is never dropped
iptables -I DOCKER-USER -p tcp --dport 8900 -s "$BRIDGE_CIDR" -m comment --comment "$TAG" -j RETURN
# 3) one RETURN per LAN CIDR -> each lands ABOVE the DROP
for cidr in "${LAN_CIDRS[@]}"; do
  iptables -I DOCKER-USER -p tcp --dport 8900 -s "$cidr" -m comment --comment "$TAG" -j RETURN
done
```

Resulting evaluation order on `8900`: `RETURN(172.16.0.0/12)`, `RETURN(cidr…)`, then `DROP`
— the broker's own bridge-sourced upstream calls and LAN clients are allowed, every other
(external) source is dropped. (DNAT does not rewrite the source, so a real LAN client to
`8900`/`9000`/`8080` still carries its `192.168.x` source and hits a LAN RETURN; only
external, non-LAN, non-bridge sources fall through to the DROP.) The same corrected ordering
and the bridge RETURN are applied to `9000`/`8080` and to the `ip6tables` equivalents (with
the IPv6 LAN CIDRs and the IPv6 bridge range Docker assigns, e.g. a ULA under `fd00::/8`) if
IPv6 is in use. `DOCKER-USER` is evaluated for
Docker-routed traffic and is not flushed by Docker on restart, so the rule is durable. (An
acceptable alternative, if the external interface is stable, is to scope the DROP itself to
the WAN interface — `-i "$WAN_IF" … -j DROP` — instead of adding the bridge RETURN; the
bridge-RETURN form is chosen as the default because it does not depend on detecting the
external interface name.) The
run-order and idempotency mechanics (chain-presence, delete-by-match flush, where this block
runs relative to the Docker install) are specified in §6.1.

Two alternatives were considered and are acceptable substitutes if the team prefers them —
**bind the published port to the LAN interface** (`ports: ["${LAN_IP}:8900:8900"]`, requires
the host not to expose other routable interfaces) or **adopt `ufw-docker`**
(`ufw-docker allow 8900`, which lands the rule in `DOCKER-USER` for you). The `DOCKER-USER`
approach is chosen as the default because it reuses the existing `LAN_CIDRS` concept, needs
no extra tool, and simultaneously fixes the `9000`/`8080` exposure. The broker does **not**
perform an application-layer IP allowlist (its container cannot see real client IPs); the
`DOCKER-USER` rule is the sole, and now effective, network access control.

**Identity (non-secret claim):** the **CLI** passes the developer's **git email** as
`gitEmail` (from `git config user.email`); **CI** omits `gitEmail` and instead passes a
`consumerId` (a stable caller identity, e.g. `"ci"` or the runner name). Neither is an
authentication secret — `gitEmail` is an *attribution* claim that decides which SonarQube
user/permissions get set up (a laptop-only concern; CI does not create per-commit SonarQube
users), and `consumerId`/`gitEmail` together scope the minted scanner token so consumers do
not clobber each other (§3.1). The CI choice to omit `gitEmail` is deliberate:
`git config user.email` is frequently unset on a self-hosted runner, and CI has no need to
provision a SonarQube login. The broker treats both as untrusted input and validates them
(see §7); when `gitEmail` is absent it simply skips user setup.

**Explicit tradeoff to document for users:** on a trusted LAN this means any host on the
office subnet can call the broker. That is acceptable for an internal DevSecOps stack
behind the office firewall; it is **not** suitable for exposing the broker to the public
internet. If the threat model later requires per-user auth, option (b) or (c) can be
layered on without changing the API shape (add an `Authorization` header check in a
single middleware).

**CI caveat (unavoidable, state it plainly):** GitHub's `ubuntu-latest` cloud runners
live on the public internet and **cannot reach** `http://192.168.x.x:8900`. For the CI
half of this design, the `run-scans` job must run on a **self-hosted GitHub Actions
runner inside the office LAN**. This is the same reachability constraint that applies to
the LAN SonarQube/DefectDojo servers themselves — the broker does not add a new problem,
it inherits the existing one. The workflow change in §6 reflects this.

---

## 5. How the broker obtains its own secrets

The broker reads its privileged credentials from `onprem/.env` — the same file
`setup.sh` already sources — so nothing new is committed and the operator fills one file.

**SonarQube admin token.** `onprem/.env` already carries `SONARQUBE_ADMIN_PASSWORD`. Two
ways to get an admin token from it:
- **Chosen:** at **startup**, the broker authenticates as `admin:$SONARQUBE_ADMIN_PASSWORD` and mints its own admin **user token** via `POST /api/user_tokens/generate` (`name=cs-devtest-broker`), holding it in memory for the process lifetime. If a token named `cs-devtest-broker` already exists, the broker revokes it (`POST /api/user_tokens/revoke`) and re-mints, so restarts are clean.
- Alternative: store a long-lived `SONAR_ADMIN_TOKEN` in `onprem/.env`. Rejected as the default because it is a second long-lived secret to manage and rotate; deriving it from the password the operator already sets keeps `.env` minimal. The broker still **honors** `SONAR_ADMIN_TOKEN` if present (skip the mint step) — useful if the operator prefers token-only and never stores the admin password.

**Startup readiness vs. fatal auth (resolves the ordering problem).** In `setup.sh`,
`docker compose … up -d` runs in section 5 *before* section 5.1 changes the admin
password from `admin/admin` to `SONARQUBE_ADMIN_PASSWORD`. If the broker started with the
rest of the stack it would try to authenticate before SonarQube is even UP or before the
password exists, and (with `restart: always`) crash-loop. Two mechanisms together fix
this:
1. **The broker is started explicitly, after bootstrap** — see §6.1 (`profiles` + an explicit `docker compose up -d broker` step in `setup.sh` after section 5.1 completes).
2. **Startup admin-auth retries with backoff**, treating "SonarQube not UP yet" and "auth not valid yet" as *retryable* for a bounded window (e.g. 10 attempts, 10s apart). It becomes **fatal** (non-zero exit) only after SonarQube reports UP *and* the configured password is genuinely rejected — a real misconfiguration the operator must fix. This keeps the broker robust even if an operator later runs a plain `up -d`.

**DefectDojo API key.** DefectDojo generates its admin password on first boot, which is
awkward for an unattended broker. To make it deterministic the canonical variable names
are **`DD_ADMIN_USER` / `DD_ADMIN_PASSWORD`** (the exact names the DefectDojo initializer
expects), used end to end:
- `setup.sh` appends `DD_ADMIN_USER` / `DD_ADMIN_PASSWORD` (from `onprem/.env`) to the generated `onprem/defectdojo.env`, so the initializer sets a known admin password on first boot.
- At startup the broker calls `POST /api/v2/api-token-auth/` with those same credentials to obtain the API key, holding it in memory. The DefectDojo token-auth is retried lazily (see §8) so the broker can start before DefectDojo is fully up.
- Alternative/fallback: if `DEFECTDOJO_API_KEY` is already set in `onprem/.env`, the broker uses it directly and skips the token-auth call.
- **Caveat:** `DD_ADMIN_PASSWORD` only sets the password on a **fresh** DefectDojo initialization. On an already-initialized instance the operator must either reset the admin password to match, or set `DEFECTDOJO_API_KEY` directly in `onprem/.env`. `setup.sh` prints this note.

**New `onprem/.env` keys** (added to `.env.example`, placeholders only, never committed):
```
# Broker — reaches the stack server-side on behalf of clients.
# Canonical DefectDojo admin creds (same names the DefectDojo initializer reads):
DD_ADMIN_USER=admin
DD_ADMIN_PASSWORD=change-me-strong-password
# DefectDojo product type the broker creates products under (auto-created if absent):
DD_PRODUCT_TYPE_NAME=cs-devtest
# Optional overrides (skip the startup derivation if set):
# SONAR_ADMIN_TOKEN=
# DEFECTDOJO_API_KEY=
# Internal URLs the broker uses to reach each service (defaults shown):
SONAR_INTERNAL_URL=http://sonarqube:9000
DEFECTDOJO_URL=http://host.docker.internal:8080
# Public SonarQube URL returned to clients in /sonar/provision + /config:
SONAR_PUBLIC_URL=http://192.168.1.50:9000
```

`.gitignore` already ignores `onprem/.env` and `onprem/defectdojo.env`, so no secret is
committed. Startup fails fast (non-zero exit, logged error) if neither a usable admin
password nor an explicit token is present for SonarQube; DefectDojo credential problems
degrade to `503` on the `/defectdojo/*` routes rather than blocking startup (§8).

**Reaching the two services from the container.** SonarQube is on `devsecops-net`, so the
broker reaches it by service name at `http://sonarqube:9000` (`SONAR_INTERNAL_URL`).
DefectDojo runs under its **own** upstream compose/network (per `LOCAL_SETUP.md`), so the
broker reaches it over the host's published `:8080` via `host.docker.internal` (enabled
with `extra_hosts: ["host.docker.internal:host-gateway"]` in compose). This avoids
coupling the broker to DefectDojo's internal network, which the on-prem setup
deliberately keeps upstream-managed.

---

## 6. Deployment and the exact client/CI changes

### 6.1 New files and infra changes (server side)

- **`onprem/broker/`** — the service: `server.js`, `package.json`, `Dockerfile` (multi-stage `node:20-alpine`, non-root), and route modules (`sonar.js`, `defectdojo.js`). No secrets in any layer.
- **`onprem/docker-compose.yml`** — add a `broker` service: `build: ./broker`, `restart: always`, `ports: ["8900:8900"]`, `networks: [devsecops-net]`, `env_file: [./.env]`, `extra_hosts: ["host.docker.internal:host-gateway"]`, `depends_on: [sonarqube]`, and **`profiles: ["broker"]`**. The profile keeps the broker *out* of the generic section-5 `docker compose up -d` (which starts SonarQube before the admin password exists) so it only comes up when explicitly requested. The published `8900` is confined to the LAN by the `DOCKER-USER` rule in `firewall.sh`, not by the compose publish itself (§4); if the team prefers the interface-bind alternative instead, this becomes `ports: ["${LAN_IP}:8900:8900"]`.
- **`onprem/firewall.sh`** — one change only: add `8900` to `SERVICE_PORTS` (comment it as the broker port). **This ufw entry does not itself restrict the broker:** as §4 establishes, ufw's `INPUT` chain does not filter Docker-published ports, so the `8900` ufw rule never applies to the published broker port. It is kept only for consistency with the other `SERVICE_PORTS` entries, for documentation, and to cover any future non-Docker listener on `8900`; the effective broker access control is the `DOCKER-USER` rule applied by `setup.sh` section 4.1. **The `DOCKER-USER` rules do *not* live here.** `firewall.sh` is documented to run *before* `setup.sh` (LOCAL_SETUP step 4 → step 5), and `setup.sh` is what installs Docker (§4 of that script); the `DOCKER-USER` chain is created by the Docker daemon, so on a not-yet-Docker host `iptables -I DOCKER-USER …` fails with "No chain/target/match by that name" and, under `set -euo pipefail`, aborts `firewall.sh`. The effective Docker-layer control therefore moves into `setup.sh` (next bullet, new section 4.1), after Docker is installed. `firewall.sh` keeps only the ufw `INPUT` rules and stays runnable before Docker exists.
- **`onprem/setup.sh`** — five edits:
  0. **New section 4.1 (immediately after section 4, Docker install) — the `DOCKER-USER` LAN restriction.** This is where the Docker-layer rules from §4 run, because the `DOCKER-USER` chain only exists once the Docker daemon is installed. The block: (a) ensures the chain exists — `iptables -nL DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER`; (b) **flushes its own managed rules first (idempotency)** by delete-by-match on the identifying comment, in a loop, for each port — the DROP: `while iptables -D DOCKER-USER -p tcp --dport "$port" -m comment --comment "cs-devtest-broker" -j DROP 2>/dev/null; do :; done`, the bridge RETURN: `while iptables -D DOCKER-USER -p tcp --dport "$port" -s 172.16.0.0/12 -m comment --comment "cs-devtest-broker" -j RETURN 2>/dev/null; do :; done`, plus the matching per-LAN-CIDR RETURN-delete loop — so re-running `setup.sh` never stacks or reorders duplicates; (c) re-inserts in the §4 order (**DROP first, then the `172.16.0.0/12` bridge RETURN, then one RETURN per `LAN_CIDRS` entry**) for ports `8900`, `9000`, `8080`, tagging every rule `-m comment --comment "cs-devtest-broker"` — the bridge RETURN keeps the broker's own container-origin traffic to SonarQube/DefectDojo from being dropped (Finding 1); (d) repeats with `ip6tables` when IPv6 is enabled, using the IPv6 LAN CIDRs and the IPv6 bridge range Docker assigns. `LAN_CIDRS` is read from the same definition `firewall.sh` uses (sourced or duplicated with a comment pointing at `firewall.sh` as the single source of truth). This section is guarded to run on every invocation (the flush makes it safe) rather than skipped, so a changed `LAN_CIDRS` is re-applied.
  1. In the DefectDojo `defectdojo.env` generation block (currently guarded by `if [ ! -f "${DD_ENV}" ]`, writing only the three `DD_*` crypto values), **also append** `DD_ADMIN_USER=${DD_ADMIN_USER}` and `DD_ADMIN_PASSWORD=${DD_ADMIN_PASSWORD}` so the initializer sets a known admin password on first boot (print the "fresh-init only" caveat from §5).
  2. **Make the SonarQube admin password fatal when unset.** Line 42 today is `SONARQUBE_ADMIN_PASSWORD="${SONARQUBE_ADMIN_PASSWORD:-Creole@123456}"`, which silently falls back to the publicly-known default — the same credential the broker derives its admin token from. Replace it with a guard: if `SONARQUBE_ADMIN_PASSWORD` is unset/empty, `echo` an error naming `onprem/.env` and `exit 1` (the script already requires `.env` to exist, so this is consistent). This removes the last hardcoded credential on the server side.
  3. **After** section 5.1 (quality-gate bootstrap) and section 6 (DefectDojo up) complete, start the broker explicitly: `docker compose -f "${SCRIPT_DIR}/docker-compose.yml" --profile broker up -d broker`.
  4. Add a **bounded readiness wait** on `GET http://localhost:8900/healthz` that waits for the broker to be *listening*, not for upstreams to be ready: treat **any** HTTP response (`200` **or** `503`) within N seconds (e.g. 60s) as ready, since `/healthz` returns `503` until both SonarQube and DefectDojo are reachable and DefectDojo initialization takes minutes (§3.4, §8). Print the `sonar`/`defectdojo` sub-statuses as informational and note that `defectdojo:"down"` right after boot is **expected** and self-heals via the broker's lazy re-auth (§8). Only "no HTTP response at all within N seconds" is an error. Print the broker URL in the final summary.
- **`onprem/.env.example`** — add the keys listed in §5.
- **`onprem/LOCAL_SETUP.md`** — document (a) the new broker service and its port `8900`; (b) that the run order is unchanged — `firewall.sh` (ufw, now including `8900`) still runs before `setup.sh`, and the Docker-layer `DOCKER-USER` LAN rules are applied **by `setup.sh` section 4.1 after Docker is installed** (so no step tries to touch `DOCKER-USER` before Docker exists); (c) the `devsecops.lan` → server LAN IP `/etc/hosts`/DNS entry that clients need for `CS_DEVTEST_BROKER_URL` (§6.2, §13(3)); (d) the new `onprem/.env` keys from §5; and (e) a one-line prerequisite note that the self-hosted LAN runner for the `run-scans` job must have Docker, Node.js ≥ 18, and `jq` installed (§6.5).

### 6.2 `lib/sonarqube.js` (client)

- **Remove** the three hardcoded constants `DEFAULT_SONAR_HOST` (the `34.100.239.232` IP), `DEFAULT_SONAR_TOKEN` (the `squ_…` admin token), and `DEFAULT_SONAR_PASSWORD` (`Creole@123456`).
- **Remove** the client-side admin operations and their only helpers: `ensureProjectExists`, `ensureUserExists`, `changeUserPassword`, `assignUserToProject`, `sonarRequest`, **and `getUsernameFromEmail`** (dead once `ensureUserExists` is gone). Keep `getGitEmail()` and `setupSonarProperties()`; keep `installSonarScanner` (still used elsewhere).
- **Add** `CS_DEVTEST_BROKER_URL` (non-secret) with a shipped default of **`http://devsecops.lan:8900`** — a hostname, not an IP, so we do not re-bake an address (the original problem). The LOCAL_SETUP docs instruct operators to add a DNS or `/etc/hosts` entry mapping `devsecops.lan` to the server's LAN IP; any machine can override with the env var. (Decision for v1: hostname + documented `/etc/hosts` fallback — see §13.)
- `setupSonarProperties()` becomes: derive `projectKey` (via the §3.0 transform) / `projectName` from `package.json` and `gitEmail` from git; `POST {brokerUrl}/sonar/provision`; on success write `sonar-project.properties` with the returned `hostUrl` and `scannerToken` as **`sonar.token=<scannerToken>`**, plus `sonar.projectKey`, `sonar.projectName`, and the existing excludes; print the returned `dashboardUrl` only (no username/password). Also append `sonar-project.properties` to the project's `.gitignore` idempotently (see §9).
- **Graceful degradation:** if `CS_DEVTEST_BROKER_URL` is unset/unreachable or the broker returns non-2xx, log one clear warning and write `sonar-project.properties` **with an empty `sonar.token=`** (and no host). The pre-commit hook's skip-check is updated in the same change (§6.3) to key on `sonar.token`, so an offline laptop degrades to "no scan" instead of a blocked commit. Never throw out of `setupSonarProperties()`.

### 6.3 `lib/hooks.js` (client)

Two coordinated changes in `buildHookScript`:
- **Fix the skip-check (the degradation contract).** The current hook greps `^sonar.login=` (REPLACE_WITH_YOUR_TOKEN or empty). Since the client now writes `sonar.token`, change the skip to key on that field:
  ```sh
  if ! grep -qE '^sonar\.token=.+' sonar-project.properties; then
    echo "[SonarQube] Token is missing — skipping scan."
  ```
  This makes the empty-token (broker-down) case skip the scan rather than run `sonar-scanner` with no token and block the commit. Without this edit, the §6.2 degradation path is broken.
- **Remove both printed `Password: Creole@123456` lines** (the quality-gate-failed block and the quality-gate-passed block). Replace the three-line `URL/Username/Password` block with the dashboard URL line only. No credential is printed by the hook anymore.

### 6.4 `templates/github-template/scripts/run-all-scans.sh` (CI)

- **Remove from the `REQUIRED` array:** `SONAR_HOST_URL`, `SONAR_TOKEN`, `DEFECTDOJO_URL`, `DEFECTDOJO_API_KEY`, `DEFECTDOJO_ENGAGEMENT_ID`, `DEFECTDOJO_PRODUCT_ID`. Keep `GIT_SHA`, `GIT_BRANCH`, `RUN_DATE`. **Add** `CS_DEVTEST_BROKER_URL` (non-secret) **and `GIT_REPO`** — the repository identity the broker needs to resolve-or-create the DefectDojo product (§3.2/§3.3). `GIT_REPO` is sourced in the workflow from the GitHub Actions built-in `GITHUB_REPOSITORY` (owner/repo), wired through the `env:` block in §6.5; `run-all-scans.sh` only reads it from the environment, so it must be in `REQUIRED` alongside `GIT_SHA`/`GIT_BRANCH`/`RUN_DATE`/`CS_DEVTEST_BROKER_URL`. `SONAR_HOST_URL` is removed too — the host now comes from the broker's `/sonar/provision` response (`hostUrl`).
- **Remove from the "trim secrets" / URL-normalize blocks** every one of those six variables, including the `SONAR_HOST_URL` and `DEFECTDOJO_URL` `http://`-normalization lines. The script must not reference them at all.
- **Step 1 (Sonar):** `POST {CS_DEVTEST_BROKER_URL}/sonar/provision` with JSON `{projectKey` (via §3.0)`, projectName, consumerId}`. CI sends **`consumerId`** (the runner identity, e.g. `"ci-${RUNNER_NAME}"` or a fixed `"ci"`) and **omits `gitEmail`** — CI does not provision SonarQube users (§3.1 step 3, §4 identity); `consumerId` only scopes the minted token so CI never clobbers a laptop's token (§3.1 token lifecycle). The `projectName`/`projectKey` continue to derive from `package.json` as today, which keeps the SonarQube project name aligned with the DefectDojo product name the broker derives from `GIT_REPO` (§3.2) so the two stay predictable; `GIT_REPO` may also be used as the `consumerId` basis if a stable per-repo CI identity is wanted. Use `hostUrl` + `scannerToken` from the response; run `sonar-scanner` with `-Dsonar.host.url=<hostUrl> -Dsonar.token=<scannerToken>`. Drop the client-side project-search/create curls (the broker does that). Poll the CE task / quality gate using the scoped token as today.
- **Step 5 (DefectDojo import — both reports):** replace **both** `do_import` calls that used `DEFECTDOJO_*` with `POST {CS_DEVTEST_BROKER_URL}/defectdojo/import` multipart uploads:
  - `sonarqube-report.json` with `scanType="SonarQube Scan"`,
  - `zap-report.xml` with `scanType="ZAP Scan"`,
  each sending `repo="${GIT_REPO}"`, `branch="${GIT_BRANCH}"`, `commit="${GIT_SHA}"`. Use the broker JSON responses for the import summary/counts. Product/engagement IDs are resolved server-side, so the script no longer references `DEFECTDOJO_ENGAGEMENT_ID`/`DEFECTDOJO_PRODUCT_ID`.
- **Step 6 (final report fetch):** replace the direct `GET {DEFECTDOJO_URL}/api/v2/findings/?engagement=…` (which used `DEFECTDOJO_API_KEY`) with `GET {CS_DEVTEST_BROKER_URL}/defectdojo/findings?repo=${GIT_REPO}&branch=${GIT_BRANCH}&limit=500` (URL-encoding `GIT_REPO`, since an owner-qualified name contains `/`). The broker returns the same findings JSON shape, so `generate-html.js` is unchanged. Keep the existing raw-bundle fallback when the broker is unreachable.
- The DefectDojo/SonarQube reachability pre-checks that used the removed URLs become **one advisory, non-fatal** `GET {CS_DEVTEST_BROKER_URL}/healthz` call. It must **not** `exit 1` on a `503` (that would regress today's graceful paths): `/healthz` returns `503` whenever *either* upstream is down (§3.4), so the script logs the JSON and **branches on the per-field status** — `sonar:"down"` ⇒ skip the SAST stage (matching today's soft SonarQube handling), `defectdojo:"down"` ⇒ still run SAST and fall back to bundling the raw reports at import/findings time (matching today's `DOJO_IMPORT_FAILED`). The only hard failure is the broker being entirely unreachable (no HTTP response), which skips SAST and bundles raw reports per §8. This keeps §6.4 consistent with §8 and §10.2.

### 6.5 `templates/github-template/workflows/security-pipeline.yml` (CI)

- In the `run-scans` job `env:` block, **remove** these six secret references: `SONAR_HOST_URL`, `SONAR_TOKEN`, `DEFECTDOJO_URL`, `DEFECTDOJO_API_KEY`, `DEFECTDOJO_ENGAGEMENT_ID`, `DEFECTDOJO_PRODUCT_ID`. (Leave `POSTMAN_API_KEY` and `COLLECTION_UID` — they are the consumer's own Newman/Postman secrets, not cs-devtest DevSecOps secrets.)
- **Add** `CS_DEVTEST_BROKER_URL` as a **repo/org variable** (not a secret) **and wire it into the `run-scans` job `env:` block** so the script can read it: `CS_DEVTEST_BROKER_URL: ${{ vars.CS_DEVTEST_BROKER_URL }}`. Declaring the variable alone is not enough — `run-all-scans.sh` reads it from the environment (§6.4 validates it in `REQUIRED`), and the workflow only exposes variables the `env:` block maps. Add this line in the same edit that removes the six secret lines.
- **Add** `GIT_REPO: ${{ github.repository }}` to the same `run-scans` `env:` block (the `github.repository` context is the GitHub Actions built-in `GITHUB_REPOSITORY`, in `owner/repo` form — the `/` is permitted by the §7 `repo` regex). This is the repository identity the broker uses to resolve-or-create the DefectDojo product on `/defectdojo/import` and `/defectdojo/findings` (Finding 2); it is non-secret. Like `GIT_SHA`/`GIT_BRANCH`, it is a plain workflow value, not a secret or a `vars.*` entry. Add it in the same edit as the removals so `run-all-scans.sh`'s `REQUIRED` check (§6.4) is satisfied.
- Change `runs-on: ubuntu-latest` on the **`run-scans`** job to a self-hosted LAN runner, e.g. `runs-on: [self-hosted, lan]`. The other jobs (`prepare`, `collect-report`, `cleanup`) stay on `ubuntu-latest` since they do not touch the LAN stack. **Runner prerequisites:** unlike `ubuntu-latest`, a self-hosted LAN runner is not guaranteed to ship the tools `run-scans` needs — it must have **Docker** (ZAP baseline via `docker run`), **Node.js ≥ 18** (sonar-scanner, `generate-html.js`), and **`jq`** installed. Note this in `LOCAL_SETUP.md` (§6.1) so whoever provisions the runner installs them; the `prepare` job's environment check still runs on `ubuntu-latest` and does not validate the self-hosted box.
- Update the `collect-report` job-summary line `| Scans | SonarQube SAST |` to reflect what the job actually runs: `| Scans | SonarQube SAST, Newman API, OWASP ZAP DAST |`.

### 6.6 GitHub Secrets removed (the deliverable list)

After this change a consuming repo removes these cs-devtest DevSecOps secrets entirely:

1. `SONAR_HOST_URL`
2. `SONAR_TOKEN`
3. `DEFECTDOJO_URL`
4. `DEFECTDOJO_API_KEY`
5. `DEFECTDOJO_ENGAGEMENT_ID`
6. `DEFECTDOJO_PRODUCT_ID`

**Net new GitHub secrets required: none.** `CS_DEVTEST_BROKER_URL` is non-secret (a LAN
URL) and belongs in a repo/org **variable**, not Secrets.

> Out of scope but noted so the "zero secrets" claim is precise: `POSTMAN_API_KEY`,
> `COLLECTION_UID`, and the `GRAFANA_*` values are the consumer's own third-party SaaS
> credentials, not cs-devtest DevSecOps stack secrets. The broker does not manage them and
> this design does not remove them.

---

## 7. Input validation (per external input)

The broker treats every client input as untrusted. On any validation failure it returns
`400` with the error envelope and logs at `warn` (no body contents logged beyond field
names). Rules:

- **`projectKey`** — required, string, 1–400 chars; normalized with the §3.0 transform; after normalization must match `^[a-z0-9._:-]+$` and contain at least one non-digit (SonarQube's constraint). Reject otherwise.
- **`projectName`** — required, string, 1–255 chars. Trim; reject empty.
- **`gitEmail`** — optional, string, must match a basic email regex and be ≤254 chars. If absent, skip user/permission setup (the CI case). If present but malformed, skip user/permission setup (do **not** fail the whole provision) and note it in the response (`userSetup: "skipped: invalid email"`).
- **`consumerId`** — optional, string, ≤128 chars, regex `^[A-Za-z0-9._@:-]+$`. Trim; reject oversize/illegal chars with `400`. Used only to derive the token-naming `cid` (§3.1); never used for authentication. When absent the broker falls back to `gitEmail`, then to the literal `"anon"`.
- **`repo`** — required, string, 1–255 chars, regex `^[A-Za-z0-9._/-]+$`.
- **`branch`** — required, string, 1–255 chars.
- **`commit`** — required, hex `^[0-9a-f]{7,40}$`.
- **`scanType`** — optional; must be one of the allowlist `{"SonarQube Scan", "ZAP Scan"}` (default `"SonarQube Scan"`). Reject unknown types with `400`.
- **`scanDate`** — optional ISO `YYYY-MM-DD`; default server date.
- **`limit`** (findings query) — optional integer 1–500; default 500; clamp out-of-range.
- **`file`** (multipart) — required; max size **20 MB** (`multer` limit); reject missing file (`400`) or oversize (`413`). Content is passed straight to DefectDojo, which validates the format.

---

## 8. Error handling (per operation that can fail)

| Operation | Failure condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| Broker startup: Sonar admin auth / token mint | SonarQube not UP yet, or auth not valid yet | **Retryable** — backoff (10×, 10s) treating "not ready" as transient | n/a (not serving yet) | `info` per retry |
| Broker startup: Sonar admin auth | SonarQube UP but password genuinely rejected, or no password/token at all | **Fatal** — exit non-zero so the operator fixes `.env` | n/a | `error` |
| Broker startup: DefectDojo token-auth | Bad admin creds, DD down | **Non-fatal** — broker starts and serves `/sonar/*`; `/defectdojo/*` returns `503` and re-auths lazily on next request | n/a | `error` once, then `warn` on retry |
| `/sonar/provision` → project create | Sonar non-2xx (not "already exists") | Recoverable (retry) | `502 {error: sonar_unavailable}` | `warn` |
| `/sonar/provision` → user/permission | Sonar non-2xx | Partial — project + token still returned; `userSetup` flag notes the failure | `200` with `userSetup: "failed"` | `warn` |
| `/sonar/provision` → token mint | Sonar non-2xx; or name collision because the prior same-named `cs-devtest-<key>-<cid>` token revoke did not clear it | Recoverable — the revoke-then-mint on the deterministic name is retried once (revoke, then generate), then fail | `502` on repeated failure | `warn` |
| `/defectdojo/import` or `/defectdojo/findings` → resolve/create product or engagement | DD non-2xx | Recoverable | `502 {error: defectdojo_unavailable}` | `warn` |
| `/defectdojo/import` → import-scan | DD rejects file / 4xx | Not recoverable for this request (bad report) | `422 {error: import_rejected, detail}` | `warn` |
| `/defectdojo/findings` → no engagement yet | Product/engagement not created | n/a | `404 {error: not_found}` | `info` |
| `/defectdojo/*` while DD credential unresolved | DD token-auth still failing | Recoverable later | `503 {error: defectdojo_unconfigured}` | `warn` |
| Any endpoint: validation | See §7 | n/a | `400` (or `413` oversize) | `warn` |
| Upstream network timeout (Sonar/DD) | Connect/read timeout (default 15s) | Recoverable | `504 {error: upstream_timeout}` | `warn` |

Network access control is **not** an application-layer concern (see §4): the broker does
not return `403` for off-LAN callers — the firewall drops those connections before they
reach the service.

Secrets (admin token, API key, admin password) are **never** written to logs or returned
in any response or error body. Startup errors log the *fact* of a missing/invalid
credential, not its value.

**Client-side (`cs-devtest`) error handling:** broker unreachable or non-2xx →
one `warn` line, degrade gracefully (write `sonar.token=` empty; the updated hook skips the
scan). CI script: a broker failure on `/sonar/provision` skips SAST (matching today's
"SonarQube not reachable → skip"); a failure on `/defectdojo/import` or
`/defectdojo/findings` bundles the raw reports as the final artifact (matching today's
`DOJO_IMPORT_FAILED` fallback).

---

## 9. Invariants and which layer owns each

- **The SonarQube admin token and DefectDojo API key never leave the server.** Owned by the **broker layer**: no route serializes them; the only token a response ever contains is the project-scoped scanner token. Enforced in code + covered by a unit test asserting response bodies never contain the **exact in-memory admin-token string or DefectDojo API-key string** (not a prefix match — a prefix test would wrongly flag the `sqp_` scanner token the response legitimately returns).
- **Only LAN clients can reach the broker from outside the stack.** Owned by the **network/firewall layer**, specifically the **`DOCKER-USER` iptables rules** added by `setup.sh` section 4.1 (after Docker is installed — §6.1). The control restricts **external ingress** only: it permits `LAN_CIDRS` and the Docker bridge range (`172.16.0.0/12`) and drops all other sources on ports 8900/9000/8080 (§4). The bridge RETURN is load-bearing — it leaves the broker's own intra-stack traffic to SonarQube (`sonarqube:9000`) and DefectDojo (`host.docker.internal:8080`) intact; without it the DROP would also sever the broker from its upstreams (Finding 1). These rules cannot live in `firewall.sh` because it runs before Docker exists (§6.1). A plain `ufw allow` rule is *not* sufficient here because ufw does not filter Docker-published ports; the `DOCKER-USER` chain is the layer Docker actually honors, with the DROP ordered below the bridge RETURN and the per-CIDR RETURNs (§4). The broker deliberately does not duplicate this in code because its container networking does not see real client IPs (§4); claiming an app-layer check would be false assurance.
- **Scanner tokens are project-scoped.** Owned by the **broker layer** via `type=PROJECT_ANALYSIS_TOKEN`; a leaked scanner token cannot administer the server or touch other projects.
- **No *privileged* secret is committed, and the scoped token on a laptop is not committable.** Owned by the **repo/tooling layer**:
  - `.gitignore` already covers `onprem/.env` and `onprem/defectdojo.env`, and the published package no longer contains the hardcoded admin token/password.
  - The one credential written on a laptop — the project-scoped scanner token in `sonar-project.properties` — is intentionally disposable, but it must still not be committed. Note that `sonar-project.properties` is on the hook-written `.gitleaksignore` and is **not** in `.gitignore`, so Gitleaks will *not* catch a token there. The fix is to prevent the file from being staged at all: `setupSonarProperties()` appends `sonar-project.properties` to the consuming project's `.gitignore` (idempotently) when it writes the file. The invariant here is "the scoped token is never committed," owned by the client writing `.gitignore`, **not** by Gitleaks.

---

## 10. Sequence flows

### 10.1 Local CLI flow (developer laptop)

1. Developer runs `npx cs-devtest init` (or `check-hooks` / `sync`), which calls `setupSonarProperties()`.
2. CLI reads `projectKey` (via §3.0) / `projectName` from `package.json` and `gitEmail` from `git config user.email`.
3. CLI `POST {CS_DEVTEST_BROKER_URL}/sonar/provision` with those non-secret fields (no `consumerId` — the broker derives this developer's `cid` from `gitEmail`, §3.1).
4. Broker (already holding the admin token): normalizes the key, computes `cid` from `gitEmail`, ensures project (private), ensures user + project permissions (no `admin`), revokes only this consumer's own prior token (`cs-devtest-<key>-<cid>`), mints a fresh project-scoped analysis token under that name.
5. Broker returns `{hostUrl, scannerToken, dashboardUrl}`.
6. CLI writes `sonar-project.properties` with `sonar.host.url=<hostUrl>` and `sonar.token=<scannerToken>`; ensures `sonar-project.properties` is in `.gitignore`; prints the dashboard URL.
7. On commit, the pre-commit hook sees a non-empty `sonar.token=` and runs `sonar-scanner` with the stored scoped token — **without re-provisioning**. This is safe because the token is named per consumer (`cid`): another developer's `init` or a CI run revokes only *their* same-named token, never this laptop's, so the stored token keeps working across commits until this same developer re-runs `init`/`sync`. No admin token, no password anywhere on the laptop.
8. **Offline/broker down:** step 3 fails → CLI warns, writes `sonar.token=` empty → the updated hook skip (`^sonar\.token=.+` fails to match) skips the Sonar stage. Commit proceeds.

### 10.2 CI flow (self-hosted LAN runner)

1. Push triggers `security-pipeline.yml`; the `run-scans` job runs on a **self-hosted LAN runner**.
2. `run-all-scans.sh` validates it has `GIT_SHA`, `GIT_BRANCH`, `RUN_DATE`, `GIT_REPO` (from the workflow's `GITHUB_REPOSITORY`), `CS_DEVTEST_BROKER_URL` (no Sonar/DefectDojo secrets); checks `{broker}/healthz`.
3. Script `POST /sonar/provision` with `{projectKey, projectName, consumerId}` — CI sends `consumerId` (runner identity, e.g. `"ci"`/`"ci-${RUNNER_NAME}"`) and omits `gitEmail`, so the broker scopes the token to a CI-specific `cid` distinct from any laptop's and skips SonarQube user setup → gets `hostUrl` + scoped `scannerToken`.
4. Script runs `sonar-scanner` with that host + token; polls the CE task and quality gate with the scoped token; saves `sonarqube-report.json`. (Steps 2–4 of the script — unit tests, Newman, ZAP against `localhost:3000` — are unchanged and produce `zap-report.xml`.)
5. Script `POST /defectdojo/import` **twice** (multipart): once for `sonarqube-report.json` (`scanType="SonarQube Scan"`), once for `zap-report.xml` (`scanType="ZAP Scan"`), each sending `repo="${GIT_REPO}"`/`branch`/`commit`.
6. Broker maps `repo`→DefectDojo product and `branch`→engagement, resolving-or-creating both by name via `import-scan` `auto_create_context=true` (`product_name=<repo>`, `engagement_name=<branch>`, `product_type_name=cs-devtest` — §3.2), and imports using the server-side API key; returns per-import `{findingsCount, severity, …}`.
7. Script `GET /defectdojo/findings?repo=${GIT_REPO}&branch=` → broker returns the engagement's findings JSON; `generate-html.js` builds the final report/HTML; artifact uploaded (downstream jobs unchanged).
8. **Broker/DefectDojo down:** matches today's fallbacks — SAST skipped if `/sonar/provision` fails; raw reports bundled if `/defectdojo/import` or `/defectdojo/findings` fails.

---

## 11. Testability

- **Unit-testable (broker):** input validation (§7) per field (including `consumerId`); the §3.0 key-normalization function (table of raw → normalized); the consumer-identity → `cid` derivation (`consumerId` wins over `gitEmail` wins over `"anon"`; same identity ⇒ same deterministic token name `cs-devtest-<key>-<cid>`; distinct identities ⇒ distinct names — the Finding-1 no-clobber property); the revoke-then-mint sequence asserting it targets **only** the same-named token (mock `fetch`, assert the revoke call carries the exact `cs-devtest-<key>-<cid>` name and no wildcard/revoke-all); request-builders for the Sonar and DefectDojo API calls; the response shapers — asserting responses never contain the exact admin-token/API-key values (the §9 invariant, value match not prefix). Upstream HTTP is mocked (`fetch` stubbed), so these need no live services.
- **Unit-testable (client):** `setupSonarProperties()` with the broker call mocked — asserts it writes the returned host + `sonar.token`, adds `sonar-project.properties` to `.gitignore`, and on broker failure writes an empty `sonar.token=` and does not throw. A hook-script unit test asserts the generated skip-check greps `^sonar\.token=.+` and that no `Creole@123456` string remains.
- **Integration-testable:** **first**, confirm that a `PROJECT_ANALYSIS_TOKEN` can both run the scan and poll `/api/ce/component` and `/api/qualitygates/project_status` (the §3.1 load-bearing assumption) — sequence this ahead of the end-to-end test so that, if it fails, the §3.1 project-scoped user-token fallback is adopted before the CLI/CI edits are built on `sqp_` behavior. Then: `GET /healthz` against a compose stack with real SonarQube + DefectDojo; one end-to-end `provision → scan → import → findings` against a throwaway stack; the `setup.sh` broker-profile start + readiness wait. These run on a LAN/CI box with Docker, not on cloud runners.
- The service is stateless and dependency-light (Express + two upstream HTTP APIs), which keeps the unit surface large and the integration surface small — a sign the decomposition is testable rather than a monolith that only works end to end.

---

## 12. Hard constraints (restated)

- **Scope is LOCAL / on-prem only**, on branch `local-onprem-setup`. No GCP work is designed here.
- **No edits to `terraform/` or `main`.** The broker lives entirely under `onprem/` plus the `cs-devtest` client/template files listed in §6.
- **The package is not published or version-bumped** as part of this work. These are source changes on the branch; releasing is a separate, later decision (and would be a breaking change for GCP consumers, out of scope now).
- The hardcoded SonarQube host/token/password are **removed** from the published code paths as a direct result of §6.2 and §6.3.

---

## 13. Open questions for review

1. **Dashboard login for developers** — the first version drops the per-user password flow (scanning only needs the scoped token). Confirm devs don't need immediate dashboard login, or we add the optional random-password-returned path from §3.1.
2. **Engagement strategy** — decided as **one engagement per branch** (per `repo` product) for traceability. Flag if a single rolling "CI/CD" engagement per product is preferred instead.
3. **Broker host default** — RESOLVED for v1: ship `CS_DEVTEST_BROKER_URL=http://devsecops.lan:8900` (hostname) with a documented `/etc/hosts` fallback in `LOCAL_SETUP.md`; the env var overrides it. If the office later adds internal DNS this needs no change. (A reserved LAN IP remains the alternative if hostnames prove inconvenient.)
4. **Changed CLI project key on upgrade** — RESOLVED as accept-for-fresh-setups: the §3.0 transform lowercases the CLI key (`My_App` → `my_app`), which differs from the old CLI (`My_App`). Fresh on-prem setups (this branch's target) are unaffected. A repo already scanned under the old key needs a one-time admin `POST /api/projects/update_key` to preserve history (§3.0). Flag if any pre-existing local project must be migrated so the rename is scheduled before the first post-upgrade scan.

---

## 14. Responses to the design review

Review: `onprem/BROKER_DESIGN_REVIEW.md` — verdict CHANGES_REQUESTED (2 HIGH, 6 MEDIUM, 4 NIT). All 12 findings **addressed**.

1. **HIGH — degradation keys on `sonar.login` vs `sonar.token`.** Addressed. §6.2 now writes `sonar.token` (empty on broker-down); §6.3 explicitly changes the hook skip-check to `if ! grep -qE '^sonar\.token=.+' sonar-project.properties`. §10.1 step 8 and §11 reflect it.
2. **HIGH — `SONAR_HOST_URL` removed as secret but not from the CI `REQUIRED` list.** Addressed. §6.4 now removes `SONAR_HOST_URL` from both the `REQUIRED` array and the trim/normalize block; the host comes from the `/sonar/provision` response.
3. **MEDIUM — broker startup ordering vs `setup.sh`.** Addressed with two mechanisms (§5, §6.1, §8): the broker service is `profiles: ["broker"]` and started by an explicit `docker compose --profile broker up -d broker` step *after* section 5.1 bootstrap; startup admin-auth retries with backoff and is fatal only after SonarQube is UP with a genuinely wrong password.
4. **MEDIUM — Docker port publishing hides client IP, defeating the CIDR middleware.** Addressed. §4 drops the in-broker CIDR middleware; the ufw firewall (`firewall.sh`, port 8900 → `LAN_CIDRS`) is stated as the sole network control. §9/§11 and the §8 table updated to remove the app-layer `403`; `BROKER_ALLOWED_CIDRS` removed from §5.
5. **MEDIUM — CI changes only covered SonarQube; ZAP import + Step-6 fetch still used removed secrets.** Addressed. §3.2 accepts `scanType="ZAP Scan"`; §3.3 adds `GET /defectdojo/findings`; §6.4 rewrites both `do_import` calls and the Step-6 fetch through the broker; §6.5 fixes the "Scans" job-summary line; §10.2 covers Newman/ZAP.
6. **MEDIUM — DefectDojo admin-cred var naming + missing `setup.sh` wiring.** Addressed. Canonical `DD_ADMIN_USER`/`DD_ADMIN_PASSWORD` used throughout (§5); §6.1 adds the explicit bullet to append them to the generated `defectdojo.env`, with the "fresh-init only" caveat.
7. **MEDIUM — "laptops store nothing" vs a gitleaks-ignored, non-gitignored token file.** Addressed. §1 reworded to the accurate claim; §6.2/§9 add `sonar-project.properties` to the project `.gitignore` via the client, and §9 no longer relies on Gitleaks for that file.
8. **MEDIUM — divergent project-key derivation across CLI and CI.** Addressed. §3.0 defines one canonical transform, re-applied server-side by the broker (authoritative), referenced from §3.1, §6.2, §6.4, §7, §10.
9. **NIT — `BROKER_PUBLIC_HOST` misleading name.** Addressed. Renamed to `SONAR_PUBLIC_URL` in §5 (comment kept).
10. **NIT — leak test would flag legitimate scanner tokens.** Addressed. §9/§11 assert the response never contains the exact admin-token/API-key **values** (not a `squ_` prefix); §3.1 example corrected to `sqp_…` for a `PROJECT_ANALYSIS_TOKEN`.
11. **NIT — removing `ensureUserExists` leaves `getUsernameFromEmail` dead.** Addressed. §6.2 adds `getUsernameFromEmail` to the removal list.
12. **NIT — shipped client default left open.** Addressed. §6.2 and §13(3) fix the v1 default to `http://devsecops.lan:8900` with a documented `/etc/hosts` fallback and env override.

On the review's "unverified" note about `PROJECT_ANALYSIS_TOKEN` polling CE/quality-gate
endpoints: captured as an explicit implementation-validation step in §3.1 and §11, with a
documented fallback (project-scoped user token) that does not change the §9 leak invariant.

---

## 15. Responses to the second design review

Second review: `onprem/BROKER_DESIGN_REVIEW.md` — verdict CHANGES_REQUESTED (1 HIGH, 4 MEDIUM, 4 NIT). All 9 findings **addressed**.

1. **HIGH — ufw does not filter Docker-published ports, so the firewall does not actually restrict the broker to the LAN.** Addressed. §4 now explains that Docker's `DOCKER`/`DOCKER-USER` chains bypass ufw's `INPUT` chain and **chooses** enforcement in the `DOCKER-USER` chain (RETURN per `LAN_CIDRS`, trailing DROP) for `8900` plus `9000`/`8080`, with interface-bind and `ufw-docker` named as acceptable substitutes. §6.1's `firewall.sh` edit and the compose publish note are updated; the §9 invariant now names `DOCKER-USER` as the owning mechanism.
2. **MEDIUM — `POST /api/users/create` requires a password, contradicting "no password set".** Addressed. §3.1 step 3 now has the broker generate a random high-entropy password server-side for `users/create` and discard it (never returned, never logged); the response paragraph is reworded to "sets a random password it never returns."
3. **MEDIUM — §6.4 single `/healthz` call conflicts with graceful SAST-skip / raw-bundle fallbacks.** Addressed. §6.4 now specifies the healthz check is advisory/non-fatal, branches per-field (`sonar:down` ⇒ skip SAST; `defectdojo:down` ⇒ run SAST + raw bundle), and never `exit 1`s on a 503 — consistent with §8 and §10.2.
4. **MEDIUM — `setup.sh` readiness wait pass condition unspecified; can block on slow DefectDojo.** Addressed. §6.1 edit 4 defines readiness as "broker answers `/healthz` with any HTTP response (200 or 503) within N seconds" (listening, not upstream-ready), prints sub-statuses, and notes `defectdojo:down` at boot is expected and self-heals.
5. **MEDIUM — DefectDojo product/engagement create fields missing (400 as written).** Addressed. §3.2 now **chooses** `import-scan` with `auto_create_context=true` and enumerates the exact fields (`product_name`, `engagement_name`, `product_type_name`, etc.), avoiding the underspecified numeric `prod_type`; §3.3 is read-only name resolution (no create). `DD_PRODUCT_TYPE_NAME` added to §5's `.env.example`.
6. **NIT — `setup.sh` still hardcodes `Creole@123456` fallback.** Addressed. §6.1 setup.sh edit 2 makes the unset case fatal (`echo` error naming `onprem/.env`, `exit 1`), removing the last server-side hardcoded credential.
7. **NIT — timestamped tokens accumulate unbounded.** Addressed. §3.1 step 4 + the Token-lifecycle paragraph now revoke prior `cs-devtest-<projectKey>-*` tokens (via `GET /api/user_tokens/search` + `POST /api/user_tokens/revoke`) before minting, so at most one live broker token per project.
8. **NIT — `CS_DEVTEST_BROKER_URL` declared as a variable but not wired into the CI `env:` block.** Addressed. §6.5 now adds `CS_DEVTEST_BROKER_URL: ${{ vars.CS_DEVTEST_BROKER_URL }}` to the `run-scans` `env:` block in the same edit that removes the six secrets.
9. **NIT — new §3.0 key transform differs from the old CLI transform (orphan/duplicate on upgrade).** Addressed. §3.0 adds an upgrade/migration note (accept for fresh setups; one-time `POST /api/projects/update_key` for pre-existing keys) and §13(4) records it as a resolved open question; the CI script already matches §3.0, so only the CLI key changes.

On the review's "unverified" items: the `PROJECT_ANALYSIS_TOKEN` CE/quality-gate polling,
the `DD_ADMIN_USER`/`DD_ADMIN_PASSWORD` initializer names, and `host.docker.internal:8080`
reachability remain flagged as implementation-time validations in §3.1/§5/§11 with the
fallbacks already documented; none can be verified from this repo and each has a stated
alternative that preserves the design's invariants.

---

## 16. Responses to the third design review

Third review: `onprem/BROKER_DESIGN_REVIEW.md` — verdict CHANGES_REQUESTED (1 HIGH, 2 MEDIUM, 1 NIT). All 4 findings **addressed**.

1. **HIGH — "revoke-before-mint" (revoke-all) token lifecycle clobbers other consumers and contradicts the CLI flow.** Addressed by the review's **preferred** fix: scope the token identity to the consumer. The minted token is now named `cs-devtest-<projectKey>-<cid>`, where `cid = sha256(identity).slice(0,12)` and `identity` is the request `consumerId`, else `gitEmail`, else `"anon"` (§3.1 "Consumer identity" + step 4). On provision the broker revokes **only the same-named** token before re-minting — never a wildcard revoke-all. This removes the dev-A/dev-B and laptop/CI races: each consumer owns exactly one live token per project and cannot revoke another's. The false "a scan always re-provisions immediately before it runs" premise is explicitly retired in the §3.1 token-lifecycle paragraph. §10.1 (steps 3–4, and step 7's "without re-provisioning … safe because the token is named per consumer"), §10.2 step 3, §7 (`consumerId` validation), and §11 (unit tests for `cid` derivation, no-clobber, and same-name-only revoke) all updated to match.

2. **MEDIUM — the `DOCKER-USER` snippet inserted the DROP above the RETURNs (`-I`), dropping all traffic including LAN.** Addressed. §4's rule block now inserts the **DROP first** (so it lands at the bottom) and then one **RETURN per LAN CIDR** above it, with the `-I` evaluation-order trap called out explicitly and the `-A`-is-also-wrong note (Docker's trailing RETURN) retained. Correct resulting order `RETURN(cidr…)` then `DROP`. Applied to `8900`, `9000`/`8080`, and the `ip6tables` equivalents. Every managed rule carries `-m comment --comment "cs-devtest-broker"` for the idempotency flush.

3. **MEDIUM — `firewall.sh` runs before Docker is installed (chain absent) and the idempotency mechanism was unspecified.** Addressed by moving the Docker-layer rules out of `firewall.sh`. §6.1: `firewall.sh` now only adds `8900` to the ufw `SERVICE_PORTS` (it must stay runnable before Docker exists); the `DOCKER-USER` block moves into a **new `setup.sh` section 4.1, immediately after the Docker install (§4)**, so the chain exists. That block ensures the chain (`iptables -nL DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER`), **flushes its own rules by delete-by-match on the `cs-devtest-broker` comment in a loop** before re-inserting (concrete, repeatable idempotency, no duplicate stacking/reordering), then re-inserts in the Finding-2 order. §9's invariant and §6.1's `LOCAL_SETUP.md` bullet state the run order unambiguously (firewall/ufw before setup; `DOCKER-USER` applied by setup after Docker install).

4. **NIT — `gitEmail` source in CI was described three different ways.** Addressed by deciding CI **omits `gitEmail`** (SonarQube user setup is a laptop-only concern) and instead sends a `consumerId` runner identity for token scoping. Aligned across §4 (identity paragraph), §3.1 (request body + step 3 "skip when absent"), §6.4 Step 1, and §10.2 step 3. §7 documents the absent-`gitEmail` = skip-user-setup behavior.

---

## 17. Responses to the fourth design review

Fourth review: `onprem/BROKER_DESIGN_REVIEW.md` — verdict CHANGES_REQUESTED (1 HIGH, 1 MEDIUM, 3 NIT). All 5 findings **addressed**; the review file is superseded by this round and removed.

1. **HIGH — the `DOCKER-USER` DROP also drops the broker's own container-origin traffic to SonarQube (9000) and DefectDojo (8080).** Addressed. Because `DOCKER-USER` sees *all* forwarded packets, a DROP matching only destination port + LAN source CIDR also matched the broker's bridge-sourced (`172.x`) calls to `sonarqube:9000` and the DNAT'd `host.docker.internal:8080`, severing the broker from its upstreams. Fixed by inserting a **RETURN for the Docker bridge range `172.16.0.0/12` above the DROP** (the review's preferred fix), so the DROP now applies to external ingress only while intra-stack traffic is always allowed. The new resulting order per port is `RETURN(172.16.0.0/12)`, `RETURN(cidr…)`, then `DROP`. Applied in §4 (rule block + prose), §6.1 section 4.1 (the delete-by-match idempotency flush now also clears the bridge RETURN, and re-insert order is DROP → bridge RETURN → LAN RETURNs, with the `ip6tables` block using the IPv6 bridge range), and §9 (the invariant now states the control restricts external ingress and names the bridge RETURN as load-bearing). An interface-scoped DROP (`-i "$WAN_IF"`) is documented as the acceptable alternative.

2. **MEDIUM — CI has no source for the `repo` field the broker requires for DefectDojo import/findings.** Addressed. `GIT_REPO` is now sourced from the GitHub Actions built-in `GITHUB_REPOSITORY` via `GIT_REPO: ${{ github.repository }}` added to the `run-scans` `env:` block (§6.5), added to `run-all-scans.sh`'s `REQUIRED` array (§6.4), and passed as `repo="${GIT_REPO}"` on `/defectdojo/import` and (URL-encoded) on `/defectdojo/findings` (§6.4 Steps 5/6, §10.2 steps 5/7). The broker's repo→DefectDojo mapping is documented: `import-scan` with `auto_create_context=true` creates/resolves `product_name=<repo>`, `engagement_name=<branch>`, `product_type_name=cs-devtest` (§3.2, §10.2 step 6). §6.4 Step 1 notes the SonarQube `projectName` source stays aligned with the `GIT_REPO`-derived product name for predictability.

3. **NIT — the ufw `8900` rule is a no-op for the broker; its rationale was misleading.** Addressed. §6.1's `firewall.sh` bullet now states the ufw `8900` entry does not filter the Docker-published port and is kept only for consistency/documentation and any non-Docker listener, with the effective control being the `DOCKER-USER` rule in `setup.sh` section 4.1.

4. **NIT — self-hosted runner tool prerequisites not stated.** Addressed. §6.5 and the §6.1 `LOCAL_SETUP.md` bullet now list what the self-hosted LAN runner must provide: Docker, Node.js ≥ 18, and `jq`.

5. **NIT — `PROJECT_ANALYSIS_TOKEN` capability validated only at implementation time.** Addressed. §11 now sequences the `PROJECT_ANALYSIS_TOKEN` CE/quality-gate polling check **first** in the integration tests, so the §3.1 project-scoped user-token fallback is adopted before the CLI/CI edits depend on `sqp_` behavior.
