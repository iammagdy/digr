import { ownTitleWords, sameNounStem } from "./quantity";

/**
 * THE WORDS ABOUT THE FILES MATCH THE FILES. A mission delivers ONE Excel workbook with a sheet per delivered stage (and a CSV copy of the last sheet); the model's closing note may call each stage «a file» («تم تسليم ملفين مرتبطين. ملف الفيديوهات
 * يضم ... ملف التعليقات يضم ...»): live, the customer was told «ملفين» while «طلباتي» listed one. Code rewrites what the model wrote: a count of files becomes «ملف إكسل واحد من N أوراق مرتبطة», and «ملف <what a stage holds>» becomes
 * «ورقة <...>» (with the verb that follows it in the feminine). Everything else the model wrote is left as it is. Pure.
 */
const SHEETS_AR: Record<number, string> = { 2: "ورقتين مرتبطتين", 3: "ثلاث أوراق مرتبطة", 4: "أربع أوراق مرتبطة", 5: "خمس أوراق مرتبطة", 6: "ست أوراق مرتبطة", 7: "سبع أوراق مرتبطة", 8: "ثماني أوراق مرتبطة", 9: "تسع أوراق مرتبطة", 10: "عشر أوراق مرتبطة" };
const FEMININE_VERB: Record<string, string> = { يضم: "تضم", يشير: "تشير", يحتوي: "تحتوي", يحوي: "تحوي", يعرض: "تعرض", يتضمن: "تتضمن", يشمل: "تشمل" };
const FILES_COUNT = /تم تسليم\s+(?:ملفين|ملفان|(?:[0-9٠-٩]+|ثلاثة|أربعة|خمسة|ستة|سبعة|ثمانية|تسعة|عشرة)\s+ملفات)(?:\s+(?:مرتبطين|مرتبطان|مرتبطة|منفصلة|منفصلين))?/g;

export function fixFileWordingAr(summary: string, stages: ReadonlyArray<{ title_ar?: unknown; deliver?: boolean }> | null | undefined): string {
  const delivered = (stages ?? []).filter((s) => s?.deliver !== false);
  const sheets = delivered.length;
  const sheetsPhrase = SHEETS_AR[sheets] ?? "أوراق مرتبطة";
  const nouns = delivered.flatMap((s) => ownTitleWords(String(s?.title_ar ?? "")));
  let text = String(summary ?? "");
  text = text.replace(FILES_COUNT, sheets >= 2 ? `تم تسليم ملف إكسل واحد من ${sheetsPhrase}` : "تم تسليم ملف إكسل");
  text = text.replace(/ملف\s+(\S+)(\s+(?:يضم|يشير|يحتوي|يحوي|يعرض|يتضمن|يشمل))?/g, (whole, next: string, verb?: string) => {
    const word = next.replace(/[«»"،,.:؛]/g, "");
    if (!word || !nouns.some((n) => sameNounStem(n, word))) return whole;
    const v = verb ? verb.trim() : "";
    return `ورقة ${next}${verb ? ` ${FEMININE_VERB[v] ?? v}` : ""}`;
  });
  return text;
}
