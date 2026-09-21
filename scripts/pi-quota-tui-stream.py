#!/usr/bin/env python3
"""Real-TUI quota on/off streaming-interaction verification (phase quota A).

Drives the real Pi 0.85.1 TUI with the deterministic in-process fixture provider
(zero network, zero credentials, zero billing) and the working-tree HUD with the
quota feature ENABLED in config. The configured profile deliberately matches no
provider, so the quota row shows the `no quota source` marker and no network task
exists — the live networked path is separately evidenced by the real-account E2E
(scripts/pi-quota-e2e.py, docs/quota-live-e2e.json).

Checks, each against the live PTY:
  1. mid-stream typing and a full measured stream with quota enabled: the HUD
     stays within the terminal width, the quota marker renders, the activity is
     `working` during the stream and `ready` after settle;
  2. `/hud quota off` mid-stream: acknowledged immediately, quota marker gone,
     stream completes undisturbed;
  3. `/hud quota on` after settle: marker returns; `/hud quotas` answers;
  4. narrow resize (120 -> 42): rows never exceed the width with quota enabled.

Usage: python3 scripts/pi-quota-tui-stream.py [--json=docs/quota-tui-stream.json]
"""
import argparse
import json
import pathlib
import shutil
import sys
import tempfile
import time

SCRIPTS = pathlib.Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("pi_live_scenarios", SCRIPTS / "pi-live-scenarios.py")
live = importlib.util.module_from_spec(_spec)
sys.modules["pi_live_scenarios"] = live
_spec.loader.exec_module(live)

QUOTA_CONFIG = {
    "version": 1, "preset": "balanced", "surface": "footer", "language": "en",
    "quota": {
        "enabled": True, "ttlMs": 300000, "timeoutMs": 5000,
        "profiles": [
            {"id": "glm-personal", "providerId": "zai-coding-cn", "adapter": "zai",
             "source": "pi", "region": "cn", "plan": "personal", "queryMode": "personal-legacy"},
        ],
    },
}


def visible_width_limited(plain, cols):
    for line in plain.splitlines():
        if not line.strip():
            continue
        if len(line) > cols + 2:  # allow the wrap marker slack the harness tolerates
            return False, line[:80]
    return True, ""


def command(host, text):
    # No Escape prefix: the palette must not intercept the slash command.
    host.send((text + "\r").encode())


def typeahead(host, text):
    host.send(text.encode())


def main() -> int:
    directory = pathlib.Path(tempfile.mkdtemp(prefix="pi-hud-quota-tui-"))
    results = []
    host = live.LiveHost(directory, [live.HUD, live.PROVIDER], QUOTA_CONFIG, extra_env=live.LONG_ENV)
    try:
        host.wait_for_plain("ready", timeout=60)
        host.pump(1.0)
        marker_at_start = "no quota source" in host.plain()
        results.append({"check": "quota marker with enabled-but-unmatched profile", "passed": marker_at_start})

        # 1. Mid-stream typing with quota enabled.
        host.send(b"FIXTURE:LONGREPLY:quota-on\r")
        host.wait_for_plain("working", timeout=30)
        host.pump(0.4)
        typeahead(host, "typed during stream with quota on")
        time.sleep(1.0)
        host.resize(50, 120)
        host.pump(0.5)
        plain = host.plain()
        limited, offender = visible_width_limited(plain, 120)
        results.append({"check": "mid-stream rows within width with quota on", "passed": limited, "offender": offender[:60] if offender else None})
        host.wait_for_plain("ready", timeout=90)
        host.pump(0.8)
        completed = "ready" in host.plain()
        results.append({"check": "stream completes with quota on", "passed": completed})

        # 2. /hud quota off mid-stream, then a second stream.
        host.send(b"FIXTURE:LONGREPLY:quota-off\r")
        host.wait_for_plain("working", timeout=30)
        command(host, "/hud quota off")
        host.pump(1.5)
        plain = host.plain()
        off_ack = "quota off" in plain
        marker_gone = "no quota source" not in plain.split("quota off")[-1][:4000] if off_ack else False
        results.append({"check": "/hud quota off acknowledged mid-stream", "passed": off_ack and marker_gone})
        host.wait_for_plain("ready", timeout=90)
        results.append({"check": "stream completes after quota off", "passed": "ready" in host.plain()})

        # 3. Re-enable, quotas command, narrow resize.
        command(host, "/hud quota on")
        host.pump(1.2)
        results.append({"check": "/hud quota on restores the marker", "passed": "no quota source" in host.plain()})
        command(host, "/hud quotas")
        host.pump(3.0)
        plain = host.plain()
        quotas_ok = ('"enabled"' in plain and "true" in plain and '"profiles"' in plain) or "unconfigured" in plain
        results.append({"check": "/hud quotas answers with quota on", "passed": quotas_ok})
        host.resize(50, 42)
        narrow_frame = host.repaint(rows=50, cols=42)
        overflow = live.hud_overflow(narrow_frame, 42)
        marker_visible_narrow = "no quota source" not in narrow_frame
        results.append({"check": "narrow 42-col HUD rows stay within width", "passed": not overflow,
                        "offender": overflow[0][:60] if overflow else None})
        results.append({"check": "quota marker folds away on narrow rows", "passed": marker_visible_narrow})
    finally:
        host.close()
        shutil.rmtree(directory, ignore_errors=True)
    passed = all(item["passed"] for item in results)
    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "passed": passed, "checks": results,
              "note": "fixture provider (no network); quota profile intentionally unmatched so the check exercises the enabled-quota rendering and lifecycle without live credentials; the networked path is covered by docs/quota-live-e2e.json"}
    destination = None
    for argument in sys.argv[1:]:
        if argument.startswith("--json="):
            destination = argument.split("=", 1)[1]
    if destination:
        pathlib.Path(destination).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
