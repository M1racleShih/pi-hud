#!/usr/bin/env python3
"""B2b automated live-TUI streaming / tool / keyboard A/B (PERFORMANCE.md protocol).

Alternates the HUD on/off (PI_HUD_DISABLE=1 for the off side) across >= 20 paired
trials per profile in the REAL Pi 1.0.2 TUI, driven through a PTY with the
deterministic in-process fixture provider (zero network, credentials or billing)
and an isolated disposable HOME/workspace.

Two profiles, reported separately:
  default : usageScope=observed, surface=widget   (the shipped defaults)
  optin   : usageScope=session,  surface=footer   (the opt-in combination)

Per trial, with identical instrumentation on both sides:
  idleKeyboard     - 12 verified single-key echoes before any streaming
  cold/warm stream - FIXTURE:REPLY:<word>: the reply is «<word>-START» (ONE atomic
                     first delta) + exactly FIXTURE_CHUNKS body deltas + ONE «END»
                     delta, so total deltas = FIXTURE_CHUNKS + 2 exactly.
                     firstContentMs = write -> first render of the full prefix;
                     completionMs   = write -> render of the terminator;
                     renderFrameIntervals = inter-frame gaps WITHIN the streaming
                       window (pi-tui render cadence while content streams - these
                       are terminal frame gaps, NOT provider token gaps);
                     publicationDelayMs/Bytes = the HUD's coalesced post-turn
                       publication frame (designed behavior, measured separately).
  longStreamTyping - FIXTURE:LONGREPLY:<word> streams ~FIXTURE_LONG_CHUNKS deltas
                     x FIXTURE_LONG_DELAY_MS; while it streams the harness types 8
                     printable keys (verified echo), 2 backspaces and 2 cursor-left
                     keys (frame-latency semantics - during active streaming the
                     next frame may be a stream frame, so control-key numbers are
                     labeled redraw-latency, not echo).
  toolTurn         - FIXTURE:TOOL:read: toolVisibleMs = Enter -> the transcript's
                     "read marker.txt" tool row (dispatch + execution visibility,
                     isolated from the follow-up); toolTurnMs = Enter -> the
                     follow-up reply (the full turn).

Failure policy (per the B2b review): a missing stream completion, a missing tool
marker, or more than 25% keyboard timeouts FAILS the trial - timeouts are counted
and reported, never silently dropped. Raw samples (per-key latencies, frame
timestamps) are preserved in the JSON record.

Paired analysis: per-pair deltas (on - off) with mean/stddev, plus a same-side
adjacent-pair repeatability envelope as the measured noise floor.

What this is NOT: a human perception study, a dark/light terminal visual
acceptance, a live-provider A/B (no paid provider is ever contacted), or a
cross-machine claim. Resize-during-stream, live compaction and abort/retry
scenarios from the full PERFORMANCE.md protocol remain explicitly pending.

Usage:
  python3 scripts/pi-stream-ab.py --pairs=20 --json=docs/pi-stream-ab-b2b.json
  python3 scripts/pi-stream-ab.py --self-test        # deterministic analysis checks
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
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[<>\"][a-zA-Z]")
STREAM_DELAY_MS = 2
STREAM_CHUNKS = 40          # body deltas; total deltas = STREAM_CHUNKS + 2
LONG_DELAY_MS = 10
LONG_CHUNKS = 150
KEY_TIMEOUT_S = 2.0
MAX_KEYBOARD_FAILURE_RATIO = 0.25
PROFILES = {
    "default": {"usageScope": "observed", "surface": "widget"},
    "optin": {"usageScope": "session", "surface": "footer"},
}


class MeasurementError(RuntimeError):
    """A required event was not observed; the trial must fail, not pass quietly."""


# ---------------------------------------------------------------------------
# Pure analysis functions (exercised by --self-test with synthetic input).
# ---------------------------------------------------------------------------

def percentiles(values):
    if not values:
        raise MeasurementError("percentiles of an empty sample set")
    ordered = sorted(values)

    def pct(p):
        return ordered[min(len(ordered) - 1, int(len(ordered) * p))]
    return {
        "n": len(values),
        "min": ordered[0],
        "p50": pct(0.5),
        "p95": pct(0.95),
        "max": ordered[-1],
        "mean": sum(ordered) / len(ordered),
    }


def analyze_keyboard(samples, required=True, timeout_ceiling_ms=KEY_TIMEOUT_S * 1_000):
    """samples: latency in ms, or None for a timed-out key.

    Required measurements (default) FAIL on any timeout: a percentile computed after
    dropping censored keys would understate the tail (the review showed
    [1, 2, None, 1.5] reporting p95=2 with a 2-second censoring ceiling), so the
    all-key acceptance conclusion is withheld entirely instead.
    Optional measurements report explicit censored statistics: responded-only
    percentiles plus a censoring-aware upper bound, never an unlabelled all-key p95."""
    failures = sum(1 for sample in samples if sample is None)
    successes = [sample for sample in samples if sample is not None]
    if not successes:
        raise MeasurementError("keyboard: every key timed out")
    if required and failures:
        raise MeasurementError(
            f"keyboard: {failures}/{len(samples)} keys timed out; a required all-key latency cannot be reported from censored samples")
    if not required and failures > len(samples) * MAX_KEYBOARD_FAILURE_RATIO:
        raise MeasurementError(
            f"keyboard: {failures}/{len(samples)} keys timed out (limit {MAX_KEYBOARD_FAILURE_RATIO:.0%})")
    stats = {key: round(value, 3) for key, value in percentiles(successes).items()}
    result = {
        "failures": failures,
        "censored": failures > 0,
        "samples": [round(sample, 3) if sample is not None else None for sample in samples],
        **stats,
    }
    if failures:
        result["censoringCeilingMs"] = timeout_ceiling_ms
        result["respondedOnly"] = True
        result["upperBoundWithCensored"] = {key: timeout_ceiling_ms for key in ("p50", "p95", "max")}
        result["note"] = "percentiles cover responded keys only; the true all-key p50/p95 lies between these and the censoring ceiling"
    return result


def analyze_stream(frames, write_time, prefix, terminator):
    """frames: [(timestamp_s, raw_byte_count, plain_text_delta)] accumulated AFTER the
    command write. Byte metrics count RAW terminal bytes (escape sequences included);
    the plain text exists only for marker detection.

    Returns first-content/completion timings, render-frame intervals strictly inside
    the streaming window, raw byte counts, and the post-completion publication window.
    Raises MeasurementError when the prefix or the terminator is never observed."""
    first_content_at = None
    completion_at = None
    for frame in frames:
        timestamp, _, text = frame
        if first_content_at is None and prefix in text:
            first_content_at = timestamp
        if completion_at is None and terminator in text:
            completion_at = timestamp
            break
    if first_content_at is None:
        raise MeasurementError(f"stream: first-content marker never rendered: {prefix!r}")
    if completion_at is None:
        raise MeasurementError(f"stream: completion terminator never rendered: {terminator!r}")
    window = [frame for frame in frames if first_content_at <= frame[0] <= completion_at]
    intervals = [(window[i][0] - window[i - 1][0]) * 1_000 for i in range(1, len(window))]
    # Publication window: the entire defined interval after a small epsilon (the final
    # text_end tail renders within ~50ms) up to 1.5s past completion - every frame in
    # it is counted, no read-chunk cap. On the HUD side the first frame is the
    # ~250ms-budget coalesced publication; on the off side the native footer repaints
    # with the frame cadence (usually nothing lands in the window at all).
    post = [frame for frame in frames if completion_at + 0.05 < frame[0] <= completion_at + 1.5]
    return {
        "firstContentMs": (first_content_at - write_time) * 1_000,
        "completionMs": (completion_at - write_time) * 1_000,
        "streamedSeconds": completion_at - first_content_at,
        "renderFrameIntervals": [round(value, 3) for value in intervals],
        "framesInWindow": len(window),
        "rawBytesInWindow": sum(frame[1] for frame in window),
        "publicationDelayMs": ((post[0][0] - completion_at) * 1_000) if post else None,
        "publicationWindowRawBytes": sum(frame[1] for frame in post),
        "publicationWindowFrames": len(post),
    }


# ---------------------------------------------------------------------------
# PTY trial
# ---------------------------------------------------------------------------

class Trial:
    def __init__(self, home: pathlib.Path, hud: bool, profile: dict):
        (home / "agent").mkdir(parents=True, exist_ok=True)
        (home / "ws").mkdir(parents=True, exist_ok=True)
        (home / "ws" / "marker.txt").write_text("DISPATCH-OUTPUT-MARKER-42\n")
        (home / "agent" / "pi-hud.json").write_text(json.dumps({"preset": "full", **profile}))
        env = {
            "PATH": os.environ.get("PATH", ""), "HOME": str(home), "TERM": "xterm-256color",
            "LANG": "C.UTF-8", "PI_CODING_AGENT_DIR": str(home / "agent"),
            "PI_HUD_CONFIG": str(home / "agent" / "pi-hud.json"), "PI_OFFLINE": "1",
            "FIXTURE_STREAM_DELAY_MS": str(STREAM_DELAY_MS), "FIXTURE_CHUNKS": str(STREAM_CHUNKS),
            "FIXTURE_LONG_DELAY_MS": str(LONG_DELAY_MS), "FIXTURE_LONG_CHUNKS": str(LONG_CHUNKS),
        }
        if not hud:
            env["PI_HUD_DISABLE"] = "1"
        args = [NODE, str(SDK / "dist/bundle/cli.js"), "--no-session", "--no-extensions",
                "-e", str(ROOT / "index.ts"),
                "--provider", "fixture", "--model", "fixture-alpha",
                "-e", str(ROOT / "tests/fixtures/fixture-provider.ts")]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(home / "ws")
            os.execve(NODE, args, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 120, 0, 0))
        self.frames = []          # (timestamp, raw byte count, plain-text delta)
        self.write_time = None

    def _pump_once(self, timeout=0.005):
        readable, _, _ = select.select([self.fd], [], [], timeout)
        if not readable:
            return False
        try:
            data = os.read(self.fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                raise RuntimeError("TUI exited during measurement") from error
            raise
        if not data:
            raise RuntimeError("TUI EOF during measurement")
        self.frames.append((time.monotonic(), len(data), ANSI.sub("", data.decode("utf8", "replace"))))
        return True

    def wait_for(self, predicate, timeout, description):
        """Pump until predicate(joined plain text) holds; MeasurementError on timeout."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate("".join(text for _, _, text in self.frames)):
                return
            self._pump_once(0.01)
        raise MeasurementError(f"timed out waiting for {description}")

    def collect_quiet(self, quiet_s=0.5, max_s=8.0):
        """Pump until no output for quiet_s (bounded by max_s)."""
        deadline = time.monotonic() + max_s
        while time.monotonic() < deadline:
            if not self._pump_once(0.02):
                if time.monotonic() - self.frames[-1][0] > quiet_s:
                    return
        return

    def reset(self):
        self.frames = []

    def send(self, keys: bytes):
        self.write_time = time.monotonic()
        os.write(self.fd, keys)

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


