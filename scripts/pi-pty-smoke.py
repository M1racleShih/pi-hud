#!/usr/bin/env python3
"""Optional Linux/macOS real-Pi TUI smoke. No model requests or API credentials.

Requires the isolated .tmp/sdk install used by CI. This is NOT a streaming
performance A/B test. It checks real widget/footer mounting, surface ownership,
native-footer restoration, extension status updates, commands and resizing.
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
                            "-e", str(root / "examples/bridge-demo.ts"),
                            "-e", str(root / "examples/status-demo.ts")], env)
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
        # Markers only the built-in Pi footer renders: the auto-compaction flag and its
        # one-decimal context percentage. The HUD never prints either, in any surface.
        native_footer = re.compile(rb"\(auto\)|\d+\.\d+%/")
        demo_status = b"DEMO status"

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
            # --- optional footer surface -------------------------------------------------
            # The surface switch replaces the footer container, so the notify and the redraw
            # land in the same PTY window; each window is checked for native-footer-only text.
            os.write(fd, b"/hud surface footer\r")
            footer_frame = wait_for(b"ctx(last)")
            if b"pi-hud surface footer" not in footer_frame:
                raise RuntimeError("the surface command did not run before the footer frame")
            if native_footer.search(footer_frame):
                raise RuntimeError("the native footer was still rendered after switching to the footer surface")
            # A full repaint must not resurrect the native footer while the HUD owns the slot.
            # The size really changes, because Pi only repaints the whole tree for a new size.
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 101, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            repaint = wait_for(b"ctx(last)")
            if native_footer.search(repaint):
                raise RuntimeError("the native footer reappeared during a footer-surface repaint")
            # An independent extension's setStatus must reach the HUD footer with no HUD event.
            # Pi redraws only the changed footer line, so the full frame is checked after a
            # forced repaint that still carries the new status text.
            os.write(fd, b"/hud-status-demo two\r")
            wait_for(b"DEMO status two")
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 102, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            status = wait_for(b"DEMO status two")
            if b"ctx(last)" not in status:
                raise RuntimeError("the HUD footer disappeared while updating an extension status")
            if native_footer.search(status):
                raise RuntimeError("the native footer reappeared while updating an extension status")
            # Switching back must restore the built-in footer: `(auto)` is native-footer only.
            os.write(fd, b"/hud surface widget\r")
            restored = wait_for(b"(auto)")
            if b"ctx(last)" not in restored or b"pi-hud surface widget" not in restored:
                raise RuntimeError("the widget surface did not return after switching back")
            # Footer ownership: off must restore the native footer instead of leaving a gap.
            os.write(fd, b"/hud surface footer\r")
            back_to_footer = wait_for(b"ctx(last)")
            if native_footer.search(back_to_footer):
                raise RuntimeError("the native footer was still rendered in footer mode")
            os.write(fd, b"/hud off\r")
            off = wait_for(b"(auto)")
            if b"pi-hud off" not in off:
                raise RuntimeError("the off command did not run before the native footer returned")
            os.write(fd, b"/hud on\r")
            on = wait_for(b"ctx(last)")
            if b"pi-hud on" not in on:
                raise RuntimeError("the on command did not reinstall the footer surface")
            if native_footer.search(on):
                raise RuntimeError("the native footer was still rendered after re-enabling the footer surface")
            print("PASS: real Pi TUI mounts the HUD widget and footer, shows bridged activity and an "
                  "independent extension status, switches surface, restores the native footer on "
                  "surface switch and off, resizes, and switches layout/palette without a model call")
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
