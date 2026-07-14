import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined;
}
const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const target = argument("--target") ?? `bun-${os}-${arch}`;
const outfile = argument("--outfile") ?? `build/sessions${target.includes("windows") ? ".exe" : ""}`;
mkdirSync(dirname(outfile), { recursive: true });

for (const command of [
  [process.execPath, "run", "build:ui"],
  [process.execPath, "scripts/embed.ts"],
  [process.execPath, "build", "--compile", `--target=${target}`, "build/standalone.ts", `--outfile=${outfile}`],
]) {
  const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode) process.exit(result.exitCode);
}
console.log(outfile);
