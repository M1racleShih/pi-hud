#!/usr/bin/env python3
"""B2b real-Pi-host acceptance for the session usage ledger and footer coexistence.

Drives the REAL Pi 1.0.2 TUI in a disposable PTY with:
  - the deterministic in-process fixture provider (tests/fixtures/fixture-provider.ts,
    zero network, zero credentials, zero billing),
  - the HUD under test (index.ts) with usageScope: session,
  - scenario fixtures: a post-HUD async message_end replacer and an independent
    second footer extension,
  - isolated HOME/workspace (nothing from the real user account is read or written).

Scenarios (each in a fresh process unless noted):
  1  resume-10k      resume a 10,000-entry branched fixture session; ledger totals must
                     equal the independent file oracle; report the real-host baseline
                     time from /hud status diagnostics
  2  live-turn       one scripted model turn with a real `read` tool call; incremental
                     reconciliation through turn_end (getEntries stays at 1)
  3  compact-twice   /compact twice; the fixture provider returns the SAME summary text
                     both times; both compaction usages counted exactly once
  4  tree-branch     /tree navigation to an earlier user message, edited resubmit
                     (new branch), then /tree back to the ROOT user message (leaf reset)
                     and a new root-level append; totals stay equal to the file oracle
  5  model-switch    switch fixture-alpha -> fixture-beta mid-session; totals keep
                     accumulating across models
  6  fast-switch     switch sessions while the 10k baseline is still slicing; the stale
                     generation must never publish; the new session's totals are exact
  7  dual-footer     two footer extensions, BOTH load orders: the later installer owns
                     the slot; the HUD stays suppressed without clearing the other
                     footer; /hud surface footer re-claims; off restores the native one
  8  replacer        a post-HUD async message_end replacement extension doubles usage;
                     the ledger must count the FINAL committed record (doubled), never
                     the event usage the HUD observed

Every scenario compares the ledger's published totals (parsed from /hud status) with
scripts/session-file-oracle.mjs over the live session file. Requires the isolated
pinned SDK install under .tmp/sdk. No model requests leave the process.

Usage: python3 scripts/pi-host-acceptance.py [--json=docs/host-acceptance-b2b.json]
"""
import argparse
import errno
import fcntl
import hashlib
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
SDK = ROOT / ".tmp/sdk/node_modules/@earendil-works/pi-coding-agent"
NODE = shutil.which("node")
TOTALS_PATTERN = re.compile(
    r'"totals":\s*\{\s*"input":\s*(\d+),\s*"output":\s*(\d+),\s*"cacheRead":\s*(\d+),'
    r'\s*"cacheWrite":\s*(\d+),\s*"cost":\s*([0-9.eE+-]+),\s*"costKnown":\s*(\d+),\s*"costMissing":\s*(\d+)', re.S)
def field_pattern(key):
    return re.compile(r'"' + key + r'":\s*("?[^",\n}]+)"?,')
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[<>\"][a-zA-Z]")


