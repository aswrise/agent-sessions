import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import MarkdownIt from "markdown-it";
import { CatalogError, SessionCatalog } from "./catalog.ts";
import { isStatus, type MarkPatch, type SearchEnvelope } from "./contracts.ts";
import { withResumeCommand } from "./resume.ts";
import { homeDirectory } from "./paths.ts";

type ServerOptions = {
  catalog: SessionCatalog;
  port?: number;
  nonce?: string;
  html?: string;
  platform?: NodeJS.Platform;
  home?: string;
};

class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const links = new MarkdownIt();
const previewExtensions = new Set([".md", ".markdown", ".txt", ".sql", ".html", ".htm", ".json", ".xml", ".yaml", ".yml", ".csv", ".log", ".sh", ".py", ".js", ".ts", ".java", ".properties"]);

const json = (value: unknown, status = 200) => Response.json(value, { status });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function body(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new RequestError(400, "请求 JSON 无效"); }
  if (!isRecord(value)) throw new RequestError(400, "请求 JSON 无效");
  return value;
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
  const home = options.home ?? homeDirectory();
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 7867,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") return json({ error: "Not found" }, 404);
      try {
        if (request.method === "GET" && url.pathname === "/health")
          return url.searchParams.get("nonce") === nonce ? json({ ok: true, nonce }) : json({ error: "Not found" }, 404);
        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (request.method === "GET" && url.pathname === "/api/sessions") {
          const scope = url.searchParams.get("scope") ?? undefined;
          if (scope !== undefined && scope !== "live" && scope !== "archive") throw new RequestError(400, "scope 必须是 live 或 archive");
          const sessions = await catalog.list({ ...(scope ? { scope } : {}), fresh: scope !== "archive" || url.searchParams.get("fresh") === "1" });
          return json({ generatedAt: new Date().toISOString(), home, sessions: sessions.map((session) => withResumeCommand(session, platform)), diagnostics: catalog.sourceDiagnostics() });
        }
        if (request.method === "GET" && url.pathname === "/api/search") {
          const query = url.searchParams.get("q")?.trim();
          if (!query) throw new RequestError(400, "缺少 q");
          const rawLimit = url.searchParams.get("limit"), limit = rawLimit === null ? Number.MAX_SAFE_INTEGER : Number(rawLimit);
          if (!Number.isSafeInteger(limit) || limit < 1) throw new RequestError(400, "limit 必须是正整数");
          const result = await catalog.find({ terms: [query] }, limit);
          const envelope: SearchEnvelope = { ...result, results: result.results.map((session) => withResumeCommand(session, platform)) };
          return json(envelope);
        }
        if (request.method === "GET" && url.pathname === "/api/session") {
          const id = url.searchParams.get("id");
          if (!id) throw new RequestError(400, "缺少 id");
          return json(withResumeCommand(await catalog.detail(id), platform));
        }
        if (request.method === "GET" && url.pathname === "/api/file-preview") {
          if (request.headers.get("sec-fetch-site") === "cross-site") throw new RequestError(403, "不允许跨站读取文件");
          const id = url.searchParams.get("id"), href = url.searchParams.get("href");
          if (!id || !href) throw new RequestError(400, "缺少会话或文件路径");
          const session = await catalog.detail(id);
          const linked = session.messages.some((message) => links.parse(message.text, {}).some((token) =>
            token.children?.some((child) => child.type === "link_open" && child.attrGet("href") === href)));
          if (!linked) throw new RequestError(403, "文件链接不在当前会话中");
          let path: string;
          try { path = decodeURIComponent(href.split("#", 1)[0] ?? "").replace(/:\d+(?::\d+)?$/, ""); }
          catch { throw new RequestError(400, "文件路径无效"); }
          if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) throw new RequestError(400, "仅支持本地文件");
          const extension = extname(path).toLowerCase();
          if (!previewExtensions.has(extension)) throw new RequestError(400, "不支持预览此文件类型");
          if (!isAbsolute(path) && (!session.cwd || session.cwd === "?" || !isAbsolute(session.cwd)))
            throw new RequestError(400, "会话工作目录不可用");
          const file = isAbsolute(path) ? path : resolve(session.cwd, path);
          try {
            const info = await stat(file);
            if (!info.isFile()) throw new RequestError(400, "路径不是文件");
            if (info.size > 2 * 1024 * 1024) throw new RequestError(400, "文件超过 2 MB，无法预览");
            const content = await readFile(file, "utf8");
            if (content.includes("\0")) throw new RequestError(400, "无法预览二进制文件");
            return json({ path: file, extension, content });
          } catch (error) {
            if (error instanceof RequestError) throw error;
            throw new RequestError(404, "文件不存在或无法读取");
          }
        }
        if (request.method === "GET" && url.pathname === "/api/lineage") {
          const id = url.searchParams.get("id");
          if (!id) throw new RequestError(400, "缺少 id");
          const lineage = await catalog.lineage(id, url.searchParams.get("refresh") !== "0");
          return json({ ...lineage, sessions: lineage.sessions.map((session) => withResumeCommand(session, platform)) });
        }
        if (request.method === "GET" && url.pathname === "/api/lineages") {
          const lineage = await catalog.lineages();
          return json({ ...lineage, sessions: lineage.sessions.map((session) => withResumeCommand(session, platform)) });
        }
        if (request.method === "POST" && url.pathname === "/api/lineage/index") {
          const value = await body(request);
          if (value.force !== undefined && typeof value.force !== "boolean") throw new RequestError(400, "force 必须是 boolean");
          return json(await catalog.refreshLineage(value.force === true));
        }
        if ((request.method === "POST" || request.method === "DELETE") && url.pathname === "/api/lineage/manual") {
          const value = await body(request), upstreamId = value.upstream_id, downstreamId = value.downstream_id;
          if (typeof upstreamId !== "string" || !upstreamId || typeof downstreamId !== "string" || !downstreamId)
            throw new RequestError(400, "缺少 upstream_id 或 downstream_id");
          if (request.method === "POST") await catalog.addManualLineage(upstreamId, downstreamId);
          else catalog.removeManualLineage(upstreamId, downstreamId);
          return json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/star") {
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
          if (value.pin !== undefined) {
            if (typeof value.pin !== "boolean") throw new RequestError(400, "pin 必须是 boolean");
            patch.pin = value.pin;
          }
          if (value.status !== undefined) {
            if (!isStatus(value.status)) throw new RequestError(400, "status 无效");
            patch.status = value.status;
          }
          await catalog.updateMark(id, patch);
          return json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/rename") {
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
