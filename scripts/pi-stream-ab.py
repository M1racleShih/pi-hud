#!/usr/bin/env python3
"""B2b automated live-TUI streaming / tool / keyboard A/B (PERFORMANCE.md protocol).

Alternates the HUD on/off (PI_HUD_DISABLE=1 for the off side) across >= 20 paired
trials in the REAL Pi 0.85.1 TUI, driven through a PTY with the deterministic
in-process fixture provider (zero network, zero credentials, zero billing) and an
isolated disposable HOME/workspace. The provider streams replies in 40 deltas with a
2 ms inter-delta delay so inter-token rendering is exercised.

Per trial, with identical instrumentation on both sides:
  keyboardEcho  - 12 single printable keystrokes; write->first-output latency per key
                   (the TUI repaints the editor line on input; the char is verified
                   in the returned bytes)
  firstToken    - Enter->first rendered reply chunk for a streamed response
  interToken    - gaps between successive PTY frames while the reply streams
  toolDispatch  - Enter->bash tool output visible, and ->turn completion
  repaintBytes  - total PTY bytes from Enter to completion (streaming + tool turns)

Alternation starts with a different side in each pair (even pairs: off first; odd
pairs: on first is NOT used - the protocol requires not always running the disabled
case first, so the order flips every pair). Paired per-trial deltas are reported.

What this is NOT: a human perception study, a dark/light terminal visual acceptance,
or a cross-machine claim. Those remain explicitly-open evidence gaps.

Usage: python3 scripts/pi-stream-ab.py [--pairs=10] [--json=docs/pi-stream-ab-b2b.json]
       (pairs here means HUD-off/HUD-on trial pairs; >=10 pairs gives >=20 trials)
"""
import argparse
import errno
import fcntl
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


