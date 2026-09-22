#!/usr/bin/env python3
"""Real-account quota E2E (read-only).

GLM mode runs the real Pi 0.85.1 TUI with the user's real agent directory
(auth.json holds the zai-coding-cn personal credential). DeepSeek mode runs the
same flow against Pi's built-in `deepseek` provider, whose key resolves from the
DEEPSEEK_API_KEY environment variable at query time (the auth.json entry is
empty, so the env fallback applies). Both use a temporary HUD config that enables
the quota feature with the matching profile and the working-tree extension.
It never prints credentials; only sanitized HUD rows and the /hud quotas JSON are
captured. No model requests are sent; the quota queries are read-only GETs
against https://open.bigmodel.cn (GLM) / https://api.deepseek.com (DeepSeek).
"""
import json
import os
import pathlib
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import fcntl
import termios

ROOT = pathlib.Path(__file__).resolve().parent.parent
SDK = ROOT / ".tmp/sdk/node_modules/@earendil-works/pi-coding-agent"
METADATA = json.loads((SDK / "package.json").read_text())
assert METADATA["version"] == "0.85.1", METADATA["version"]
CLI = SDK / "dist/bundle/cli.js"
NODE = shutil.which("node")

PROFILES = {
    "personal": {
        "id": "glm-personal", "providerId": "zai-coding-cn", "adapter": "zai", "source": "pi",
        "region": "cn", "plan": "personal", "queryMode": "personal-legacy",
    },
    "team": {
        "id": "glm-team", "providerId": "zai-coding-team", "adapter": "zai", "source": "pi",
        "region": "cn", "plan": "team", "queryMode": "team",
        "organizationId": os.environ.get("E2E_TEAM_ORG", ""),
        "projectId": os.environ.get("E2E_TEAM_PROJECT", ""),
    },
    "deepseek": {
        "id": "deepseek-balance", "providerId": "deepseek", "adapter": "deepseek", "source": "pi",
    },
    "codex": {
        "id": "codex-main", "providerId": "openai-codex", "adapter": "codex", "source": "codex-app-server",
    },
}

MODELS = {
    "personal": "zai-coding-cn/glm-4.7",
    "team": "zai-coding-team/glm-5.3",
    "deepseek": "deepseek/deepseek-v4-flash",
    "codex": "openai-codex/gpt-6-astra",
}


def read_pty(fd, seconds, sink):
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        sink.append(chunk.decode("utf-8", errors="replace"))
    return "".join(sink)


def strip_ansi(text):
    return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f]", "", text)


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "personal"
    if mode not in PROFILES:
        print(json.dumps({"mode": mode, "error": "unknown mode; use personal|team|deepseek|codex"}))
        return 2
    model = MODELS[mode]
    profile = dict(PROFILES[mode])
    if mode == "team":
        if not profile["organizationId"] or not profile["projectId"]:
            print(json.dumps({"mode": mode, "skipped": "E2E_TEAM_ORG/E2E_TEAM_PROJECT not provided"}, ensure_ascii=False))
            return 0
    work = tempfile.mkdtemp(prefix="pi-hud-quota-e2e-")
    config_path = pathlib.Path(work) / "pi-hud.json"
    config_path.write_text(json.dumps({
        "version": 1, "preset": "balanced", "surface": "footer", "language": "en",
        "quota": {"enabled": True, "ttlMs": 300000, "timeoutMs": 8000, "profiles": [profile]},
    }, ensure_ascii=False, indent=2))
    env = {
        "PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "/home/shq"),
        "TERM": "xterm-256color", "LANG": "C.UTF-8",
        "PI_CODING_AGENT_DIR": os.environ.get("PI_CODING_AGENT_DIR", str(pathlib.Path.home() / ".pi/agent")),
        "PI_HUD_CONFIG": str(config_path), "PI_OFFLINE": "1",
        "ZAI_API_KEY_TEAM": os.environ.get("ZAI_API_KEY_TEAM", ""),
        # DeepSeek: the built-in provider resolves the key from this env var when
        # the auth.json entry is empty; passed through, never printed.
        "DEEPSEEK_API_KEY": os.environ.get("DEEPSEEK_API_KEY", ""),
        # Codex: the app-server child inherits this environment; networks that need
        # an egress proxy must have it set where this script runs (generic passthrough).
        "http_proxy": os.environ.get("http_proxy", ""),
        "https_proxy": os.environ.get("https_proxy", ""),
        "all_proxy": os.environ.get("all_proxy", ""),
        "no_proxy": os.environ.get("no_proxy", ""),
    }
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work)
        os.execve(NODE, [NODE, str(CLI), "--no-session", "--no-extensions", "--model", model,
                         "-e", str(ROOT / "index.ts")], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    result = {"mode": mode, "model": model, "config": json.loads(config_path.read_text())}
    try:
        frames = []
        read_pty(fd, 9, frames)
        result["initialFrameQuota"] = quota_rows("".join(frames))
        # /hud quotas output
        os.write(fd, b"/hud quotas\r")
        out = read_pty(fd, 8, [])
        result["quotasCommandSeen"] = '"enabled": true' in out or '"enabled":true' in out
        result["quotaRows"] = quota_rows(out)
        result["quotasJson"] = extract_quotas_json(out)
        # quota off / on round-trip (streaming interaction sanity)
        os.write(fd, b"/hud quota off\r")
        out = read_pty(fd, 4, [])
        result["offAck"] = "quota off" in out
        os.write(fd, b"/hud quota on\r")
        out = read_pty(fd, 4, [])
        result["onAck"] = "quota on" in out
        os.write(fd, b"/hud quota refresh\r")
        out = read_pty(fd, 6, [])
        result["refreshAck"] = "quota refresh" in out
        result["postRefreshRows"] = quota_rows(out)
    finally:
        os.write(fd, b"\x03")
        time.sleep(0.3)
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
        time.sleep(0.5)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)
        shutil.rmtree(work, ignore_errors=True)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def quota_rows(text):
    rows = []
    for line in strip_ansi(text).splitlines():
        if any(mark in line for mark in ("GLM Personal", "GLM Team", "GLM \u4e2a\u4eba", "GLM \u56e2\u961f", "DeepSeek", "Codex")):
            rows.append(line.strip()[:160])
    return rows[-4:]


def extract_quotas_json(text):
    plain = strip_ansi(text)
    for marker in ('"enabled"', "'enabled'"):
        start = plain.find(marker)
        if start < 0:
            continue
        # Walk outward to the enclosing object: find the nearest '{' before the marker
        # whose JSON parses and contains the quota diagnostics keys.
        begin = plain.rfind("{", 0, start)
        while begin >= 0:
            depth = 0
            end = -1
            in_string = False
            escape = False
            for index in range(begin, len(plain)):
                char = plain[index]
                if in_string:
                    if escape:
                        escape = False
                    elif char == "\\":
                        escape = True
                    elif char == '"':
                        in_string = False
                    continue
                if char == '"':
                    in_string = True
                elif char == "{":
                    depth += 1
                elif char == "}":
                    depth -= 1
                    if depth == 0:
                        end = index + 1
                        break
            if end > 0:
                candidate = plain[begin:end]
                try:
                    parsed = json.loads(candidate)
                    if isinstance(parsed, dict) and "enabled" in parsed and ("profileList" in parsed or "profiles" in parsed):
                        return parsed
                except json.JSONDecodeError:
                    pass
            begin = plain.rfind("{", 0, begin)
    return None


if __name__ == "__main__":
    raise SystemExit(main())
