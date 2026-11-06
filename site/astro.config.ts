import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
import { groups, pageUrl, repoUrl } from "./src/docs";
import { ogImage, siteDescription, siteName, siteUrl } from "./src/site";

/** Public origin. Override with SITE_URL (the Pages project sets it for production). */
const site = process.env.SITE_URL || siteUrl;

const nimbusConfig = defineNimbusConfig({
  site,
  title: siteName,
  description: siteDescription,
  locale: "en",
  homeLabel: "Docs",
  github: repoUrl,
  socialImage: ogImage.path,
  socialImageAlt: ogImage.alt,
  sidebar: {
    items: groups.map((group) => ({
      label: group.label,
      collapsed: false,
      items: group.pages.map((page) => ({ label: page.label, link: pageUrl(page) })),
    })),
  },
});

export default defineConfig({
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    nimbus(nimbusConfig, {
      // The docs are plain Markdown read by src/lib/docs-loader.ts; there is no MDX to validate.
      validateMdx: false,
      markdown: {
        // Wrap wide tables so they scroll instead of overflowing the page
        // (styled by `.nb-table-scroll` in src/styles/prose.css).
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
