import { writeFileSync } from "node:fs";

const [file, target, executed] = process.argv.slice(2);
if (!file || !target || !executed) throw new Error("usage: record-verification <file> <target> <true|false>");
writeFileSync(`${file}.verification.json`, JSON.stringify({ target, executed: executed === "true", checkedAt: new Date().toISOString() }, null, 2) + "\n");
