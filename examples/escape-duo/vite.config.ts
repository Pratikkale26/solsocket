import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: {
    // web3.js expects a node-style global in the browser
    global: "globalThis",
  },
});
