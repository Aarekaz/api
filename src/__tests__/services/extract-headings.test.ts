import { describe, expect, it } from "vitest";
import { extractArticle } from "../../services/links/extract";

const para = "This paragraph has enough words in it to count as real article prose for the extractor to keep.";

describe("extractArticle heading levels", () => {
  it("keeps the page's h2 and h3 levels instead of flattening every heading to ##", () => {
    const html = `<html><head><title>Levels</title></head><body><article>
      <p>${para}</p><h2>Part one</h2><p>${para}</p><h3>A detail</h3><p>${para}</p><h4>Deeper</h4><p>${para}</p>
    </article></body></html>`;
    const { markdown } = extractArticle(html, "https://example.com/levels") as { markdown: string };
    expect(markdown).toContain("## Part one");
    expect(markdown).toContain("### A detail");
    expect(markdown).toContain("#### Deeper");
  });
});
