import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: any) => createElement("a", { href, ...rest }, children) }));

import SegmentPage, { generateStaticParams } from "../src/app/for/[segment]/page";
import { SEGMENTS, segmentExample } from "../src/lib/segments";
import { estimateMission } from "../src/lib/missionEstimate";

const render = async (slug: string) => renderToStaticMarkup(await SegmentPage({ params: Promise.resolve({ segment: slug }) }));

describe("segment pages", () => {
  it("there are four: agencies, researchers, journalists and sales teams", () => {
    expect(SEGMENTS.map((s) => s.slug)).toEqual(["marketing-agencies", "researchers", "journalists", "sales-teams"]);
    expect(generateStaticParams()).toHaveLength(4);
  });

  it.each(SEGMENTS.map((s) => s.slug))("%s: one example mission with an approximate price, marked as an example, and a sign-up path", async (slug) => {
    const html = await render(slug);
    const text = html.replace(/<[^>]+>/g, " ");
    expect((html.match(/data-testid="segment-example"/g) || []).length).toBe(1);
    expect(html).toMatch(/data-testid="segment-price"[^>]*>[^<]*حوالي/);
    expect(text).toContain("مثال توضيحي");
    expect(html).toContain('href="/register"');
    expect(text).not.toMatch(/[0-9]|undefined|null|NaN|USD|\$|treg|scrapecreators|tikhub|serpapi|openai|anthropic|100\s*%/i);
  });

  it("each price comes from the public estimate for exactly the example's input", () => {
    for (const segment of SEGMENTS) {
      const example = segmentExample(segment);
      expect(example.result.status).toBe("ok");
      expect(example.result).toEqual(estimateMission(segment.estimate));
      expect(example.understoodAr).toMatch(/^فهمت أنك تريد/);
    }
  });

  it("an example bigger than one job says it needs several requests (no hidden cap); the real examples now fit one job whole", () => {
    const researchers = SEGMENTS.find((s) => s.slug === "researchers")!;
    const big = segmentExample({ ...researchers, estimate: { kind: "comments", platform: "youtube", volume: 100000 } });
    expect(big.notesAr.join(" ")).toContain("طلبات منفصلة");
    for (const segment of SEGMENTS) expect(segmentExample(segment).notesAr, segment.slug).toEqual([]);
  });

  it("an unknown segment is a 404", async () => {
    await expect(render("nope")).rejects.toThrow();
  });
});
