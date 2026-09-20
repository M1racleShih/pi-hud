#!/usr/bin/env python3
"""Live-TUI protocol scenarios for the default-footer decision's condition 4.

Drives the REAL Pi 0.85.1 TUI in a disposable PTY with the deterministic
in-process fixture provider (zero network/credentials/billing), reusing the B2b
host-acceptance harness (PiHost, file oracle, ledger waiters). Nothing from the
real user account is read or written.

Scenarios (each in a fresh process):
  A  resize-mid-stream   resizes the terminal (120 -> 47 -> 92, four SIGWINCHes)
                         while a ~5.5s measured stream (LONGREPLY, atomic
                         «word-START»/«END» markers) is in flight, once per
                         surface (widget and footer); asserts the stream
                         completes, HUD rows never exceed the current width
                         (mid-stream and settled), the activity row was
                         `working` during the resize window, and the session
                         ledger still equals the independent file oracle.
  B  compact-mid-measure submits /compact while a measured stream is in flight
                         (recording whether the host queues it behind the turn);
                         after filler-grown context the compaction is counted
                         exactly once, the ledger totals stay oracle-equal and
                         the compaction counter becomes visible.
  C  abort-retry         aborts a measured stream mid-flight with Escape, waits
                         for the settled activity, compares the ledger against
                         the file oracle (whatever the host committed for the
                         aborted turn), then retries the same prompt to a full
                         completion and re-compares.
  D  concurrent-widget   an independent second extension widget coexists with
                         the HUD widget: /hud off|on, surface footer|widget and
                         /other-widget off|on must never disturb the other
                         extension's widget, and the HUD rows stay within width.

Every ledger comparison goes through scripts/session-file-oracle.mjs over the
live session file. Requires the isolated pinned SDK install under .tmp/sdk.

Usage: python3 scripts/pi-live-scenarios.py [--json=docs/live-protocol-scenarios.json]
       python3 scripts/pi-live-scenarios.py --scenarios=resize,compact,abort,widget
"""
import argparse
import fcntl
import json
import os
import pathlib
import pty
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

SCRIPTS = pathlib.Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("pi_host_acceptance", SCRIPTS / "pi-host-acceptance.py")
b2b = importlib.util.module_from_spec(_spec)
sys.modules["pi_host_acceptance"] = b2b
_spec.loader.exec_module(b2b)  # shared B2b harness (dashed filename, safe: __main__ guarded)

NODE = b2b.NODE
SDK = b2b.SDK
HUD = b2b.HUD
PROVIDER = b2b.PROVIDER
OTHER_WIDGET = ROOT / "tests/fixtures/other-widget.ts"

# Long stream: 220 body deltas * 25 ms ~= 5.5 s, leaving a comfortable window
# for two manual resizes plus two repaint cycles while the stream is in flight.
LONG_ENV = {"FIXTURE_LONG_CHUNKS": "220", "FIXTURE_LONG_DELAY_MS": "25"}


class LiveHost(b2b.PiHost):
    """PiHost with extra child environment (fixture stream pacing)."""

    def __init__(self, home, extensions, config, extra_env=None, session_file=None, term=(50, 120)):
        self.home = home
        (home / "agent").mkdir(parents=True, exist_ok=True)
        (home / "ws").mkdir(parents=True, exist_ok=True)
        (home / "ws/notes.txt").write_text("fixture workspace file for the live-protocol scenarios\n")
        self.config_path = home / "agent/pi-hud.json"
        self.config_path.write_text(json.dumps(config))
        env = {
            "PATH": os.environ.get("PATH", ""), "HOME": str(home), "TERM": "xterm-256color",
            "LANG": "C.UTF-8", "PI_CODING_AGENT_DIR": str(home / "agent"),
            "PI_HUD_CONFIG": str(self.config_path), "PI_OFFLINE": "1",
        }
        env.update(extra_env or {})
        args = [NODE, str(SDK / "dist/bundle/cli.js"), "--no-extensions"]
        for extension in extensions:
            args += ["-e", str(extension)]
        args += ["--provider", "fixture", "--model", "fixture-alpha"]
        if session_file is not None:
            args += ["--session", str(session_file)]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(home / "ws")
            os.execve(NODE, args, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", term[0], term[1], 0, 0))
        self.seen = bytearray()

    def resize(self, rows, cols):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)

    def alive(self):
        done, _ = os.waitpid(self.pid, os.WNOHANG)
        return done == 0

    def status_totals(self):
        """B2b-compatible but stale-frame-safe /hud status totals reader.

        The B2b variant can match a totals frame still queued in the kernel PTY
        buffer when called back-to-back (clear() only wipes the Python side). This
        one drains first, closes any open popup, then parses the LAST totals match
        and the LAST occurrence of every diagnostic field - always the newest frame."""
        import re as _re
        self.pump(0.3)          # drain in-flight output (old popup tails included)
        self.seen.clear()
        self.send(b"\x1b")      # close any popup left open by a previous command
        self.pump(0.3)
        self.seen.clear()
        self.send(b"/hud status\r")
        self.wait_for(b'"totals"', timeout=15)
        self.pump(0.8)
        text = self.plain()
        matches = list(b2b.TOTALS_PATTERN.finditer(text))
        if not matches:
            raise RuntimeError(f"no totals in /hud status output:\n{text[-2000:]}")
        input_, output, cache_read, cache_write, cost, known, missing = matches[-1].groups()
        def last_field(key):
            found = list(b2b.field_pattern(key).finditer(text))
            return found[-1].group(1).strip('"') if found else None
        fields = {}
        for key in ("status", "updating", "rebuilds", "recoveryRebuilds", "failureReason", "usageRecords", "examinedEntries", "lastBaselineMs", "maxChunkMs"):
            value = last_field(key)
            if value is not None:
                fields[key] = value
        get_entries = list(_re.finditer(r'"getEntries":\s*(\d+)', text))
        fields["getEntries"] = int(get_entries[-1].group(1)) if get_entries else None
        return {
            "input": int(input_), "output": int(output), "cacheRead": int(cache_read),
            "cacheWrite": int(cache_write), "cost": float(cost),
            "costKnown": int(known), "costMissing": int(missing),
            **fields,
        }


