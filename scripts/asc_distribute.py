#!/usr/bin/env python3
"""Assign a TestFlight build to beta groups via the App Store Connect API.

Used by upload-testflight.sh after altool accepts an IPA. Internal groups can
also be patched with hasAccessToAllBuilds so future builds skip the per-build
Groups + button in App Store Connect.
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

ASC_BASE = "https://api.appstoreconnect.apple.com"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def der_ecdsa_to_rs(der: bytes) -> bytes:
    if not der or der[0] != 0x30:
        raise ValueError("not a DER ECDSA signature")
    i = 1
    seq_len = der[i]
    i += 1
    if seq_len & 0x80:
        i += seq_len & 0x7F

    def read_int() -> bytes:
        nonlocal i
        if i >= len(der) or der[i] != 0x02:
            raise ValueError("expected INTEGER")
        i += 1
        ln = der[i]
        i += 1
        if ln & 0x80:
            n = ln & 0x7F
            ln = int.from_bytes(der[i : i + n], "big")
            i += n
        val = der[i : i + ln]
        i += ln
        while len(val) > 32 and val[0] == 0:
            val = val[1:]
        if len(val) > 32:
            raise ValueError("integer too large for P-256")
        return val.rjust(32, b"\x00")

    return read_int() + read_int()


def make_jwt(key_id: str, issuer_id: str, p8: str) -> str:
    header = b64url(
        json.dumps(
            {"alg": "ES256", "kid": key_id, "typ": "JWT"}, separators=(",", ":")
        ).encode()
    )
    now = int(time.time())
    payload = b64url(
        json.dumps(
            {
                "iss": issuer_id,
                "iat": now,
                "exp": now + 12 * 60,
                "aud": "appstoreconnect-apple.com",
            },
            separators=(",", ":"),
        ).encode()
    )
    signing_input = f"{header}.{payload}".encode()
    der = subprocess.check_output(
        ["openssl", "dgst", "-sha256", "-sign", p8], input=signing_input
    )
    return f"{header}.{payload}.{b64url(der_ecdsa_to_rs(der))}"


def parse_groups_spec(spec: str | None) -> dict[str, Any]:
    raw = (spec or "").strip()
    if not raw or raw.lower() in ("none", "off", "0", "skip"):
        return {"mode": "none", "names": []}
    if raw.lower() in ("*", "all"):
        return {"mode": "all", "names": []}
    if raw.lower() in ("internal", "internal-only"):
        return {"mode": "internal", "names": []}
    names = [
        n.strip().lower()
        for n in raw.replace(";", ",").split(",")
        if n.strip()
    ]
    return {"mode": "names", "names": names}


def select_beta_groups(groups: list[dict[str, Any]], spec: str | None) -> list[dict[str, Any]]:
    parsed = parse_groups_spec(spec)
    if parsed["mode"] == "none":
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for g in groups:
        gid = str(g.get("id") or "").strip()
        name = str(g.get("name") or "").strip()
        internal = bool(g.get("isInternalGroup"))
        if not gid:
            continue
        if parsed["mode"] == "all":
            keep = True
        elif parsed["mode"] == "internal":
            keep = internal
        else:
            keep = name.lower() in parsed["names"]
        if keep and gid not in seen:
            seen.add(gid)
            out.append(g)
    return out


def parse_encryption_flag(raw: str | None) -> bool | None:
    v = (raw or "").strip().lower()
    if v in ("", "unset", "ask", "skip"):
        return None
    if v in ("0", "false", "no", "off"):
        return False
    if v in ("1", "true", "yes", "on"):
        return True
    raise ValueError(
        "BSL_ASC_USES_NON_EXEMPT_ENCRYPTION must be true, false, or empty"
    )


def group_from_api(item: dict[str, Any]) -> dict[str, Any]:
    attrs = item.get("attributes") if isinstance(item.get("attributes"), dict) else {}
    return {
        "id": str(item.get("id") or "").strip(),
        "name": str(attrs.get("name") or "").strip(),
        "isInternalGroup": bool(attrs.get("isInternalGroup")),
        "hasAccessToAllBuilds": bool(attrs.get("hasAccessToAllBuilds")),
    }


class AscClient:
    def __init__(self, key_id: str, issuer_id: str, p8: str):
        self.key_id = key_id
        self.issuer_id = issuer_id
        self.p8 = p8
        self.token = ""
        self.token_at = 0.0
        self.refresh()

    def refresh(self) -> None:
        self.token = make_jwt(self.key_id, self.issuer_id, self.p8)
        self.token_at = time.time()

    def request(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> tuple[int, Any]:
        if time.time() - self.token_at > 8 * 60:
            self.refresh()
        url = path if path.startswith("http") else ASC_BASE + path
        data = None if body is None else json.dumps(body).encode()
        headers = {
            "Authorization": "Bearer " + self.token,
            "Accept": "application/json",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = resp.read().decode("utf-8", "replace")
                parsed = json.loads(raw) if raw.strip() else {}
                return resp.status, parsed
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            if e.code == 401:
                self.refresh()
                if "Authorization" in headers:
                    req = urllib.request.Request(
                        url, data=data, method=method, headers={**headers, "Authorization": "Bearer " + self.token}
                    )
                    try:
                        with urllib.request.urlopen(req, timeout=45) as resp:
                            raw2 = resp.read().decode("utf-8", "replace")
                            parsed = json.loads(raw2) if raw2.strip() else {}
                            return resp.status, parsed
                    except urllib.error.HTTPError as e2:
                        raw = e2.read().decode("utf-8", "replace")
                        try:
                            return e2.code, json.loads(raw) if raw.strip() else {"error": raw}
                        except Exception:
                            return e2.code, {"error": raw}
            try:
                parsed = json.loads(raw) if raw.strip() else {"error": raw}
            except Exception:
                parsed = {"error": raw}
            return e.code, parsed

    def get_pages(self, path: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        next_path = path
        for _ in range(20):
            status, payload = self.request("GET", next_path)
            if status != 200 or not isinstance(payload, dict):
                raise RuntimeError(f"ASC GET {path} failed ({status}): {payload}")
            data = payload.get("data") or []
            if isinstance(data, list):
                items.extend([x for x in data if isinstance(x, dict)])
            nxt = (payload.get("links") or {}).get("next") if isinstance(payload.get("links"), dict) else None
            if not nxt:
                break
            next_path = str(nxt)
        return items


def included_by_type(payload: dict[str, Any], typ: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    included = payload.get("included") or []
    if not isinstance(included, list):
        return out
    for item in included:
        if isinstance(item, dict) and item.get("type") == typ and item.get("id"):
            out[str(item["id"])] = item
    return out


def find_app_id(client: AscClient, bundle_id: str) -> str:
    q = urllib.parse.urlencode({"filter[bundleId]": bundle_id, "limit": "10"})
    status, payload = client.request("GET", f"/v1/apps?{q}")
    if status != 200 or not isinstance(payload, dict):
        raise RuntimeError(f"ASC apps lookup failed ({status}): {payload}")
    for item in payload.get("data") or []:
        if not isinstance(item, dict):
            continue
        attrs = item.get("attributes") if isinstance(item.get("attributes"), dict) else {}
        bid = str(attrs.get("bundleId") or "").strip()
        if bid.lower() == bundle_id.lower() and item.get("id"):
            return str(item["id"])
    raise RuntimeError(f"No App Store Connect app for bundle id {bundle_id}")


def list_beta_groups(client: AscClient, app_id: str) -> list[dict[str, Any]]:
    q = urllib.parse.urlencode({"limit": "200"})
    items = client.get_pages(f"/v1/apps/{urllib.parse.quote(app_id)}/betaGroups?{q}")
    return [group_from_api(x) for x in items if group_from_api(x).get("id")]


def enable_auto_distribute(client: AscClient, group: dict[str, Any]) -> str:
    if not group.get("isInternalGroup"):
        return "skip-external"
    if group.get("hasAccessToAllBuilds"):
        return "already"
    gid = group["id"]
    body = {
        "data": {
            "type": "betaGroups",
            "id": gid,
            "attributes": {"hasAccessToAllBuilds": True},
        }
    }
    status, payload = client.request("PATCH", f"/v1/betaGroups/{urllib.parse.quote(gid)}", body)
    if status in (200, 204):
        group["hasAccessToAllBuilds"] = True
        return "enabled"
    # Some roles / external groups reject this attribute.
    print(
        f"Could not enable automatic distribution on {group.get('name') or gid} ({status}): {payload}",
        file=sys.stderr,
    )
    return "fail"


def assign_build(client: AscClient, group: dict[str, Any], build_id: str) -> str:
    gid = group["id"]
    body = {"data": [{"type": "builds", "id": build_id}]}
    status, payload = client.request(
        "POST",
        f"/v1/betaGroups/{urllib.parse.quote(gid)}/relationships/builds",
        body,
    )
    if status in (200, 204):
        return "assigned"
    err = json.dumps(payload)
    if status == 409 or "already" in err.lower() or "exists" in err.lower():
        return "already"
    print(
        f"Could not assign build to {group.get('name') or gid} ({status}): {payload}",
        file=sys.stderr,
    )
    return "fail"


def patch_encryption(client: AscClient, build_id: str, uses: bool) -> str:
    body = {
        "data": {
            "type": "builds",
            "id": build_id,
            "attributes": {"usesNonExemptEncryption": uses},
        }
    }
    status, payload = client.request("PATCH", f"/v1/builds/{urllib.parse.quote(build_id)}", body)
    if status in (200, 204):
        return "ok"
    print(f"Could not set export compliance on build ({status}): {payload}", file=sys.stderr)
    return "fail"


def pick_build(
    client: AscClient, app_id: str, version: str, short_version: str
) -> dict[str, Any] | None:
    params = {
        "filter[app]": app_id,
        "filter[version]": version,
        "limit": "20",
        "sort": "-uploadedDate",
        "include": "preReleaseVersion,buildBetaDetail",
    }
    if short_version:
        params["filter[preReleaseVersion.version]"] = short_version
    q = urllib.parse.urlencode(params)
    status, payload = client.request("GET", f"/v1/builds?{q}")
    if status != 200 or not isinstance(payload, dict):
        raise RuntimeError(f"ASC builds lookup failed ({status}): {payload}")
    prereleases = included_by_type(payload, "preReleaseVersions")
    details = included_by_type(payload, "buildBetaDetails")
    data = payload.get("data") or []
    if not isinstance(data, list):
        return None
    for item in data:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        attrs = item.get("attributes") if isinstance(item.get("attributes"), dict) else {}
        rel = item.get("relationships") if isinstance(item.get("relationships"), dict) else {}
        prv = ((rel.get("preReleaseVersion") or {}).get("data") or {}) if isinstance(rel.get("preReleaseVersion"), dict) else {}
        prv_id = str(prv.get("id") or "")
        prv_attrs = (prereleases.get(prv_id) or {}).get("attributes") or {}
        prv_ver = str(prv_attrs.get("version") or "")
        if short_version and prv_ver and prv_ver != short_version:
            continue
        detail_id = ""
        brel = rel.get("buildBetaDetail")
        if isinstance(brel, dict) and isinstance(brel.get("data"), dict):
            detail_id = str(brel["data"].get("id") or "")
        detail_attrs = (details.get(detail_id) or {}).get("attributes") or {}
        enc = attrs.get("usesNonExemptEncryption")
        return {
            "id": str(item["id"]),
            "processingState": str(attrs.get("processingState") or ""),
            "usesNonExemptEncryption": enc,
            "internalBuildState": str(detail_attrs.get("internalBuildState") or ""),
            "expired": bool(attrs.get("expired")),
            "version": str(attrs.get("version") or version),
            "shortVersion": prv_ver or short_version,
        }
    return None


def wait_for_build(
    client: AscClient,
    app_id: str,
    version: str,
    short_version: str,
    timeout: int,
    poll: int,
    encryption: bool | None,
) -> dict[str, Any] | None:
    deadline = time.time() + max(timeout, 1)
    last_state = ""
    while time.time() < deadline:
        build = pick_build(client, app_id, version, short_version)
        if build:
            state = build.get("processingState") or "UNKNOWN"
            internal = build.get("internalBuildState") or ""
            label = state + (f"/{internal}" if internal else "")
            if label != last_state:
                print(f"TestFlight build {build['id']} state: {label}", flush=True)
                last_state = label
            if build.get("expired"):
                raise RuntimeError("Matched TestFlight build is expired")
            if state in ("FAILED", "INVALID"):
                raise RuntimeError(f"TestFlight processing {state} for build {build['id']}")
            if state == "VALID":
                enc = build.get("usesNonExemptEncryption")
                missing = enc is None or str(internal).upper() == "MISSING_COMPLIANCE"
                if missing and encryption is not None:
                    print(
                        f"Submitting export compliance usesNonExemptEncryption={str(encryption).lower()}…",
                        flush=True,
                    )
                    if patch_encryption(client, build["id"], encryption) == "ok":
                        build["usesNonExemptEncryption"] = encryption
                        missing = False
                    else:
                        time.sleep(max(poll, 5))
                        continue
                if missing:
                    print(
                        "Build is Missing Compliance. Testers cannot install until you "
                        "answer Export Compliance in App Store Connect, set "
                        "ITSAppUsesNonExemptEncryption in Info.plist, or set "
                        "BSL_ASC_USES_NON_EXEMPT_ENCRYPTION=false in .env.",
                        flush=True,
                    )
                    return build
                return build
        else:
            if last_state != "WAITING":
                print("Waiting for the uploaded build to appear in App Store Connect…", flush=True)
                last_state = "WAITING"
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        time.sleep(min(max(poll, 5), remaining))
    return pick_build(client, app_id, version, short_version)


def print_select(groups_json: str, spec: str) -> int:
    payload = json.loads(groups_json)
    groups = payload if isinstance(payload, list) else payload.get("data") or []
    normalized = []
    for g in groups:
        if not isinstance(g, dict):
            continue
        if "attributes" in g:
            normalized.append(group_from_api(g))
        else:
            normalized.append(
                {
                    "id": str(g.get("id") or ""),
                    "name": str(g.get("name") or ""),
                    "isInternalGroup": bool(g.get("isInternalGroup")),
                    "hasAccessToAllBuilds": bool(g.get("hasAccessToAllBuilds")),
                }
            )
    selected = select_beta_groups(normalized, spec)
    for g in selected:
        auto = "1" if g.get("hasAccessToAllBuilds") else "0"
        kind = "internal" if g.get("isInternalGroup") else "external"
        print(f"{g['id']}\t{g['name']}\t{kind}\tauto={auto}")
    return 0


def dry_run_plan(args: argparse.Namespace) -> int:
    spec = parse_groups_spec(args.groups)
    enc = parse_encryption_flag(args.encryption)
    auto = args.auto_distribute
    print("DRY_RUN: TestFlight tester assignment plan")
    if auto:
        print("DRY_RUN: enable Automatic Distribution on internal TestFlight groups (hasAccessToAllBuilds)")
    else:
        print("DRY_RUN: skip enabling Automatic Distribution (BSL_ASC_AUTO_DISTRIBUTE=0)")
    if spec["mode"] == "none":
        print("DRY_RUN: not assigning this build to groups (set BSL_ASC_BETA_GROUPS=internal to wait and attach)")
    else:
        print(f"DRY_RUN: wait for processing, then assign groups spec={args.groups!r}")
    if enc is None:
        print("DRY_RUN: leave Export Compliance unchanged (set BSL_ASC_USES_NON_EXEMPT_ENCRYPTION=false to submit via API)")
    else:
        print(f"DRY_RUN: submit usesNonExemptEncryption={str(enc).lower()} after processing")
    print("TESTFLIGHT_DISTRIBUTE=dry-run")
    return 0


def run(args: argparse.Namespace) -> int:
    if args.select_groups:
        return print_select(sys.stdin.read() or "[]", args.groups or "internal")
    if args.dry_run:
        return dry_run_plan(args)

    if not args.bundle_id:
        print("asc_distribute.py requires --bundle-id", file=sys.stderr)
        print("TESTFLIGHT_DISTRIBUTE=fail")
        return 2
    if not args.key_id or not args.issuer_id or not args.p8:
        print("ASC API key is required to assign TestFlight groups.", file=sys.stderr)
        print("TESTFLIGHT_DISTRIBUTE=fail")
        return 2

    try:
        encryption = parse_encryption_flag(args.encryption)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        print("TESTFLIGHT_DISTRIBUTE=fail")
        return 2

    spec = parse_groups_spec(args.groups)
    need_wait = spec["mode"] != "none" or encryption is not None
    if not args.auto_distribute and spec["mode"] == "none" and encryption is None:
        print("TESTFLIGHT_DISTRIBUTE=skipped")
        print(
            "Hint: enable Automatic Distribution on an Internal group in App Store Connect, "
            "or set BSL_ASC_BETA_GROUPS=internal / BSL_ASC_AUTO_DISTRIBUTE=1."
        )
        return 0

    try:
        client = AscClient(args.key_id, args.issuer_id, args.p8)
        app_id = find_app_id(client, args.bundle_id)
        groups = list_beta_groups(client, app_id)
    except Exception as e:
        print(f"ASC TestFlight group lookup failed: {e}", file=sys.stderr)
        print("TESTFLIGHT_DISTRIBUTE=fail")
        return 2

    if not groups:
        print("TESTFLIGHT_DISTRIBUTE=skipped")
        print(
            "No TestFlight groups exist yet. One-time in App Store Connect → TestFlight → Testers:\n"
            "  1. Create an Internal group and add yourself.\n"
            "  2. Enable Automatic Distribution on that group (then new builds skip the Groups + button).\n"
            "Re-upload (or run upload-testflight.sh --assign-only) after the group exists."
        )
        return 0

    names = ", ".join(g["name"] or g["id"] for g in groups)
    print(f"Found TestFlight groups: {names}", flush=True)

    auto_targets = [g for g in groups if g.get("isInternalGroup")] if args.auto_distribute else []
    enabled: list[str] = []
    for g in auto_targets:
        result = enable_auto_distribute(client, g)
        label = g.get("name") or g["id"]
        if result == "enabled":
            print(f"Enabled Automatic Distribution on internal group {label!r} (future builds skip ASC assignment).", flush=True)
            enabled.append(label)
        elif result == "already":
            print(f"Internal group {label!r} already has Automatic Distribution.", flush=True)
            enabled.append(label)

    assign_targets = select_beta_groups(groups, args.groups)
    missing_names: list[str] = []
    if spec["mode"] == "names":
        have = {str(g.get("name") or "").strip().lower() for g in groups}
        missing_names = [n for n in spec["names"] if n not in have]
        if missing_names:
            print(
                "No TestFlight group named: " + ", ".join(missing_names) + f" (have: {names})",
                file=sys.stderr,
            )

    if not need_wait:
        if enabled:
            print("TESTFLIGHT_DISTRIBUTE=ok")
            print("TESTFLIGHT_DISTRIBUTE_GROUPS=" + ", ".join(enabled))
        else:
            print("TESTFLIGHT_DISTRIBUTE=skipped")
            if not auto_targets:
                print(
                    "No internal TestFlight groups to auto-distribute. Create an Internal group "
                    "and add testers, or set BSL_ASC_BETA_GROUPS to an existing group name."
                )
        return 0

    if not args.bundle_version:
        print("Waiting for processing requires --bundle-version (CFBundleVersion).", file=sys.stderr)
        print("TESTFLIGHT_DISTRIBUTE=fail")
        return 2

    print(
        f"Waiting up to {args.timeout}s for build {args.bundle_short_version or '?'} ({args.bundle_version}) to finish processing…",
        flush=True,
    )
    try:
        build = wait_for_build(
            client,
            app_id,
            args.bundle_version,
            args.bundle_short_version or "",
            args.timeout,
            args.poll,
            encryption,
        )
    except Exception as e:
        print(f"TestFlight processing wait failed: {e}", file=sys.stderr)
        print("TESTFLIGHT_DISTRIBUTE=fail")
        return 2

    if not build:
        print("TESTFLIGHT_DISTRIBUTE=timeout")
        print(
            "Upload is in App Store Connect but processing did not finish in time. "
            "When the build is Ready to Test, re-run with --assign-only or assign groups in ASC."
        )
        return 0

    assigned: list[str] = []
    failed = 0
    for g in assign_targets:
        result = assign_build(client, g, build["id"])
        label = g.get("name") or g["id"]
        if result in ("assigned", "already"):
            print(f"Assigned build to TestFlight group {label!r}.", flush=True)
            assigned.append(label)
        else:
            failed += 1

    if assign_targets and not assigned and failed:
        print("TESTFLIGHT_DISTRIBUTE=fail")
        return 2
    print("TESTFLIGHT_DISTRIBUTE=ok")
    shown = assigned or enabled
    if shown:
        print("TESTFLIGHT_DISTRIBUTE_GROUPS=" + ", ".join(shown))
    if missing_names:
        return 2
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Assign TestFlight builds to beta groups")
    p.add_argument("--bundle-id", default="")
    p.add_argument("--bundle-version", default="")
    p.add_argument("--bundle-short-version", default="")
    p.add_argument("--key-id", default="")
    p.add_argument("--issuer-id", default="")
    p.add_argument("--p8", default="")
    p.add_argument("--groups", default="")
    p.add_argument("--encryption", default="")
    p.add_argument("--auto-distribute", action="store_true")
    p.add_argument("--timeout", type=int, default=900)
    p.add_argument("--poll", type=int, default=20)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--select-groups", action="store_true")
    args = p.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