class PiHost:
    """One real Pi TUI process in a disposable PTY + workspace."""

    def __init__(self, home: pathlib.Path, extensions, config, provider=True, session_file=None, name=None, offline=True, term=(50, 120)):
        self.home = home
        (home / "agent").mkdir(parents=True, exist_ok=True)
        (home / "ws").mkdir(parents=True, exist_ok=True)
        (home / "ws" / "notes.txt").write_text("fixture workspace file for the B2b host acceptance\n")
        self.config_path = home / "agent" / "pi-hud.json"
        self.config_path.write_text(json.dumps(config))
        self.session_file = session_file
        env = {
            "PATH": os.environ.get("PATH", ""), "HOME": str(home), "TERM": "xterm-256color",
            "LANG": "C.UTF-8", "PI_CODING_AGENT_DIR": str(home / "agent"),
            "PI_HUD_CONFIG": str(self.config_path),
        }
        if offline:
            env["PI_OFFLINE"] = "1"
        args = [NODE, str(SDK / "dist/bundle/cli.js"), "--no-extensions"]
        # Regular mode is pinned explicitly: Pi 1.0+ defaults to fullscreen, whose
        # chat viewport paints only visible rows, so the long /hud status JSON
        # dump scrolls out of the captured screen. Regular scrollback keeps the
        # ledger assertions deterministic (fullscreen mounting is covered by
        # pi-pty-smoke.py --fullscreen).
        args += ["--tui-mode", "regular"]
        for extension in extensions:
            args += ["-e", str(extension)]
        if provider:
            args += ["--provider", "fixture", "--model", "fixture-alpha"]
        if session_file is not None:
            args += ["--session", str(session_file)]
        else:
            args += ["--no-session"]
        if name:
            args += ["--name", name]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(home / "ws")
            os.execve(NODE, args, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", term[0], term[1], 0, 0))
        self.seen = bytearray()

    def pump(self, duration: float) -> bool:
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            readable, _, _ = select.select([self.fd], [], [], 0.05)
            if not readable:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return False
                raise
            if not data:
                return False
            self.seen.extend(data)
            if len(self.seen) > 8_000_000:
                raise RuntimeError("unbounded PTY output")
        return True

    def send(self, keys: bytes):
        os.write(self.fd, keys)

    def wait_for(self, marker: bytes, timeout: float = 30.0, reset: bool = False) -> bytes:
        deadline = time.monotonic() + timeout
        if reset:
            self.seen.clear()
        while time.monotonic() < deadline:
            if marker in self.seen:  # the screen may already show it; frames are cumulative
                return bytes(self.seen)
            readable, _, _ = select.select([self.fd], [], [], 0.05)
            if not readable:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    raise RuntimeError(f"TUI exited while waiting for {marker!r}")
                raise
            self.seen.extend(data)
            if marker in self.seen:
                return bytes(self.seen)
        raise RuntimeError(f"timed out waiting for {marker!r}; tail={bytes(self.seen)[-300:]!r}")

    def repaint(self, rows: int = 50, cols: int = 120) -> str:
        """Force a full repaint and return only the fresh frame (cumulative buffers
        keep superseded overlays, so screen-state assertions need a clean read)."""
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols + 1, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)
        self.pump(0.4)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)
        self.seen.clear()
        self.pump(0.6)
        return self.plain()

    def plain(self) -> str:
        return ANSI.sub("", bytes(self.seen).decode("utf8", "replace"))

    def wait_for_plain(self, marker: str, timeout: float = 30.0) -> str:
        """Wait until the ANSI-stripped screen text contains `marker` (styled fields
        insert escape sequences between label and value, so byte matching fails)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if marker in self.plain():  # already-on-screen content must match too
                return self.plain()
            readable, _, _ = select.select([self.fd], [], [], 0.05)
            if not readable:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    raise RuntimeError(f"TUI exited while waiting for {marker!r}")
                raise
            self.seen.extend(data)
            if marker in self.plain():
                return self.plain()
        raise RuntimeError(f"timed out waiting for {marker!r}; tail={self.plain()[-3000:]!r}")

    def status_totals(self):
        """Send /hud status and regex-extract the published ledger totals."""
        self.seen.clear()  # parse ONLY this command's popup; the buffer keeps old ones
        self.send(b"/hud status\r")
        # Plain-text matching: the host's notify popup syntax-highlights JSON,
        # inserting SGR runs between quote and key tokens (Pi 1.0.2).
        self.wait_for_plain('"totals"', timeout=15)
        self.pump(0.6)
        text = self.plain()
        match = TOTALS_PATTERN.search(text)
        if not match:
            raise RuntimeError(f"no totals in /hud status output:\n{text[-2000:]}")
        input_, output, cache_read, cache_write, cost, known, missing = match.groups()
        fields = {}
        for key in ("status", "updating", "rebuilds", "recoveryRebuilds", "failureReason", "usageRecords", "examinedEntries", "lastBaselineMs", "maxChunkMs"):
            found = field_pattern(key).search(text)
            if found:
                fields[key] = found.group(1).strip('"')
        get_entries = re.search(r'"getEntries":\s*(\d+)', text)
        fields["getEntries"] = int(get_entries.group(1)) if get_entries else None
        return {
            "input": int(input_), "output": int(output), "cacheRead": int(cache_read),
            "cacheWrite": int(cache_write), "cost": float(cost),
            "costKnown": int(known), "costMissing": int(missing),
            **fields,
        }

    def close(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
            deadline = time.monotonic() + 1.5
            while time.monotonic() < deadline:
                done, _ = os.waitpid(self.pid, os.WNOHANG)
                if done:
                    return
                time.sleep(0.05)
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except ProcessLookupError:
            pass
        finally:
            try:
                os.close(self.fd)
            except OSError:
                pass


def file_oracle(path: pathlib.Path) -> dict:
    result = subprocess.run([NODE, str(ROOT / "scripts/session-file-oracle.mjs"), str(path)], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def compare_totals(label, ledger, oracle):
    problems = []
    for key in ("input", "output", "cacheRead", "cacheWrite"):
        if ledger[key] != oracle[key]:
            problems.append(f"{key}: ledger {ledger[key]} vs oracle {oracle[key]}")
    if abs(ledger["cost"] - oracle["cost"]) > 1e-6 * max(1.0, abs(oracle["cost"])):
        problems.append(f"cost: ledger {ledger['cost']} vs oracle {oracle['cost']}")
    if problems:
        raise RuntimeError(f"{label}: totals mismatch -> " + "; ".join(problems))
    return True


def wait_ledger_ready(host: PiHost, timeout: float = 30.0):
    """Wait until /hud status reports a quiet non-loading ledger (status ready/partial)."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        totals = host.status_totals()
        last = totals
        if totals.get("status") in ("ready", "partial") and totals.get("updating") in ("false", None):
            return totals
        time.sleep(0.3)
    raise RuntimeError(f"ledger never became ready: {last}")