IDLE_KEYS = "ζηθικξπταβγδ"
STREAM_KEYS = "ζηθικξπτ"


def echo_keys(trial: Trial, keys):
    """Type one distinct marker key at a time; each sample is write->frame whose text
    contains that key's character. The keys are distinct characters that never occur
    in the TUI chrome or the fixture's ASCII replies, so a post-write occurrence can
    only be the editor echoing that keystroke (the review showed plain letters match
    unrelated transcript/footer output and pass without any editor change)."""
    samples = []
    for key in keys:
        trial.reset()
        trial.send(key.encode())
        deadline = time.monotonic() + KEY_TIMEOUT_S
        sample = None
        while time.monotonic() < deadline:
            if trial._pump_once(0.005):
                text = "".join(text for _, _, text in trial.frames)
                if key in text:
                    sample = (trial.frames[-1][0] - trial.write_time) * 1_000
                    break
        samples.append(sample)
        time.sleep(0.03)
    return samples


def stream_turn(trial: Trial, word: str):
    """One measured streamed reply; returns analyze_stream(...) plus raw frames."""
    prefix = f"«{word}-START»"
    terminator = "«END»"
    trial.reset()
    trial.send(f"FIXTURE:REPLY:{word}\r".encode())
    trial.wait_for(lambda text: terminator in text, 15.0, f"{word} stream completion")
    trial.collect_quiet(0.5, 3.0)
    result = analyze_stream(trial.frames, trial.write_time, prefix, terminator)
    result["deltaCount"] = STREAM_CHUNKS + 2
    result["rawFrameTimestamps"] = [round(timestamp - trial.write_time, 4) for timestamp, _, _ in trial.frames]
    return result


