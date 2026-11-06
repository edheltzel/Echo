import { parse, postprocess, preprocess } from "micromark";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";

const container: Record<string, true> = { link: true, image: true, definition: true };

/**
 * Rewrites every Markdown link and image destination, as CommonMark parses
 * them: inline `[text](target)` and `![alt](target)` (with or without `<>`),
 * and reference definitions (`[label]: target`), which count as images when an
 * image uses their label. Code spans, code blocks, and all other text are left
 * byte for byte. `image` is true for image destinations.
 *
 * scripts/check-links.mjs holds the worked examples.
 */
export function rewriteLinks(body: string, resolve: (target: string, image: boolean) => string): string {
  const events = postprocess(parse().document().write(preprocess()(body, undefined, true)));
  const spans: { start: number; end: number; image: boolean; label?: string }[] = [];
  const imageLabels = new Set<string>();
  // Open link/image/definition tokens, innermost last, with what each has seen so far.
  const open: { type: string; label?: string; reference?: string; resource?: boolean }[] = [];
  for (const [kind, token] of events) {
    const top = open.at(-1);
    const text = body.slice(token.start.offset, token.end.offset);
    if (kind === "enter") {
      if (container[token.type]) open.push({ type: token.type });
      else if (top && (token.type === "labelText" || token.type === "definitionLabelString")) top.label ??= text;
      else if (top && token.type === "referenceString") top.reference = text;
      else if (top && token.type === "resource") top.resource = true;
      else if (top && (token.type === "resourceDestinationString" || token.type === "definitionDestinationString")) {
        spans.push({
          start: token.start.offset,
          end: token.end.offset,
          image: top.type === "image",
          label: top.type === "definition" ? top.label : undefined,
        });
      }
    } else if (top?.type === token.type && container[token.type]) {
      open.pop();
      // A reference image (`![alt][ref]`, `![alt][]`, `![alt]`) names its definition.
      if (token.type === "image" && !top.resource) imageLabels.add(normalizeIdentifier(top.reference ?? top.label ?? ""));
    }
  }
  let out = body;
  for (const span of spans.reverse()) {
    const image = span.label === undefined ? span.image : imageLabels.has(normalizeIdentifier(span.label));
    out = out.slice(0, span.start) + resolve(body.slice(span.start, span.end), image) + out.slice(span.end);
  }
  return out;
}
