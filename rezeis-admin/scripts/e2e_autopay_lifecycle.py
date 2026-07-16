#!/usr/bin/env python3
"""E2E lifecycle: register → pay tariff → near-expiry → autopay → renew.

Simulates the merchant autopay path against live/internal rezeis APIs.

Flow
----
1. Bootstrap Telegram user (idempotent register)
2. Attach a chargeable saved payment method (copy provider_method_id or use env)
3. NEW checkout with savedPaymentMethodId (off-session, no browser)
4. Wait until subscription ACTIVE
5. Force expires_at ≈ now + NEAR_EXPIRY_MINUTES (SQL via docker or DATABASE_URL)
6. Poll /api/internal/worker/expiry-alerts until:
     - RENEW COMPLETED + expires_at extended  → PASS
     - or EXPIRED after 3 failed attempts     → FAIL (or PASS if --expect-expire)
7. Print a JSON report

Env
---
  REZEIS_BASE_URL   default http://127.0.0.1:8000  (on server use docker network)
  REZEIS_TOKEN      internal Bearer token (required)
  PLAN_ID           default cmrn197bw006801jg5auunfou (test 1₽/1d)
  DURATION_DAYS     default 1
  PROVIDER_METHOD_ID  YooKassa payment_method.id to charge (optional; auto from DB)
  NEAR_EXPIRY_MINUTES default 4
  MAX_WAIT_SEC      default 420
  TELEGRAM_ID       optional fixed id; else random high id
  EXPECT_EXPIRE     1 to assert expiry after failed charges
  SKIP_DB           1 to skip SQL steps (only API)
  DB_MODE           docker (default) | none
  DOCKER_DB_CONTAINER default rezeis-db
  DOCKER_DB_USER    default rezeis
  DOCKER_DB_NAME    default rezeis

Examples
--------
  # On server (inside host, rezeis container network via docker exec):
  export REZEIS_TOKEN=$(docker exec reiwa printenv REZEIS_TOKEN)
  export REZEIS_BASE_URL=http://127.0.0.1:8000   # if port published
  # or:
  python3 scripts/e2e_autopay_lifecycle.py --via-docker-reiwa

  # Remote SSH one-liner is documented in --help
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def log(msg: str) -> None:
    ts = utc_now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value


@dataclass
class Report:
    steps: list[dict[str, Any]] = field(default_factory=list)
    ok: bool = False
    error: Optional[str] = None
    user_id: Optional[str] = None
    subscription_id: Optional[str] = None
    payment_id_new: Optional[str] = None
    payment_id_renew: Optional[str] = None
    expires_before: Optional[str] = None
    expires_after: Optional[str] = None
    cycle_results: list[dict[str, Any]] = field(default_factory=list)

    def step(self, name: str, **data: Any) -> None:
        self.steps.append({"name": name, **data})
        log(f"{name}: {json.dumps(data, ensure_ascii=False, default=str)[:400]}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "error": self.error,
            "user_id": self.user_id,
            "subscription_id": self.subscription_id,
            "payment_id_new": self.payment_id_new,
            "payment_id_renew": self.payment_id_renew,
            "expires_before": self.expires_before,
            "expires_after": self.expires_after,
            "cycle_results": self.cycle_results,
            "steps": self.steps,
        }


class RezeisClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        query: Optional[dict[str, str]] = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        if query:
            qs = urllib.parse.urlencode({k: str(v) for k, v in query.items()})
            url = f"{url}?{qs}"
        data = None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
                if not raw:
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {path} → HTTP {exc.code}: {detail[:800]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{method} {path} → {exc}") from exc


def docker_psql(sql: str, container: str, user: str, db: str) -> str:
    cmd = [
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        db,
        "-v",
        "ON_ERROR_STOP=1",
        "-tAc",
        sql,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            f"psql failed ({proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc.stdout.strip()


def docker_psql_table(sql: str, container: str, user: str, db: str) -> str:
    cmd = [
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        db,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            f"psql failed ({proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc.stdout


def main() -> int:
    parser = argparse.ArgumentParser(description="E2E autopay lifecycle simulator")
    parser.add_argument(
        "--via-docker-reiwa",
        action="store_true",
        help="Call rezeis API via `docker exec reiwa wget` (no host port needed)",
    )
    parser.add_argument("--base-url", default=env("REZEIS_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--token", default=env("REZEIS_TOKEN"))
    parser.add_argument("--plan-id", default=env("PLAN_ID", "cmrn197bw006801jg5auunfou"))
    parser.add_argument("--duration-days", type=int, default=int(env("DURATION_DAYS", "1") or "1"))
    parser.add_argument("--provider-method-id", default=env("PROVIDER_METHOD_ID"))
    parser.add_argument(
        "--near-expiry-minutes",
        type=float,
        default=float(env("NEAR_EXPIRY_MINUTES", "4") or "4"),
    )
    parser.add_argument("--max-wait-sec", type=int, default=int(env("MAX_WAIT_SEC", "420") or "420"))
    parser.add_argument("--telegram-id", default=env("TELEGRAM_ID"))
    parser.add_argument(
        "--expect-expire",
        action="store_true",
        default=env("EXPECT_EXPIRE") == "1",
        help="Pass only if subscription ends EXPIRED (no successful renew)",
    )
    parser.add_argument("--skip-db", action="store_true", default=env("SKIP_DB") == "1")
    parser.add_argument("--db-container", default=env("DOCKER_DB_CONTAINER", "rezeis-db"))
    parser.add_argument("--db-user", default=env("DOCKER_DB_USER", "rezeis"))
    parser.add_argument("--db-name", default=env("DOCKER_DB_NAME", "rezeis"))
    parser.add_argument(
        "--reuse-user-id",
        default=env("REUSE_USER_ID"),
        help="Skip bootstrap; use existing user id",
    )
    parser.add_argument(
        "--only-near-expiry",
        action="store_true",
        help="Only force near-expiry + cycle for --reuse-user-id / --subscription-id",
    )
    parser.add_argument("--subscription-id", default=env("SUBSCRIPTION_ID"))
    args = parser.parse_args()

    report = Report()

    if args.via_docker_reiwa and not args.token:
        try:
            args.token = subprocess.check_output(
                ["docker", "exec", "reiwa", "printenv", "REZEIS_TOKEN"],
                text=True,
            ).strip()
        except Exception as exc:  # noqa: BLE001
            report.error = f"cannot read REZEIS_TOKEN from reiwa container: {exc}"
            print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
            return 2

    if not args.token:
        report.error = "REZEIS_TOKEN / --token required"
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        return 2

    # Optional: route HTTP through docker exec reiwa → http://rezeis:8000
    if args.via_docker_reiwa:
        client = DockerReiwaClient(args.token)
        args.base_url = "docker://reiwa→rezeis:8000"
    else:
        client = RezeisClient(args.base_url, args.token)

    try:
        health = client.request("GET", "/api/health")
        report.step("health", health=health)
        version = (health or {}).get("version")
        if version and str(version) < "0.9.6.49":
            log(f"WARN: rezeis version {version} may lack T-5m autopay (need >= 0.9.6.49)")
    except Exception as exc:  # noqa: BLE001
        report.error = f"health failed: {exc}"
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        return 2

    try:
        if args.only_near_expiry:
            if not args.reuse_user_id or not args.subscription_id:
                raise RuntimeError("--only-near-expiry needs --reuse-user-id and --subscription-id")
            report.user_id = args.reuse_user_id
            report.subscription_id = args.subscription_id
            run_near_expiry_and_autopay(args, client, report)
        else:
            run_full_lifecycle(args, client, report)
        report.ok = True
    except Exception as exc:  # noqa: BLE001
        report.error = str(exc)
        report.ok = False
        log(f"ERROR: {exc}")

    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return 0 if report.ok else 1


class DockerReiwaClient:
    """HTTP client that posts via `docker exec reiwa wget` to http://rezeis:8000."""

    def __init__(self, token: str) -> None:
        self.token = token
        self.base = "http://rezeis:8000"

    def request(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        query: Optional[dict[str, str]] = None,
    ) -> Any:
        url = f"{self.base}{path}"
        if query:
            qs = urllib.parse.urlencode({k: str(v) for k, v in query.items()})
            url = f"{url}?{qs}"

        auth = f"Authorization: Bearer {self.token}"
        if body is None:
            if method != "GET":
                raise RuntimeError(
                    f"DockerReiwaClient body-less only supports GET, got {method}"
                )
            cmd = [
                "docker",
                "exec",
                "-e",
                f"E2E_AUTH={auth}",
                "reiwa",
                "sh",
                "-c",
                f'wget -qO- --header="$E2E_AUTH" {shlex.quote(url)}',
            ]
        else:
            if method != "POST":
                raise RuntimeError(
                    f"DockerReiwaClient body only supports POST, got {method}"
                )
            payload = json.dumps(body)
            b64 = base64.b64encode(payload.encode()).decode()
            cmd = [
                "docker",
                "exec",
                "-e",
                f"E2E_AUTH={auth}",
                "reiwa",
                "sh",
                "-c",
                (
                    f"echo {shlex.quote(b64)} | base64 -d > /tmp/e2e_body.json && "
                    'wget -qO- --header="$E2E_AUTH" '
                    "--header='Content-Type: application/json' "
                    f"--post-file=/tmp/e2e_body.json {shlex.quote(url)}"
                ),
            ]

        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise RuntimeError(
                f"docker wget {method} {path} failed: "
                f"{proc.stderr.strip() or proc.stdout.strip()}"
            )
        raw = proc.stdout.strip()
        if not raw:
            return None
        return json.loads(raw)


