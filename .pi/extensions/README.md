# Clawdy Pi Extensions

## OpenClaw SSH

`openclaw-ssh.ts` adds project-local Pi tools for inspecting OpenClaw on pi-server while keeping normal `read`/`edit`/`bash` local to the iOS app repo.

Default remote:

```bash
pi
```

The extension defaults to:

```text
OPENCLAW_SSH=pi-server
```

Optional overrides:

```bash
OPENCLAW_SSH=chrisherold@192.168.10.96 pi
OPENCLAW_DIR=/path/to/openclaw pi
OPENCLAW_IDENTITY=~/.ssh/some-key pi
OPENCLAW_LOG_COMMAND='journalctl --user -u openclaw -n {lines} --no-pager' pi
```

Registered tools:

- `openclaw_status` — read-only status/process/service/container check
- `openclaw_logs` — tail recent logs
- `openclaw_read` — read a remote config/log file
- `openclaw_bash` — explicit remote shell command for debugging

Use `/reload` in Pi after editing the extension.