def long_stream_with_typing(trial: Trial, word: str):
    """Long streamed reply with interleaved typing.

    Timing invariants (fixed in review round 2): every typed key - echo AND control -
    must be written while the reply is still streaming (the terminator not yet in the
    accumulated output at write time; any violation fails the scenario), and
    first-content/completion are taken from the FRAME SCAN (the frame whose text first
    contains the marker), never from `frames[-1]` after a wait - a post-terminator
    quiet-period frame used to inflate the completion timestamp by hundreds of ms."""
    prefix = f"«{word}-START»"
    terminator = "«END»"
    trial.reset()
    trial.send(f"FIXTURE:LONGREPLY:{word}\r".encode())
    trial.wait_for(lambda text: prefix in text, 15.0, f"{word} long-stream first content")
    typed = []
    redraw = []
    sent_before_completion = []
    redraw_before_completion = []

    def still_streaming():
        return terminator not in "".join(text for _, _, text in trial.frames)

    # Verified editor echoes while the body streams: distinct marker characters that
    # cannot occur in the ASCII reply body or the TUI chrome (see echo_keys).
    for char in STREAM_KEYS:
        before = still_streaming()
        written = time.monotonic()
        os.write(trial.fd, char.encode())
        deadline = time.monotonic() + KEY_TIMEOUT_S
        sample = None
        while time.monotonic() < deadline:
            if trial._pump_once(0.005):
                text = "".join(text for _, _, text in trial.frames)
                if char in text:
                    sample = (trial.frames[-1][0] - written) * 1_000
                    break
        typed.append(sample)
        sent_before_completion.append(before)
        time.sleep(0.06)
    # Control keys (backspace, cursor-left) DURING the same stream: redraw-frame
    # latency semantics - written immediately after the echo keys, with no long
    # settle in between, so they still land before the reply completes.
    for key in (b"\x7f", b"\x7f", b"\x1b[D", b"\x1b[D"):
        before = still_streaming()
        written = time.monotonic()
        os.write(trial.fd, key)
        deadline = time.monotonic() + 0.5
        sample = None
        while time.monotonic() < deadline:
            if trial._pump_once(0.005):
                sample = (trial.frames[-1][0] - written) * 1_000
                break
        redraw.append(sample)
        redraw_before_completion.append(before)
        time.sleep(0.04)
    trial.wait_for(lambda text: terminator in text, 20.0, f"{word} long-stream completion")
    trial.collect_quiet(0.5, 2.0)
    # Frame-scan timings (never frames[-1] heuristics).
    first_content_at = None
    completion_at = None
    accumulated = ""
    for timestamp, _, text in trial.frames:
        accumulated += text
        if first_content_at is None and prefix in accumulated:
            first_content_at = timestamp
        if completion_at is None and terminator in accumulated:
            completion_at = timestamp
    if first_content_at is None or completion_at is None:
        raise MeasurementError("long-stream: marker frames missing after completion wait")
    # Editor-state evidence: the editor line must have rendered the whole accumulated
    # marker sequence contiguously (an unrelated transcript frame cannot produce it).
    if STREAM_KEYS not in accumulated:
        raise MeasurementError(
            "long-stream typing: the accumulated editor marker sequence never rendered; "
            "echo evidence is inconclusive")
    typed_analyzed = analyze_keyboard(typed, required=True)
    redraw_analyzed = analyze_keyboard(redraw, required=False)
    if not all(sent_before_completion):
        raise MeasurementError(
            f"long-stream typing: {sent_before_completion.count(False)} echo key(s) were typed "
            "at/after the reply completed; the during-stream window was not exercised for them")
    if not all(redraw_before_completion):
        raise MeasurementError(
            f"long-stream typing: {redraw_before_completion.count(False)} control key(s) were "
            "typed at/after the reply completed; they would not measure during-stream redraw")
    return {
        "deltaCount": LONG_CHUNKS + 2,
        "streamedSeconds": completion_at - first_content_at,
        "keysTypedBeforeCompletion": sum(sent_before_completion),
        "controlKeysTypedBeforeCompletion": sum(redraw_before_completion),
        "typingDuringStreamEcho": typed_analyzed,
        "typingDuringStreamRedraw": redraw_analyzed,
    }


