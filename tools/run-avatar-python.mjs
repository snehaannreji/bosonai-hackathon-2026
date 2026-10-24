import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const windows = process.platform === "win32";
const python = resolve(
  ".venv-avatar",
  windows ? "Scripts" : "bin",
  windows ? "python.exe" : "python",
);
const result = spawnSync(python, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`Could not run the avatar Python environment. Run npm run avatar:setup first. ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
