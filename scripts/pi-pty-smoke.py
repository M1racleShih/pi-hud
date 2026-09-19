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
        (agent / "pi-hud.json").write_text(json.dumps({"color": False, "preset": "balanced"}))
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home), "TERM": "xterm-256color",
               "LANG": "C.UTF-8", "PI_CODING_AGENT_DIR": str(agent), "PI_HUD_CONFIG": str(agent / "pi-hud.json")}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(home)
            os.execve(node, [node, str(cli), "--no-session", "--no-extensions", "-e", str(root / "index.ts")], env)
        alive = True
        seen = bytearray()

        def wait_for(text: bytes, timeout: float = 20.0) -> None:
            deadline = time.monotonic() + timeout
            seen.clear()
            while time.monotonic() < deadline:
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
                    return
            raise RuntimeError(f"Timed out waiting for {text!r}; inspect Pi/terminal compatibility")

        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            wait_for(b"ctx(last)")
            os.write(fd, b"/hud preset full\r")
            wait_for(b"no bridged activity")
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 70, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            # The full preset's unchanged ASCII activity line also survives narrow redraws.
            wait_for(b"no bridged activity")
            os.write(fd, b"/hud off\r")
            wait_for(b"pi-hud off")
            os.write(fd, b"/hud on\r")
            wait_for(b"ctx(last)")
            print("PASS: real Pi TUI mounts HUD, switches layout, resizes, and toggles off/on without a model call")
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
