import { createHash } from "node:crypto";
import { SessionCatalog } from "../src/catalog.ts";
import { startServer } from "../src/server.ts";

const catalog = new SessionCatalog();
const sessions = await catalog.list({ fresh: true });
const ids = new Set(sessions.map(({ id }) => id));
if (ids.size !== sessions.length) throw new Error("duplicate Session ids");
for (const session of sessions) {
  if (!session.id || !["claude", "codex", "pi"].includes(session.tool) || !Number.isFinite(session.mtime))
    throw new Error("invalid normalized Session shape");
}
const server = startServer({ catalog, port: 0, nonce: crypto.randomUUID(), html: "ok" });
try {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions`);
  if (!response.ok) throw new Error(`HTTP shape check failed: ${response.status}`);
  const envelope = await response.json();
  if (!Array.isArray(envelope.sessions) || envelope.sessions.length !== sessions.length) throw new Error("HTTP/catalog count mismatch");
} finally { server.stop(true); }

const counts = Object.fromEntries(["claude", "codex", "pi"].map((tool) => [tool, sessions.filter((session) => session.tool === tool).length]));
const idShapeHash = createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
console.log(JSON.stringify({ count: sessions.length, counts, idShapeHash, httpStatus: 200 }));
