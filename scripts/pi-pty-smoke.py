#!/usr/bin/env python3
"""Optional Linux/macOS real-Pi TUI smoke. No model requests or API credentials.

Requires the isolated .tmp/sdk install used by CI. This is NOT a streaming
performance A/B test. It checks real widget mounting, commands and resizing.
"""
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
import tempfile
import termios
import time


def main() -> None:
    root = pathlib.Path(__file__).resolve().parent.parent
    sdk = root / ".tmp/sdk/node_modules/@earendil-works/pi-coding-agent"
    metadata = json.loads((sdk / "package.json").read_text())
    if metadata["version"] != "0.85.1":
        raise RuntimeError("Expected Pi 0.85.1")
    binary = metadata["bin"]
    cli = sdk / (binary if isinstance(binary, str) else binary["pi"])
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node was not found")
    with tempfile.TemporaryDirectory(prefix="pi-hud-pty-") as directory:
        home = pathlib.Path(directory)
        agent = home / "agent"
        agent.mkdir()
        (agent / "pi-hud.json").write_text(json.dumps({"preset": "balanced", "palette": "pastel"}))
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home), "TERM": "xterm-256color",
               "LANG": "C.UTF-8", "PI_CODING_AGENT_DIR": str(agent), "PI_HUD_CONFIG": str(agent / "pi-hud.json"),
               # Without fd on PATH Pi would download it from github.com before the
               # session starts; skip that so the smoke stays offline and deterministic.
               "PI_OFFLINE": "1"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(home)
            os.execve(node, [node, str(cli), "--no-session", "--no-extensions",
                            "-e", str(root / "index.ts"),
                            "-e", str(root / "examples/bridge-demo.ts")], env)
        alive = True
        seen = bytearray()

        def wait_for(text: bytes, timeout: float = 20.0) -> bytes:
            wait_deadline = time.monotonic() + timeout
            seen.clear()
            while time.monotonic() < wait_deadline:
                readable, _, _ = select.select([fd], [], [], 0.1)
                if not readable:
                    continue
                try:
                    data = os.read(fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        raise RuntimeError("Pi TUI exited before expected output") from error
                    raise
                if not data:
                    raise RuntimeError("Unexpected PTY EOF")
                seen.extend(data)
                if len(seen) > 2_000_000:
                    raise RuntimeError("Unexpected unbounded PTY output")
                if text in seen:
                    return bytes(seen)
            raise RuntimeError(f"Timed out waiting for {text!r}; inspect Pi/terminal compatibility")

        # A field-colored segment (TRUEcolor or 256-color) immediately before the label.
        colored_context = re.compile(rb"\x1b\[38;(?:2|5);[0-9;]+mctx\(last\)")
        # The full preset's summary row carries the explicitly synthetic demo label; the
        # balanced preset shows the same bridge data as a shorter `agents`/`tasks` field.
        demo_label = b"DEMO: build Pi HUD"

        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            mounted = wait_for(b"ctx(last)")
            if not colored_context.search(mounted):
                raise RuntimeError("HUD mounted without the default pastel field colors")
            # Bridge data is displayed only when a real producer publishes it.
            # The notify text is contiguous; styled field segments are not, so the
            # full-preset demo label below is the contiguous row-3 marker.
            os.write(fd, b"/hud-demo\r")
            wait_for(b"no agent or task was actually started")
            os.write(fd, b"/hud preset full\r")
            wait_for(demo_label)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 70, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            # The full preset's bridge summary row also survives narrow redraws.
            wait_for(demo_label)
            os.write(fd, b"/hud palette mono\r")
            plain = wait_for(b"ctx(last)")
            if colored_context.search(plain):
                raise RuntimeError("mono palette still emitted field colors")
            os.write(fd, b"/hud palette pastel\r")
            recolored = wait_for(b"ctx(last)")
            if not colored_context.search(recolored):
                raise RuntimeError("pastel palette did not restore field colors")
            os.write(fd, b"/hud off\r")
            wait_for(b"pi-hud off")
            os.write(fd, b"/hud on\r")
            wait_for(b"ctx(last)")
            print("PASS: real Pi TUI mounts HUD, shows bridged activity, switches layout/palette, resizes, and toggles off/on without a model call")
        finally:
            try:
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    ended, _ = os.waitpid(pid, os.WNOHANG)
                    if ended:
                        alive = False
                        break
                    time.sleep(0.05)
                if alive:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)


if __name__ == "__main__":
    main()
