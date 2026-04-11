import { spawn } from "node:child_process";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const electronBin = resolve(appRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const electronEntry = resolve(appRoot, "scripts", "native-streamer-e2e-electron.mjs");

const child = spawn(electronBin, ["--no-sandbox", electronEntry], {
  cwd: appRoot,
  env: {
    ...process.env,
    OPENNOW_NATIVE_STREAMER_AUDIO_SINK: process.env.OPENNOW_NATIVE_STREAMER_AUDIO_SINK ?? "fakesink",
    OPENNOW_NATIVE_STREAMER_BIN:
      process.env.OPENNOW_NATIVE_STREAMER_BIN ??
      resolve(appRoot, "native-bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "opennow-native-streamer.exe" : "opennow-native-streamer"),
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