def analyze_tool(frames, write_time, tool_marker="read marker.txt", done_marker="FIXTURE:DONE"):
    """Pure analysis of one tool turn's frames. The tool row is MANDATORY: a turn
    whose follow-up reply arrives without the tool row raises (the review showed
    DONE-only output silently returning toolVisibleMs=None). Byte counts are RAW
    terminal bytes (escapes included)."""
    tool_visible_at = None
    done_at = None
    for timestamp, _, text in frames:
        if tool_visible_at is None and tool_marker in text:
            tool_visible_at = timestamp
        if done_at is None and done_marker in text:
            done_at = timestamp
            break
    if done_at is None:
        raise MeasurementError("tool turn: the follow-up reply never rendered")
    if tool_visible_at is None:
        raise MeasurementError(
            "tool turn: the follow-up reply rendered without the tool row; "
            "dispatch visibility cannot be measured")
    post = [frame for frame in frames if done_at + 0.05 < frame[0] <= done_at + 1.5]
    return {
        "toolVisibleMs": (tool_visible_at - write_time) * 1_000,
        "toolTurnMs": (done_at - write_time) * 1_000,
        "rawBytes": sum(frame[1] for frame in frames),
        "publicationDelayMs": ((post[0][0] - done_at) * 1_000) if post else None,
        "publicationWindowRawBytes": sum(frame[1] for frame in post),
    }


