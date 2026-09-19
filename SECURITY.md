# Security policy

pi-hud is trusted code inside Pi's process, not a sandbox. Its protection is deliberately limited to its own behavior: no network requests, credential reads, prompt/session writes, LLM tools or shell execution. Git is opt-in and uses a fixed argument array without a shell. Config and display inputs are bounded; terminal escape/control/bidi sequences are removed from untrusted display text. API callbacks contain failures rather than writing raw output.

Configuration symlinks are supported for dotfile workflows; only point them at files you control. Another loaded extension can emit bridge data or mutate shared process state, so the event bus is not an authenticated security boundary. An attacker with the ability to replace this package, its config, Node, or Git is outside this model. Optional Git's command timeout is best-effort; it cannot guarantee that a kernel-blocked filesystem operation instantly stops.

Do not publish API tokens, transcripts, command contents, sensitive basenames, personal paths or raw debug dumps in issues. Provide a sanitized minimal reproduction and aggregate timing data. The HUD itself keeps basenames rather than full tool paths, but basenames and bridge labels can still be sensitive on a shared screen.

This delivery has no pre-created GitHub repository or private reporting endpoint. After publishing the repository, its owner should enable GitHub private vulnerability reporting. Until then, report privately to the maintainer through an established channel rather than creating a public issue with exploit details or credentials. No fictitious email/contact address is supplied.

Supported integration target for this initial delivery: Pi 0.85.1. Host upgrades require contract, loader, lifecycle and performance revalidation; there is no claim of universal forward compatibility.