def hud_overflow(frame: str, width: int, tolerance: int = 2):
    """Lines carrying HUD/other-widget markers must not exceed the terminal width."""
    markers = ("ctx(last)", "OTHER-WIDGET-ACTIVE", "working", "ready")
    return [line for line in frame.splitlines()
            if any(marker in line for marker in markers) and len(line) > width + tolerance]


def wait_ledger_oracle(host, session_file, timeout: float = 25.0):
    """Poll until the ledger totals equal a FRESH file oracle and the ledger is quiet.
    The file is re-read every poll: commits land asynchronously, so a single early
    oracle read can legitimately differ from a not-yet-reconciled ledger."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        totals = host.status_totals()
        oracle = b2b.file_oracle(session_file)
        last = (totals, oracle)
        ok = all(totals[k] == oracle[k] for k in ("input", "output", "cacheRead", "cacheWrite")) \
            and abs(totals["cost"] - oracle["cost"]) <= 1e-6 * max(1.0, abs(oracle["cost"])) \
            and totals.get("updating") in ("false", None)
        if ok:
            return totals, oracle
        time.sleep(0.5)
    raise RuntimeError(f"ledger never converged to the file oracle: {last!r}")


def dismiss(host):
    """Close the /hud status popup (any leftover overlay) before typing a prompt."""
    host.send(b"\x1b")
    host.pump(0.3)


def start_session_host(directory, config, extensions=None, size=150, term=(50, 120)):
    session_file = b2b.build_session(directory, size, "linear")
    host = LiveHost(directory, extensions or [HUD, PROVIDER], config, extra_env=LONG_ENV,
                    session_file=session_file, term=term)
    host.wait_for(b"sess*", timeout=40)
    host.send(b"\x1b")
    host.pump(0.8)
    return host, session_file


RESULTS = []


def record(scenario, passed, details):
    RESULTS.append({"scenario": scenario, "passed": bool(passed), **details})
    print(f"{'PASS' if passed else 'FAIL'}: {scenario}" + (f" - {details.get('note','')}" if details.get("note") else ""))
    if not passed:
        print(json.dumps(details, indent=2, default=str))


def scenario_resize_mid_stream(directory, surface):
    directory.mkdir(parents=True, exist_ok=True)
    host, session_file = start_session_host(directory, {"preset": "full", "usageScope": "session", "surface": surface})
    try:
        before = b2b.wait_ledger_ready(host)
        dismiss(host)
        host.send(b"FIXTURE:LONGREPLY:rsz\r")
        host.wait_for_plain("«rsz-START»", timeout=30)
        first_content_at = time.monotonic()
        # Mid-stream resize #1 + clean frame at 47 columns (repaint itself sends
        # two more SIGWINCHes: 48 then 47 - four resize events total mid-stream).
        mid_frame = host.repaint(rows=30, cols=47)
        mid_overflows = hud_overflow(mid_frame, 47)
        mid_working = "working" in mid_frame
        # Mid-stream resize #2: straight to 92 columns while still streaming.
        host.resize(40, 92)
        host.pump(0.4)
        mid_stream_alive = host.alive()
        host.wait_for_plain("«END»", timeout=45)
        completion_at = time.monotonic()
        host.wait_for_plain("ready", timeout=20)
        settled_frame = host.repaint(rows=40, cols=92)
        settled_overflows = hud_overflow(settled_frame, 92)
        totals, oracle = wait_ledger_oracle(host, session_file)
        b2b.compare_totals(f"resize-mid-stream/{surface}", totals, oracle)
        stream_seconds = round(completion_at - first_content_at, 2)
        record(f"resize-mid-stream-{surface}", (
            not mid_overflows and not settled_overflows and mid_working and mid_stream_alive
        ), {
            "note": "terminal resized 120->47->92 (4 SIGWINCH) during a measured LONGREPLY stream; stream completed, HUD rows within width, ledger == file oracle",
            "workingDuringResize": mid_working,
            "midStreamAlive": mid_stream_alive,
            "midOverflowLines47": mid_overflows,
            "settledOverflowLines92": settled_overflows,
            "streamSeconds": stream_seconds,
            "ledger": {k: totals[k] for k in ("input", "output", "usageRecords")},
        })
    finally:
        host.close()


def scenario_compact_mid_measurement(directory):
    directory.mkdir(parents=True, exist_ok=True)
    host, session_file = start_session_host(directory, {"preset": "full", "usageScope": "session", "surface": "footer"}, size=300)
    try:
        before = b2b.wait_ledger_ready(host)
        # Grow real context so a compaction has work to do (mirrors B2b compact-twice).
        for _ in range(4):
            host.send(b"FIXTURE:FILLER:100\r")
            host.wait_for_plain("fixture token history window ledger", timeout=90)
            host.pump(1.0)
        grown = b2b.wait_ledger_growth(host, before["input"])
        dismiss(host)
        host.send(b"FIXTURE:LONGREPLY:cmp\r")
        host.wait_for_plain("«cmp-START»", timeout=30)
        # Submit /compact while the stream is in flight. Observed host behavior:
        # the in-flight submission INTERRUPTS the running stream (no «END» terminator)
        # and runs the compaction on the settled conversation. If a future host
        # instead drops the submission, the fallback resends it settled. Either way
        # the compaction must reconcile exactly once.
        host.send(b"/compact\r")
        queued_accepted = True
        try:
            host.wait_for_plain("compactions* 1", timeout=90)
        except RuntimeError:
            queued_accepted = False  # the in-flight submission was dropped: retry settled
            host.wait_for_plain("ready", timeout=30)
            dismiss(host)
            host.send(b"/compact\r")
            host.wait_for_plain("compactions* 1", timeout=90)
        stream_completed = "«END»" in host.plain()  # False when the queued command aborted the stream
        host.wait_for_plain("ready", timeout=30)
        after, oracle = wait_ledger_oracle(host, session_file)
        b2b.compare_totals("compact-mid-measure", after, oracle)
        compactions = sum(1 for line in session_file.read_text().splitlines() if '"type":"session_compact"' in line)
        record("compact-mid-measurement", after["input"] > grown["input"] and host.alive(), {
            "note": "/compact submitted mid-stream (observed: the host interrupts the running stream and runs the compaction); compaction counted exactly once, ledger == file oracle",
            "midStreamSubmissionAccepted": queued_accepted,
            "streamCompletedAfterSubmission": stream_completed,
            "sessionCompactEventsInFile": compactions,
            "beforeInput": grown["input"], "afterInput": after["input"],
            "rebuilds": after.get("rebuilds"), "failureReason": after.get("failureReason"),
        })
    finally:
        host.close()


def scenario_abort_retry(directory):
    directory.mkdir(parents=True, exist_ok=True)
    host, session_file = start_session_host(directory, {"preset": "full", "usageScope": "session", "surface": "footer"})
    try:
        before = b2b.wait_ledger_ready(host)
        dismiss(host)
        host.send(b"FIXTURE:LONGREPLY:abr\r")
        host.wait_for_plain("«abr-START»", timeout=30)
        host.pump(1.0)  # let several body deltas land before the abort
        host.seen.clear()  # fresh-readiness: old ready frames must not match
        host.send(b"\x1b")  # Escape aborts the running turn
        host.wait_for_plain("ready", timeout=20)
        aborted_frame = host.plain()
        terminator_seen = "«END»" in aborted_frame  # a real abort never reaches the terminator
        aborted_totals, _ = wait_ledger_oracle(host, session_file)
        # Retry the same prompt to a full completion.
        dismiss(host)
        host.send(b"FIXTURE:LONGREPLY:abr\r")
        host.wait_for_plain("«END»", timeout=45)
        host.wait_for_plain("ready", timeout=20)
        end_seen = "«END»" in host.plain()  # capture before oracle polling clears the buffer
        retried_totals, oracle = wait_ledger_oracle(host, session_file)
        record("abort-retry", (not terminator_seen) and end_seen and host.alive()
               and retried_totals["input"] > aborted_totals["input"], {
            "note": "Escape aborted a measured stream mid-flight (terminator never reached); ledger == file oracle after the abort and after the full retry",
            "settledAfterAbort": "ready" in aborted_frame,
            "terminatorSeenDuringAbort": terminator_seen,
            "abortedTotals": {k: aborted_totals[k] for k in ("input", "usageRecords")},
            "retriedTotals": {k: retried_totals[k] for k in ("input", "usageRecords")},
        })
    finally:
        host.close()


def scenario_concurrent_widget(directory):
    directory.mkdir(parents=True, exist_ok=True)
    host, session_file = start_session_host(
        directory, {"preset": "full", "usageScope": "session", "surface": "widget"},
        extensions=[HUD, PROVIDER, OTHER_WIDGET])
    try:
        host.pump(1.0)
        frame = host.repaint(rows=50, cols=120)
        both = "ctx(last)" in frame and "OTHER-WIDGET-ACTIVE" in frame
        overflow = hud_overflow(frame, 120)
        host.send(b"/hud off\r")
        host.pump(1.2)
        off_frame = host.repaint(rows=50, cols=120)
        hud_off = "ctx(last)" not in off_frame
        other_survives_off = "OTHER-WIDGET-ACTIVE" in off_frame
        host.send(b"/hud on\r")
        host.wait_for_plain("ctx(last)", timeout=15)
        host.pump(0.8)
        on_frame = host.repaint(rows=50, cols=120)
        both_again = "ctx(last)" in on_frame and "OTHER-WIDGET-ACTIVE" in on_frame
        host.send(b"/hud surface footer\r")
        host.pump(1.5)
        footer_frame = host.repaint(rows=50, cols=120)
        footer_coexist = "ctx(last)" in footer_frame and "OTHER-WIDGET-ACTIVE" in footer_frame
        host.send(b"/hud surface widget\r")
        host.pump(1.5)
        back_frame = host.repaint(rows=50, cols=120)
        back_coexist = "ctx(last)" in back_frame and "OTHER-WIDGET-ACTIVE" in back_frame
        host.send(b"/other-widget off\r")
        host.pump(1.0)
        gone_frame = host.repaint(rows=50, cols=120)
        other_gone = "OTHER-WIDGET-ACTIVE" not in gone_frame
        hud_stays = "ctx(last)" in gone_frame
        totals, oracle = wait_ledger_oracle(host, session_file)
        b2b.compare_totals("concurrent-widget", totals, oracle)
        record("concurrent-widget", (
            both and not overflow and hud_off and other_survives_off and both_again
            and footer_coexist and back_coexist and other_gone and hud_stays
        ), {
            "note": "independent second extension widget coexists with the HUD widget; HUD on/off, surface switches and /other-widget off never disturb the other widget",
            "coexistAtStartup": both,
            "hudOffIsolatesOther": hud_off and other_survives_off,
            "coexistAfterHudOn": both_again,
            "coexistInFooterMode": footer_coexist,
            "coexistAfterSurfaceBack": back_coexist,
            "otherOffKeepsHud": other_gone and hud_stays,
            "overflowLines": overflow,
        })
    finally:
        host.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", default=None)
    parser.add_argument("--scenarios", default="resize,compact,abort,widget")
    args = parser.parse_args()
    if not SDK.exists():
        raise RuntimeError("pinned SDK not installed under .tmp/sdk (see DEVELOPMENT.md)")
    wanted = set(args.scenarios.split(","))
    started = time.time()
    with tempfile.TemporaryDirectory(prefix="pi-hud-live-") as directory:
        base = pathlib.Path(directory)
        if "resize" in wanted:
            scenario_resize_mid_stream(base / "resize-widget", "widget")
            scenario_resize_mid_stream(base / "resize-footer", "footer")
        if "compact" in wanted:
            scenario_compact_mid_measurement(base / "compact")
        if "abort" in wanted:
            scenario_abort_retry(base / "abort")
        if "widget" in wanted:
            scenario_concurrent_widget(base / "widget")
    passed = all(entry["passed"] for entry in RESULTS)
    record_out = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "passed": passed,
        "provenance": b2b.provenance(),
        "durationSeconds": round(time.time() - started, 1),
        "environment": {
            "node": subprocess.run([NODE, "--version"], capture_output=True, text=True).stdout.strip(),
            "pi": "0.85.1 (isolated .tmp/sdk)",
            "provider": "deterministic in-process fixture (zero network/billing)",
        },
        "results": RESULTS,
    }
    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(record_out, indent=2, default=str) + "\n")
    print(json.dumps({"passed": passed, "scenarios": len(RESULTS)}, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
