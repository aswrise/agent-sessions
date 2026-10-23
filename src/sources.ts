import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { isTool, type SourceDiagnostic, type Tool } from "./contracts.ts";
import { sourceCopy } from "./sourceCopy.ts";

export type ArchiveSource = {
  id: string;
  label: string;
  scope?: string;
  roots: { id: string; tool: Tool; path: string }[];
  cwdMappings: { from: string; to: string }[];
  continuationDirectory?: string;
};

export function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function realContained(root: string, path: string): boolean {
  try { return contained(realpathSync(root), realpathSync(path)); } catch { return false; }
}

const historicalPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") ? win32 : posix;

export function cwdMappingSuffix(from: string, cwd: string): string | undefined {
  const paths = historicalPath(from);
  if (!paths.isAbsolute(cwd)) return;
  const child = paths.relative(from, cwd);
  if (child === ".." || child.startsWith(`..${paths.sep}`) || paths.isAbsolute(child)) return;
  return child.split(paths.sep).join(sep);
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && value !== "live";

export function readSources(file: string, home: string): { sources: ArchiveSource[]; diagnostics: SourceDiagnostic[] } {
  const diagnostics: SourceDiagnostic[] = [], sources: ArchiveSource[] = [];
  if (!existsSync(file)) return { sources, diagnostics };
  const pathValue = (value: unknown): string => {
    if (typeof value !== "string" || value.includes("\0")) throw new Error(sourceCopy.errors.absolutePath);
    const expanded = value.startsWith("~/") ? join(home, value.slice(2)) : value;
    if (!isAbsolute(expanded)) throw new Error(sourceCopy.errors.absolutePath);
    return resolve(expanded);
  };
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!object(value) || value.version !== 1 || !Array.isArray(value.sources)) throw new Error(sourceCopy.errors.schema);
    const ids = new Set<string>();
    for (const item of value.sources) {
      const sourceId = object(item) && typeof item.id === "string" ? item.id : "config";
      try {
        if (!object(item) || !identifier(item.id) || ids.has(item.id)) throw new Error(sourceCopy.errors.sourceId);
        ids.add(item.id);
        if (item.label !== undefined && typeof item.label !== "string" || item.scope !== undefined && typeof item.scope !== "string") throw new Error(sourceCopy.errors.labels);
        if (!Array.isArray(item.roots) || !item.roots.length) throw new Error(sourceCopy.errors.roots);
        const rootIds = new Set<string>();
        const roots = item.roots.map((root) => {
          if (!object(root) || !identifier(root.id) || rootIds.has(root.id) || !isTool(root.tool)) throw new Error(sourceCopy.errors.root);
          rootIds.add(root.id);
          return { id: root.id, tool: root.tool, path: pathValue(root.path) };
        });
        if (item.cwdMappings !== undefined && !Array.isArray(item.cwdMappings)) throw new Error(sourceCopy.errors.mappings);
        const cwdMappings = (item.cwdMappings ?? []).map((mapping: unknown) => {
          if (!object(mapping) || typeof mapping.from !== "string" || !historicalPath(mapping.from).isAbsolute(mapping.from) || mapping.from.includes("\0")) throw new Error(sourceCopy.errors.mappingFrom);
          return { from: historicalPath(mapping.from).normalize(mapping.from), to: pathValue(mapping.to) };
        });
        sources.push({ id: item.id, label: typeof item.label === "string" ? item.label : item.id, roots, cwdMappings,
          ...(typeof item.scope === "string" ? { scope: item.scope } : {}),
          ...(item.continuationDirectory === undefined ? {} : { continuationDirectory: pathValue(item.continuationDirectory) }) });
      } catch (error) { diagnostics.push({ source_id: sourceId, level: "error", message: error instanceof Error ? error.message : sourceCopy.errors.source }); }
    }
  } catch (error) { diagnostics.push({ source_id: "config", level: "error", message: error instanceof Error ? error.message : sourceCopy.errors.config }); }
  return { sources, diagnostics };
}
