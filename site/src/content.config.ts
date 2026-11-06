import { defineCollection } from "astro:content";
import { docsCollection, withNimbusMarkdown } from "@cloudflare/nimbus-docs/content";
import { echoDocsLoader } from "./lib/docs-loader";

export const collections = {
  // The repo's public Markdown (src/docs.ts), served at /docs/ by src/pages/docs/[...slug].astro.
  echo: defineCollection({
    loader: withNimbusMarkdown(echoDocsLoader()),
    schema: docsCollection().schema,
  }),
};
