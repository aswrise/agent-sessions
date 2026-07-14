import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixtureHome } from "../tests/fixture-home.ts";
import packageJson from "../package.json" with { type: "json" };

const artifact = resolve(process.argv[2] ?? "");
if (!existsSync(artifact)) throw new Error(`artifact not found: ${artifact}`);
if (process.platform !== "win32" && !(statSync(artifact).mode & 0o100)) throw new Error("artifact is not executable");
const fixture = fixtureHome(), cwd = join(fixture.home, "cwd with spaces"); mkdirSync(cwd);
const environment = { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home };

function run(args: string[], env = environment) {
  const result = Bun.spawnSync([artifact, ...args], { cwd, env });
  if (result.exitCode) throw new Error(`${args[0]} smoke failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

try {
  if (!run(["--help"]).includes("sessions dash --stop")) throw new Error("help output missing");
  if (!run(["--version"]).includes(packageJson.version)) throw new Error("version output missing");
  const database = join(fixture.home, ".codex/state_5.sqlite"), before = statSync(database).mtimeMs;
  if (!run(["list", "-n", "3"]).includes("codex-b")) throw new Error("fixture SQLite/list smoke failed");
  if (statSync(database).mtimeMs !== before) throw new Error("Codex SQLite was modified");
  const missingRg = Bun.spawnSync([artifact, "find", "fixture"], { cwd, env: { ...environment, PATH: join(fixture.home, "missing") } });
  if (missingRg.exitCode !== 1 || !missingRg.stderr.toString().includes("ripgrep")) throw new Error("missing-rg error smoke failed");

  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port!; probe.stop(true);
  const nonce = crypto.randomUUID(), state = join(fixture.home, "state", "dashboard.json");
  const child = Bun.spawn([artifact, "_serve", "--port", String(port), "--nonce", nonce, "--state", state], { cwd, env: environment, stdout: "ignore", stderr: "ignore" });
  try {
    for (let attempt = 0; attempt < 50 && !existsSync(state); attempt++) await Bun.sleep(100);
    const saved = JSON.parse(readFileSync(state, "utf8"));
    if (saved.pid !== child.pid || saved.nonce !== nonce) throw new Error("dashboard state mismatch");
    const response = await fetch(`http://127.0.0.1:${port}/`), html = await response.text();
    if (!response.ok || !html.includes('id="app"') || /\b(?:src|href)="\/assets\//.test(html)) throw new Error("embedded dashboard asset smoke failed");
    const health = await (await fetch(`http://127.0.0.1:${port}/health?nonce=${nonce}`)).json();
    if (health.nonce !== nonce) throw new Error("nonce health smoke failed");
  } finally {
    child.kill("SIGTERM"); await child.exited;
  }
  if (existsSync(state)) throw new Error("dashboard state was not cleaned");
  console.log("artifact smoke passed");
} finally {
  fixture.cleanup();
}
