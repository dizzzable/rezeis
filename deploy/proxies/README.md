# Reverse proxies for the rezeis panel

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

All HTTPS stacks also ship a stealth default server: connections that hit
the IP without the right SNI get a TLS reject / `204`, so the panel
hostname isn't trivially discoverable by scanning the IP.

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
