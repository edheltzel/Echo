// Worked CommonMark examples for src/lib/markdown-links.ts: which destinations the
// docs loader rewrites, which it leaves alone, and which count as images.
import { rewriteLinks } from "../src/lib/markdown-links.ts";

const mark = (target, image) => (image ? `IMG(${target})` : `LINK(${target})`);
const cases = [
  ["inline link, code span, inline image", "[a](x.md) and `[b](y.md)` and ![i](p.png)", "[a](LINK(x.md)) and `[b](y.md)` and ![i](IMG(p.png))"],
  ["angle destination with a space", "[a](<x y.md>)", "[a](<LINK(x y.md)>)"],
  ["title kept", '[a](x.md "Title")', '[a](LINK(x.md) "Title")'],
  ["reference link definition", '[ops]: operations.md "t"\n\nSee [ops].', '[ops]: LINK(operations.md) "t"\n\nSee [ops].'],
  ["reference image, angle definition", "![Shot][shot]\n\n[shot]: <assets/a b.png>", "![Shot][shot]\n\n[shot]: <IMG(assets/a b.png)>"],
  ["shortcut reference image", "![Shot]\n\n[Shot]: shot.png", "![Shot]\n\n[Shot]: IMG(shot.png)"],
  ["link to a .png stays a link", "[pic]: pic.png\n\n[see the picture][pic]", "[pic]: LINK(pic.png)\n\n[see the picture][pic]"],
  ["double-backtick code span", "`` `[Example](missing.md)` `` then [ok](ok.md)", "`` `[Example](missing.md)` `` then [ok](LINK(ok.md))"],
  ["image inside a link", "[![badge](b.svg)](page.md)", "[![badge](IMG(b.svg))](LINK(page.md))"],
  ["longer fence holds a shorter one", "````md\n```\n[a](x.md)\n```\n````\n[b](z.md)", "````md\n```\n[a](x.md)\n```\n````\n[b](LINK(z.md))"],
  ["table cells", "| a | [t](t.md) |\n| - | - |\n| [u](u.md) | x |", "| a | [t](LINK(t.md)) |\n| - | - |\n| [u](LINK(u.md)) | x |"],
  ["autolinks untouched", "<https://example.com> and https://x.y", "<https://example.com> and https://x.y"],
];

let failed = 0;
for (const [name, input, want] of cases) {
  const got = rewriteLinks(input, mark);
  if (got !== want) {
    failed++;
    console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
}
console.log(failed ? `FAIL (${failed} of ${cases.length})` : `PASS (${cases.length} cases)`);
process.exitCode = failed ? 1 : 0;
