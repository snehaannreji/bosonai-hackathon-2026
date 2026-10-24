import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const requestedPython = process.env.AVATAR_SETUP_PYTHON;
const candidates = requestedPython
  ? [requestedPython]
  : process.platform === "win32"
    ? ["py -3.13", "py -3.12", "py -3.11", "py -3.10", "python"]
    : ["python3.12", "python3.11", "python3.10", "python3"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) return { ok: false, error: result.error };
  return { ok: result.status === 0, status: result.status };
}

function pythonCommand(candidate) {
  if (candidate.startsWith("py ")) {
    const [, version] = candidate.split(" ");
    return { command: "py", args: [version] };
  }
  return { command: candidate, args: [] };
}

let selected;
for (const candidate of candidates) {
  const parsed = pythonCommand(candidate);
  const probe = run(parsed.command, [...parsed.args, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], { stdio: "ignore" });
  if (probe.ok) {
    selected = parsed;
    break;
  }
}

if (!selected) {
  console.error("Python 3.10+ was not found. Set AVATAR_SETUP_PYTHON to its executable and retry.");
  process.exit(1);
}

const venvResult = run(selected.command, [...selected.args, "-m", "venv", ".venv-avatar"]);
if (!venvResult.ok) process.exit(venvResult.status ?? 1);

const venvPython = resolve(
  process.platform === "win32" ? ".venv-avatar/Scripts/python.exe" : ".venv-avatar/bin/python",
);
for (const args of [
  ["-m", "pip", "install", "-r", "avatar/requirements.txt"],
  ["avatar/agent.py", "--check"],
]) {
  const result = run(venvPython, args);
  if (!result.ok) process.exit(result.status ?? 1);
}