def run_full_lifecycle(args: argparse.Namespace, client: Any, report: Report) -> None:
    # 1) bootstrap
    if args.reuse_user_id:
        user_id = args.reuse_user_id
        report.user_id = user_id
        report.step("reuse_user", user_id=user_id)
    else:
        tg = args.telegram_id or str(9_000_000_000 + random.randint(10_000_000, 99_999_999))
        session = client.request(
            "POST",
            "/api/internal/user/bootstrap",
            {
                "telegramId": tg,
                "name": f"e2e-autopay-{tg[-6:]}",
                "username": f"e2e_{tg[-8:]}",
                "language": "ru",
            },
        )
        user_id = session["id"]
        report.user_id = user_id
        report.step("bootstrap", telegram_id=tg, user_id=user_id, session_keys=list(session.keys()))

    # 2) ensure chargeable saved method
    method_id = ensure_saved_method(args, client, report, user_id)

    # 3) NEW checkout off-session
    checkout = client.request(
        "POST",
        "/api/internal/payments/checkout",
        {
            "userId": user_id,
            "purchaseType": "NEW",
            "planId": args.plan_id,
            "durationDays": args.duration_days,
            "gatewayType": "YOOKASSA",
            "channel": "WEB",
            "savedPaymentMethodId": method_id,
            "successUrl": "https://reiwa.d3mshop.site/purchase/success",
            "failUrl": "https://reiwa.d3mshop.site/purchase/fail",
        },
    )
    payment_id = checkout["paymentId"]
    report.payment_id_new = payment_id
    report.step("checkout_new", checkout=checkout)

    # poll status
    status = wait_payment_completed(client, payment_id, user_id, timeout=120)
    report.step("payment_new_status", status=status)

    # 4) resolve subscription id
    sub_id = resolve_subscription_id(args, report, user_id, payment_id)
    report.subscription_id = sub_id
    report.step("subscription_resolved", subscription_id=sub_id)

    # 5) near-expiry + autopay
    run_near_expiry_and_autopay(args, client, report)


