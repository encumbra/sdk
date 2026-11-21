// Post-build step: point relative imports in the emitted declaration files at `.js`.
//
// The sources import siblings with `.ts` extensions. `rewriteRelativeImportExtensions` rewrites
// those to `.js` in the emitted JavaScript, but tsc leaves the specifiers in `.d.ts` output as
// written. Consumers resolve `./client.js` to `./client.d.ts`, so rewrite them here.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const SPECIFIER = /((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']+?)\.ts\2/g;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

let files;
try {
  files = walk(dist).filter((p) => p.endsWith(".d.ts"));
} catch (err) {
  console.error(`fix-dts-extensions: cannot read ${dist}; run tsc first.`, err);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`fix-dts-extensions: no declaration files in ${dist}`);
  process.exit(1);
}

let rewritten = 0;
for (const file of files) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(SPECIFIER, (_m, lead, quote, path) => {
    rewritten++;
    return `${lead}${quote}${path}.js${quote}`;
  });
  if (after !== before) writeFileSync(file, after);
}

const leftover = files.filter((f) => /(["'])\.{1,2}\/[^"']+\.ts\1/.test(readFileSync(f, "utf8")));
if (leftover.length > 0) {
  console.error(`fix-dts-extensions: .ts specifiers remain in ${leftover.join(", ")}`);
  process.exit(1);
}
console.log(`fix-dts-extensions: ${rewritten} specifiers rewritten in ${files.length} declaration files`);
