#!/usr/bin/env python3
"""B2b automated live-TUI streaming / tool / keyboard A/B (PERFORMANCE.md protocol).

Alternates the HUD on/off (PI_HUD_DISABLE=1 for the off side) across >= 20 paired
trials per profile in the REAL Pi 0.85.1 TUI, driven through a PTY with the
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


def analyze_keyboard(samples, max_failure_ratio=MAX_KEYBOARD_FAILURE_RATIO):
    """samples: latency in ms, or None for a timed-out key. Timeouts are counted;
    too many (or no successes) is a measurement failure, never a quiet pass."""
    failures = sum(1 for sample in samples if sample is None)
    successes = [sample for sample in samples if sample is not None]
    if not successes:
        raise MeasurementError("keyboard echo: every key timed out")
    if failures > len(samples) * max_failure_ratio:
        raise MeasurementError(
            f"keyboard echo: {failures}/{len(samples)} keys timed out (limit {max_failure_ratio:.0%})")
    return {
        "failures": failures,
        "samples": [round(sample, 3) if sample is not None else None for sample in samples],
        **{key: round(value, 3) for key, value in percentiles(successes).items()},
    }


def analyze_stream(frames, write_time, prefix, terminator, tail_quiet_s=0.5, max_collect_s=15.0):
    """frames: [(timestamp_s, plain_text_delta)] accumulated AFTER the command write.

    Returns first-content/completion timings, render-frame intervals strictly inside
    the streaming window, byte counts, and the post-completion publication frame.
    Raises MeasurementError when the prefix or the terminator is never observed."""
    first_content_at = None
    completion_at = None
    for timestamp, text in frames:
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
    # Post-completion frames: after a small epsilon (the final text_end tail renders
    # within ~50ms) but inside the coalesced-publication window. The first such frame
    # is the post-turn repaint (the HUD's ~250ms-budget coalesced publication on the
    # on side; the native footer's own repaint on the off side).
    post = [frame for frame in frames if completion_at + 0.05 < frame[0] <= completion_at + 1.5]
    return {
        "firstContentMs": (first_content_at - write_time) * 1_000,
        "completionMs": (completion_at - write_time) * 1_000,
        "streamedSeconds": completion_at - first_content_at,
        "renderFrameIntervals": [round(value, 3) for value in intervals],
        "framesInWindow": len(window),
        "bytesInWindow": sum(len(frame[1].encode("utf8", "replace")) for frame in window),
        "publicationDelayMs": ((post[0][0] - completion_at) * 1_000) if post else None,
        "publicationBytes": (sum(len(frame[1].encode("utf8", "replace")) for frame in post[:3]) if post else 0),
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
        self.frames = []          # (timestamp, plain-text delta) AFTER the last reset
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
        self.frames.append((time.monotonic(), ANSI.sub("", data.decode("utf8", "replace"))))
        return True

    def wait_for(self, predicate, timeout, description):
        """Pump until predicate(joined plain text) holds; MeasurementError on timeout."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate("".join(text for _, text in self.frames)):
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


def echo_keys(trial: Trial, keys, verify_chars=True):
    """Type keys one at a time; each sample is write->frame containing the char
    (verified echo) or None on timeout. Timeouts are kept as None - the analysis
    decides whether the failure ratio is fatal."""
    samples = []
    for key in keys:
        trial.reset()
        trial.send(key.encode() if isinstance(key, str) else key)
        char = key if isinstance(key, str) and len(key) == 1 else None
        deadline = time.monotonic() + KEY_TIMEOUT_S
        sample = None
        while time.monotonic() < deadline:
            if trial._pump_once(0.005):
                text = "".join(text for _, text in trial.frames)
                if not verify_chars or (char is not None and char in text):
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
    result["rawFrameTimestamps"] = [round(timestamp - trial.write_time, 4) for timestamp, _ in trial.frames]
    return result


def long_stream_with_typing(trial: Trial, word: str):
    prefix = f"«{word}-START»"
    terminator = "«END»"
    trial.reset()
    trial.send(f"FIXTURE:LONGREPLY:{word}\r".encode())
    trial.wait_for(lambda text: prefix in text, 15.0, f"{word} long-stream first content")
    typed = []
    # Verified printable echoes while the body streams.
    for char in "zhqimwax":
        written = time.monotonic()
        os.write(trial.fd, char.encode())
        deadline = time.monotonic() + KEY_TIMEOUT_S
        sample = None
        while time.monotonic() < deadline:
            if trial._pump_once(0.005):
                text = "".join(text for _, text in trial.frames)
                if char in text.split(prefix)[-1][-400:]:
                    sample = (time.monotonic() - written) * 1_000
                    break
        typed.append(sample)
        time.sleep(0.08)
    # Control keys during streaming: redraw-frame latency semantics (the next frame
    # may be a stream frame; these are labeled redraw, not echo).
    redraw = []
    for key in (b"\x7f", b"\x7f", b"\x1b[D", b"\x1b[D"):
        written = time.monotonic()
        os.write(trial.fd, key)
        deadline = time.monotonic() + KEY_TIMEOUT_S
        sample = None
        while time.monotonic() < deadline:
            if trial._pump_once(0.005):
                sample = (time.monotonic() - written) * 1_000
                break
        redraw.append(sample)
        time.sleep(0.08)
    trial.wait_for(lambda text: terminator in text, 20.0, f"{word} long-stream completion")
    trial.collect_quiet(0.4, 2.0)
    typed_analyzed = analyze_keyboard(typed)
    redraw_analyzed = {
        "failures": sum(1 for sample in redraw if sample is None),
        "samples": [round(sample, 3) if sample is not None else None for sample in redraw],
        **{key: round(value, 3) for key, value in percentiles([s for s in redraw if s is not None]).items()},
    } if any(sample is not None for sample in redraw) else {"failures": len(redraw), "samples": redraw}
    return {
        "deltaCount": LONG_CHUNKS + 2,
        "streamedSeconds": None,
        "typingDuringStreamEcho": typed_analyzed,
        "typingDuringStreamRedraw": redraw_analyzed,
    }


