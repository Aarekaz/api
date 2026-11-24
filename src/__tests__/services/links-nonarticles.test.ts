import { describe, expect, it } from "vitest";
import { cleanTitle, postText, titleFromPdfUrl, titleFromText } from "../../services/links";

describe("non-articles", () => {
  it("cleans X's share titles to the quoted words", () => {
    expect(cleanTitle('Dhravya Shah on X: "Jev changes a lot in memory & context engineering. Here\'s exactly how." / X'))
      .toBe("Jev changes a lot in memory & context engineering. Here's exactly how.");
    expect(cleanTitle("Growth Without Goals")).toBe("Growth Without Goals");
  });

  it("reads a post's words from X's embed, without media links", () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">How the highest performers sustain a massive workload: <a href="https://t.co/x">pic.twitter.com/KHwSopfjCw</a></p>&mdash; Justin Skycak</blockquote>';
    expect(postText(html)).toBe("How the highest performers sustain a massive workload:");
    expect(postText('<p>One<br><br>Two &amp; three</p>')).toBe("One\n\nTwo & three");
  });

  it("titles a post by its first line, cut at a word", () => {
    expect(titleFromText("How the highest performers sustain a massive workload:")).toBe("How the highest performers sustain a massive workload");
    const long = "An influencer is incentivized by attention, so their content must be optimized to be consumed and forgotten (cheap dopamine).";
    expect(titleFromText(long).endsWith("…")).toBe(true);
    expect(titleFromText(long).length).toBeLessThanOrEqual(91);
  });

  it("names a PDF by its file", () => {
    expect(titleFromPdfUrl("https://example.com/papers/Attention-Is-All_You_Need.pdf")).toBe("Attention Is All You Need");
    expect(titleFromPdfUrl("https://arxiv.org/pdf/2401.12345v2")).toBeNull();
  });
});