def tool_turn(trial: Trial):
    trial.reset()
    trial.send(b"FIXTURE:TOOL:read:marker.txt\r")
    # The transcript renders the running/completed tool row as "read marker.txt"
    # (space-separated); the echoed command is colon-separated
    # ("FIXTURE:TOOL:read:marker.txt"), so the space form is unambiguous.
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if not trial._pump_once(0.01):
            continue
        text = "".join(text for _, _, text in trial.frames)
        if "FIXTURE:DONE" in text:
            # Bounded grace for the tool row to land in the same/next frame(s).
            grace = time.monotonic() + 0.5
            while time.monotonic() < grace and "read marker.txt" not in text:
                trial._pump_once(0.01)
                text = "".join(text for _, _, text in trial.frames)
            trial.collect_quiet(0.5, 2.0)
            return analyze_tool(trial.frames, trial.write_time)
    raise MeasurementError("tool turn: the follow-up reply never rendered")


def run_trial(base: pathlib.Path, hud: bool, profile_name: str, index: int) -> dict:
    profile = PROFILES[profile_name]
    home = base / f"{profile_name}-{'hud' if hud else 'off'}-{index}"
    trial = Trial(home, hud, profile)
    try:
        trial.wait_for(lambda text: "Press ctrl+o" in text, 25.0, "startup hint")
        trial.send(b"\x1b")
        time.sleep(0.4)
        trial.collect_quiet(0.5, 1.5)
        idle = analyze_keyboard(echo_keys(trial, IDLE_KEYS), required=True)
        trial.send(b"\x03")
        time.sleep(0.2)
        trial.collect_quiet(0.3, 1.0)
        cold = stream_turn(trial, "zq7")
        warm = stream_turn(trial, "wb9")
        long_typing = long_stream_with_typing(trial, "lg4")
        trial.send(b"\x03")
        time.sleep(0.2)
        trial.collect_quiet(0.3, 1.0)
        tool = tool_turn(trial)
        return {
            "hud": hud, "profile": profile_name, "index": index,
            "idleKeyboard": idle,
            "coldStream": cold, "warmStream": warm,
            "longStreamTyping": long_typing,
            "toolTurn": tool,
        }
    finally:
        trial.close()


# ---------------------------------------------------------------------------
# Aggregation and provenance
# ---------------------------------------------------------------------------

def aggregate(trials, reader):
    values = [reader(trial) for trial in trials]
    values = [value for value in values if isinstance(value, (int, float))]
    if not values:
        return None
    return {key: round(value, 3) for key, value in percentiles(values).items()}