def wait_ledger_growth(host: PiHost, before_input: int, timeout: float = 30.0):
    """Wait until the ledger's committed input strictly grows past `before_input`.

    A quiet-but-stale reading is legal immediately after a turn: turn_end/agent_settled
    fire asynchronously, so scenarios that expect an increment must wait for the growth
    itself rather than trusting the first ready snapshot."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        totals = host.status_totals()
        last = totals
        if totals["input"] > before_input and totals.get("updating") in ("false", None):
            return totals
        time.sleep(0.3)
    raise RuntimeError(f"ledger never grew past {before_input}: {last}")


def build_session(directory: pathlib.Path, size: int, shape: str, name: str = "B2b long history", same_summary: bool = False) -> pathlib.Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"session-{size}-{shape}{'-same' if same_summary else ''}.jsonl"
    subprocess.run(
        [NODE, str(ROOT / "scripts/usage-session-file.mjs"), str(target), f"--size={size}", f"--shape={shape}", f"--name={name}", f"--cwd={directory / 'ws'}"]
        + (["--sameSummary"] if same_summary else []),
        check=True, capture_output=True, cwd=ROOT, text=True)
    return target


HUD = ROOT / "index.ts"
PROVIDER = ROOT / "tests/fixtures/fixture-provider.ts"
REPLACER = ROOT / "tests/fixtures/replacer-extension.ts"
OTHER_FOOTER = ROOT / "tests/fixtures/other-footer.ts"


def provenance():
    def git(args):
        return subprocess.run(["git", *args], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    dirty = {}
    for line in git(["status", "--porcelain"]).splitlines():
        if not line.strip():
            continue
        path = line[3:].strip()
        try:
            dirty[path] = hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
        except OSError:
            dirty[path] = "unreadable"
    lock = ROOT / ".tmp/sdk/package-lock.json"
    return {
        "commit": git(["rev-parse", "HEAD"]),
        "dirtyFilesSha256": dirty,
        "sdkLockSha256": hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None,
        "node": subprocess.run([NODE, "--version"], capture_output=True, text=True).stdout.strip(),
    }


RESULTS = []


def record(scenario, passed, details):
    RESULTS.append({"scenario": scenario, "passed": bool(passed), **details})
    print(f"{'PASS' if passed else 'FAIL'}: {scenario}" + (f" - {details.get('note','')}" if details.get("note") else ""))
    if not passed:
        print(json.dumps(details, indent=2, default=str))


def scenario_resume_long(directory):
    session_file = build_session(directory, 10_000, "branched")
    host = PiHost(directory, [HUD, PROVIDER], {"preset": "full", "usageScope": "session", "surface": "footer"}, session_file=session_file)
    try:
        host.wait_for(b"sess*", timeout=40)
        host.send(b"\x1b")  # dismiss the startup overlay so /hud reaches the editor
        host.pump(1.0)
        # The 10k baseline slices for a while; wait for a published, quiet ledger.
        started = time.monotonic()
        totals = wait_ledger_ready(host, timeout=60)
        wall = time.monotonic() - started
        oracle = file_oracle(session_file)
        compare_totals("resume-10k", totals, oracle)
        record("resume-10k", True, {
            "note": "10,000-entry branched resume in the real TUI; ledger == independent file oracle",
            "ledger": {k: totals[k] for k in ("input", "output", "cacheRead", "cacheWrite", "cost", "usageRecords")},
            "oracle": {k: oracle[k] for k in ("input", "output", "cacheRead", "cacheWrite", "cost", "usageRecords")},
            "diagnostics": {k: totals.get(k) for k in ("status", "rebuilds", "getEntries", "lastBaselineMs", "maxChunkMs", "failureReason")},
            "waitReadySeconds": round(wall, 2),
        })
    finally:
        host.close()


def scenario_live_turn(directory):
    session_file = build_session(directory, 200, "linear")
    host = PiHost(directory, [HUD, PROVIDER], {"preset": "full", "usageScope": "session", "surface": "footer"}, session_file=session_file)
    try:
        host.wait_for(b"sess*", timeout=30)
        before = wait_ledger_ready(host)
        host.send(b"\x1b")  # dismiss any startup overlay
        host.pump(0.3)
        host.send(b"FIXTURE:TOOL:read:/home/shq/opensource/agents/pi-hud/README.md\r")
        host.wait_for(b"FIXTURE:DONE", timeout=60)
        after = wait_ledger_growth(host, before["input"])
        oracle = file_oracle(session_file)
        compare_totals("live-turn", after, oracle)
        grew = after["input"] > before["input"] and after["usageRecords"] != before["usageRecords"]
        one_read = after.get("getEntries") == "1" or after.get("getEntries") == 1
        record("live-turn", grew and one_read, {
            "note": "real read-tool turn reconciled incrementally; getEntries stayed at 1",
            "before": {k: before[k] for k in ("input", "usageRecords")},
            "after": {k: after[k] for k in ("input", "usageRecords")},
            "getEntries": after.get("getEntries"),
            "oracle": {k: oracle[k] for k in ("input", "usageRecords")},
        })
    finally:
        host.close()


def scenario_compact_twice(directory):
    # Every resumed compaction summary is already the same text, so the FIRST live
    # /compact (whose cut lands at an entry boundary, producing the identical summary)
    # makes the pinned SDK's find(summary === summary) select an OLD entry for the
    # session_compact event - the ledger must still count the new one exactly once.
    session_file = build_session(directory, 300, "linear", same_summary=True)
    initial_compactions = [json.loads(line) for line in session_file.read_text().splitlines() if json.loads(line).get("type") == "compaction"]
    host = PiHost(directory, [HUD, PROVIDER], {"preset": "full", "usageScope": "session", "surface": "footer"}, session_file=session_file)
    try:
        host.wait_for(b"sess*", timeout=30)
        before = wait_ledger_ready(host)
        host.send(b"\x1b"); host.pump(0.3)
        host.send(b"FIXTURE:ECHO:first turn before compaction\r")
        host.wait_for(b"first turn before compaction", timeout=60)
        before = wait_ledger_growth(host, before["input"])
        # The TUI renders compactions as a fold, not the summary text; the HUD's
        # compaction counter in the footer is the visible completion marker.
        host.send(b"/compact\r")
        host.wait_for_plain("compactions* 1", timeout=60)
        first = wait_ledger_growth(host, before["input"])
        # Grow real context between the compactions so the second one has work to do
        # (pi refuses a compact whose retained tail is already small). Several whole
        # filler turns (not one huge one) keep the cut point at a turn boundary: a
        # mid-turn split would prepend Pi's "Turn Context (split turn)" wrapper to the
        # summary and the two summaries would no longer be identical.
        for _ in range(4):
            host.send(b"FIXTURE:FILLER:100\r")
            host.wait_for_plain("fixture token history window ledger", timeout=90)
            host.pump(1.0)
        host.send(b"/compact\r")
        host.wait_for_plain("compactions* 2", timeout=90)
        second = wait_ledger_growth(host, first["input"])
        oracle = file_oracle(session_file)
        compare_totals("compact-twice", second, oracle)
        # The first live summary duplicates the resumed summary, exercising the
        # old-entry lookup hazard. Newer Pi may wrap the second summary with a
        # split-turn checkpoint; verify both new entries and their fixture content
        # instead of assuming an exact summary count from the seeded history.
        compactions = [json.loads(line) for line in session_file.read_text().splitlines() if json.loads(line).get("type") == "compaction"]
        new_compactions = compactions[len(initial_compactions):]
        correct_summaries = len(new_compactions) == 2 and new_compactions[0]["summary"] == "FIXTURE-SUMMARY" and new_compactions[1]["summary"].startswith("FIXTURE-SUMMARY")
        record("compact-twice", correct_summaries and second["input"] > first["input"] > before["input"], {
            "note": "two live /compact runs, duplicate first summary and optional split-turn wrapper; both counted exactly once",
            "newCompactions": len(new_compactions),
            "summaries": [entry["summary"] for entry in new_compactions],
            "before": before["input"], "afterFirst": first["input"], "afterSecond": second["input"],
            "oracle": {k: oracle[k] for k in ("input", "usageRecords")},
            "rebuilds": second.get("rebuilds"),
        })
    finally:
        host.close()


def scenario_tree_branch(directory):
    session_file = build_session(directory, 40, "linear")
    host = PiHost(directory, [HUD, PROVIDER], {"preset": "full", "usageScope": "session", "surface": "footer"}, session_file=session_file)
    try:
        host.wait_for(b"sess*", timeout=30)
        before = wait_ledger_ready(host)
        host.send(b"\x1b"); host.pump(0.3)
        # The tree lists oldest-first with the cursor on the current leaf; move UP to an
        # earlier entry and select it. Leaving the current branch offers a summary:
        # keep the preselected "No summary" and press Enter.
        host.send(b"/tree\r")
        host.wait_for(b"Session Tree", timeout=15)
        host.pump(0.6)
        host.send(b"\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A\r")
        host.wait_for(b"Summarize branch?", timeout=15)
        host.pump(0.4)
        host.send(b"\r")  # No summary (preselected)
        host.pump(1.0)
        # The leaf moved; a new user message from here creates a branch.
        host.send(b"FIXTURE:ECHO:branch-b\r")
        host.wait_for_plain("branch-b", timeout=60)
        branched = wait_ledger_growth(host, before["input"])
        # Back to the ROOT user message: reopen the tree, move to the very top (oldest),
        # select, decline the summary. The leaf resets to an empty conversation and the
        # editor receives the original prompt; a fresh submit appends a new root entry.
        host.send(b"/tree\r")
        host.wait_for(b"Session Tree", timeout=15)
        host.pump(0.6)
        host.send(b"\x1b[A" * 60 + b"\r")
        host.wait_for(b"Summarize branch?", timeout=15)
        host.pump(0.4)
        host.send(b"\r")
        host.pump(1.0)
        host.send(b"\x03")  # clear the resubmitted original prompt from the editor
        host.pump(0.4)
        host.send(b"FIXTURE:ECHO:root-re\r")
        host.wait_for_plain("root-re", timeout=60)
        rooted = wait_ledger_growth(host, branched["input"])
        oracle = file_oracle(session_file)
        compare_totals("tree-branch", rooted, oracle)
        record("tree-branch", rooted["input"] > branched["input"] > before["input"], {
            "note": "branch via /tree navigation + decline summary, then root navigation (leaf reset) + re-append; totals == full-history oracle",
            "before": before["input"], "afterBranch": branched["input"], "afterRoot": rooted["input"],
            "oracle": {k: oracle[k] for k in ("input", "usageRecords")},
            "rebuilds": rooted.get("rebuilds"), "recoveries": rooted.get("recoveryRebuilds"),
            "failureReason": rooted.get("failureReason"),
        })
    finally:
        host.close()


def scenario_model_switch(directory):
    session_file = build_session(directory, 150, "linear")
    host = PiHost(directory, [HUD, PROVIDER], {"preset": "full", "usageScope": "session", "surface": "footer"}, session_file=session_file)
    try:
        host.wait_for(b"sess*", timeout=30)
        before = wait_ledger_ready(host)
        host.send(b"\x1b"); host.pump(0.3)
        host.send(b"FIXTURE:ECHO:before model switch\r")
        host.wait_for(b"before model switch", timeout=60)
        switched_at = wait_ledger_growth(host, before["input"])
        # Model selector (ctrl+l), search "beta", Enter to switch.
        host.send(b"\x0c")
        host.pump(0.8)
        host.send(b"beta\r")
        host.wait_for(b"fixture-beta", timeout=15)
        host.pump(0.8)
        host.send(b"FIXTURE:ECHO:after model switch\r")
        host.wait_for(b"after model switch", timeout=60)
        after = wait_ledger_growth(host, switched_at["input"])
        oracle = file_oracle(session_file)
        compare_totals("model-switch", after, oracle)
        record("model-switch", after["input"] > switched_at["input"] > before["input"], {
            "note": "fixture-alpha -> fixture-beta mid-session; session totals keep accumulating across models",
            "before": before["input"], "afterFirstTurn": switched_at["input"], "afterSecondTurn": after["input"],
            "oracle": {k: oracle[k] for k in ("input", "usageRecords")},
        })
    finally:
        host.close()


def scenario_fast_switch(directory):
    # 100k entries: the real-host baseline runs ~300ms, so the loading footer
    # (`sess* ?`, no numbers) is observably in flight before the first publication
    # (~0.3s window, measured). The switch must land inside that window; the scenario
    # FAILS if the race was not exercised (published totals seen before /new) instead
    # of silently testing an ordinary settled switch.
    session_file = build_session(directory, 100_000, "branched")
    host = PiHost(directory, [HUD, PROVIDER], {"preset": "full", "usageScope": "session", "surface": "footer"}, session_file=session_file)
    try:
        started = time.monotonic()
        # Loading footer row (`sess* ?`, no numbers); styled segments break byte
        # markers, so this waits on the ANSI-stripped stream.
        plain_loading = host.wait_for_plain("sess* ?", timeout=60)
        loading_seen_at = time.monotonic() - started
        # The most recent sess* render must still be the loading state, not a published
        # total (a `sess* ... <arrow><digits>` row would mean the baseline finished).
        if re.search(r"sess\*[^\n\r]{0,40}[\u2191\u2193]\d", plain_loading):
            raise RuntimeError("fast-switch: the baseline already published before the switch; race not exercised")
        # Switch NOW, in the same burst that observed the in-flight loading render.
        # A small gap separates the overlay-dismissing Escape from /new: sent
        # back-to-back, pi drops the keystrokes while handling the escape (verified -
        # the switch silently no-ops and the scenario would test nothing).
        host.send(b"\x1b")
        time.sleep(0.05)
        host.send(b"/new\r")
        switched_at = time.monotonic() - started
        # Watch only frames AFTER the switch: a stale old-generation publication would
        # render the 100k totals (input ~10G -> an arrow-number row). None may appear
        # (the fresh session's all-zero fields render hidden, so any arrow row is stale).
        host.seen.clear()
        stale_published = False
        switch_confirmed = False
        watchdog = time.monotonic() + 6.0
        while time.monotonic() < watchdog:
            readable, _, _ = select.select([host.fd], [], [], 0.05)
            if not readable:
                continue
            try:
                data = os.read(host.fd, 65536)
            except OSError:
                break
            if not data:
                break
            host.seen.extend(data)
            plain = host.plain()
            if "New session started" in plain:
                switch_confirmed = True
            if re.search(r"sess\*[^\n\r]{0,40}[\u2191\u2193]\d", plain):
                stale_published = True
                break
        if not switch_confirmed:
            raise RuntimeError("fast-switch: /new was not processed; the scenario tested nothing")
        totals = wait_ledger_ready(host, timeout=30)
        leaked = totals["input"] != 0 or totals["usageRecords"] not in ("0", 0)
        record("fast-switch", (not leaked) and (not stale_published), {
            "note": "/new issued while the 100k baseline footer still showed the loading marker; the switch was confirmed and the stale generation never published afterwards",
            "loadingMarkerAtSeconds": round(loading_seen_at, 2),
            "switchSentAtSeconds": round(switched_at, 2),
            "inFlightMarginSeconds": round(switched_at - loading_seen_at, 3),
            "switchConfirmed": switch_confirmed,
            "stalePublicationObserved": stale_published,
            "newSessionTotals": {k: totals[k] for k in ("input", "output", "cacheRead", "cacheWrite", "usageRecords")},
            "status": totals.get("status"), "rebuilds": totals.get("rebuilds"),
            "lastBaselineMs": totals.get("lastBaselineMs"),
        })
    finally:
        host.close()


def scenario_dual_footer(directory, order):
    scenario = f"dual-footer-{'hud-first' if order == 'hud' else 'other-first'}"
    extensions = [HUD, PROVIDER, OTHER_FOOTER] if order == "hud" else [OTHER_FOOTER, PROVIDER, HUD]
    host = PiHost(directory, extensions, {"preset": "full", "usageScope": "session", "surface": "footer"})
    try:
        host.send(b"\x1b"); host.pump(2.5)
        # The HUD's startup attach runs after every extension's session_start (the
        # deferred configuration read), so the HUD owns the slot in BOTH load orders;
        # the other extension's session_start footer was disposed by the later install.
        host.wait_for(b"ctx(last)", timeout=20)
        frame = host.repaint()  # clean read: the buffer kept the superseded startup frames
        other_at_startup = "OTHER-FOOTER-ACTIVE" in frame
        # A post-startup manual claim by the other extension takes the slot from the
        # HUD; the HUD must suppress itself and never clear the other's footer.
        host.send(b"/other-footer\r")
        host.wait_for(b"OTHER-FOOTER-ACTIVE", timeout=15)
        host.pump(1.0)
        after_claim = host.repaint()
        hud_suppressed = "ctx(last)" not in after_claim
        # A plain HUD refresh (preset change) must NOT steal the slot back.
        host.send(b"/hud preset balanced\r")
        host.pump(1.5)
        after_refresh = host.repaint()
        still_other = "OTHER-FOOTER-ACTIVE" in after_refresh
        hud_still_suppressed = "ctx(last)" not in after_refresh
        # An explicit surface command is the documented way to re-claim the slot.
        host.send(b"/hud surface footer\r")
        host.wait_for(b"ctx(last)", timeout=15)
        host.pump(1.0)
        reclaimed = host.repaint()
        other_gone = "OTHER-FOOTER-ACTIVE" not in reclaimed
        record(scenario, (not other_at_startup) and hud_suppressed and still_other and hud_still_suppressed and other_gone, {
            "note": "HUD owns the slot at startup in both -e orders (deferred attach runs after session_start); a post-startup claim suppresses the HUD without clearing the other footer; /hud surface footer re-claims",
            "hudOwnsAtStartup": not other_at_startup,
            "hudSuppressedAfterOtherClaim": hud_suppressed,
            "otherSurvivesHudRefresh": still_other and hud_still_suppressed,
            "reclaimedAfterSurfaceCommand": other_gone,
        })
    finally:
        host.close()


def scenario_replacer(directory):
    session_file = build_session(directory, 100, "linear")
    host = PiHost(directory, [HUD, PROVIDER, REPLACER], {"preset": "full", "usageScope": "session", "surface": "footer"}, session_file=session_file)
    try:
        host.wait_for(b"sess*", timeout=30)
        before = wait_ledger_ready(host)
        host.send(b"\x1b"); host.pump(0.3)
        host.send(b"FIXTURE:ECHO:replacement target\r")
        host.wait_for(b"[replaced]", timeout=60)
        after = wait_ledger_growth(host, before["input"])
        oracle = file_oracle(session_file)
        compare_totals("replacer", after, oracle)
        # The event usage the HUD observed was usageFor(1)-of-this-process; the ledger must
        # equal the FILE (final, doubled) records, proving it never counted event usage.
        record("replacer", after["input"] > before["input"], {
            "note": "post-HUD async message_end replacer doubled usage; ledger counts the final committed record",
            "before": before["input"], "after": after["input"],
            "oracle": {k: oracle[k] for k in ("input", "usageRecords")},
        })
    finally:
        host.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", default=None)
    parser.add_argument("--scenarios", default="resume,long-turn,compact,tree,model,fast-switch,dual-footer,replacer")
    args = parser.parse_args()
    if not SDK.exists():
        raise RuntimeError("pinned SDK not installed under .tmp/sdk (see DEVELOPMENT.md)")
    wanted = set(args.scenarios.split(","))
    started = time.time()
    with tempfile.TemporaryDirectory(prefix="pi-hud-b2b-host-") as directory:
        base = pathlib.Path(directory)
        if "resume" in wanted:
            scenario_resume_long(base / "resume")
        if "long-turn" in wanted:
            scenario_live_turn(base / "turn")
        if "compact" in wanted:
            scenario_compact_twice(base / "compact")
        if "tree" in wanted:
            scenario_tree_branch(base / "tree")
        if "model" in wanted:
            scenario_model_switch(base / "model")
        if "fast-switch" in wanted:
            scenario_fast_switch(base / "fast")
        if "dual-footer" in wanted:
            scenario_dual_footer(base / "footer-hud-first", "hud")
            scenario_dual_footer(base / "footer-other-first", "other")
        if "replacer" in wanted:
            scenario_replacer(base / "replacer")
    passed = all(entry["passed"] for entry in RESULTS)
    record_out = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "passed": passed,
        "provenance": provenance(),
        "durationSeconds": round(time.time() - started, 1),
        "environment": {
            "node": subprocess.run([NODE, "--version"], capture_output=True, text=True).stdout.strip(),
            "pi": "1.0.2 (isolated .tmp/sdk)",
            "provider": "deterministic in-process fixture (zero network/billing)",
        },
        "results": RESULTS,
    }
    if args.json:
        pathlib.Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(args.json).write_text(json.dumps(record_out, indent=2, default=str) + "\n")
    print(json.dumps({"passed": passed, "scenarios": len(RESULTS)}, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
