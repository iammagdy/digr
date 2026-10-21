import { describe, expect, it } from "vitest";
import { formatCell } from "../src/app/dashboard/chat/components/ResultsCanvas";
import { relativeDateDisplay } from "../src/lib/relativeDateDisplay";

describe("dates in the results preview are shown in Arabic words and Arabic-Indic digits", () => {
  it("ISO dates and times keep their shape in Arabic-Indic digits", () => {
    expect(formatCell("2026-08-06")).toBe("٢٠٢٦-٠٨-٠٦");
    expect(formatCell("2026-10-10T10:00:00Z")).toBe("٢٠٢٦-١٠-١٠T١٠:٠٠:٠٠Z");
  });

  it("«3 weeks ago» style text from the source is shown as Arabic", () => {
    expect(formatCell("3 weeks ago")).toBe("منذ ٣ أسابيع");
    expect(formatCell("1 day ago")).toBe("منذ يوم");
    expect(formatCell("2 days ago")).toBe("منذ يومين");
    expect(formatCell("a month ago")).toBe("منذ شهر");
    expect(formatCell("11 months ago")).toBe("منذ ١١ شهرًا");
    expect(formatCell("5 hours ago")).toBe("منذ ٥ ساعات");
    expect(formatCell("1 year ago")).toBe("منذ سنة");
  });

  it("Arabic relative dates with Western digits and day/month/year dates only change their digits", () => {
    expect(formatCell("منذ 3 أسابيع")).toBe("منذ ٣ أسابيع");
    expect(formatCell("06/08/2026")).toBe("٠٦/٠٨/٢٠٢٦");
    expect(formatCell("منذ يومين")).toBe("منذ يومين");
  });

  it("anything else is left as it is: a comment that mentions a number, a count, a name", () => {
    expect(formatCell("شاهدت الماتش من 3 أسابيع تقريباً")).toBe("شاهدت الماتش من 3 أسابيع تقريباً");
    expect(formatCell("2 days ago was great")).toBe("2 days ago was great");
    expect(relativeDateDisplay("ماتش حلو")).toBeNull();
    expect(formatCell(1234)).toBe(formatCell(1234));
  });

  it("the shown text of a date column never contains Latin letters or Western digits", () => {
    for (const value of ["3 weeks ago", "2026-08-06", "06/08/2026", "منذ 3 أسابيع", "an hour ago"]) {
      expect(formatCell(value)).not.toMatch(/[A-Za-z0-9]/);
    }
  });
});
