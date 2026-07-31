#!/usr/bin/env node
// Post-build fixup for dist/esm so native Node ESM can load the package:
//  1. append ".js" to extensionless relative import/export specifiers
//     (tsc emits them verbatim; Node's ESM resolver requires extensions)
//  2. drop a {"type":"module"} package.json into dist/esm (the package root
//     has no "type" field, so .js defaults to CJS without it)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const esm = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist/esm");
const spec = /(from\s+|import\s+|export\s+\*\s+from\s+)(["'])(\.\.?\/[^"']+)\2/g;
// CJS deps whose named exports Node's cjs-module-lexer cannot detect (e.g.
// anchor re-exports BN via getters) — rewrite to default-import + destructure.
const cjsDeps = ["@coral-xyz/anchor", "@solana/web3.js"];
const cjsImport = new RegExp(
  `import\\s*\\{([^}]+)\\}\\s*from\\s*(["'])(${cjsDeps.map((d) => d.replace(/[/@.]/g, "\\$&")).join("|")})\\2;?`,
  "g",
);

let n = 0;
for (const file of readdirSync(esm, { recursive: true })) {
  if (!String(file).endsWith(".js")) continue;
  const path = join(esm, String(file));
  const fixed = readFileSync(path, "utf8")
    .replace(spec, (m, kw, q, p) =>
      /\.(js|json|mjs|cjs)$/.test(p) ? m : `${kw}${q}${p}.js${q}`,
    )
    .replace(cjsImport, (m, names, q, mod) => {
      // Namespace + default-unwrap works everywhere: under a bundler (or a
      // real ESM build like web3.js's browser bundle) the namespace carries
      // the named exports; under native Node a CJS dep carries them on
      // `.default` (= module.exports), including names the lexer missed.
      const ns = `__cjs${n}ns`;
      const local = `__cjs${n}`;
      n += 1;
      const destructured = names.replace(/\s+as\s+/g, ": ").trim();
      return (
        `import * as ${ns} from ${q}${mod}${q};\n` +
        `const ${local} = ${ns}.default ?? ${ns};\n` +
        `const { ${destructured} } = ${local};`
      );
    });
  writeFileSync(path, fixed);
}
writeFileSync(join(esm, "package.json"), '{"type":"module"}\n');
console.log("fixed dist/esm specifiers + module type marker");
