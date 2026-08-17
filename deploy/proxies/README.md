# Reverse proxies for the rezeis panel

This root `deploy/proxies` tree is the canonical proxy documentation for the
repository. The older `rezeis-admin/deploy/proxies` tree is kept only as a
legacy/reference copy and should not be used for new deployments.

These stacks put a TLS-terminating reverse proxy in front of the rezeis
admin panel, following the same patterns the Remnawave panel uses
(<https://docs.rw/docs/install/reverse-proxies/>). The panel container
listens on `rezeis:8000` inside the shared `remnawave-network` and is
**not** published to the host, so the proxy reaches it over the docker
network — just like Remnawave's `remnawave:3000`.

## 443-only, bring-your-own certificate

All HTTPS stacks here bind **only `:443`** — no port 80, no automatic
ACME. You supply the TLS certificate yourself. This keeps the public
surface to a single port and works on boxes where 80 is taken or blocked.

> ### ⚠️ The panel's certificate must be publicly trusted
>
> **Do not use a self-signed certificate for the panel in a split
> deployment.** This is the one choice on this page that breaks something
> which does not look broken.
>
> The reiwa cabinet calls the panel over HTTPS using Node's default trust
> store. It sets no custom CA, no `NODE_EXTRA_CA_CERTS`, and never disables
> verification. A self-signed panel certificate therefore fails **every**
> cabinet → panel call at the TLS handshake — subscriptions, plans,
> payments, the lot.
>
> The symptom points at the wrong machine. The cabinet keeps serving pages
> from its Redis snapshot, so it looks alive and merely "empty", and the
> obvious conclusion is that the panel is down. Operators lose an hour
> debugging a healthy panel.
>
> - **Cabinet** — self-signed is acceptable for browser-only local testing
>   (you click through the warning yourself). Telegram Mini App use still
>   requires a trusted cert.
> - **Panel** — self-signed is never acceptable in a split deployment.
>   Use a certificate from a public CA, or a Cloudflare Origin cert with
>   the domain proxied through Cloudflare.
>
> The generator below is for single-box or lab use. If reiwa and rezeis run
> on separate VPSes, skip it and install a real certificate.

Generate a self-signed cert (10-year, RSA-4096) with the helper:

```bash
cd deploy/proxies
./gen-self-signed-cert.sh panel.example.com <stack-dir-or-certs-dir>
```

Where the cert files go per stack (always `fullchain.pem` + `privkey.key`):

| Stack    | Cert location           |
| -------- | ----------------------- |
| caddy    | `caddy/certs/`          |
| nginx    | `nginx/`                |
| angie    | `angie/`                |
| traefik  | `traefik/certs/`        |

You can also drop in a **real** certificate instead of self-signed — a
Cloudflare Origin cert, or one you issued out-of-band (e.g. acme.sh via
DNS-01 on another machine). Just name the files `fullchain.pem` +
`privkey.key` in the same place.

> Self-signed certs trip the browser's "not trusted" warning. For a clean
> padlock either (a) put the domain behind Cloudflare proxy with SSL mode
> **Full** and use a Cloudflare Origin cert here, or (b) install a real
> cert issued elsewhere.

## Topology

```
                 :443 (TLS, your cert)
  Internet ───▶  reverse proxy ───▶  rezeis:8000   (panel + internal API)
                 (this folder)        on remnawave-network
```

- `rezeis` exposes `8000` only on the docker network (`expose`, not
  `ports`). The proxy is the single public surface.
- Every proxy stack joins the **external** `remnawave-network`, so it
  resolves `rezeis` by its compose service name.
- Postgres and Redis stay on the rezeis compose stack's private internal
  network; proxy/Reiwa-facing containers do not need direct DB/Redis access.
- The same proxy can also route the Remnawave panel itself
  (`remnawave:3000`) and the reiwa user app (`reiwa-web:80`) — add extra
  `server` / router blocks for those hostnames if you run them together.

## Prerequisites

1. A registered domain pointing (A/AAAA) at the server IP. The panel does
   **not** support being served on a sub-path (`/panel`), only on a host
   or sub-domain — same constraint as Remnawave.
2. The shared docker network exists:

   ```bash
   docker network create remnawave-network 2>/dev/null || true
   ```

3. Generate/drop in the cert, edit the config (replace
   `REPLACE_WITH_YOUR_DOMAIN`), then bring the proxy up **before** (or
   together with) the rezeis stack:

   ```bash
   cd deploy/proxies/<chosen>      # caddy | nginx | traefik | angie
   docker compose up -d && docker compose logs -f
   ```

## Which one?

| Proxy            | Notes                                                     |
| ---------------- | --------------------------------------------------------- |
| **caddy**        | simplest; serves your mounted cert, redirects disabled    |
| **nginx**        | full control, Mozilla-Intermediate TLS profile            |
| **angie**        | nginx-syntax, same TLS profile                            |
| **traefik**      | file-driven; BYO cert via dynamic `tls` provider          |
| **try-cloudflare** | dev/demo only — outbound Quick Tunnel, **never prod**   |

Traefik uses only the file provider and does not mount the Docker socket. Its
dashboard and debug API are disabled by default.

### Request-body limits

The Nginx and Angie templates set a **64 MB** default at the edge, then raise
it per-path for the two route families that legitimately need more. The proxy
is deliberately never the thing that says no: each of these endpoints enforces
its real limit in the application and returns a proper error, rather than a
bare edge `413` with no explanation.

| Path | Edge limit | Application limit |
| --- | --- | --- |
| *(everything else)* | 64 MB | broadcast video 50 MB, FAQ media 25 MB, bot-flow media 20 MB, banners 8 MB |
| `POST /api/admin/backup/restore-upload` | 2 GB | 1 GiB default, 2 GiB hard cap (`BACKUP_MAX_UPLOAD_BYTES`) |
| `POST /api/admin/imports/{3xui,remnashop,altshop,stealthnet}` | 128 MB | 100 MB each |

Both overrides use a regex `location` matching those exact paths. A prefix
`location /api/admin/imports/` would **not** be narrow enough — the same
controller also serves nine small-JSON routes (`GET /`, `GET /:importId`,
`POST /remnawave`, `/remnawave/sync`, `/assign-plan`, `/:importId/cancel`,
`/:importId/rollback`, `/:importId/plan-preview`, `/:importId/clone-plans`)
which would silently inherit the raised ceiling.

> Nginx and Angie buffer the whole request body to disk before forwarding, so
> a 2 GB restore needs 2 GB free in the container's `client_body_temp_path`.
> Each `restore-upload` block carries a commented `proxy_request_buffering
> off;` if you would rather stream straight through.

**Caddy and Traefik impose no request-body ceiling of their own**, and none is
configured in these templates. On those two stacks the application's own
per-route limits are the *only* ceiling — which means **no per-path work is
needed there**: backup restores and importer uploads pass through at full size
already. Each config carries a commented snippet (`request_body` for Caddy, a
`buffering` middleware for Traefik) if you nonetheless want an edge limit, in
which case you must add the per-path exceptions yourself.

### Security headers

All four stacks send `Strict-Transport-Security: max-age=31536000;
includeSubDomains` (one year). `preload` is deliberately **not** set — it is a
one-way submission to browser vendors and should be a separate, conscious
decision.

> `includeSubDomains` is a commitment. It pins HTTPS for every name under this
> host's apex. If the panel and the reiwa cabinet share an apex (e.g.
> `panel.example.com` and `app.example.com` under `example.com`), the header
> from either one applies to the whole tree — including subdomains that have
> no certificate yet, which become unreachable in browsers that saw the
> header, for a year. Drop `includeSubDomains` if your DNS layout makes that
> risky; the max-age alone still protects this host.

