import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
let html = readFileSync(join(dist, "index.html"), "utf8");
html = html.replace(/<link\s+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href: string) =>
  `<style>${readFileSync(join(dist, href.replace(/^\//, "")), "utf8")}</style>`);
html = html.replace(/<script\s+type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src: string) =>
  `<script type="module">${readFileSync(join(dist, src.replace(/^\//, "")), "utf8").replaceAll("</script", "<\\/script")}</script>`);
if (/\b(?:src|href)="\/assets\//.test(html)) throw new Error("Vite asset was not embedded");

const build = fileURLToPath(new URL("../build/", import.meta.url));
mkdirSync(build, { recursive: true });
writeFileSync(join(build, "generated-html.ts"), `export const INDEX_HTML = ${JSON.stringify(html)};\n`);
writeFileSync(join(build, "standalone.ts"), `import { main } from "../src/cli.ts";\nimport { INDEX_HTML } from "./generated-html.ts";\nprocess.exit(await main(process.argv.slice(2), { html: INDEX_HTML }));\n`);
