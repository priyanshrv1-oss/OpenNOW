import { spawn } from "node:child_process";
import { resolve } from "node:path";

const script = process.argv[2];
if (!script) {
  console.error("usage: node run-electron-script.mjs <script>");
  process.exit(1);
}

const appRoot = resolve(import.meta.dirname, "..");
const electronBin = resolve(appRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const entry = resolve(appRoot, "scripts", script);

const child = spawn(electronBin, ["--no-sandbox", entry], {
  cwd: appRoot,
  env: {
    ...process.env,
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
