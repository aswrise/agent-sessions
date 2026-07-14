import { Database } from "bun:sqlite";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = new URL("./fixtures/home/", import.meta.url).pathname;

export function fixtureHome(): { home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
  const home = join(root, "home");
  cpSync(source, home, { recursive: true });
  for (const path of new Bun.Glob("**/*.jsonl").scanSync({ cwd: home, absolute: true, dot: true })) {
    if (!path.endsWith("small.jsonl"))
      appendFileSync(path, JSON.stringify({ padding: "x".repeat(2200) }) + "\n");
    const name = path.split("/").at(-1);
    const timestamp = name === "claude-a.jsonl" ? 100 : name === "rollout-codex-b.jsonl" ? 200 : name === "pi-c.jsonl" ? 300 : 50;
    utimesSync(path, timestamp, timestamp);
  }
  const rows = JSON.parse(readFileSync(join(home, ".codex/state-rows.json"), "utf8"));
  const database = new Database(join(home, ".codex/state_5.sqlite"), { create: true });
  database.run("CREATE TABLE threads (id, title, first_user_message)");
  const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?)");
  database.transaction((values: string[][]) => values.forEach((row) => insert.run(...row)))(rows);
  database.close();
  return { home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
