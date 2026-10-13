"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { useBalance } from "@/hooks/useBalance";
import { useCreditValue } from "@/hooks/useCreditValue";
import { useLlmEnabled } from "@/hooks/useLlmEnabled";
import { getPersonaConfig, PersonaType } from "@/functions/shared/personaConfigs";
import { chronological, EVENT_HISTORY_LIMIT, formatNumber, methodologyAlertText, methodologyMessageText } from "@/lib/honestDisplay";
import { formatAr } from "@/lib/arabicDigits";
import { clearPendingQuestion, readPendingQuestion } from "@/lib/pendingQuestion";
import type { DiscoveryAnswer } from "./components/discoveryQuestions";
import type { ReviewSeverity, ReviewSuggestion, ResultReview } from "@/functions/shared/resultReview";
import type { ArtifactEditOperation } from "@/functions/shared/artifactEditing";

import OnboardingModal from "./components/OnboardingModal";
import { useShell } from "@/components/app/AppShell";
import DetailsBlanks from "./components/DetailsBlanks";
import PlanQuoteCard, { PlanQuoteData } from "./components/PlanQuoteCard";
import ActivityTimeline, { JobEvent } from "./components/ActivityTimeline";
import ResultsCanvas, { ExtractedRecord } from "./components/ResultsCanvas";
import ResearchDocument, { type DocStage } from "./components/ResearchDocument";
import EmptyChat from "./components/EmptyChat";
import { FailureBox, FilesSection } from "./components/RunSections";
import Composer from "./components/Composer";

interface ConversationItem { $id: string; title: string; updatedAt: string }

const orderDesc = { ascending: false } as const;

async function getAccessToken(): Promise<string | undefined> {
  try {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token;
  } catch {
    return undefined;
  }
}

function mapJobEvents(rows: any[] | null | undefined): JobEvent[] {
  return (rows || []).map((e: any) => ({
    $id: e.id || e.$id || `ev_${Date.now()}`,
    textAr: e.text_ar || e.textAr || "",
    kind: e.kind || "info",
    createdAt: e.created_at || e.createdAt || new Date().toISOString(),
  }));
}

interface MessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  outputType?: "propose_plan" | "edit_plan" | "ask_clarification" | "suggest_alternative" | "refuse" | "edit_artifact" | "answer_question" | "write_note";
  planQuote?: PlanQuoteData;
  clarificationQuestions?: string[];
  clarificationItems?: unknown;
  completedClarificationAnswers?: DiscoveryAnswer[];
  suggestedAlternative?: any;
  refusalReason?: string;
  jobId?: string;
  /** Internal turns (clarification-answer summaries) are shown through the details sentence instead. */
  hidden?: boolean;
  errorRetryPrompt?: string;
  createdAt: string;
}

interface ActiveJobState {
  jobId: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  templateSlug: string;
  rowsCollected: number;
  chargedCredits?: number;
  reservedCredits?: number;
  errorAr?: string;
  events: JobEvent[];
  /** Records the approved plan asked for. */
  requestedRows?: number;
  review?: ResultReview | null;
  reviewSeverity?: ReviewSeverity;
  artifactVersion?: { id: string; versionNum: number; rowCount: number } | null;
  fileIds?: { xlsx: string; pdf: string; csv: string };
  versionHistory?: Array<{ id: string; versionNum: number; parentVersionId?: string | null; rowCount: number; isOriginal: boolean }>;
  artifactHistoryAvailable?: boolean;
}

