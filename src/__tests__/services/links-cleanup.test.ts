import { describe, expect, it } from "vitest";
import { unwrapRedirects, arxivId, linkKind, isBotCheck, xArticleMarkdown, titleFromText, canonicalUrl, cleanMarkdown, extractArticle, isAvatar, isBoilerplate, postMarkdown, tableMarkdown } from "../../services/links";

const prose = "This is a real paragraph of the article, long enough to count as the story and not as a menu or a button.";

describe("cleaning saved articles", () => {
  it("drops avatars from X and Substack but keeps real pictures", () => {
    expect(isAvatar("https://pbs.twimg.com/profile_images/1/abc_normal.jpg")).toBe(true);
    expect(isAvatar("https://substackcdn.com/image/fetch/$s_!TnFC!,w_40,h_40,c_fill/https%3A%2F%2Fx")).toBe(true);
    expect(isAvatar("https://example.com/a.png", "X avatar for @packyM")).toBe(true);
    expect(isAvatar("https://pbs.twimg.com/media/HTCclUOWMAA4bTK.png?name=orig")).toBe(false);
    expect(isAvatar("https://substackcdn.com/image/fetch/$s_!x!,w_1456,c_limit/https%3A%2F%2Fy")).toBe(false);
  });

  it("drops newsletter furniture, not sentences that mention it", () => {
    for (const line of ["Subscribe now", "Thanks for reading Useful Fictions! Subscribe for free to receive new posts and support my work.",
      "*Become a paid subscriber to get tips on exactly how to stop stifling your curiosity!*", "- Subscribed", "## sign up",
      "- Asher's Blog [Copy shortlink](https://wp.me/x) [Manage subscriptions](https://subs)"]) {
      expect(isBoilerplate(line), line).toBe(true);
    }
    expect(isBoilerplate("Their subscription business grew because customers kept paying every month for years.")).toBe(false);
    expect(isBoilerplate(`${prose} ${prose} Subscribe.`)).toBe(false);
  });

  it("keeps data tables as Markdown tables", () => {
    const md = tableMarkdown("<thead><tr><th>Strategy</th><th>Example</th></tr></thead><tbody><tr><td>Network | effects</td><td><a href='/x'>Ants</a></td></tr></tbody>", "https://stephango.com/moats");
    expect(md).toBe("| Strategy | Example |\n| --- | --- |\n| Network \\| effects | [Ants](https://stephango.com/x) |");
    expect(tableMarkdown("<tr><td>Only one column</td></tr><tr><td>here</td></tr>", "https://a.b")).toBeNull();
  });

  it("an article made of tables comes in whole", () => {
    const html = `<html><body><article><p>${prose}</p><h2>Supply</h2><table><tr><th>Strategy</th><th>Biology</th></tr><tr><td>Scale</td><td>Whales</td></tr></table>
      <p>Subscribe now</p></article></body></html>`;
    const a = extractArticle(html, "https://stephango.com/moats");
    expect(a.markdown).toContain("| Scale | Whales |");
    expect(a.markdown).toContain("## Supply");
    expect(a.markdown).not.toContain("Subscribe");
  });

  it("a post comes in whole, with its photos and the post it quotes", () => {
    const md = postMarkdown({
      text: "An artisan is incentivized by the satisfaction.\n\nBecome an artisan. https://aiengineeringfromscratch.com",
      media: { photos: [{ url: "https://pbs.twimg.com/media/A.png" }] },
      quote: { text: "Quoted words", author: { name: "Eden", screen_name: "eden" } },
    }, "https://x.com/a/status/1");
    expect(md).toBe("An artisan is incentivized by the satisfaction.\n\nBecome an artisan. [aiengineeringfromscratch.com](https://aiengineeringfromscratch.com)\n\n![](https://pbs.twimg.com/media/A.png)\n\n> **Eden** @eden\n> Quoted words");
  });

  it("finds where a share link really points", () => {
    expect(canonicalUrl(`<link rel="canonical" href="https://h.substack.com/p/how-to-start" />`, "https://h.substack.com/p/14194ed3-f99c-4a26-8737-bee951953823"))
      .toBe("https://h.substack.com/p/how-to-start");
  });

  it("cleans text saved before the rules, keeping the story", () => {
    const md = ["Words.", "![@theo](https://pbs.twimg.com/profile_images/1/a_normal.jpg)", "![](https://pbs.twimg.com/media/B.png)",
      "[Get 35% off for 1 year](https://x.substack.com/subscribe?coupon=1)", "More words."].join("\n\n");
    expect(cleanMarkdown(md)).toBe("Words.\n\n![](https://pbs.twimg.com/media/B.png)\n\nMore words.");
  });

  it("a post's title leaves its links out", () => {
    expect(titleFromText("wtf is this https://aiengineeringfromscratch.com")).toBe("wtf is this");
  });

  it("takes off what every site bolts on, keeping the essay", () => {
    const essay = "When I was 12 years old, I tried out for a baseball all-star team in our area. It mattered a lot.";
    const md = [essay, "The rest of the story goes on from here, long enough to be a real paragraph of the essay.",
      essay,                                                   // the page's second copy
      "- [YouTube](https://youtube.com/@a),", "- [Linkedin](https://linkedin.com/in/b)",
      "## [You Need a New CFO](https://a16z.com/you-need-a-new-cfo/)",
      "- [Share on X (Opens in new window) X](https://a.com/p?share=x)", "## *Related*",
      "![Unknown's avatar](https://2.gravatar.com/avatar/86)", "![](https://lh3.googleusercontent.com/a/ACg8=s96-c)",
      "![$store.lightbox.alt](https://a16z.com/p/$store.lightbox.src)",
      "BreatheLess is a reader-supported publication. To receive new posts, consider becoming a free or paid subscriber.",
      "![](https://t.com/1.png)", "![](https://t.com/2.png)", "![](https://t.com/3.png)"].join("\n\n");
    expect(cleanMarkdown(md, "https://a16z.com/context-is-king/")).toBe(
      `${essay}\n\nThe rest of the story goes on from here, long enough to be a real paragraph of the essay.`);
  });

  it("keeps a section heading that links to its own anchor, and one closing picture", () => {
    const md = "## [Improvements](https://linear.app/now/ci#improvements)\n\nText.\n\n![A chart](https://linear.app/c.png)";
    expect(cleanMarkdown(md, "https://linear.app/now/ci")).toBe(md);
  });

  it("numbered lists keep their numbers", () => {
    const html = `<article><p>${prose}</p><ol start="3"><li>Third step of the plan</li><li>Fourth step of the plan</li></ol><ul><li>A bullet point here</li></ul><p>${prose}</p></article>`;
    const md = extractArticle(html, "https://a.b/c").markdown;
    expect(md).toContain("3. Third step of the plan\n\n4. Fourth step of the plan\n\n- A bullet point here");
  });

  it("an X Article comes from its own blocks: headings, styles, links, pictures, numbers", () => {
    const md = xArticleMarkdown({
      content: {
        blocks: [
          { type: "header-two", text: "Humans use interfaces" },
          { type: "unstyled", text: "Claude Code has 2 parts: the interface", inlineStyleRanges: [{ offset: 25, length: 13, style: "Bold" }] },
          { type: "atomic", text: " ", entityRanges: [{ offset: 0, length: 1, key: 0 }] },
          { type: "ordered-list-item", text: "First" }, { type: "ordered-list-item", text: "Second" },
          { type: "unstyled", text: "Also check out T3 Code.", entityRanges: [{ offset: 15, length: 7, key: 1 }] },
          { type: "code-block", text: "bun run dev" },
        ],
        entityMap: [
          { key: "0", value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "42" }] } } },
          { key: "1", value: { type: "LINK", data: { url: "https://t3.codes/" } } },
        ],
      },
      media_entities: [{ media_id: "42", media_info: { original_img_url: "https://pbs.twimg.com/media/A.jpg" } }],
    });
    expect(md).toBe([
      "## Humans use interfaces", "Claude Code has 2 parts: **the interface**", "![](https://pbs.twimg.com/media/A.jpg)",
      "1. First", "2. Second", "Also check out [T3 Code](https://t3.codes/).", "```\nbun run dev\n```",
    ].join("\n\n"));
  });

  it("knows a bot check when it sees one", () => {
    expect(isBotCheck("Just a moment... Enable JavaScript and cookies to continue")).toBe(true);
    expect(isBotCheck("Why agents need schemas: tools are product work.")).toBe(false);
  });

  it("an arXiv or alphaXiv page is the paper, read as its PDF", () => {
    expect(arxivId("https://www.alphaxiv.org/abs/2609.26550")).toBe("2609.26550");
    expect(arxivId("https://arxiv.org/pdf/2401.01234v2")).toBe("2401.01234");
    expect(arxivId("https://arxiv.org/abs/cs/0112017")).toBe("cs/0112017");
    expect(linkKind("https://www.alphaxiv.org/abs/2609.26550")).toBe("pdf");
    expect(arxivId("https://example.com/abs/1")).toBeNull();
  });

  it("links point where they go, not through Google's redirect", () => {
    expect(unwrapRedirects("[StreamDiffusion](https://www.google.com/url?q=https://github.com/cumulo-autumn/StreamDiffusion&sa=D&usg=AOv)"))
      .toBe("[StreamDiffusion](https://github.com/cumulo-autumn/StreamDiffusion)");
  });
});
