import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Loader, LoaderContext } from "astro/loaders";
import { rewriteLinks } from "./markdown-links";
import { pages, repoBranch, repoDir, repoUrl, urlForFile } from "../docs";

/**
 * Loads the published Markdown files from the Echo repository as they are on disk.
 *
 * - The first `# ` heading becomes the page title. It and anything above it
 *   (the README's ASCII banner) leave the body, so the layout renders the title once.
 * - Relative links keep working off GitHub: a link to a published page becomes
 *   its site URL, and a link to any other repo file becomes that file on GitHub.
 * - Relative images stay relative, so Astro bundles them from the repository.
 */
export function echoDocsLoader(): Loader {
  return {
    name: "echo-docs",
    async load(context: LoaderContext) {
      const root = fileURLToPath(context.config.root);
      const repoRoot = path.resolve(root, repoDir);
      const files = pages.map((page) => path.join(repoRoot, page.file));
      const gitOutput = (...args: string[]) => {
        try {
          return execFileSync("git", args, {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        } catch {
          return undefined;
        }
      };

      const sync = async () => {
        const fullHistory = gitOutput("rev-parse", "--is-shallow-repository") === "false";
        context.store.clear();
        for (const page of pages) {
          const abs = path.join(repoRoot, page.file);
          const source = await fs.readFile(abs, "utf8");
          const { title, body } = splitTitle(source, page.file);
          // HTML keeps relative images so Astro bundles them; the Markdown alternate
          // (View as Markdown, llms-full.txt) needs a URL that fetches on its own.
          const forHtml = rewriteLinks(body, (target, image) =>
            image ? resolveImage(target, abs, repoRoot) : resolveLink(target, path.dirname(abs), repoRoot),
          );
          const forMarkdown = rewriteLinks(body, (target, image) =>
            image
              ? rawImageUrl(resolveImage(target, abs, repoRoot), abs, repoRoot)
              : resolveLink(target, path.dirname(abs), repoRoot),
          );
          const filePath = path.relative(root, abs);
          const lastUpdated = fullHistory
            ? gitOutput("log", "-1", "--format=%aI", "--", abs) || undefined
            : undefined;
          const data = await context.parseData({ id: page.id, data: { title, lastUpdated }, filePath });
          const rendered = await context.renderMarkdown(forHtml, { fileURL: pathToFileURL(abs) });
          context.store.set({
            id: page.id,
            data,
            body: forMarkdown,
            filePath,
            digest: context.generateDigest(source),
            rendered,
            // Same as Astro's glob loader: the image pipeline picks these up.
            assetImports: rendered.metadata?.imagePaths,
          });
        }
      };

      await sync();
      context.watcher?.add(files);
      // Nimbus awaits this callback to commit the reload as one transaction.
      context.watcher?.on("change", (changed: string) => {
        if (files.includes(changed)) return sync();
      });
    },
  };
}

/**
 * The first level-one heading outside code fences, as plain text, and the body
 * after it.
 */
function splitTitle(source: string, file: string) {
  const lines = source.split("\n");
  const code = fencedLines(lines);
  for (const [i, line] of lines.entries()) {
    const heading = code[i] ? null : /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const title = heading[1].replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      return { title, body: lines.slice(i + 1).join("\n") };
    }
  }
  throw new Error(`${file} has no level-one heading to use as its title`);
}

/** Scheme (`https:`, `mailto:`), site path, or fragment: left as written. */
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** The site URL or GitHub URL for a relative link written in a file in `dir`. */
function resolveLink(target: string, dir: string, repoRoot: string): string {
  if (NOT_RELATIVE.test(target)) return target;
  const [file, hash] = target.split("#", 2);
  const suffix = hash ? `#${hash}` : "";
  const repoPath = path.relative(repoRoot, path.resolve(dir, file)).split(path.sep).join("/");
  if (repoPath.startsWith("..")) throw new Error(`docs link ${target} points outside the repository`);
  const url = urlForFile(repoPath);
  if (url) return url + suffix;
  const full = path.join(repoRoot, repoPath);
  if (!existsSync(full)) throw new Error(`docs link ${target} names a missing file`);
  // A folder opens as a tree on GitHub, a file as a blob.
  const kind = statSync(full).isDirectory() ? "tree" : "blob";
  return `${repoUrl}/${kind}/${repoBranch}/${repoPath}${suffix}`;
}

/** A relative image, written so Astro resolves it next to the file that embeds it. */
function resolveImage(target: string, file: string, repoRoot: string): string {
  if (NOT_RELATIVE.test(target)) return target;
  const abs = path.resolve(path.dirname(file), target);
  if (path.relative(repoRoot, abs).startsWith("..")) throw new Error(`docs image ${target} points outside the repository`);
  if (!existsSync(abs)) throw new Error(`docs image ${target} in ${file} does not exist`);
  return target.startsWith(".") ? target : `./${target}`;
}

/** The raw GitHub URL for a relative image already checked by resolveImage. */
function rawImageUrl(target: string, file: string, repoRoot: string): string {
  if (NOT_RELATIVE.test(target)) return target;
  const repoPath = path.relative(repoRoot, path.resolve(path.dirname(file), target)).split(path.sep).join("/");
  return `${repoUrl.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${repoBranch}/${repoPath}`;
}

/**
 * Which lines belong to a fenced code block, fences included. Per CommonMark,
 * a fence closes only on the same character, at least as long, with nothing
 * after it but whitespace.
 */
function fencedLines(lines: string[]): boolean[] {
  let open: string | null = null;
  return lines.map((line) => {
    if (open === null) {
      const start = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
      if (start) open = start;
      return start !== undefined;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
    if (close && close[0] === open[0] && close.length >= open.length) open = null;
    return true;
  });
}