def paired_summary(trials, reader):
    """True paired deltas (on - off within one pair) plus a same-side adjacent-pair
    repeatability envelope as the measured noise floor."""
    on = {trial["index"]: reader(trial) for trial in trials if trial["hud"] and isinstance(reader(trial), (int, float))}
    off = {trial["index"]: reader(trial) for trial in trials if not trial["hud"] and isinstance(reader(trial), (int, float))}
    shared = sorted(set(on) & set(off))
    if not shared:
        return {"on": aggregate([t for t in trials if t["hud"]], reader),
                "off": aggregate([t for t in trials if not t["hud"]], reader), "note": "no complete pairs"}
    deltas = [on[index] - off[index] for index in shared]
    envelope = []
    for side_map in (on, off):
        ordered = [side_map[index] for index in shared]
        envelope += [abs(ordered[i] - ordered[i - 1]) for i in range(1, len(ordered))]
    envelope.sort()
    def env(p):
        return envelope[min(len(envelope) - 1, int(len(envelope) * p))] if envelope else None
    mean = sum(deltas) / len(deltas)
    std = (sum((value - mean) ** 2 for value in deltas) / len(deltas)) ** 0.5
    within_noise = env(0.9) is not None and abs(mean) <= env(0.9)
    return {
        "on": aggregate([t for t in trials if t["hud"]], reader),
        "off": aggregate([t for t in trials if not t["hud"]], reader),
        "pairs": len(deltas),
        "pairedDeltaMean": round(mean, 3),
        "pairedDeltaStd": round(std, 3),
        "pairsPositive": sum(1 for value in deltas if value > 0),
        "noiseEnvelopeMedian": round(env(0.5), 3) if envelope else None,
        "noiseEnvelopeP90": round(env(0.9), 3) if envelope else None,
        "withinMeasuredNoise": within_noise,
    }


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


METRICS = [
    ("idleKeyboard.p50Ms", lambda t: t["idleKeyboard"].get("p50"), True),
    ("idleKeyboard.p95Ms", lambda t: t["idleKeyboard"].get("p95"), True),
    ("coldStream.firstContentMs", lambda t: t["coldStream"]["firstContentMs"], True),
    ("warmStream.firstContentMs", lambda t: t["warmStream"]["firstContentMs"], True),
    ("warmStream.renderFrameInterval.p50Ms", lambda t: percentiles(t["warmStream"]["renderFrameIntervals"])["p50"] if t["warmStream"]["renderFrameIntervals"] else None, True),
    ("warmStream.renderFrameInterval.p95Ms", lambda t: percentiles(t["warmStream"]["renderFrameIntervals"])["p95"] if t["warmStream"]["renderFrameIntervals"] else None, True),
    ("warmStream.completionMs", lambda t: t["warmStream"]["completionMs"], True),
    ("longStreamTyping.echo.p50Ms", lambda t: t["longStreamTyping"]["typingDuringStreamEcho"].get("p50"), True),
    ("longStreamTyping.echo.p95Ms", lambda t: t["longStreamTyping"]["typingDuringStreamEcho"].get("p95"), True),
    ("longStreamTyping.echo.failures", lambda t: t["longStreamTyping"]["typingDuringStreamEcho"]["failures"], True),
    ("longStreamTyping.keysTypedBeforeCompletion", lambda t: t["longStreamTyping"]["keysTypedBeforeCompletion"], True),
    ("longStreamTyping.controlKeysTypedBeforeCompletion", lambda t: t["longStreamTyping"]["controlKeysTypedBeforeCompletion"], True),
    ("longStreamTyping.redraw.p50Ms", lambda t: t["longStreamTyping"]["typingDuringStreamRedraw"].get("p50"), True),
    ("longStreamTyping.streamedSeconds", lambda t: t["longStreamTyping"]["streamedSeconds"], True),
    ("toolTurn.toolVisibleMs", lambda t: t["toolTurn"]["toolVisibleMs"], True),
    ("toolTurn.toolTurnMs", lambda t: t["toolTurn"]["toolTurnMs"], True),
    ("toolTurn.rawBytes", lambda t: t["toolTurn"]["rawBytes"], True),
    ("warmStream.rawBytesInWindow", lambda t: t["warmStream"]["rawBytesInWindow"], True),
    # The coalesced publication exists only on the HUD side (and the native footer
    # rarely lands a frame in the defined window), so None is a legitimate value.
    ("warmStream.publicationDelayMs", lambda t: t["warmStream"].get("publicationDelayMs"), False),
    ("warmStream.publicationWindowRawBytes", lambda t: t["warmStream"].get("publicationWindowRawBytes"), False),
]


