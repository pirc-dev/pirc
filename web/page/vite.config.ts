// Builds the page into dist/, which pirc-web serves. In development,
// `vite` here serves it with /api proxied to a pirc-web started with
// --origin http://localhost:5173 --listen 127.0.0.1:7402 --plaintext.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig, type Plugin } from "vite";

import { licenses, packageRoots } from "../../sh/licenses.ts";

// The page is sent to every browser, and with it the third-party code it
// carries: their licences go with it, at /third-party-licenses.txt.
function thirdPartyLicenses(): Plugin {
  return {
    name: "third-party-licenses",
    apply: "build",
    generateBundle() {
      const roots = packageRoots([...this.getModuleIds()].map((id) => id.replace(/^\0/, "").split("?")[0]));
      // Tailwind writes its CSS outside the module graph, so it is not
      // among the modules; the page's CSS carries its code.
      roots.push(dirname(createRequire(import.meta.url).resolve("tailwindcss/package.json")));
      this.emitFile({ type: "asset", fileName: "third-party-licenses.txt", source: licenses("PiRC's web app: the page", roots) });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss(), thirdPartyLicenses()],
  // Nothing inlined as a data: URI, which the CSP (the page's own files
  // only) would refuse: a small font file among them.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: process.env.PIRC_WEB_DEV_SERVER ?? "http://127.0.0.1:7402", changeOrigin: false } },
  },
});
