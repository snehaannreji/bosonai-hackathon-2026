import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const customPython = process.env.AVATAR_SETUP_PYTHON;
const candidates = customPython
  ? [{ command: customPython, args: [] }]
  : windows
    ? [
        ...["3.13", "3.12", "3.11", "3.10"].map(version => ({ command: "py", args: [`-${version}`] })),
        { command: "py", args: ["-3"] },
        { command: "python", args: [] },
      ]
    : ["python3.13", "python3.12", "python3.11", "python3.10", "python3"].map(command => ({ command, args: [] }));

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result;
};

let python;
for (const candidate of candidates) {
  const result = spawnSync(
    candidate.command,
    [...candidate.args, "-c", "import sys; raise SystemExit(sys.version_info < (3, 10))"],
    { cwd: root, stdio: "ignore" },
  );
  if (!result.error && result.status === 0) {
    python = candidate;
    break;
  }
}

if (!python) {
  console.error("Python 3.10 or newer was not found. Install it, or set AVATAR_SETUP_PYTHON to its executable path.");
  process.exit(1);
}

const venv = resolve(root, ".venv-avatar");
const venvPython = resolve(venv, windows ? "Scripts" : "bin", windows ? "python.exe" : "python");

try {
  const commands = [
    [python.command, [...python.args, "-m", "venv", venv]],
    [venvPython, ["-m", "pip", "install", "-r", resolve(root, "avatar", "requirements.txt")]],
    [venvPython, [resolve(root, "avatar", "agent.py"), "--check"]],
  ];
  for (const [executable, args] of commands) {
    const result = run(executable, args);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log("Avatar agent setup complete.");
} catch (error) {
  console.error(`Avatar setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
