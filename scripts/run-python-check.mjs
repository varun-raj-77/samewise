import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matcherProject = join(root, "services", "matcher");
const checks = {
  lint: {
    uvArgs: ["run", "--project", matcherProject, "ruff", "check", join(root, "services", "matcher")],
    moduleArgs: ["-m", "ruff", "check", join(root, "services", "matcher")],
  },
  test: {
    uvArgs: ["run", "--project", matcherProject, "pytest", join(root, "services", "matcher"), "--basetemp", join(root, ".samewise-data", "pytest-tmp")],
    moduleArgs: ["-m", "pytest", join(root, "services", "matcher"), "--basetemp", join(root, ".samewise-data", "pytest-tmp")],
  },
};

const checkName = process.argv[2];
const check = checks[checkName];
if (!check) {
  console.error("Usage: node scripts/run-python-check.mjs <lint|test>");
  process.exit(2);
}

const uvResult = spawnSync("uv", check.uvArgs, { cwd: root, stdio: "inherit", shell: false });
if (!uvResult.error) process.exit(uvResult.status ?? 1);
if (uvResult.error.code !== "ENOENT") {
  console.error(`Could not launch uv: ${uvResult.error.message}`);
  process.exit(1);
}

const python = process.platform === "win32"
  ? join(matcherProject, ".venv", "Scripts", "python.exe")
  : join(matcherProject, ".venv", "bin", "python");

if (!existsSync(python)) {
  console.error([
    "Python verification requires uv or the synchronized services/matcher/.venv environment.",
    "Install uv if needed, then run: uv sync --project services/matcher --locked",
  ].join("\n"));
  process.exit(1);
}

console.log(`uv is not on PATH; using the synchronized project environment at ${python}`);
const fallbackResult = spawnSync(python, check.moduleArgs, { cwd: root, stdio: "inherit", shell: false });
if (fallbackResult.error) {
  console.error(`Could not launch the project Python environment: ${fallbackResult.error.message}`);
  process.exit(1);
}
process.exit(fallbackResult.status ?? 1);
