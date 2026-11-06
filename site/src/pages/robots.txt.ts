import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { config } from "virtual:nimbus/config";

export const prerender = true;

export function GET() {
  const body = [
    "User-agent: *",
    // Same policy as the earlier echo-site robots.txt. Nimbus's starter adds a
    // Content-Signal line (https://contentsignals.org); that is a licensing
    // choice for the owner to make, not part of this migration.
    "Allow: /",
    "",
    `Sitemap: ${new URL(withBase("/sitemap-index.xml", import.meta.env.BASE_URL), config.site).href}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
