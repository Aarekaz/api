import { describe, expect, it } from "vitest";
import { titleFromText, canonicalUrl, cleanMarkdown, extractArticle, isAvatar, isBoilerplate, postMarkdown, tableMarkdown } from "../../services/links";

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
});
