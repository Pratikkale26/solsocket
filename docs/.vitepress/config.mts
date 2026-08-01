import { defineConfig } from "vitepress";

export default defineConfig({
  title: "solsocket",
  description:
    "Socket.io for Solana — realtime multiplayer rooms, fully onchain, powered by MagicBlock Ephemeral Rollups.",
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/quickstart" },
      { text: "API", link: "/reference/api" },
      { text: "npm", link: "https://www.npmjs.com/package/solsocket" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Concepts", link: "/guide/concepts" },
          { text: "Trust model", link: "/guide/trust-model" },
          { text: "Build a tiny Gather", link: "/guide/gather" },
        ],
      },
      {
        text: "Reference",
        items: [{ text: "API", link: "/reference/api" }],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/Pratikkale26/solsocket" },
    ],
    footer: {
      message: "MIT Licensed",
      copyright: "© 2026 Pratik Kale",
    },
    search: { provider: "local" },
  },
});
