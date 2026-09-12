import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";

const nimbusConfig = defineNimbusConfig({
  site: "https://paykernel-docs.abshahin.workers.dev",
  title: "PayKernel",
  description:
    "Type-safe payment orchestration for TypeScript (MENA providers + modern server runtimes).",
  locale: "en",
  github: "https://github.com/aashahin/paykernel",
  editPattern: "https://github.com/aashahin/paykernel/edit/main/apps/docs/{path}",
  socialImageAlt: "PayKernel documentation preview",
  sidebar: {
    items: [
      { label: "Home", link: "/" },
      "quickstart",
      { label: "Guides", autogenerate: { directory: "guides" } },
      { label: "Packages", autogenerate: { directory: "packages" } },
      { label: "Gateways", autogenerate: { directory: "gateways" } },
      { label: "Stores", autogenerate: { directory: "stores" } },
      { label: "Integrations", autogenerate: { directory: "integrations" } },
      { label: "Examples", autogenerate: { directory: "examples" } },
      { label: "Reference", autogenerate: { directory: "reference" } },
      "contributing",
    ],
  },
});

export default defineConfig({
  output: "static",
  // Tailwind v4 via its Vite plugin (the integration Astro recommends for
  // Tailwind v4 — replaces the PostCSS plugin, which doesn't build under
  // Astro 7's Vite 8 bundler).
  vite: {
    plugins: [tailwindcss()],
  },
  // Hover-prefetch link targets so full-page navigations feel instant without
  // a client-side router.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    nimbus(nimbusConfig, {
      // Authoring rules are opt-in by design — your repo, your taste. The
      // two below are the load-bearing pair: frontmatter has to validate
      // against the content schema for the page to render properly, and
      // broken internal links are 404s for your readers. Add the others
      // (heading hierarchy, code-block language, style, etc.) when you're
      // ready to enforce them — see `nimbus-docs lint --help`.
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      // Wrap wide tables so they scroll instead of overflowing the page
      // (styled by `.nb-table-scroll` in src/styles/prose.css).
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
