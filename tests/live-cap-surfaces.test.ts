import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ value: 200 as number | undefined }));
vi.mock("../src/lib/server/liveDailyCap", () => ({ liveDailyCapPoints: vi.fn(async () => live.value) }));

import { NextRequest } from "next/server";
import { POST as estimatePost } from "../src/app/api/calculator/estimate/route";
import { GET as capGet } from "../src/app/api/calculator/cap/route";
import SegmentPage from "../src/app/for/[segment]/page";
import { SEGMENTS, segmentExample } from "../src/lib/segments";

const estimateRequest = (body: unknown, ip: string) => new NextRequest("http://localhost/api/calculator/estimate", {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body),
});

beforeEach(() => { live.value = 200; });

describe("every public surface reads the same live daily limit", () => {
  it("the estimate route sizes one job with the live limit, and with the default when it cannot be read", async () => {
    // companies: the points cap, not the service's record ceiling, limits one job (54 records at a 200-point limit, 164 at 600)
    const withLive: any = await (await estimatePost(estimateRequest({ kind: "companies", volume: 500 }, "10.0.0.1"))).json();
    expect(withLive.result.jobCapPoints).toBe(200);
    live.value = undefined;
    const withDefault: any = await (await estimatePost(estimateRequest({ kind: "companies", volume: 500 }, "10.0.0.2"))).json();
    expect(withDefault.result.jobCapPoints).toBe(600);
    expect(withDefault.result.maxVolumeInOneJob).toBeGreaterThan(withLive.result.maxVolumeInOneJob);
  });

  it("the cap route returns the same number in points, never a dollar value, and null when unreadable", async () => {
    const response = await capGet(new NextRequest("http://localhost/api/calculator/cap", { headers: { "x-forwarded-for": "10.0.0.3" } }));
    expect(await response.json()).toEqual({ dailyCapPoints: 200 });
    live.value = undefined;
    const unreadable = await capGet(new NextRequest("http://localhost/api/calculator/cap", { headers: { "x-forwarded-for": "10.0.0.4" } }));
    expect(await unreadable.json()).toEqual({ dailyCapPoints: null });
  });

  it("the segment pages show the number the estimate box shows for the same example", async () => {
    for (const segment of SEGMENTS) {
      const html = renderToStaticMarkup(await SegmentPage({ params: Promise.resolve({ segment: segment.slug }) }));
      const example = segmentExample(segment, 200);
      expect(example.result.status === "ok" && example.result.jobCapPoints).toBe(200);
      for (const note of example.notesAr) expect(html).toContain(note.replace(/&/g, "&amp;"));
    }
  });
});
