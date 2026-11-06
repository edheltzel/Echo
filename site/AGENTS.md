# site - public website (landing + docs)

> Child DOX. Root `AGENTS.md` carries repo-wide rules; this file owns local detail for `site/`.

## Purpose

The public site at https://echo.edheltzel.codes: the landing page at `/` and the docs at `/docs/`,
one static [Nimbus](https://nimbus-docs.com) (Astro) build. Migrated from `edheltzel/echo-site`.

## Ownership

- `src/pages/index.astro`, `src/layouts/Landing.astro`, `src/components/landing/`,
  `src/styles/landing/`, `src/scripts/`, `src/site.ts`, `public/loop/`, `public/og.png`,
  `public/favicon.svg` - the landing page, its design and artwork. `scripts/og.py` regenerates
  `public/og.png`.
- `src/docs.ts` - the only list of published docs: repo file, URL, sidebar group and label.
- `src/lib/docs-loader.ts` - reads those files from the repository at build time (title from the
  first `#` heading, relative images bundled). `src/lib/markdown-links.ts` rewrites
  GitHub-relative links to site or GitHub URLs from CommonMark tokens; its worked examples are
  `scripts/check-links.mjs`.
- `src/pages/docs/[...slug].astro` - the docs route. The rest of `src/` (layouts,
  `components/ui/`, `pages/`, `styles/globals.css`) is the Nimbus starter, branded.
- `public/_redirects` - Cloudflare Pages redirects for URLs from the earlier site.
- `scripts/check-links.mjs`, `scripts/check-dist.mjs`, `scripts/lint-docs.mjs`,
  `scripts/{contrast,flash,install-box}.mjs`, and `scripts/mobile-toc.mjs` (browser checks served
  by `scripts/serve-dist.mjs`) - link-rewrite examples, docs lint, and post-build checks.
  `src/components/ui/toc/mobile-toc.client.ts` differs from the Nimbus starter on purpose: it
  resolves the current section from heading positions, which `scripts/mobile-toc.mjs` covers.

## Local Contracts

- Tooling is isolated from Echo's runtime: npm with `site/package-lock.json`, Node `>=22.12`
  (`.node-version` pins the Pages build), exact dependency pins. Never add site dependencies,
  scripts, or tests to the root `package.json`, `bun.lock`, `tsconfig.json`, or `verify.yml`;
  never import `core/`, `shared/`, `converse/`, or `adapters/` from the site. `site/` is not a Bun
  workspace member and is not in the npm package's `files`.
- Docs content lives only in the repository's Markdown (`docs/*.md`, `README.md`, `SECURITY.md`).
  Never copy a doc into `site/`. Publish a file by adding it to `src/docs.ts`; never publish
  `AGENTS.md`, `CLAUDE.md`, `docs/AGENTS.md`, `docs/dox.md`, `docs/agents/`, `docs/plans/`,
  `docs/handoffs/`, or `docs/design-docs/`.
- Docs stay GitHub-friendly: no frontmatter, relative links, one `#` title. The loader adapts
  them; never add site-only syntax to the Markdown.
- A page's URL is its `id` in `src/docs.ts`. Renaming one needs a `public/_redirects` entry.
- Theme choice is shared across landing and docs through `localStorage["echo-theme"]`.

## Work Guidance

- Upgrade Nimbus with `npx nimbus-docs migrate --dry-run --diff`, then `migrate --yes`; take
  starter fixes with `npx nimbus-docs outdated` and `diff <file>`. Keep `nimbus.json` committed and
  never edit it by hand.
- Cloudflare Pages project `echo` (`echo-dud.pages.dev`) builds this folder from `master` when
  `site/*`, `docs/*`, `README.md`, or `SECURITY.md` change: root directory `site`, build command
  `npm run build`, output directory `dist`, `NODE_VERSION` and `SITE_URL` set on the project.
  It replaces the `echo-site` project, which built from `edheltzel/echo-site`.

## Verification

From `site/`: `npm ci`, `npm run lint:docs`, `npm run check:links`, `npm run typecheck`,
`npm run build`, `npm run check:dist`, `npm run check:nimbus`, and
`CHROME_PATH=<chrome> npm run check:landing` and `npm run check:toc`.
`wrangler pages dev dist` serves the build with `_redirects` applied.

## Child DOX Index

No child docs.