On Nginx and Angie the directive uses `always` so it also covers error
responses. Note that `add_header` is **not** inherited into a `location` that
declares its own `add_header` — if you add one, repeat the HSTS line there or
it silently disappears for that path.

### Real client IP behind a CDN

These stacks assume the VPS terminates TLS **directly**, which is the
supported topology: the peer address is the real client and `X-Forwarded-For`
is correct.

If you ever put Cloudflare (or any CDN) in front, you must tell the proxy whom
to trust, or the panel will see a CDN edge address as the client and
auto-block **that edge** for 30 minutes after repeated failed logins — locking
out every operator routed through the same datacentre. The reiwa cabinet is
worse: its bans last 24 hours. Every config in this folder carries a
commented, ready-to-enable block; ranges must be fetched from
<https://www.cloudflare.com/ips/> (they change).

> Traefik is the worst of the four here. Nginx, Angie and Caddy forward a
> wrong-but-present client address when untrusted. Traefik **strips every
> `X-Forwarded-*` header** from an untrusted peer instead of shifting them, so
> the client address is destroyed outright rather than merely wrong.

### Stealth default

All HTTPS stacks ship a stealth default server: connections that hit the IP
without the right SNI get a TLS reject (Nginx/Angie), a self-signed handshake
and empty `204` (Caddy), or Traefik's own generated self-signed certificate —
so the panel hostname isn't trivially discoverable by scanning the IP.

> Traefik's `config/tls.yml` previously set the real `fullchain.pem` as
> `stores.default.defaultCertificate`, which had the opposite of the intended
> effect: an SNI-less IP scan completed a handshake and was handed a
> certificate **naming the panel domain**. The store block has been removed so
> Traefik falls back to its generated self-signed default, which names
> nothing. Only clients sending no SNI or a wrong SNI are affected, and every
> TLS 1.3 client sends SNI.

## After the proxy is up

```bash
cd ../../../rezeis-admin   # from deploy/proxies/<chosen>/ back to the panel stack
docker compose up -d
```

Open `https://<your-domain>` — you should see the rezeis panel login.

## try-cloudflare (dev only)

`try-cloudflare/` runs a Cloudflare Quick Tunnel (outbound, no inbound
port at all). 200 in-flight connection cap, ephemeral hostname — **never
use it in production**.
