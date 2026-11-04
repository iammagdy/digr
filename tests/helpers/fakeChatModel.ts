import type { ChatModelCall, ChatModelInput } from "../../src/lib/agentMission/chatModel";
import { CORPUS, type CorpusEntry } from "./chatCorpus";

/**
 * A FAKE CHAT MODEL for the round-22 tests: it answers the way the real one is told to (ONE line of JSON: type, reason, reply, count), with realistic Arabic replies built only from the facts of the system prompt.
 * No network and no paid call: it never touches fetch. It records every call, so a test can count them and read the prompt and the token limit.
 */
const REPLIES: Record<string, string> = {
  greeting_or_small_talk: "أهلًا بك، أنا مساعد ديجر. أجمع لك بيانات البحث من وسائل التواصل ومن مصادر الشركات وأسلّمها لك في ملف إكسل منظم. اكتب لي ما تريد جمعه وسأجهّز لك الخطة والسعر، ولا يُخصم شيء قبل موافقتك.",
  service_question: "ديجر خدمة لجمع بيانات البحث من تيك توك وإكس وإنستجرام وفيسبوك ويوتيوب، ومن الشركات حيثما توفرت. قيمة النقطة الواحدة ٠٫١٠ جنيه مصري، وأقل طلب ٢٠٠ نقطة، ولا يُخصم شيء قبل موافقتك على الخطة والسعر، ولا تدفع إلا مقابل ما سُلّم لك.",
  methodology_request: "تكتب ديجر منهجية جمع البيانات لطلب سُلّم لك، وتشرح فيها المصادر والفترة والخطوات والأعداد المسلّمة وحدود التسليم، بصيغة بي دي إف وسعرها ٥٠ نقطة.",
  other: "يسعدني أن أساعدك فيما أتقنه: جمع بيانات بحثك من وسائل التواصل والشركات. لا أكتب فصول الرسالة، لكن إن أخبرتني بما تحتاج جمعه من بيانات أجهّز لك الخطة والسعر قبل أي خصم.",
  edit_of_open_request: "",
  data_request: "",
};

export interface FakeModelOptions {
  /** Overrides the type the fake gives to a message (a model that is wrong or unsure). */
  override?: (text: string) => Partial<{ type: string; reply: string; count: number | null; reason: string }> | "fail" | "garbage" | undefined;
}

export interface FakeChatModel { call: ChatModelCall; calls: ChatModelInput[] }

const lastUserText = (input: ChatModelInput): string => {
  for (let i = input.messages.length - 1; i >= 0; i -= 1) if (input.messages[i].role === "user") return input.messages[i].content;
  return "";
};

export function fakeChatModel(entries: CorpusEntry[] = CORPUS, options: FakeModelOptions = {}): FakeChatModel {
  const calls: ChatModelInput[] = [];
  const byText = new Map<string, CorpusEntry>();
  for (const e of entries) if (!byText.has(e.text)) byText.set(e.text, e);
  const call: ChatModelCall = async (input) => {
    calls.push(input);
    const text = lastUserText(input);
    const o = options.override?.(text);
    if (o === "fail") return { ok: false, failure: "http_529" };
    if (o === "garbage") return { ok: true, text: "عذرًا، لا أستطيع التصنيف الآن." };
    const entry = byText.get(text);
    const type = o?.type ?? entry?.type ?? "other";
    const hasOpen = /OPEN_REQUEST: (?!none)/.test(input.system);
    const reply = o?.reply ?? (type === "data_request" || (type === "edit_of_open_request" && hasOpen) ? "" : REPLIES[type] ?? "");
    const count = o && "count" in o ? o.count ?? null : entry?.count ?? null;
    return { ok: true, text: JSON.stringify({ type, reason: o?.reason ?? "corpus", reply, count }), usage: { inputTokens: 900, outputTokens: 120 } };
  };
  return { call, calls };
}