def ensure_saved_method(
    args: argparse.Namespace,
    client: Any,
    report: Report,
    user_id: str,
) -> str:
    # list existing
    listed = client.request("GET", f"/api/internal/user/{user_id}/payment-methods")
    methods = (listed or {}).get("methods") or listed or []
    if isinstance(listed, dict) and "methods" in listed:
        methods = listed["methods"]
    for m in methods:
        if m.get("isActive", True) is False:
            continue
        if m.get("autopayEnabled") is False:
            continue
        if m.get("gatewayType") == "YOOKASSA":
            report.step("saved_method_existing", method=m)
            return m["id"]

    provider_id = args.provider_method_id
    if not provider_id and not args.skip_db:
        # pick any active non-demo YOOKASSA method from DB
        provider_id = docker_psql(
            "SELECT provider_method_id FROM saved_payment_methods "
            "WHERE is_active AND autopay_enabled AND gateway_type='YOOKASSA' "
            "AND provider_method_id NOT LIKE 'demo_pm_%' "
            "ORDER BY created_at DESC LIMIT 1;",
            args.db_container,
            args.db_user,
            args.db_name,
        )
    if not provider_id:
        raise RuntimeError(
            "No PROVIDER_METHOD_ID and no existing chargeable method. "
            "Pass --provider-method-id from a prior successful YooKassa save."
        )

    if args.skip_db:
        raise RuntimeError(
            "Need DB for saved method when user has none (disable --skip-db)"
        )

    # provider_method_id is UNIQUE globally — rebind existing row to this user
    # for e2e instead of inserting a duplicate (shop-level charge token).
    method_id = docker_psql(
        f"""
        UPDATE saved_payment_methods
        SET user_id = '{user_id}',
            is_active = true,
            autopay_enabled = true,
            unbound_at = NULL,
            title = COALESCE(title, 'E2E autopay method'),
            updated_at = NOW()
        WHERE gateway_type = 'YOOKASSA'
          AND provider_method_id = '{provider_id}'
        RETURNING id;
        """.strip(),
        args.db_container,
        args.db_user,
        args.db_name,
    )
    if not method_id:
        method_id = docker_psql(
            f"""
            INSERT INTO saved_payment_methods (
              id, user_id, gateway_type, provider_method_id, method_type, title,
              is_active, autopay_enabled, created_at, updated_at
            ) VALUES (
              'cme2e' || substr(md5(random()::text), 1, 20),
              '{user_id}',
              'YOOKASSA',
              '{provider_id}',
              'yoo_money',
              'E2E autopay method',
              true,
              true,
              NOW(),
              NOW()
            ) RETURNING id;
            """.strip(),
            args.db_container,
            args.db_user,
            args.db_name,
        )
        report.step(
            "saved_method_inserted",
            method_id=method_id,
            provider_method_id=provider_id,
        )
    else:
        report.step(
            "saved_method_rebound",
            method_id=method_id,
            provider_method_id=provider_id,
            user_id=user_id,
        )
    return method_id