def tool_turn(trial: Trial):
    trial.reset()
    trial.send(b"FIXTURE:TOOL:read:marker.txt\r")
    # The transcript renders the running/completed tool row as "read marker.txt"
    # (space-separated); the echoed command is colon-separated
    # ("FIXTURE:TOOL:read:marker.txt"), so the space form is unambiguous.
    tool_visible_at = None
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if trial._pump_once(0.01):
            text = "".join(text for _, text in trial.frames)
            if tool_visible_at is None and "read marker.txt" in text:
                tool_visible_at = trial.frames[-1][0]
            if "FIXTURE:DONE" in text:
                done_at = trial.frames[-1][0]
                trial.collect_quiet(0.5, 2.0)
                post = [frame for frame in trial.frames if frame[0] > done_at + 0.25]
                return {
                    "toolVisibleMs": (tool_visible_at - trial.write_time) * 1_000 if tool_visible_at else None,
                    "toolTurnMs": (done_at - trial.write_time) * 1_000,
                    "bytes": sum(len(text.encode("utf8", "replace")) for _, text in trial.frames),
                    "publicationDelayMs": ((post[0][0] - done_at) * 1_000) if post else None,
                }
    if tool_visible_at is None:
        raise MeasurementError("tool turn: the read tool row never rendered")
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
        idle = analyze_keyboard(echo_keys(trial, "zhqimwaxpler"))
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
    ("idleKeyboard.p50Ms", lambda t: t["idleKeyboard"].get("p50")),
    ("idleKeyboard.p95Ms", lambda t: t["idleKeyboard"].get("p95")),
    ("coldStream.firstContentMs", lambda t: t["coldStream"]["firstContentMs"]),
    ("warmStream.firstContentMs", lambda t: t["warmStream"]["firstContentMs"]),
    ("warmStream.renderFrameInterval.p50Ms", lambda t: percentiles(t["warmStream"]["renderFrameIntervals"])["p50"] if t["warmStream"]["renderFrameIntervals"] else None),
    ("warmStream.renderFrameInterval.p95Ms", lambda t: percentiles(t["warmStream"]["renderFrameIntervals"])["p95"] if t["warmStream"]["renderFrameIntervals"] else None),
    ("warmStream.completionMs", lambda t: t["warmStream"]["completionMs"]),
    ("longStreamTyping.echo.p50Ms", lambda t: t["longStreamTyping"]["typingDuringStreamEcho"].get("p50")),
    ("longStreamTyping.echo.p95Ms", lambda t: t["longStreamTyping"]["typingDuringStreamEcho"].get("p95")),
    ("longStreamTyping.echo.failures", lambda t: t["longStreamTyping"]["typingDuringStreamEcho"]["failures"]),
    ("longStreamTyping.redraw.p50Ms", lambda t: t["longStreamTyping"]["typingDuringStreamRedraw"].get("p50")),
    ("toolTurn.toolVisibleMs", lambda t: t["toolTurn"]["toolVisibleMs"]),
    ("toolTurn.toolTurnMs", lambda t: t["toolTurn"]["toolTurnMs"]),
    ("toolTurn.bytes", lambda t: t["toolTurn"]["bytes"]),
    ("warmStream.publicationDelayMs", lambda t: t["warmStream"].get("publicationDelayMs")),
]


def self_test():
    """Deterministic checks of the analysis functions' failure paths (no PTY)."""
    now = time.monotonic()
    # 1. Missing terminator fails.
    frames = [(now + 0.001, "«zq7-START» some body"), (now + 0.002, "more body")]
    try:
        analyze_stream(frames, now, "«zq7-START»", "«END»")
        raise AssertionError("missing terminator must fail")
    except MeasurementError:
        pass
    # 2. Missing prefix fails.
    try:
        analyze_stream([(now, "no marker at all «END»")], now, "«zq7-START»", "«END»")
        raise AssertionError("missing prefix must fail")
    except MeasurementError:
        pass
    # 3. Prefix in the echoed command never counts: the command contains the word
    #    but not the guillemet-delimited prefix, and pre-write frames are excluded.
    frames = [(now - 0.5, "FIXTURE:REPLY:zq7 echoed"), (now + 0.05, "«zq7-START»b0"), (now + 0.07, "b1"), (now + 0.09, "«END»")]
    result = analyze_stream(frames, now, "«zq7-START»", "«END»")
    assert abs(result["firstContentMs"] - 50) < 1, result
    assert result["framesInWindow"] == 3, result
    assert len(result["renderFrameIntervals"]) == 2
    # 4. Keyboard failure ratio is fatal; a single timeout is not.
    try:
        analyze_keyboard([1.0] * 3 + [None] * 2)
        raise AssertionError("40% timeouts must fail")
    except MeasurementError:
        pass
    analyzed = analyze_keyboard([1.0, 2.0, None, 1.5])
    assert analyzed["failures"] == 1 and analyzed["n"] == 3
    # 5. Empty keyboard sample fails.
    try:
        analyze_keyboard([None, None])
        raise AssertionError("all-timeout keyboard must fail")
    except MeasurementError:
        pass
    print("PASS: stream/keyboard analysis failure paths behave deterministically")
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
        summary[profile_name] = {label: paired_summary(profile_trials, reader) for label, reader in METRICS}
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
            "pi": "0.85.1 (isolated .tmp/sdk)", "provider": "deterministic in-process fixture",
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