class Trial:
    def __init__(self, home: pathlib.Path, hud: bool, stream_delay_ms: int):
        (home / "agent").mkdir(parents=True, exist_ok=True)
        (home / "ws").mkdir(parents=True, exist_ok=True)
        (home / "ws" / "notes.txt").write_text("stream ab workspace\n")
        (home / "ws" / "marker.txt").write_text("DISPATCH-OUTPUT-MARKER-42\n")
        (home / "agent" / "pi-hud.json").write_text(json.dumps({"preset": "full", "usageScope": "session", "surface": "footer"}))
        env = {
            "PATH": os.environ.get("PATH", ""), "HOME": str(home), "TERM": "xterm-256color",
            "LANG": "C.UTF-8", "PI_CODING_AGENT_DIR": str(home / "agent"),
            "PI_HUD_CONFIG": str(home / "agent" / "pi-hud.json"), "PI_OFFLINE": "1",
            "FIXTURE_STREAM_DELAY_MS": str(stream_delay_ms), "FIXTURE_CHUNKS": "40",
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
        self.buffer = bytearray()

    def read_until(self, predicate, timeout: float):
        """Pump until predicate(plain-text-so-far) is true; returns (elapsed, frames).

        Frames are (timestamp, byte_count) tuples for output bursts - inter-token gaps
        are derived from them."""
        frames = []
        started = time.monotonic()
        deadline = started + timeout
        while time.monotonic() < deadline:
            readable, _, _ = select.select([self.fd], [], [], 0.005)
            if not readable:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    raise RuntimeError("TUI exited during measurement")
                raise
            if not data:
                raise RuntimeError("TUI EOF during measurement")
            self.buffer.extend(data)
            frames.append((time.monotonic(), len(data)))
            if predicate(self.plain()):
                return time.monotonic() - started, frames
        raise RuntimeError("predicate not met before timeout")

    def read_bursts(self, duration: float):
        """Collect output bursts for a fixed duration (used for idle echo sampling)."""
        frames = []
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            readable, _, _ = select.select([self.fd], [], [], 0.005)
            if not readable:
                continue
            data = os.read(self.fd, 65536)
            if not data:
                break
            self.buffer.extend(data)
            frames.append((time.monotonic(), len(data)))
        return frames

    def send(self, keys: bytes):
        self.write_time = time.monotonic()
        os.write(self.fd, keys)

    def plain(self) -> str:
        return ANSI.sub("", bytes(self.buffer).decode("utf8", "replace"))

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


def echo_latency(trial: Trial, keys: str = "zhqimwaxpler"):
    """One keystroke at a time; latency = write -> first output containing the char."""
    latencies = []
    for char in keys:
        trial.buffer.clear()
        trial.send(char.encode())
        try:
            elapsed, _ = trial.read_until(lambda text: char in text, timeout=2.0)
        except RuntimeError:
            continue
        latencies.append(elapsed * 1_000)
        time.sleep(0.05)
    return latencies


def percentiles(values):
    if not values:
        return {"n": 0}
    ordered = sorted(values)

    def pct(p):
        return ordered[min(len(ordered) - 1, int(len(ordered) * p))]
    return {"n": len(values), "p50Us": round(pct(0.5) * 1_000, 1), "p95Us": round(pct(0.95) * 1_000, 1), "meanUs": round(sum(values) / len(values) * 1_000, 1)}


def run_trial(base: pathlib.Path, hud: bool, index: int) -> dict:
    home = base / f"{'hud' if hud else 'off'}-{index}"
    trial = Trial(home, hud, stream_delay_ms=2)
    try:
        # Startup: wait for the editor hint, dismiss the overlay, settle.
        trial.read_until(lambda text: "Press ctrl+o" in text, timeout=25)
        trial.send(b"\x1b")
        time.sleep(0.4)
        # Flush residual output.
        trial.read_bursts(0.5)
        trial.buffer.clear()

        keyboard = echo_latency(trial)
        trial.send(b"\x03")  # clear the typed echo characters from the editor
        time.sleep(0.2)
        trial.read_bursts(0.3)

        # Streamed replies: the command and the reply text are disjoint (FIXTURE:REPLY:x
        # vs STREAM-REPLY-x-MARKER ...), so the first appearance of the reply marker is
        # the first rendered token, never the echoed command line. Inter-token gaps are
        # computed only INSIDE the streaming window: the quiet period between the last
        # streamed frame and the HUD's ~250ms-coalesced post-turn publication is
        # reported separately as publicationDelayMs (designed behavior, not a stall -
        # the HUD's own maxFlushMs diagnostic stays in single-digit milliseconds).
        def streamed_turn(word):
            marker = f"STREAM-REPLY-{word}-MARKER"
            tail = " ".join([word] * 9)
            trial.buffer.clear()
            trial.send(f"FIXTURE:REPLY:{word}\r".encode())
            first, frames = trial.read_until(lambda text: marker in text, timeout=30)
            rest = []
            deadline = time.monotonic() + 8
            complete_at = None
            while time.monotonic() < deadline:
                readable, _, _ = select.select([trial.fd], [], [], 0.05)
                if not readable:
                    if complete_at is not None and time.monotonic() - rest[-1][0] > 0.5:
                        break
                    if complete_at is None and time.monotonic() - ((rest[-1][0] if rest else frames[-1][0])) > 1.0:
                        break
                    continue
                data = os.read(trial.fd, 65536)
                if not data:
                    break
                trial.buffer.extend(data)
                rest.append((time.monotonic(), len(data)))
                if complete_at is None and tail in trial.plain():
                    complete_at = rest[-1][0]
            all_frames = frames + rest
            if complete_at is None:
                complete_at = all_frames[-1][0]
            stream_frames = [f for f in all_frames if f[0] <= complete_at]
            gaps = [(stream_frames[i][0] - stream_frames[i - 1][0]) * 1_000
                    for i in range(1, len(stream_frames)) if stream_frames[i - 1][0] > trial.write_time]
            post = [f for f in all_frames if f[0] > complete_at]
            return {
                "firstTokenMs": first * 1_000,
                "interToken": percentiles(gaps),
                "streamBytes": sum(size for _, size in stream_frames),
                "publicationDelayMs": ((post[0][0] - complete_at) * 1_000) if post else None,
                "publicationBytes": sum(size for _, size in post),
            }
        cold = streamed_turn("zq7")
        first_token = cold["firstTokenMs"] / 1_000
        gaps = [cold["interToken"]["p50Us"] / 1_000] if cold["interToken"].get("n") else []
        stream_bytes = cold["streamBytes"]
        warm = streamed_turn("wb9")
        warm_first = warm["firstTokenMs"] / 1_000
        warm_gaps = [warm["interToken"]["p50Us"] / 1_000] if warm["interToken"].get("n") else []
        warm_bytes = warm["streamBytes"]

        # Tool turn: Enter -> the follow-up reply (FIXTURE:DONE) is visible. The read
        # tool's output itself renders as a collapsed fold, so the DONE reply is the
        # first deterministic on-screen completion marker; the metric therefore covers
        # dispatch + execution + the follow-up model round-trip.
        trial.buffer.clear()
        trial.send(b"FIXTURE:TOOL:read:marker.txt\r")
        dispatch, tool_frames = trial.read_until(lambda text: "FIXTURE:DONE" in text, timeout=30)
        completion_deadline = time.monotonic() + 15
        while time.monotonic() < completion_deadline:
            readable, _, _ = select.select([trial.fd], [], [], 0.05)
            if not readable:
                if "FIXTURE:DONE" in trial.plain():
                    break
                continue
            data = os.read(trial.fd, 65536)
            if not data:
                break
            trial.buffer.extend(data)
            tool_frames.append((time.monotonic(), len(data)))
        done_seen = "FIXTURE:DONE" in trial.plain()
        tool_bytes = sum(size for _, size in tool_frames)
        return {
            "hud": hud, "index": index,
            "keyboardEcho": percentiles(keyboard),
            "firstTokenMs": round(first_token * 1_000, 2),
            "interToken": cold["interToken"],
            "streamBytes": stream_bytes,
            "warmFirstTokenMs": round(warm["firstTokenMs"], 2),
            "warmInterToken": warm["interToken"],
            "warmStreamBytes": warm["streamBytes"],
            "coldPublicationDelayMs": cold["publicationDelayMs"] and round(cold["publicationDelayMs"], 1),
            "coldPublicationBytes": cold["publicationBytes"],
            "warmPublicationDelayMs": warm["publicationDelayMs"] and round(warm["publicationDelayMs"], 1),
            "warmPublicationBytes": warm["publicationBytes"],
            "toolTurnMs": round(dispatch * 1_000, 2),
            "toolBytes": tool_bytes,
            "toolCompletionSeen": done_seen,
        }
    finally:
        trial.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=int, default=10)
    parser.add_argument("--json", default=None)
    args = parser.parse_args()
    if not SDK.exists():
        raise RuntimeError("pinned SDK not installed under .tmp/sdk")
    trials = []
    with tempfile.TemporaryDirectory(prefix="pi-hud-stream-ab-") as directory:
        base = pathlib.Path(directory)
        for pair in range(args.pairs):
            # Alternate the order inside pairs AND across pairs so neither side is
            # systematically first (PERFORMANCE.md: do not always run disabled first).
            order = ["off", "hud"] if pair % 2 == 0 else ["hud", "off"]
            for side in order:
                result = run_trial(base, side == "hud", pair)
                trials.append(result)
                print(f"pair {pair + 1}/{args.pairs} {side}: echo p50={result['keyboardEcho'].get('p50Us')}us "
                      f"first={result['firstTokenMs']}ms toolTurn={result['toolTurnMs']}ms bytes={result['streamBytes']}", file=sys.stderr)
    on = [t for t in trials if t["hud"]]
    off = [t for t in trials if not t["hud"]]
    def agg(side, key, sub=None):
        values = []
        for trial in side:
            source = trial[key] if sub is None else trial[key].get(sub)
            if isinstance(source, (int, float)):
                values.append(source)
        if not values:
            return None
        return {"n": len(values), "mean": round(sum(values) / len(values), 3), "min": round(min(values), 3), "max": round(max(values), 3)}
    metrics = {}
    for label, key, sub in [
        ("keyboardEcho.p50Us", "keyboardEcho", "p50Us"), ("keyboardEcho.p95Us", "keyboardEcho", "p95Us"),
        ("keyboardEcho.meanUs", "keyboardEcho", "meanUs"),
        ("firstTokenMs", "firstTokenMs", None), ("interToken.p50Us", "interToken", "p50Us"),
        ("interToken.p95Us", "interToken", "p95Us"), ("streamBytes", "streamBytes", None),
        ("warmFirstTokenMs", "warmFirstTokenMs", None), ("warmInterToken.p50Us", "warmInterToken", "p50Us"),
        ("warmInterToken.p95Us", "warmInterToken", "p95Us"), ("warmStreamBytes", "warmStreamBytes", None),
        ("coldPublicationDelayMs", "coldPublicationDelayMs", None), ("coldPublicationBytes", "coldPublicationBytes", None),
        ("toolTurnMs", "toolTurnMs", None), ("toolBytes", "toolBytes", None),
    ]:
        hud_stats = agg(on, key, sub)
        off_stats = agg(off, key, sub)
        delta = None
        if hud_stats and off_stats and off_stats["mean"]:
            delta = round((hud_stats["mean"] - off_stats["mean"]) / off_stats["mean"] * 100, 2)
        metrics[label] = {"hudOff": off_stats, "hudOn": hud_stats, "deltaPercentMean": delta}
    completed = all(t["toolCompletionSeen"] for t in trials)
    record = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "pairs": args.pairs, "trials": len(trials),
        "toolCompletionSeenInAllTrials": completed,
        "environment": {
            "node": subprocess.run([NODE, "--version"], capture_output=True, text=True).stdout.strip(),
            "pi": "0.85.1 (isolated .tmp/sdk)", "provider": "deterministic in-process fixture, 40 deltas x 2ms",
            "commit": subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=ROOT).stdout.strip(),
        },
        "methodology": "Real Pi 0.85.1 TUI in a disposable PTY, HUD on/off alternated within and across pairs, identical instrumentation (write->first-output timing from the harness). Zero network/provider credentials. NOT a human perception check; dark/light visual acceptance remains open.",
        "summary": metrics,
        "trials": trials,
    }
    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(record, indent=2, default=str) + "\n")
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
