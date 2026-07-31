#!/usr/bin/env node
// create-solsocket — scaffold a realtime onchain multiplayer app.
//   npm create solsocket my-app
const fs = require("node:fs");
const path = require("node:path");

const target = process.argv[2] || "my-solsocket-app";
const dest = path.resolve(process.cwd(), target);
const template = path.join(__dirname, "template");

if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
  console.error(`error: ${target} already exists and is not empty`);
  process.exit(1);
}

fs.cpSync(template, dest, { recursive: true });
// npm strips .gitignore from published packages; ship it renamed.
fs.renameSync(path.join(dest, "gitignore"), path.join(dest, ".gitignore"));

const pkgPath = path.join(dest, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.name = path.basename(dest).toLowerCase().replace(/[^a-z0-9-_]/g, "-");
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`
  solsocket app created in ${target}/

  next:
    cd ${target}
    npm install     (or pnpm / yarn)
    npm run dev

  The template is a shared-cursor canvas on Solana devnet — fund the burner
  wallet it shows (~0.01 devnet SOL) and open the invite link in a second
  browser. Every cursor move is an onchain, zero-fee transaction.

  docs: https://github.com/Pratikkale26/solsocket
`);