export default function ChatWorkspacePage() {
  const { user } = useUser();
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStatusText, setLoadingStatusText] = useState("يفكّر في سؤالك ويجهّز الخطوة التالية...");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("");
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationLoadError, setConversationLoadError] = useState(false);
  const [userPersona, setUserPersona] = useState<PersonaType>("student");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [conversationsList, setConversationsList] = useState<ConversationItem[]>([]);
  const [canvasOpen, setCanvasOpen] = useState(false);

  // Active Job & Canvas Data
  const [startingQuoteId, setStartingQuoteId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ActiveJobState | null>(null);
  const [extractedRecords, setExtractedRecords] = useState<ExtractedRecord[]>([]);
  const [extractedProfile, setExtractedProfile] = useState<any>(null);
  const loadedResultJobs = useRef(new Set<string>());
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [artifactEditing, setArtifactEditing] = useState(false);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationLoadSequence = useRef(0);

  // 1. Check Profile & Onboarding status
  useEffect(() => {
    async function checkProfile() {
      if (!user) return;
      try {
        const supabase = createClient();
        const { data: prof } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .maybeSingle();
        if (prof) {
          if (prof.persona) setUserPersona(getPersonaConfig(prof.persona).key);
          if (prof.onboarding_completed === false) {
            setShowOnboarding(true);
          }
        }
      } catch (err) {
        console.warn("Error fetching profile:", err);
      }
    }
    checkProfile();
  }, [user]);

  // 2. Shared balance (sidebar, header and wallet read the same ledger sum)
  const { balance: userBalance, refresh: loadBalance } = useBalance();
  const creditValue = useCreditValue();
  const llmEnabled = useLlmEnabled();
  const router = useRouter();

  // 3. Load Conversations
  const loadConversations = useCallback(async () => {
    if (!user) return;
    try {
      const supabase = createClient();
      const { data: rows } = await supabase
        .from("conversations")
        .select("id, title, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", orderDesc)
        .limit(20);
      setConversationsList(
        (rows || []).map((d: any) => ({
          $id: d.id,
          title: d.title || "محادثة استخراج",
          updatedAt: d.updated_at || new Date().toISOString(),
        }))
      );
    } catch (err) {
      console.warn("Error loading conversations:", err);
    }
  }, [user]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // 4. Scroll to bottom
  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    messagesEndRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  }, [messages, loading, activeJob, viewportHeight]);

  // Shell integration: header title + «سؤال بحثي جديد» from the sidebar.
  const shell = useShell();
  useEffect(() => {
    shell.setTitle(conversationTitle || "محادثة جديدة");
  }, [shell, conversationTitle]);
  const startNewChatRef = useRef<() => void>(() => {});
  startNewChatRef.current = handleStartNewChat;
  useEffect(() => {
    const on = () => startNewChatRef.current();
    window.addEventListener("diger:new-chat", on);
    return () => window.removeEventListener("diger:new-chat", on);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const syncViewportHeight = () => setViewportHeight(Math.round(viewport.height));
    syncViewportHeight();
    viewport.addEventListener("resize", syncViewportHeight);
    return () => viewport.removeEventListener("resize", syncViewportHeight);
  }, []);

  // Load rows / review / versions once a job is finished (polling transition or opening a finished file).
  async function loadJobResults(jobId: string) {
    if (loadedResultJobs.current.has(jobId)) return;
    loadedResultJobs.current.add(jobId);
    void loadBalance();
    try {
      const [dataRes, versionsRes] = await Promise.all([
        fetch(`/api/jobs/${jobId}/data`),
        fetch(`/api/jobs/${jobId}/artifacts`),
      ]);
      const [dataJson, versionsJson] = await Promise.all([dataRes.json(), versionsRes.json()]);
      if (dataJson.success) {
        if (dataJson.profile) setExtractedProfile(dataJson.profile);
        if (dataJson.rows && Array.isArray(dataJson.rows)) setExtractedRecords(dataJson.rows);
        setActiveJob((previous) => previous ? {
          ...previous,
          review: dataJson.review || null,
          reviewSeverity: dataJson.runFacts?.severity,
          artifactVersion: dataJson.artifactVersion || null,
          fileIds: dataJson.fileIds,
          versionHistory: versionsJson.success ? versionsJson.versions : [],
          artifactHistoryAvailable: versionsJson.success && versionsJson.historyAvailable,
        } : null);
      }
    } catch (fetchErr) {
      console.warn("Failed to fetch real job data:", fetchErr);
    }
  }

  // 5. Poll active job status
  useEffect(() => {
    if (!activeJob || activeJob.status === "done" || activeJob.status === "failed" || activeJob.status === "cancelled") {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const supabase = createClient();
        const [jobRes, eventsRes] = await Promise.all([
          supabase.from("jobs").select("*").eq("id", activeJob.jobId).maybeSingle(),
          supabase
            .from("job_events")
            .select("*")
            .eq("job_id", activeJob.jobId)
            .order("created_at", orderDesc)
            .limit(EVENT_HISTORY_LIMIT),
        ]);
        const jobDoc: any = jobRes.data;
        if (!jobDoc) return;

        setActiveJob((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            status: jobDoc.status,
            rowsCollected: jobDoc.rows_collected ?? jobDoc.rowsCollected ?? 0,
            chargedCredits: jobDoc.charged_credits ?? jobDoc.chargedCredits,
            reservedCredits: jobDoc.reserved_credits ?? jobDoc.reservedCredits,
            errorAr: jobDoc.error_ar ?? jobDoc.errorAr,
            // Latest events first from the server, restored to reading order for display.
            events: chronological(mapJobEvents(eventsRes.data)),
          };
        });

        const jId = jobDoc.id || jobDoc.$id;
        if ((jobDoc.status === "done" || jobDoc.status === "cancelled") && !loadedResultJobs.current.has(jId)) {
          await loadJobResults(jId);
        }
      } catch (err) {
        console.warn("Polling job status error:", err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [activeJob, loadBalance, extractedRecords.length]);

  // Send message
  async function handleSendMessage(messageContent: string) {
    const textToSend = messageContent.trim();
    if (!textToSend || loading || conversationLoading || !user) return;

    const userMsg: MessageItem = {
      id: `usr_${Date.now()}`,
      role: "user",
      content: textToSend,
      createdAt: new Date().toISOString(),
    };

    const isPriceOrPlanRequest = /(هيكلفني كام|احسبلي|احسب لي|السعر|بكام|كم نقطة|كم يكلف|تكلف كام|التكلفة|كم التكلفة|السعر كام|ابدأ|نفذ|تمام جهز الخطة|اعمل الخطة)/i.test(textToSend);
    setLoadingStatusText(isPriceOrPlanRequest ? "أبحث وأحسب السعر..." : "يفكّر في سؤالك ويجهّز الخطوة التالية...");
    setMessages((prev) => [...prev, userMsg]);
    setInputText("");
    setLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35000);

    try {
      const jwtToken = await getAccessToken();

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtToken) headers["Authorization"] = `Bearer ${jwtToken}`;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          message: textToSend,
          conversationId: conversationId || undefined,
          jwt: jwtToken,
        }),
      });

      clearTimeout(timeoutId);

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "فشل الاتصال بالمساعد الذكي");
      }

      if (data.conversationId) {
        setConversationId(data.conversationId);
        setConversationTitle((title) => title || textToSend.slice(0, 50));
        loadConversations();
      }

      const assistantMsg: MessageItem = {
        id: data.messageId || `asst_${Date.now()}`,
        role: "assistant",
        content: data.contentAr,
        outputType: data.outputType,
        planQuote: data.planQuote,
        clarificationQuestions: data.clarificationQuestions,
        clarificationItems: data.clarificationItems,
        suggestedAlternative: data.suggestedAlternative,
        refusalReason: data.refusalReason,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      clearTimeout(timeoutId);
      const isTimeout = err.name === "AbortError";
      const errorContent = isTimeout
        ? "استغرق المساعد وقتاً أطول من المتوقع (أكثر من 35 ثانية). يرجى الضغط على زر إعادة المحاولة."
        : (err.message || "حدث خطأ غير متوقع في الاتصال. يرجى إعادة المحاولة.");

      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: "assistant",
          content: errorContent,
          errorRetryPrompt: textToSend,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  async function handleSubmitClarification(assistantMessageId: string, answers: DiscoveryAnswer[]) {
    if (loading || !user || !answers.length) return;
    const summary = answers
      .map((answer) => {
        const value = answer.skipped
          ? (answer.resolvedDefault && answer.value
              ? (Array.isArray(answer.value) ? answer.value.join("، ") : answer.value)
              : "سيُطلب منك الاختيار")
          : Array.isArray(answer.value)
            ? answer.value.join("، ")
            : answer.value || "";
        return `${answer.question}: ${value}`;
      })
      .join(" · ");

    setMessages((previous) => [...previous, {
      id: `usr_${Date.now()}`,
      role: "user",
      content: summary,
      hidden: true,
      createdAt: new Date().toISOString(),
    }]);
    setLoading(true);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35000);

    try {
      const jwtToken = await getAccessToken();

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtToken) headers.Authorization = `Bearer ${jwtToken}`;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          conversationId: conversationId || undefined,
          jwt: jwtToken,
          clarificationAnswers: { type: "clarification_answers", answers },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "تعذر إرسال إجابات الاستكشاف");

      setMessages((previous) => [
        ...previous.map((message) => message.id === assistantMessageId
          ? { ...message, completedClarificationAnswers: answers }
          : message),
        {
          id: data.messageId || `asst_${Date.now()}`,
          role: "assistant",
          content: data.contentAr,
          outputType: data.outputType,
          planQuote: data.planQuote,
          clarificationQuestions: data.clarificationQuestions,
          clarificationItems: data.clarificationItems,
          suggestedAlternative: data.suggestedAlternative,
          refusalReason: data.refusalReason,
          createdAt: new Date().toISOString(),
        },
      ]);
      if (data.conversationId) {
        setConversationId(data.conversationId);
        setConversationTitle((title) => title || summary.slice(0, 50));
      }
      loadConversations();
    } catch (err: any) {
      const errorContent = err.name === "AbortError"
        ? "استغرق الإرسال وقتاً أطول من المتوقع. يمكنك المحاولة مرة أخرى."
        : err.message || "تعذر إرسال إجابات الاستكشاف. يرجى المحاولة مرة أخرى.";
      setMessages((previous) => [...previous, {
        id: `err_${Date.now()}`,
        role: "assistant",
        content: errorContent,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  async function handleOpenConversation(id: string) {
    if (!user || loading || conversationLoading) return;
    const sequence = ++conversationLoadSequence.current;
    setConversationLoading(true);
    setConversationLoadError(false);
    setConversationId(id);
    setConversationTitle(conversationsList.find((item) => item.$id === id)?.title ?? "");
    setMessages([]);
    setInputText("");
    setActiveJob(null);
    setExtractedRecords([]);
    setExtractedProfile(null);
    setCanvasOpen(false);
    loadedResultJobs.current.clear();

    try {
      const supabase = createClient();
      if (!conversationsList.some((item) => item.$id === id)) {
        const { data: doc, error: convErr } = await supabase
          .from("conversations")
          .select("*")
          .eq("id", id)
          .single();
        if (convErr || !doc || doc.user_id !== user.id) throw new Error("forbidden");
        if (sequence === conversationLoadSequence.current) setConversationTitle(doc.title || "");
      }
      const documents: any[] = [];
      const pageSize = 100;
      let offset = 0;
      for (let page = 0; page < 50; page += 1) {
        const { data: pageRows, error: msgErr } = await supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", id)
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (msgErr) throw msgErr;
        if (sequence !== conversationLoadSequence.current) return;
        const rows = pageRows || [];
        documents.push(...rows);
        if (rows.length < pageSize) break;
        offset += pageSize;
      }

      setMessages(documents
        .filter((document) => (document.role === "user" || document.role === "assistant") && document.status !== "thinking")
        .map((document) => ({
          id: document.id || document.$id,
          role: document.role as "user" | "assistant",
          content: String(document.content || "").slice(0, 20000),
          createdAt: String(document.created_at || document.createdAt || new Date().toISOString()),
        })));

      // Restore the run (progress / files) of the conversation's accepted quote, if any.
      const { data: acceptedRows } = await supabase
        .from("plans_quotes")
        .select("*")
        .eq("conversation_id", id)
        .eq("status", "accepted")
        .order("created_at", orderDesc)
        .limit(1);
      const quote: any = acceptedRows?.[0];
      const quoteJobId = quote?.job_id || quote?.jobId;
      if (quoteJobId && sequence === conversationLoadSequence.current) {
        const [jobRes, eventsRes] = await Promise.all([
          supabase.from("jobs").select("*").eq("id", quoteJobId).maybeSingle(),
          supabase
            .from("job_events")
            .select("*")
            .eq("job_id", quoteJobId)
            .order("created_at", orderDesc)
            .limit(EVENT_HISTORY_LIMIT),
        ]);
        const jobDoc: any = jobRes.data;
        if (jobDoc) {
          let items: any[] = [];
          try {
            items = Array.isArray(quote.items_json)
              ? quote.items_json
              : JSON.parse(quote.items_json || quote.itemsJson || "[]");
          } catch { /* keep empty */ }
          const jId = jobDoc.id || jobDoc.$id;
          setActiveJob({
            jobId: jId,
            status: jobDoc.status,
            templateSlug: items[0]?.capabilitySlug || jobDoc.template_slug || jobDoc.templateSlug || "tiktok-profile",
            rowsCollected: jobDoc.rows_collected ?? jobDoc.rowsCollected ?? 0,
            chargedCredits: jobDoc.charged_credits ?? jobDoc.chargedCredits,
            reservedCredits: jobDoc.reserved_credits ?? jobDoc.reservedCredits,
            errorAr: jobDoc.error_ar ?? jobDoc.errorAr,
            requestedRows: quote.target_volume_max ?? quote.targetVolumeMax,
            events: chronological(mapJobEvents(eventsRes.data)),
          });
          if (jobDoc.status === "done" || jobDoc.status === "cancelled") await loadJobResults(jId);
        }
      }
    } catch {
      if (sequence === conversationLoadSequence.current) setConversationLoadError(true);
    } finally {
      if (sequence === conversationLoadSequence.current) setConversationLoading(false);
    }
  }

  function handleStartNewChat() {
    conversationLoadSequence.current += 1;
    setMessages([]);
    setConversationId(null);
    setConversationTitle("");
    setConversationLoading(false);
    setConversationLoadError(false);
    setInputText("");
    setActiveJob(null);
    setExtractedRecords([]);
    setExtractedProfile(null);
    loadedResultJobs.current.clear();
  }

  // Save Direct Plan Edits
  async function handleSaveDirectEdit(
    currentQuote: PlanQuoteData,
    newLimit: number,
    newParam: string,
    newFormats: string[]
  ) {
    const primaryItem = currentQuote.items?.[0] || { capabilitySlug: "tiktok-profile", params: {} };
    const slug = primaryItem.capabilitySlug;

    const operations: any[] = [
      { action: "set_limit", capabilitySlug: slug, targetVolumeMax: Number(newLimit) },
      { action: "set_formats", formats: newFormats },
    ];

    if (newParam.trim()) {
      const cleanVal = newParam.replace(/^@/, "").trim();
      operations.push({ action: "set_param", capabilitySlug: slug, key: "username", value: cleanVal });
    }

    const jwtToken = await getAccessToken();

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (jwtToken) headers["Authorization"] = `Bearer ${jwtToken}`;

    const res = await fetch("/api/chat/edit-plan", {
      method: "POST",
      headers,
      body: JSON.stringify({
        quoteId: currentQuote.quoteId,
        operations,
        jwt: jwtToken,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "فشل تحديث الخطة وعرض السعر");
    }

    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.planQuote?.quoteId === currentQuote.quoteId) {
          return {
            ...msg,
            content: `تم تعديل تفاصيل الخطة وتحديث عرض السعر:\n• السجلات المعتمدة: حتى ${data.planQuote.targetVolumeMax} سجل\n• التكلفة الإجمالية: ${data.planQuote.quotedPoints} نقطة`,
            planQuote: data.planQuote,
          };
        }
        return msg;
      })
    );
  }

  // Start Job Execution
  async function handleStartExecution(quote: PlanQuoteData) {
    if (startingQuoteId || !user) return;
    setStartingQuoteId(quote.quoteId);

    try {
      const jwtToken = await getAccessToken();

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtToken) headers["Authorization"] = `Bearer ${jwtToken}`;

      const res = await fetch("/api/chat/accept-quote", {
        method: "POST",
        headers,
        body: JSON.stringify({
          quoteId: quote.quoteId,
          expectedPlanHash: quote.planHash,
          jwt: jwtToken,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "فشل بدء تنفيذ الخطة");
      }

      loadBalance();

      setActiveJob({
        jobId: data.jobId,
        status: "running",
        templateSlug: quote.items?.[0]?.capabilitySlug || "tiktok-profile",
        rowsCollected: 0,
        reservedCredits: data.reservedCredits,
        requestedRows: quote.targetVolumeMax,
        events: [
          {
            $id: `init_${Date.now()}`,
            textAr: `تم حجز ${data.reservedCredits} نقطة وتأكيد الطلب. جاري البدء...`,
            kind: "info",
            createdAt: new Date().toISOString(),
          },
        ],
      });

      setMessages((prev) => [
        ...prev,
        {
          id: `start_${Date.now()}`,
          role: "assistant",
          content: `بدأت عملية الاستخراج بنجاح! تم حجز ${data.reservedCredits} نقطة احتياطياً. يمكنك متابعة تقدم السحب في سجل النشاط ولوحة النتائج.`,
          jobId: data.jobId,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err_start_${Date.now()}`,
          role: "assistant",
          content: `تعذر بدء الاستخراج: ${err.message}`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setStartingQuoteId(null);
    }
  }

  // Download File Handler
  async function handleDownload(ext: "xlsx" | "pdf" | "csv") {
    if (!activeJob?.jobId || downloadingKey) return;
    setDownloadingKey(ext);

    try {
      const jwtToken = await getAccessToken();
      const headers: Record<string, string> = {};
      if (jwtToken) headers["Authorization"] = `Bearer ${jwtToken}`;
      const res = await fetch(`/api/jobs/${activeJob.jobId}/download?format=${ext}`, { headers });
      const payload = await res.json();
      if (!res.ok || !payload?.success || !payload?.signedUrl) {
        throw new Error(payload?.error || "الملف غير متاح للتحميل حالياً");
      }
      const fileRes = await fetch(payload.signedUrl);
      if (!fileRes.ok) throw new Error(String(fileRes.status));
      const blobUrl = URL.createObjectURL(await fileRes.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = payload.downloadFileName || `diger_${activeJob.templateSlug}_${activeJob.jobId.slice(0, 8)}.${ext}`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(blobUrl); link.remove(); }, 250);
    } catch (err: any) {
      alert(`تعذر تحميل الملف: ${err.message}`);
    } finally {
      setDownloadingKey(null);
    }
  }

  async function submitArtifactAction(action: { operation: ArtifactEditOperation } | { undoToVersionId: string }) {
    if (!activeJob?.jobId || artifactEditing || !user) return;
    setArtifactEditing(true);
    try {
      const jwtToken = await getAccessToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtToken) headers.Authorization = `Bearer ${jwtToken}`;
      const response = await fetch(`/api/jobs/${activeJob.jobId}/artifacts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...action, expectedVersionId: activeJob.artifactVersion?.id || null }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "تعذر حفظ نسخة التعديل");
      setActiveJob((previous) => previous ? {
        ...previous,
        artifactVersion: result.version,
        fileIds: result.version.fileIds,
        versionHistory: [...(previous.versionHistory || []), {
          id: result.version.id,
          versionNum: result.version.versionNum,
          parentVersionId: result.version.parentVersionId || null,
          rowCount: result.version.rowCount,
          isOriginal: false,
        }],
      } : null);

      const dataResponse = await fetch(`/api/jobs/${activeJob.jobId}/data`);
      const data = await dataResponse.json();
      if (data.success) {
        setExtractedRecords(Array.isArray(data.rows) ? data.rows : []);
        setExtractedProfile(data.profile || null);
        setActiveJob((previous) => previous ? {
          ...previous,
          review: data.review || previous.review,
          reviewSeverity: data.runFacts?.severity || previous.reviewSeverity,
          artifactVersion: data.artifactVersion || previous.artifactVersion,
          fileIds: data.fileIds || previous.fileIds,
        } : null);
      }

      const historyResponse = await fetch(`/api/jobs/${activeJob.jobId}/artifacts`);
      const history = await historyResponse.json();
      if (history.success) setActiveJob((previous) => previous ? {
        ...previous,
        versionHistory: history.versions || [],
        artifactHistoryAvailable: history.historyAvailable,
      } : null);
      setMessages((previous) => [...previous, {
        id: `artifact_v${result.version.versionNum}_${Date.now()}`,
        role: "assistant",
        content: `اتحفظ التعديل كنسخة رقم ${result.version.versionNum} من النتيجة، بدون خصم نقاط. تقدر ترجع لأي نسخة أقدم.`,
        createdAt: new Date().toISOString(),
      }]);
    } catch (error: any) {
      setMessages((previous) => [...previous, {
        id: `artifact_error_${Date.now()}`,
        role: "assistant",
        content: error.message || "تعذر حفظ التعديل. النتيجة الأصلية لم تتغير.",
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setArtifactEditing(false);
    }
  }

  // Request Academic Methodology (10 points flow)
  async function handleGenerateMethodology() {
    if (!activeJob?.jobId || !user) return;
    try {
      const jwtToken = await getAccessToken();

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtToken) headers["Authorization"] = `Bearer ${jwtToken}`;

      const res = await fetch(`/api/jobs/${activeJob.jobId}/methodology`, {
        method: "POST",
        headers,
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || "فشل توليد التوثيق المنهجي");
        return;
      }

      const methodologyMsg: MessageItem = {
        id: `meth_${Date.now()}`,
        role: "assistant",
        content: methodologyMessageText(data.chargedPoints, data.remainingBalance, data.methodologyText),
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, methodologyMsg]);
      loadBalance();
      alert(methodologyAlertText(data.chargedPoints));
    } catch (err: any) {
      alert("تعذر طلب صياغة المنهجية: " + err.message);
    }
  }

  function handleKeepResult() {
    setMessages((previous) => [...previous, {
      id: `review_keep_${Date.now()}`,
      role: "assistant",
      content: "تمام، هنحتفظ بالنتيجة الحالية كما هي. تقدر تحمّل الملفات أو تعدّلها لاحقًا.",
      createdAt: new Date().toISOString(),
    }]);
  }

  function handleEditAndFetch() {
    handleSendMessage("عايز أراجع الخطة السابقة وأعدّلها. اعرض خطة وعرض سعر جديد فقط، ولا تبدأ أي استخراج قبل ما أوافق بنفسي.");
  }

  function handleReviewSuggestion(suggestion: ReviewSuggestion) {
    const params = suggestion.params as Record<string, any>;
    if (suggestion.type === "dedupe") {
      void submitArtifactAction({ operation: { action: "dedupe", keys: params.keys } });
      return;
    }
    if (suggestion.type === "change_columns") {
      void submitArtifactAction({ operation: { action: "select_columns", columns: params.columns } });
      return;
    }
    if (suggestion.type === "anonymize" && params.enabled) {
      void submitArtifactAction({ operation: { action: "anonymize", fields: ["username", "displayName", "bio", "bioLink", "profileUrl"] } });
      return;
    }
    if (suggestion.type === "export_variant") {
      void submitArtifactAction({ operation: { action: "convert_formats", formats: params.formats } });
      return;
    }
    let request = "";
    if (suggestion.type === "refine_window") request = `اقترح خطة جديدة للفترة من ${params.from} إلى ${params.to}`;
    else if (suggestion.type === "include_replies") request = "أعد إعداد الخطة مع طلب جمع الردود";
    else if (suggestion.type === "narrow_query") request = `ضيّق البحث حول: ${params.query}`;
    else if (suggestion.type === "language_filter") request = `صفِّ النتائج حسب اللغة: ${params.language}`;
    else if (suggestion.type === "new_collection") request = `اعرض خطة جديدة حتى ${params.maxRows} سجل لاستكمال: ${params.query}`;
    else if (suggestion.type === "write_methodology") request = "أعد صياغة ملخص المنهجية في نسخة النتيجة الحالية";
    if (!request) return;
    const needsNewQuote = ["refine_window", "include_replies", "narrow_query", "language_filter", "new_collection"].includes(suggestion.type);
    handleSendMessage(`${request}. ${needsNewQuote ? "اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ." : "لا تعِد جمع البيانات."}`);
  }

  /* ── wiring for the design's states ─────────────────────────────────── */

  // «تحديث السعر»: the server recomputes the quote (same plan). An expired quote is never accepted server-side.
  async function handleRefreshQuote(quote: PlanQuoteData) {
    try {
      await handleSaveDirectEdit(quote, quote.targetVolumeMax, "", quote.outputFormats?.length ? quote.outputFormats : ["xlsx", "pdf", "csv"]);
    } catch (err: any) {
      setMessages((prev) => [...prev, { id: `err_refresh_${Date.now()}`, role: "assistant", content: err?.message || "تعذر تحديث السعر. حاول مرة أخرى.", createdAt: new Date().toISOString() }]);
    }
  }

  // «اشحن {الفرق} والعودة هنا»
  function handleTopupShort(shortEgp: number) {
    const back = conversationId ? `/dashboard/chat?c=${conversationId}` : "/dashboard/chat";
    router.push(`/dashboard/topup?amount=${shortEgp}&return=${encodeURIComponent(back)}`);
  }

  // A question typed on the landing page is sent as the first message, then forgotten.
  const pendingHandled = useRef(false);
  useEffect(() => {
    if (!user || pendingHandled.current) return;
    const q = readPendingQuestion();
    if (!q) return;
    pendingHandled.current = true;
    clearPendingQuestion();
    void handleSendMessage(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const sendRef = useRef<(text: string) => Promise<void>>(async () => {});
  sendRef.current = handleSendMessage;

  // Deep link from «طلباتي» / the wallet return: /dashboard/chat?c=<conversationId>
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (!user || deepLinkHandled.current) return;
    const id = new URLSearchParams(window.location.search).get("c");
    if (!id || !/^[A-Za-z0-9_-]{1,36}$/.test(id)) return;
    deepLinkHandled.current = true;
    const retry = new URLSearchParams(window.location.search).get("retry") === "1";
    void handleOpenConversation(id).then(() => {
      // «إعادة المحاولة» from طلباتي: ask for a fresh quote on the same plan.
      // (sendRef always points at the latest closure, which already knows the opened conversation id.)
      if (retry) setTimeout(() => void sendRef.current("أعد المحاولة بنفس الخطة. اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ."), 350);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  /* ── derived document state ───────────────────────────────────────── */
  const isClarification = (m: MessageItem) =>
    m.outputType === "ask_clarification" || (Array.isArray(m.clarificationItems) ? m.clarificationItems.length > 0 : !!m.clarificationItems);
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  const question = conversationTitle || (firstUserIdx >= 0 ? messages[firstUserIdx].content : "");
  const startIdx = messages.findIndex((m) => !!m.jobId);
  const lastPlanIdx = messages.reduce((acc, m, i) => (m.planQuote ? i : acc), -1);
  const lastClarIdx = messages.reduce((acc, m, i) => (isClarification(m) ? i : acc), -1);
  const jobFinished = activeJob?.status === "done" || activeJob?.status === "cancelled";
  const answeringNow = loading && lastClarIdx >= 0 && !!messages[lastClarIdx].completedClarificationAnswers;

  let stage: DocStage = 0;
  if (activeJob) stage = jobFinished ? 4 : 3;
  else if (lastPlanIdx >= 0 && lastPlanIdx > lastClarIdx) stage = 2;
  else if (answeringNow) stage = 1;

  const beforeJob = startIdx >= 0 ? messages.slice(0, startIdx) : messages;
  const afterJob = startIdx >= 0 ? messages.slice(startIdx + 1) : [];
  const dateLabel = new Intl.DateTimeFormat("ar-EG-u-nu-arab", { day: "numeric", month: "long", year: "numeric" })
    .format(new Date(messages[0]?.createdAt || Date.now()));
  const balanceValue = userBalance.status === "ready" ? userBalance.value : null;
  const firstName = (user?.name || "").trim().split(/\s+/)[0] || "";
  const chatEmpty = messages.length === 0 && !conversationLoading && !conversationLoadError;

  const renderNote = (m: MessageItem) => {
    if (m.hidden || m.jobId) return null;
    if (m.role === "user") {
      return <p key={m.id} className="mb-0 mt-3 w-fit max-w-full rounded-[18px] bg-sf2 px-4 py-2.5 text-sm font-light leading-[1.8] text-ink" style={{ animation: "up .3s both" }}>{m.content}</p>;
    }
    return (
      <div key={m.id}>
        {m.content && <p className="mb-0 mt-3 whitespace-pre-wrap text-[15px] font-light leading-[2] text-ink" style={{ animation: "up .3s both" }}>{m.content}</p>}
        {m.errorRetryPrompt && (
          <button
            type="button" onClick={() => handleSendMessage(m.errorRetryPrompt!)}
            className="mt-2 min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink focus-visible:outline-2"
          >
            إعادة المحاولة الآن
          </button>
        )}
      </div>
    );
  };

  const detailsNode = (
    <div>
      {beforeJob.map((m, i) => {
        if (i === firstUserIdx || m.planQuote) return null;
        if (isClarification(m)) {
          return (
            <div key={m.id}>
              <div className="mt-3.5">
                <DetailsBlanks
                  questions={m.clarificationItems || m.clarificationQuestions || []}
                  completedAnswers={m.completedClarificationAnswers}
                  disabled={loading}
                  onComplete={(answers) => handleSubmitClarification(m.id, answers)}
                />
              </div>
            </div>
          );
        }
        return renderNote(m);
      })}
      {loading && stage === 0 && (
        <p role="status" className="mb-0 mt-4 text-[15px] font-light text-mut" style={{ animation: "breathe 1.4s infinite" }}>{loadingStatusText}</p>
      )}
    </div>
  );

  const planMsg = lastPlanIdx >= 0 ? messages[lastPlanIdx] : null;
  const planNode = (
    <>
      {stage === 1 && <p role="status" className="mb-0 mt-4 text-[15px] font-light text-mut" style={{ animation: "breathe 1.4s infinite" }}>يحسب الخادم عرض السعر…</p>}
      {planMsg?.planQuote && (stage >= 2 || lastPlanIdx > lastClarIdx) && (
        <>
          <PlanQuoteCard
            quote={planMsg.planQuote}
            onStart={handleStartExecution}
            onSaveEdit={handleSaveDirectEdit}
            onAcceptDownscaled={(units) => handleSendMessage(`أوافق على الخطة المخفضة حتى ${units} سجل تناسب رصيدي المتاح`)}
            isStarting={startingQuoteId === planMsg.planQuote.quoteId}
            available={balanceValue}
            creditValue={creditValue}
            onTopupShort={handleTopupShort}
            onRefresh={handleRefreshQuote}
            locked={!!activeJob}
          />
        </>
      )}
    </>
  );

  const runNode = activeJob ? (
    activeJob.status === "failed" ? (
      <FailureBox
        providerMessage={activeJob.errorAr}
        refunded={activeJob.reservedCredits}
        onRetry={() => handleSendMessage("أعد المحاولة بنفس الخطة. اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ.")}
        onGoRequests={() => router.push("/dashboard/requests")}
      />
    ) : (
      <ActivityTimeline
        status={activeJob.status}
        events={activeJob.events}
        rowsCollected={activeJob.rowsCollected}
        eventLimit={EVENT_HISTORY_LIMIT}
        spentPoints={activeJob.chargedCredits}
        reservedPoints={activeJob.reservedCredits}
        requestedRows={activeJob.requestedRows}
      />
    )
  ) : null;

  const filesNode = (
    <>
      {activeJob && jobFinished && (
        <FilesSection
          rows={activeJob.rowsCollected}
          requested={activeJob.requestedRows}
          charged={activeJob.chargedCredits}
          reserved={activeJob.reservedCredits}
          downloadingKey={downloadingKey}
          onDownload={handleDownload}
          onOpenCanvas={() => setCanvasOpen((v) => !v)}
          canvasOpen={canvasOpen}
        />
      )}
      {afterJob.map(renderNote)}
    </>
  );

  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden bg-bg font-sans text-ink">
      {/* 1. Onboarding (existing first-run persona step) */}
      <OnboardingModal
        isOpen={showOnboarding}
        onComplete={(p) => {
          setUserPersona(p);
          setShowOnboarding(false);
        }}
        onSkip={() => setShowOnboarding(false)}
      />

      {/* 2. Research document + composer */}
      <div data-screen-label="Chat" className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ containerType: "inline-size" }}>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pb-7 pt-5">
          {conversationLoading && (
            <div role="status" aria-label="جاري تحميل المحادثة" className="mx-auto w-full max-w-[680px] space-y-3 py-4">
              <span className="sr-only">جاري تحميل المحادثة</span>
              {["w-3/5", "w-4/5", "w-2/5"].map((width, index) => (
                <div key={index} className={`h-10 ${width} rounded-[14px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none`} />
              ))}
            </div>
          )}
          {conversationLoadError && conversationId && !conversationLoading && (
            <div role="alert" className="mx-auto max-w-[680px] rounded-[18px] p-4 text-sm text-ink" style={{ background: "color-mix(in oklab, var(--bad) 8%, var(--sf))" }}>
              <p className="m-0">تعذر تحميل المحادثة. تحقق من الاتصال ثم حاول مرة أخرى.</p>
              <button type="button" onClick={() => void handleOpenConversation(conversationId)} className="mt-3 min-h-11 cursor-pointer rounded-full border border-ln2 bg-sf px-4 text-xs text-ink focus-visible:outline-2">
                إعادة المحاولة
              </button>
            </div>
          )}

          {chatEmpty && (
            <EmptyChat
              firstName={firstName}
              zeroBalance={balanceValue !== null && balanceValue <= 0}
              onStart={(prompt) => handleSendMessage(prompt)}
            />
          )}

          {!chatEmpty && !conversationLoading && messages.length > 0 && (
            <ResearchDocument
              dateLabel={dateLabel}
              question={question}
              stage={stage}
              failed={activeJob?.status === "failed"}
              banner={!llmEnabled ? (
                <div role="status" className="mb-[18px] flex items-start gap-2.5 rounded-[18px] bg-sf2 px-4 py-3 text-[13px] leading-[1.8] text-ink2">
                  <span className="mt-0.5 flex text-goldT"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 8v5M12 16.5v.5M10.3 4l-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z" /></svg></span>
                  <span>المساعد الذكي يعمل الآن بالوضع المبسّط: أسئلة ثابتة وخطة قياسية. السعر والموافقة والتنفيذ تعمل بشكل طبيعي.</span>
                </div>
              ) : null}
              details={detailsNode}
              plan={planNode}
              run={runNode}
              files={filesNode}
            />
          )}
          <div ref={messagesEndRef} />
        </div>
        <Composer value={inputText} onChange={setInputText} onSend={handleSendMessage} disabled={conversationLoading || loading} />
      </div>

      {/* 3. Results workspace (record preview, review, versions): drawer on mobile, side column on desktop */}
      {canvasOpen && (
        <>
          <div
            onClick={() => setCanvasOpen(false)}
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-xs lg:hidden"
          />
          <div id="results-canvas" role="region" aria-label="لوحة النتائج" className="fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] max-h-[85vh] w-full flex-col overflow-hidden rounded-t-[28px] bg-sf shadow-2xl motion-reduce:animate-none lg:static lg:inset-auto lg:h-full lg:max-h-none lg:w-[460px] lg:rounded-none lg:border-s lg:border-ln lg:shadow-none" style={{ animation: "sheetUp .25s cubic-bezier(.2,.7,.2,1) both" }}>
            <ResultsCanvas
              records={extractedRecords}
              profile={extractedProfile}
              jobId={activeJob?.jobId || null}
              onDownload={handleDownload}
              downloadingKey={downloadingKey}
              onExplainMethodology={() =>
                handleSendMessage("اشرح لي كيف تم جمع البيانات وطريقة الحساب والتوثيق بالتفصيل")
              }
              onRequestDocxMethodology={handleGenerateMethodology}
              onCloseMobile={() => setCanvasOpen(false)}
              review={activeJob?.review}
              reviewSeverity={activeJob?.reviewSeverity}
              onKeepResult={handleKeepResult}
              onEditAndFetch={handleEditAndFetch}
              onReviewSuggestion={handleReviewSuggestion}
              currentVersion={activeJob?.artifactVersion ? { id: activeJob.artifactVersion.id, versionNum: activeJob.artifactVersion.versionNum } : null}
              versionHistory={activeJob?.versionHistory || []}
              artifactHistoryAvailable={activeJob?.artifactHistoryAvailable}
              artifactEditing={artifactEditing}
              onArtifactEdit={(operation) => void submitArtifactAction({ operation })}
              onUndoVersion={(targetVersionId) => void submitArtifactAction({ undoToVersionId: targetVersionId })}
            />
          </div>
        </>
      )}
    </div>
  );
}
