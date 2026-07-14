import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const file = process.argv[2];
if (!file) throw new Error("usage: bun scripts/checksum.ts <file>");
const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(`${file}.sha256`, `${digest}  ${basename(file)}\n`);
