import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({ server: { entry: "server" } }),
    // Nitro selects node-server locally and the Vercel preset during a
    // Vercel build, keeping the same proxy route in both environments.
    nitro(),
    react(),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      // @solana/web3.js depends on rpc-websockets. Its browser build is the
      // runtime-neutral entry required by the client bundle.
      "rpc-websockets": fileURLToPath(
        new URL("./node_modules/rpc-websockets/dist/index.browser.mjs", import.meta.url),
      ),
    },
  },
});
