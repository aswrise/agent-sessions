import { CatalogError, SessionCatalog } from "./catalog.ts";
import { isStatus, type MarkPatch, type Session, type Transcript } from "./contracts.ts";
import { formatResumeCommand } from "./resume.ts";

type ServerOptions = {
  catalog: SessionCatalog;
  port?: number;
  nonce?: string;
  html?: string;
  platform?: NodeJS.Platform;
};

class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const json = (value: unknown, status = 200) => Response.json(value, { status });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function body(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new RequestError(400, "请求 JSON 无效"); }
  if (!isRecord(value)) throw new RequestError(400, "请求 JSON 无效");
  return value;
}

function view<T extends Session | Transcript>(session: T, platform: NodeJS.Platform): T & { resume_command: string } {
  return { ...session, resume_command: formatResumeCommand(session, platform) };
}

function catalogStatus(error: unknown): number {
  if (error instanceof CatalogError) {
    if (error.code === "not_found") return 404;
    if (error.code === "invalid" || error.code === "ambiguous") return 400;
  }
  return 500;
}

export function startServer(options: ServerOptions): Bun.Server<undefined> {
  const catalog = options.catalog;
  const nonce = options.nonce ?? crypto.randomUUID();
  const html = options.html ?? "<!doctype html><html lang=\"zh-CN\"><body><div id=\"app\"></div></body></html>";
  const platform = options.platform ?? process.platform;
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 7867,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "POST") return json({ error: "Not found" }, 404);
      try {
        if (request.method === "GET" && url.pathname === "/health")
          return url.searchParams.get("nonce") === nonce ? json({ ok: true, nonce }) : json({ error: "Not found" }, 404);
        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (request.method === "GET" && url.pathname === "/api/sessions") {
          const sessions = await catalog.list({ fresh: url.searchParams.get("fresh") === "1" });
          return json({ generatedAt: new Date().toISOString(), sessions: sessions.map((session) => view(session, platform)) });
        }
        if (request.method === "GET" && url.pathname === "/api/session") {
          const id = url.searchParams.get("id");
          if (!id) throw new RequestError(400, "缺少 id");
          return json(view(await catalog.detail(id), platform));
        }
        if (request.method === "POST" && ["/star", "/api/star"].includes(url.pathname)) {
          const value = await body(request), id = value.id;
          if (typeof id !== "string" || !id) throw new RequestError(400, "缺少 id");
          const patch: MarkPatch = {};
          if (value.star !== undefined) {
            if (typeof value.star !== "boolean") throw new RequestError(400, "star 必须是 boolean");
            patch.star = value.star;
          }
          if (value.note !== undefined) {
            if (typeof value.note !== "string") throw new RequestError(400, "note 必须是 string");
            patch.note = value.note;
          }
          if (value.archive !== undefined) {
            if (typeof value.archive !== "boolean") throw new RequestError(400, "archive 必须是 boolean");
            patch.archive = value.archive;
          }
          if (value.status !== undefined) {
            if (!isStatus(value.status)) throw new RequestError(400, "status 无效");
            patch.status = value.status;
          }
          await catalog.updateMark(id, patch);
          return json({ ok: true });
        }
        if (request.method === "POST" && ["/rename", "/api/rename"].includes(url.pathname)) {
          const value = await body(request), id = value.id, name = value.name;
          if (typeof id !== "string" || !id) throw new RequestError(400, "缺少 id");
          if (typeof name !== "string" || !name.trim()) throw new RequestError(400, "名称不能为空");
          await catalog.rename(id, name);
          return json({ ok: true });
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        if (error instanceof RequestError) return json({ error: error.message }, error.status);
        const status = catalogStatus(error);
        if (status !== 500 && error instanceof Error) return json({ error: error.message }, status);
        return json({ error: "操作失败" }, 500);
      }
    },
  });
}