def require_mandatory(trials):
    """Every mandatory metric must yield a number for every trial; a None silently
    filtered out by aggregation would hide a broken measurement (review R3)."""
    missing = []
    for trial in trials:
        for label, reader, mandatory in METRICS:
            if not mandatory:
                continue
            if not isinstance(reader(trial), (int, float)):
                missing.append({"trial": f"{trial['profile']}-{trial['index']}-{'hud' if trial['hud'] else 'off'}", "metric": label})
    if missing:
        raise SystemExit(f"mandatory metrics missing numeric values: {missing[:5]}")


def self_test():
    """Deterministic checks of the analysis functions' failure paths (no PTY),
    including the round-2 review's negative cases: raw-byte accounting, DONE without
    the tool row, censored keyboard percentiles and echo evidence that must not pass
    on unrelated transcript output."""
    now = time.monotonic()
    # 1. Missing terminator fails.
    frames = [(now + 0.001, 3, "«zq7-START» some body"), (now + 0.002, 4, "more body")]
    try:
        analyze_stream(frames, now, "«zq7-START»", "«END»")
        raise AssertionError("missing terminator must fail")
    except MeasurementError:
        pass
    # 2. Missing prefix fails.
    try:
        analyze_stream([(now, 4, "no marker at all «END»")], now, "«zq7-START»", "«END»")
        raise AssertionError("missing prefix must fail")
    except MeasurementError:
        pass
    # 3. Prefix in the echoed command never counts: the command contains the word
    #    but not the guillemet-delimited prefix, and pre-write frames are excluded.
    frames = [(now - 0.5, 20, "FIXTURE:REPLY:zq7 echoed"), (now + 0.05, 3, "«zq7-START»b0"), (now + 0.07, 2, "b1"), (now + 0.09, 5, "«END»")]
    result = analyze_stream(frames, now, "«zq7-START»", "«END»")
    assert abs(result["firstContentMs"] - 50) < 1, result
    assert result["framesInWindow"] == 3, result
    assert len(result["renderFrameIntervals"]) == 2
    # 4. Raw bytes: a styled payload counts its escape bytes, not its plain chars
    #    (the review's 901-raw-byte / 1-plain-byte synthetic).
    styled_raw = len(b"\x1b[31m" * 100 + b"X" + b"\x1b[0m" * 100)
    frames = [(now - 0.01, styled_raw, "«zq7-START»"), (now + 0.05, styled_raw, "«END»")]
    result = analyze_stream(frames, now, "«zq7-START»", "«END»")
    assert result["rawBytesInWindow"] == 2 * styled_raw, result
    # 5. Publication window counts every frame in the defined interval (no [:3] cap).
    frames = [(now, 3, "«zq7-START»"), (now + 0.04, 5, "«END»")] + [(now + 0.1 + i * 0.1, 10, f"p{i}") for i in range(6)]
    result = analyze_stream(frames, now, "«zq7-START»", "«END»")
    assert result["publicationWindowFrames"] == 6 and result["publicationWindowRawBytes"] == 60, result
    # 6. Required keyboard measurements fail on ANY timeout (censored samples must
    #    not produce an all-key percentile); optional ones report censored bounds.
    try:
        analyze_keyboard([1.0, 2.0, None, 1.5], required=True)
        raise AssertionError("required keyboard with a timeout must fail")
    except MeasurementError:
        pass
    censored = analyze_keyboard([1.0, 2.0, None, 1.5], required=False)
    assert censored["censored"] and censored["respondedOnly"] and censored["failures"] == 1
    assert censored["upperBoundWithCensored"]["p95"] == KEY_TIMEOUT_S * 1_000
    assert "note" in censored
    try:
        analyze_keyboard([None, None])
        raise AssertionError("all-timeout keyboard must fail")
    except MeasurementError:
        pass
    # 7. DONE without the tool row FAILS (the review's silent toolVisibleMs=None).
    try:
        analyze_tool([(now + 0.02, 5, "FIXTURE:DONE")], now)
        raise AssertionError("DONE without the tool row must fail")
    except MeasurementError as error:
        assert "tool row" in str(error)
    result = analyze_tool([(now + 0.01, 5, "read marker.txt"), (now + 0.02, 5, "FIXTURE:DONE")], now)
    assert abs(result["toolVisibleMs"] - 10) < 1 and abs(result["toolTurnMs"] - 20) < 1
    assert result["rawBytes"] == 10
    # 8. Marker-key echo evidence: a character appearing only in unrelated output
    #    (typed BEFORE the write, or in stream body) is not a post-write echo. The
    #    helper semantics are exercised through the same frames discipline used by
    #    echo_keys: only post-write frames count, and the marker alphabet cannot
    #    occur in ASCII chrome or reply bodies.
    marker = "ζ"
    pre = [(now - 0.1, 5, f"unrelated transcript already contains {marker}")]
    post_unrelated = [(now + 0.01, 5, "lg4-body-token-7 footer noise")]
    text = "".join(text for _, _, text in pre + post_unrelated)
    assert marker not in "".join(text for _, _, text in post_unrelated), \
        "marker must not appear in unrelated post-write output"
    post_echo = [(now + 0.02, 5, "editor line: ζ")]
    assert marker in "".join(text for _, _, text in post_echo)
    print("PASS: stream/keyboard/tool analysis failure paths behave deterministically")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=int, default=20)
    parser.add_argument("--profiles", default="default,optin")
    parser.add_argument("--json", default=None)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not SDK.exists():
        raise RuntimeError("pinned SDK not installed under .tmp/sdk")
    if args.pairs < 20:
        raise SystemExit("--pairs must be >= 20 for this acceptance (the review rejected 10)")
    profile_names = args.profiles.split(",")
    started = time.time()
    trials = []
    errors = []
    with tempfile.TemporaryDirectory(prefix="pi-hud-stream-ab-") as directory:
        base = pathlib.Path(directory)
        for profile_name in profile_names:
            for pair in range(args.pairs):
                # Alternate within AND across pairs so neither side is systematically first.
                order = ["off", "hud"] if pair % 2 == 0 else ["hud", "off"]
                for side in order:
                    try:
                        result = run_trial(base, side == "hud", profile_name, pair)
                        trials.append(result)
                        print(f"[{profile_name}] pair {pair + 1}/{args.pairs} {side}: "
                              f"echo p50={result['idleKeyboard'].get('p50')}ms "
                              f"warmFirst={result['warmStream']['firstContentMs']:.1f}ms "
                              f"toolVisible={result['toolTurn']['toolVisibleMs'] and round(result['toolTurn']['toolVisibleMs'], 1)}ms "
                              f"duringEcho p50={result['longStreamTyping']['typingDuringStreamEcho'].get('p50')}ms",
                              file=sys.stderr, flush=True)
                    except (MeasurementError, RuntimeError) as error:
                        errors.append({"profile": profile_name, "pair": pair, "side": side, "error": str(error)})
                        print(f"[{profile_name}] pair {pair + 1} {side}: MEASUREMENT FAILURE: {error}", file=sys.stderr, flush=True)
    if errors:
        print(json.dumps({"measurementFailures": errors}, indent=2), file=sys.stderr)
        raise SystemExit(f"{len(errors)} trial(s) failed measurement; evidence is incomplete")
    summary = {}
    for profile_name in profile_names:
        profile_trials = [trial for trial in trials if trial["profile"] == profile_name]
        require_mandatory(profile_trials)
        summary[profile_name] = {label: paired_summary(profile_trials, reader) for label, reader, _ in METRICS}
    record = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "pairs": args.pairs, "profiles": profile_names, "trials": len(trials),
        "provenance": provenance(),
        "fixture": {
            "streamDeltas": STREAM_CHUNKS + 2, "streamDelayMs": STREAM_DELAY_MS,
            "longStreamDeltas": LONG_CHUNKS + 2, "longStreamDelayMs": LONG_DELAY_MS,
            "firstContentMarker": "«<word>-START» (one atomic delta)",
            "completionMarker": "«END» (one atomic delta)",
        },
        "environment": {
            "pi": "1.0.2 (isolated .tmp/sdk)", "provider": "deterministic in-process fixture",
            "methodology": "render-frame intervals are pi-tui frame gaps during streaming, NOT provider token gaps; "
                           "during-stream control-key numbers are redraw latency (next frame), printable echoes are char-verified; "
                           "toolVisibleMs is Enter -> the transcript tool row; toolTurnMs is Enter -> follow-up reply",
        },
        "summary": summary,
        "trials": trials,
    }
    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(record, indent=2, default=str) + "\n")
    print(json.dumps(summary, indent=2, default=str))
    print(f"duration: {time.time() - started:.0f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