def wait_payment_completed(
    client: Any,
    payment_id: str,
    user_id: str,
    timeout: int,
) -> dict[str, Any]:
    deadline = time.time() + timeout
    last: dict[str, Any] = {}
    while time.time() < deadline:
        last = client.request(
            "GET",
            f"/api/internal/payments/{payment_id}",
            query={"userId": user_id},
        )
        status = last.get("status") or last.get("transactionStatus")
        if status == "COMPLETED":
            return last
        if status in {"FAILED", "CANCELED"}:
            raise RuntimeError(f"payment {payment_id} ended as {status}: {last}")
        time.sleep(2)
    raise RuntimeError(f"payment {payment_id} not COMPLETED in {timeout}s: {last}")


def resolve_subscription_id(
    args: argparse.Namespace,
    report: Report,
    user_id: str,
    payment_id: str,
) -> str:
    if args.subscription_id:
        return args.subscription_id
    if args.skip_db:
        raise RuntimeError("Cannot resolve subscription without DB (pass --subscription-id)")
    sub_id = docker_psql(
        f"""
        SELECT s.id FROM subscriptions s
        JOIN users u ON u.current_subscription_id = s.id
        WHERE u.id = '{user_id}'
        LIMIT 1;
        """.strip(),
        args.db_container,
        args.db_user,
        args.db_name,
    )
    if not sub_id:
        # fallback: latest sub for user
        sub_id = docker_psql(
            f"""
            SELECT id FROM subscriptions
            WHERE user_id = '{user_id}'
            ORDER BY created_at DESC LIMIT 1;
            """.strip(),
            args.db_container,
            args.db_user,
            args.db_name,
        )
    if not sub_id:
        # via transaction
        sub_id = docker_psql(
            f"""
            SELECT COALESCE(t.subscription_id, ti.subscription_id)
            FROM transactions t
            LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
            WHERE t.payment_id = '{payment_id}'
            LIMIT 1;
            """.strip(),
            args.db_container,
            args.db_user,
            args.db_name,
        )
    if not sub_id:
        raise RuntimeError("Could not resolve subscription id after NEW payment")
    return sub_id


