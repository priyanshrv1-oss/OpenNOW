import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const appRoot = resolve(import.meta.dirname, "..");
const isWin = process.platform === "win32";
const executableName = isWin ? "opennow-native-streamer.exe" : "opennow-native-streamer";
const targetDir = resolve(workspaceRoot, "opennow-native-streamer", "target", "release");
const sourceBinary = join(targetDir, executableName);
const outputBinary = resolve(appRoot, "native-bin", `${process.platform}-${process.arch}`, executableName);

const build = spawnSync("cargo", ["build", "--release", "--manifest-path", resolve(workspaceRoot, "opennow-native-streamer", "Cargo.toml")], {
  cwd: workspaceRoot,
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!existsSync(sourceBinary)) {
  throw new Error(`Native streamer binary missing after build: ${sourceBinary}`);
}

await mkdir(dirname(outputBinary), { recursive: true });
await copyFile(sourceBinary, outputBinary);
console.log(`[native-streamer] prepared ${outputBinary}`);
