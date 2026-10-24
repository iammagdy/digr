import { describe, expect, it } from "vitest";
import { cleanSocialTopicAr, socialSubjectText } from "../src/lib/socialTasks";

/**
 * «داتا» and «بيانات» are the words of the request («عايز داتا عن…»), never the topic. Evidence (the owner's live check): the card's topic read «داتا ترندات الصحة».
 */
describe("the request's data word is not part of the topic", () => {
  it("«داتا» is dropped from the topic, the rest of the topic stays", () => {
    expect(socialSubjectText("عايز داتا عن ترندات الصحة في مصر")).toBe("ترندات الصحة");
    expect(cleanSocialTopicAr("عايز داتا عن ترندات الصحة في مصر")).toBe("ترندات الصحة في مصر");
    expect(cleanSocialTopicAr("داتا ترندات الصحة في مصر آخر ٣ شهور")).toBe("ترندات الصحة في مصر");
  });
  it("«بيانات» is dropped the same way", () => {
    expect(socialSubjectText("عايز بيانات عن ترندات الصحة في مصر")).toBe("ترندات الصحة");
    expect(socialSubjectText("بيانات الدهب في مصر")).toBe("الدهب");
  });
  it("a request without the word keeps the same topic", () => {
    expect(socialSubjectText("عايز ترندات الصحة في مصر")).toBe("ترندات الصحة");
    expect(cleanSocialTopicAr("عايز ترندات الصحة في مصر")).toBe("ترندات الصحة في مصر");
  });
});
