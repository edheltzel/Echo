/**
 * The public docs: which Markdown files in the Echo repository the site publishes,
 * the URL each one gets under /docs/, and its place in the sidebar.
 *
 * The files stay the single source; the site reads them at build time.
 * Anything not listed here (plans, handoffs, design docs, AGENTS.md and other
 * agent instructions) is never published.
 */
export const repoUrl = "https://github.com/edheltzel/Echo";
/** Branch the site links to for files it doesn't publish (the released docs). */
export const repoBranch = "master";
/** Branch "Edit page" opens; contributions go to dev, not master. */
export const editBranch = "dev";
/** The repository root, relative to the site root (site/). */
export const repoDir = "..";
/** Where the collection is served; matches src/pages/docs/[...slug].astro. */
export const docsBase = "/docs";

export interface Page {
  /** Path from the repository root. */
  file: string;
  /** Entry id; the page is served at /docs/<id>/ ("index" is /docs/). */
  id: string;
  /** Sidebar label. */
  label: string;
}

export const groups: { label: string; pages: Page[] }[] = [
  {
    label: "Start here",
    pages: [
      { file: "README.md", id: "index", label: "Overview" },
      { file: "docs/getting-started.md", id: "getting-started", label: "Hear your first notification" },
      { file: "docs/install-human.md", id: "install", label: "Install" },
      { file: "docs/install-agent.md", id: "install/agent", label: "Install with an agent" },
    ],
  },
  {
    label: "Features",
    pages: [
      { file: "docs/what-echo-does.md", id: "notifications", label: "Notifications (text-to-speech)" },
      { file: "docs/converse.md", id: "speech-to-text", label: "Voice ask (speech-to-text)" },
      { file: "docs/mute-dashboard.md", id: "mute-dashboard", label: "Mute, snooze, and the dashboard" },
      { file: "docs/voices.md", id: "voices", label: "Voices" },
    ],
  },
  {
    label: "Reference",
    pages: [
      { file: "docs/configuration.md", id: "configuration", label: "Configuration and data" },
      { file: "docs/adapters.md", id: "adapters", label: "Hosts and adapters" },
      { file: "docs/http-api.md", id: "http-api", label: "HTTP API" },
      { file: "docs/operations.md", id: "operations", label: "Operations" },
      { file: "docs/dependencies.md", id: "dependencies", label: "Dependencies" },
      { file: "docs/providers-observability.md", id: "providers", label: "Providers and observability" },
      { file: "docs/reliability.md", id: "reliability", label: "Reliability" },
      { file: "SECURITY.md", id: "security", label: "Security model" },
      { file: "docs/development.md", id: "development", label: "Development" },
    ],
  },
];

export const pages = groups.flatMap((group) => group.pages);

/** The URL a page is served at. */
export const pageUrl = (page: Page) => (page.id === "index" ? `${docsBase}/` : `${docsBase}/${page.id}/`);

/** The site URL for a published file, by its path from the repository root. */
export const urlForFile = (file: string) => {
  const page = pages.find((p) => p.file === file);
  return page ? pageUrl(page) : undefined;
};
