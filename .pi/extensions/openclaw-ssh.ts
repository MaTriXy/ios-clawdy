import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type ExecOptions = {
  timeoutMs?: number;
};

const DEFAULT_REMOTE = process.env.OPENCLAW_SSH || "pi-server";
const DEFAULT_DIR = process.env.OPENCLAW_DIR || "";
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=2",
  ...(process.env.OPENCLAW_IDENTITY ? ["-i", process.env.OPENCLAW_IDENTITY, "-o", "IdentitiesOnly=yes"] : []),
  ...(process.env.OPENCLAW_SSH_EXTRA_ARGS ? process.env.OPENCLAW_SSH_EXTRA_ARGS.split(/\s+/).filter(Boolean) : []),
];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function withRemoteDir(command: string): string {
  if (!DEFAULT_DIR) return command;
  return `cd ${shellQuote(DEFAULT_DIR)} && ${command}`;
}

function sshExec(command: string, options: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTIONS, DEFAULT_REMOTE, withRemoteDir(command)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`openclaw SSH command timed out after ${options.timeoutMs ?? 30000}ms`));
    }, options.timeoutMs ?? 30000);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString();
      const err = Buffer.concat(stderr).toString();
      if (code === 0) {
        resolve(out || err);
        return;
      }
      reject(new Error(`ssh exited ${code}\nSTDOUT:\n${out}\nSTDERR:\n${err}`));
    });
  });
}

function text(content: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: content.trimEnd() || "(no output)" }],
    details: { remote: DEFAULT_REMOTE, remoteDir: DEFAULT_DIR || null, ...details },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "openclaw_status",
    label: "OpenClaw Status",
    description:
      "Check OpenClaw process/service/container status on pi-server over SSH. Read-only.",
    parameters: Type.Object({}),
    async execute() {
      const command = `
set -u
printf 'remote: '; hostname
printf 'user: '; whoami
printf 'pwd: '; pwd
printf '\nopenclaw binary:\n'
command -v openclaw || true
printf '\nmatching processes:\n'
pgrep -af 'openclaw|claude|codex|pi' || true
printf '\nuser service:\n'
systemctl --user --no-pager status openclaw 2>&1 || true
printf '\nsystem service:\n'
systemctl --no-pager status openclaw 2>&1 || true
printf '\ndocker containers:\n'
if command -v docker >/dev/null 2>&1; then docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -i 'openclaw\|claw' || true; else echo 'docker not installed'; fi
`;
      const output = await sshExec(command, { timeoutMs: 30000 });
      return text(output);
    },
  });

  pi.registerTool({
    name: "openclaw_logs",
    label: "OpenClaw Logs",
    description:
      "Tail recent OpenClaw logs on pi-server over SSH. Uses OPENCLAW_LOG_COMMAND if set, otherwise tries journalctl/docker/common log files.",
    parameters: Type.Object({
      lines: Type.Optional(Type.Number({ description: "Number of log lines to fetch", default: 120 })),
    }),
    async execute(_id, params) {
      const requestedLines = Number(params.lines ?? 120);
      const lines = Math.max(20, Math.min(1000, requestedLines));
      const custom = process.env.OPENCLAW_LOG_COMMAND;
      const command = custom
        ? custom.replaceAll("{lines}", String(lines))
        : `
set -u
if systemctl --user list-units --type=service --all 2>/dev/null | grep -q '^  openclaw.service'; then
  journalctl --user -u openclaw -n ${lines} --no-pager
elif systemctl list-units --type=service --all 2>/dev/null | grep -q '^  openclaw.service'; then
  journalctl -u openclaw -n ${lines} --no-pager
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx 'openclaw'; then
  docker logs --tail ${lines} openclaw 2>&1
elif [ -f ./openclaw.log ]; then
  tail -n ${lines} ./openclaw.log
elif [ -f ~/.openclaw/openclaw.log ]; then
  tail -n ${lines} ~/.openclaw/openclaw.log
else
  echo 'No known OpenClaw log source found. Set OPENCLAW_LOG_COMMAND to override.'
fi
`;
      const output = await sshExec(command, { timeoutMs: 30000 });
      return text(output, { lines });
    },
  });

  pi.registerTool({
    name: "openclaw_read",
    label: "OpenClaw Read Remote File",
    description:
      "Read a file on pi-server over SSH, useful for OpenClaw config/log files. Read-only.",
    parameters: Type.Object({
      path: Type.String({ description: "Remote file path. Relative paths resolve from OPENCLAW_DIR if set, otherwise remote home." }),
      lines: Type.Optional(Type.Number({ description: "Max lines to return", default: 240 })),
    }),
    async execute(_id, params) {
      const lines = Math.max(20, Math.min(2000, Number(params.lines ?? 240)));
      const path = String(params.path);
      const command = `test -f ${shellQuote(path)} && sed -n '1,${lines}p' ${shellQuote(path)}`;
      const output = await sshExec(command, { timeoutMs: 20000 });
      return text(output, { path, lines });
    },
  });

  pi.registerTool({
    name: "openclaw_bash",
    label: "OpenClaw Remote Bash",
    description:
      "Run an explicit shell command on pi-server over SSH for OpenClaw debugging. Use for inspection; avoid destructive changes unless Chris asked.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run remotely" }),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Timeout in seconds", default: 30 })),
    }),
    async execute(_id, params) {
      const timeoutSeconds = Math.max(1, Math.min(300, Number(params.timeoutSeconds ?? 30)));
      const command = String(params.command);
      const output = await sshExec(command, { timeoutMs: timeoutSeconds * 1000 });
      return text(output, { command, timeoutSeconds });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("openclaw", ctx.ui.theme.fg("accent", `OpenClaw SSH: ${DEFAULT_REMOTE}${DEFAULT_DIR ? `:${DEFAULT_DIR}` : ""}`));
  });
}
