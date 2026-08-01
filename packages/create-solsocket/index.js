#!/usr/bin/env node
// create-solsocket — scaffold a realtime onchain multiplayer app.
//   npm create solsocket my-app                       (shared-cursor canvas)
//   npm create solsocket my-app -- --template gather  (walkable world)
const fs = require("node:fs");
const path = require("node:path");

const TEMPLATES = {
  cursor: {
    dir: "template",
    blurb: `The template is a shared-cursor canvas on Solana devnet — fund the burner
  wallet it shows (~0.01 devnet SOL) and open the invite link in a second
  browser. Every cursor move is an onchain, zero-fee transaction.`,
  },
  gather: {
    dir: "template-gather",
    blurb: `The template is a tiny Gather-style world on Solana devnet: walking
  avatars, proximity chat, emotes, and a shared door. Fund the burner wallet
  it shows (~0.01 devnet SOL) and open the invite link in a second browser —
  every step, chat line, and door toggle is an onchain, zero-fee transaction.`,
  },
};

const args = process.argv.slice(2);
let target = "";
let templateName = "cursor";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--template" || a === "-t") templateName = args[++i] ?? "";
  else if (a.startsWith("--template=")) templateName = a.slice("--template=".length);
  else if (!a.startsWith("-") && !target) target = a;
}
target = target || "my-solsocket-app";

const choice = TEMPLATES[templateName];
if (!choice) {
  console.error(
    `error: unknown template "${templateName}" — available: ${Object.keys(TEMPLATES).join(", ")}`,
  );
  process.exit(1);
}

const dest = path.resolve(process.cwd(), target);
const template = path.join(__dirname, choice.dir);

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
  solsocket app created in ${target}/  (template: ${templateName})

  next:
    cd ${target}
    npm install     (or pnpm / yarn)
    npm run dev

  ${choice.blurb}

  docs: https://github.com/Pratikkale26/solsocket
`);
