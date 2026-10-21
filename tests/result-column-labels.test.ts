import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { customerResultColumnLabel, previewColumns, UNKNOWN_COLUMN_LABEL_AR } from "../src/lib/customerResultColumns";
import { COLUMN_METADATA_MAP, normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { SOCIAL_COLUMN_ORDER } from "../src/lib/server/socialRows";
import ResultsCanvas from "../src/app/dashboard/chat/components/ResultsCanvas";

const ARABIC = /[؀-ۿ]/;
const TECHNICAL = /[A-Za-z_]/;

describe("every column of every dataset type has a plain Arabic title", () => {
  const keys = [...new Set([...Object.keys(COLUMN_METADATA_MAP), ...Object.values(SOCIAL_COLUMN_ORDER).flat()])];

  it("covers all known columns (X, TikTok, YouTube, Facebook, companies, people) with Arabic only", () => {
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys) {
      const label = customerResultColumnLabel(key);
      expect(label, key).not.toBe(key);
      expect(label, key).toMatch(ARABIC);
      expect(label, key).not.toMatch(TECHNICAL);
    }
  });

  it("the three headers the tester saw in English are Arabic now", () => {
    expect(customerResultColumnLabel("author_verified")).toBe("حساب موثّق");
    expect(customerResultColumnLabel("retweets_count")).toBe("عدد مرات إعادة النشر");
    expect(customerResultColumnLabel("quotes_count")).toBe("عدد الاقتباسات");
  });

  it("a field nobody named never shows as a technical name", () => {
    expect(customerResultColumnLabel("some_new_source_field")).toBe(UNKNOWN_COLUMN_LABEL_AR);
    expect(customerResultColumnLabel("someCamel")).toBe(UNKNOWN_COLUMN_LABEL_AR);
    expect(customerResultColumnLabel("عمود جديد")).toBe("عمود جديد");
  });
});

describe("the preview leaves out identifiers and links of social records", () => {
  it.each(["comments", "videos", "posts"] as const)("%s: no id, source id or link column", (kind) => {
    const shown = previewColumns(SOCIAL_COLUMN_ORDER[kind], false);
    // A comment is read with the video it sits under: its title, date and link are in the table; every other link and id stays out.
    const hidden = kind === "comments" ? ["id", "source_id", "url"] : ["id", "source_id", "url", "video_url"];
    for (const column of hidden) expect(shown).not.toContain(column);
    if (kind === "comments") for (const column of ["video_title", "video_url", "video_published_at", "published_at", "comment_language"]) expect(shown).toContain(column);
    expect(shown.length).toBeGreaterThan(5);
  });

  it("a company keeps its website and its profile link, and loses only the internal ids", () => {
    const shown = previewColumns(["id", "company_name", "website", "linkedin_url", "source_id", "phone"], true);
    expect(shown).toEqual(["company_name", "website", "linkedin_url", "phone"]);
  });
});

describe("the results table as the customer sees it", () => {
  const posts = Array.from({ length: 3 }, (_, i) => ({
    tweet_id: `19${i}`, text: `منشور ${i} عن المباراة`, author_name: "أحمد", username: "ahmed", author_verified: true,
    created_at: "2026-07-1" + i, likes: 10 + i, retweets: 2, replies_count: 1, quotes_count: 3, views_count: 100, url: `https://x.com/a/status/19${i}`,
  }));

  const renderTable = (socialKind: "posts" | "comments" | "videos", rows: any[]) => {
    const normalized = normalizeDataset({ metadata: { template: "x" }, rows }, { socialKind, title: "x" });
    const html = renderToStaticMarkup(createElement(ResultsCanvas as any, {
      records: normalized.rows, profile: null, jobId: "job_x", jobStatus: "done", onDownload: () => {}, fileIds: { xlsx: "ready", pdf: null, csv: null },
    }));
    return html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
  };

  it("X posts: Arabic headers only, no raw field names, no source id or link column", () => {
    const head = renderTable("posts", posts);
    expect(head).toContain("حساب موثّق");
    expect(head).toContain("عدد مرات إعادة النشر");
    expect(head).toContain("عدد الاقتباسات");
    for (const raw of ["author_verified", "retweets_count", "quotes_count", "source_id", "معرّف المصدر", "الرابط المباشر"]) expect(head, raw).not.toContain(raw);
    expect(head).not.toMatch(/<th[^>]*>[^<]*[A-Za-z_][^<]*<\/th>/);
  });

  it("TikTok comments and videos: Arabic headers only", () => {
    const comments = renderTable("comments", [{ cid: "1", text: "رائع", user_nickname: "منى", user_unique_id: "mona", digg_count: 3, create_time: 1760000000, video_url: "https://www.tiktok.com/@u/video/1", video_title: "فيديو" }]);
    const videos = renderTable("videos", [{ video_id: "1", desc: "وصف", author_nickname: "معمل", create_time: 1760000000, play_count: 10, url: "https://www.tiktok.com/@u/video/1" }]);
    for (const head of [comments, videos]) {
      expect(head).not.toMatch(/<th[^>]*>[^<]*[A-Za-z_][^<]*<\/th>/);
      expect(head).not.toContain("معرّف المصدر");
    }
    // The comments table shows exactly one link column, the video's; the videos table shows none.
    expect(comments.match(/رابط/g)).toHaveLength(1);
    expect(comments).toContain("رابط الفيديو");
    expect(comments).toContain("عنوان الفيديو");
    expect(comments).toContain("تاريخ النشر");
    expect(videos).not.toContain("رابط");
  });
});