def run_near_expiry_and_autopay(
    args: argparse.Namespace,
    client: Any,
    report: Report,
) -> None:
    user_id = report.user_id
    sub_id = report.subscription_id
    assert user_id and sub_id

    if args.skip_db:
        raise RuntimeError("near-expiry requires DB to force expires_at")

    before = docker_psql(
        f"SELECT status || '|' || COALESCE(expires_at::text,'') FROM subscriptions WHERE id='{sub_id}';",
        args.db_container,
        args.db_user,
        args.db_name,
    )
    report.step("subscription_before", row=before)
    report.expires_before = before

    minutes = args.near_expiry_minutes
    # force window inside T-5m (default 4m)
    docker_psql(
        f"""
        UPDATE subscriptions
        SET expires_at = NOW() + interval '{minutes} minutes',
            status = 'ACTIVE',
            updated_at = NOW()
        WHERE id = '{sub_id}';
        UPDATE users SET current_subscription_id = '{sub_id}', updated_at = NOW()
        WHERE id = '{user_id}';
        """.strip(),
        args.db_container,
        args.db_user,
        args.db_name,
    )
    after_force = docker_psql(
        f"SELECT status || '|' || expires_at::text || '|rem=' || (expires_at - NOW())::text "
        f"FROM subscriptions WHERE id='{sub_id}';",
        args.db_container,
        args.db_user,
        args.db_name,
    )
    report.step("forced_near_expiry", row=after_force, minutes=minutes)

    # ensure method autopay on
    docker_psql(
        f"""
        UPDATE saved_payment_methods
        SET is_active = true, autopay_enabled = true, updated_at = NOW()
        WHERE user_id = '{user_id}' AND gateway_type = 'YOOKASSA';
        """.strip(),
        args.db_container,
        args.db_user,
        args.db_name,
    )

    deadline = time.time() + args.max_wait_sec
    renew_seen = False
    expired_seen = False

    while time.time() < deadline:
        cycle = client.request("GET", "/api/internal/worker/expiry-alerts")
        report.cycle_results.append(cycle)
        report.step("cycle", cycle=cycle)

        row = docker_psql(
            f"""
            SELECT status || '|' || COALESCE(expires_at::text,'') || '|rem=' ||
                   COALESCE((expires_at - NOW())::text, '')
            FROM subscriptions WHERE id='{sub_id}';
            """.strip(),
            args.db_container,
            args.db_user,
            args.db_name,
        )
        report.expires_after = row
        status = row.split("|", 1)[0] if row else ""

        # latest auto-renew tx for this sub
        renew_tx = docker_psql(
            f"""
            SELECT COALESCE(status::text,'') || '|' || COALESCE(payment_id,'') || '|' ||
                   COALESCE(idempotency_key,'')
            FROM transactions
            WHERE purchase_type = 'RENEW'
              AND (
                subscription_id = '{sub_id}'
                OR id IN (SELECT transaction_id FROM transaction_items WHERE subscription_id = '{sub_id}')
                OR idempotency_key LIKE 'auto-renew:{sub_id}:%'
              )
            ORDER BY created_at DESC
            LIMIT 1;
            """.strip(),
            args.db_container,
            args.db_user,
            args.db_name,
        )
        if renew_tx:
            report.step("latest_renew_tx", row=renew_tx)
            parts = renew_tx.split("|")
            if parts[0] == "COMPLETED":
                renew_seen = True
                report.payment_id_renew = parts[1] if len(parts) > 1 else None
                if status == "ACTIVE":
                    # expires should be extended well beyond 5 minutes
                    rem = docker_psql(
                        f"SELECT EXTRACT(EPOCH FROM (expires_at - NOW())) FROM subscriptions WHERE id='{sub_id}';",
                        args.db_container,
                        args.db_user,
                        args.db_name,
                    )
                    try:
                        if float(rem) > 3600:
                            report.step("renew_success", remaining_sec=rem, subscription=row)
                            if args.expect_expire:
                                raise RuntimeError("expected EXPIRE but got successful renew")
                            return
                    except ValueError:
                        pass

        if status == "EXPIRED":
            expired_seen = True
            report.step("expired", row=row)
            if args.expect_expire:
                return
            # if we expected renew, keep waiting a bit for late settle then fail
            time.sleep(5)
            # re-check once more for late COMPLETED
            continue

        # adaptive sleep: while still far from expiry, wait longer
        rem_s = docker_psql(
            f"SELECT EXTRACT(EPOCH FROM (expires_at - NOW())) FROM subscriptions WHERE id='{sub_id}';",
            args.db_container,
            args.db_user,
            args.db_name,
        )
        try:
            rem_f = float(rem_s)
        except ValueError:
            rem_f = 0
        if rem_f > 120:
            time.sleep(30)
        elif rem_f > 30:
            time.sleep(10)
        else:
            time.sleep(5)

    if args.expect_expire and expired_seen:
        return
    if renew_seen and not args.expect_expire:
        # renewed but remaining not huge (1-day plan edge) — still OK if ACTIVE
        if report.expires_after and report.expires_after.startswith("ACTIVE"):
            return
    raise RuntimeError(
        f"timeout waiting for autopay outcome (renew_seen={renew_seen}, expired_seen={expired_seen}). "
        f"last={report.expires_after}"
    )


if __name__ == "__main__":
    sys.exit(main())
