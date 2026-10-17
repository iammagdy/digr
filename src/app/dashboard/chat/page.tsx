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
import { dayLabel } from "@/lib/dayLabel";
import { clearPendingQuestion, readPendingQuestion } from "@/lib/pendingQuestion";
import { parsePersistedClarificationAnswers, type DiscoveryAnswer } from "./components/discoveryQuestions";
import type { ReviewSeverity, ReviewSuggestion, ResultReview } from "@/functions/shared/resultReview";
import type { ArtifactEditOperation } from "@/functions/shared/artifactEditing";

import OnboardingModal from "./components/OnboardingModal";
import { useShell } from "@/components/app/AppShell";
import DetailsBlanks from "./components/DetailsBlanks";
import PlanQuoteCard, { PlanQuoteData } from "./components/PlanQuoteCard";
import { buildCompanyPlanEditOperations } from "@/lib/companyPlanEdits";
import { extractParamDisplayString } from "@/lib/planParameters";
import { customerFacingAssistantCopy } from "@/lib/customerFacingAssistantCopy";
import { customerFacingConversationTitle } from "@/lib/customerFacingConversationTitle";
import ActivityTimeline, { JobEvent } from "./components/ActivityTimeline";
import ResultsCanvas, { ExtractedRecord } from "./components/ResultsCanvas";
import ResearchDocument, { type DocStage } from "./components/ResearchDocument";
import EmptyChat from "./components/EmptyChat";
import { FailureBox, FilesSection } from "./components/RunSections";
import Composer, { AttachedFile } from "./components/Composer";
import RevisionQuoteCard, { RevisionQuoteData } from "./components/RevisionQuoteCard";
import { getJobIdForQuote } from "@/lib/md5";
import { isTerminalJobStatus, toChatJobStatus } from "@/lib/jobs/status";

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
  const seen = new Set<string>();
  const events: JobEvent[] = [];
  for (const e of rows || []) {
    const rawId = e.id || e.$id;
    const dedupeKey = rawId ? String(rawId) : `${e.created_at || ""}_${e.message || e.text_ar || ""}_${e.units ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    events.push({
      $id: String(rawId || `ev_${dedupeKey}`),
      textAr: e.message || e.text_ar || e.textAr || "",
      count: typeof e.units === "number" ? e.units : (typeof e.count === "number" ? e.count : undefined),
      kind: (e.event_type || e.kind || "info") as JobEvent["kind"],
      createdAt: e.created_at || e.createdAt || new Date().toISOString(),
    });
  }
  return events;
}

function dedupeAndSortChronological(events: JobEvent[]): JobEvent[] {
  const seen = new Set<string>();
  const unique: JobEvent[] = [];
  for (const ev of events) {
    const key = ev.$id || `${ev.createdAt}_${ev.textAr}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(ev);
    }
  }
  // Sort descending by date, then use chronological() to restore display order
  const descEvents = unique.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return chronological(descEvents);
}

interface MessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachment?: {
    name: string;
    type: "xlsx" | "csv";
    size: number;
  };
  outputType?: "propose_plan" | "edit_plan" | "ask_clarification" | "suggest_alternative" | "refuse" | "edit_artifact" | "answer_question" | "write_note";
  intent?: "chat" | "research";
  planQuote?: PlanQuoteData;
  revisionQuote?: RevisionQuoteData;
  clarificationQuestions?: string[];
  clarificationItems?: unknown;
  clarificationIntro?: string;
  completedClarificationAnswers?: DiscoveryAnswer[];
  suggestedAlternative?: any;
  refusalReason?: string;
  jobId?: string;
  /** Internal turns (clarification-answer summaries) are shown through the details sentence instead. */
  hidden?: boolean;
  errorRetryPrompt?: string;
  retryClarification?: { assistantMessageId: string; answers: DiscoveryAnswer[] };
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
  const [loadingStatusText, setLoadingStatusText] = useState("يكتب الرد...");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("");
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationLoadError, setConversationLoadError] = useState(false);
  const [userPersona, setUserPersona] = useState<PersonaType>("student");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [conversationsList, setConversationsList] = useState<ConversationItem[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [guestRemaining, setGuestRemaining] = useState<number | null>(null);

  // Active Job & Canvas Data
  const [startingQuoteId, setStartingQuoteId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ActiveJobState | null>(null);
  const [extractedRecords, setExtractedRecords] = useState<ExtractedRecord[]>([]);
  const [extractedProfile, setExtractedProfile] = useState<any>(null);
  const loadedResultJobs = useRef(new Set<string>());
  const lastNudgeAt = useRef(new Map<string, number>());
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [artifactEditing, setArtifactEditing] = useState(false);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationLoadSequence = useRef(0);
  const sendInFlight = useRef(false);

  // Sync canvasOpen and activeJob to sessionStorage for reload persistence
  useEffect(() => {
    try {
      if (canvasOpen) {
        sessionStorage.setItem("diger_canvas_open", "1");
      } else {
        sessionStorage.removeItem("diger_canvas_open");
      }
    } catch {}
  }, [canvasOpen]);

  useEffect(() => {
    try {
      if (activeJob?.jobId) {
        sessionStorage.setItem("diger_active_job_id", activeJob.jobId);
      }
    } catch {}
  }, [activeJob?.jobId]);

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
    if (!user) { setConversationsLoading(false); return; }
    setConversationsLoading(true);
    try {
      const supabase = createClient();
      const { data: rows } = await supabase
        .from("conversations")
        .select("id, title, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", orderDesc)
        .limit(20);
      const unique = new Map<string, ConversationItem>();
      for (const d of rows || []) {
        if (!unique.has(d.id)) unique.set(d.id, {
          $id: d.id,
          title: d.title || "محادثة استخراج",
          updatedAt: d.updated_at || new Date().toISOString(),
        });
      }
      setConversationsList(Array.from(unique.values()));
    } catch (err) {
      console.warn("Error loading conversations:", err);
    } finally {
      setConversationsLoading(false);
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
    shell.setTitle(customerFacingConversationTitle(conversationTitle || "محادثة جديدة"));
  }, [shell, conversationTitle]);
  const startNewChatRef = useRef<() => void>(() => {});
  startNewChatRef.current = handleStartNewChat;
  useEffect(() => {
    const on = () => startNewChatRef.current();
    window.addEventListener("diger:new-chat", on);
    return () => window.removeEventListener("diger:new-chat", on);
  }, []);

  useEffect(() => {
    const showHistory = () => {
      setHistoryOpen(true);
      void loadConversations();
    };
    window.addEventListener("diger:show-history", showHistory);
    if (new URLSearchParams(window.location.search).get("history") === "1") showHistory();
    return () => window.removeEventListener("diger:show-history", showHistory);
  }, [loadConversations]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("onboarding") !== "1") return;
    setShowOnboarding(true);
    params.delete("onboarding");
    const query = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
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

  // 5. Poll and subscribe to active job status
  useEffect(() => {
    if (!activeJob || isTerminalJobStatus(activeJob.status)) {
      return;
    }

    const supabase = createClient();

    // Instant real-time listener for job events
    const channel = supabase
      .channel(`job_events_live_${activeJob.jobId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "job_events",
          filter: `job_id=eq.${activeJob.jobId}`,
        },
        (payload) => {
          const newEvt = payload.new;
          if (!newEvt) return;
          setActiveJob((prev) => {
            if (!prev || prev.jobId !== activeJob.jobId) return prev;
            const mapped = mapJobEvents([newEvt]);
            const nextEvents = dedupeAndSortChronological([...prev.events, ...mapped]);
            const newUnits =
              typeof newEvt.units === "number" && newEvt.units > prev.rowsCollected
                ? newEvt.units
                : prev.rowsCollected;
            return {
              ...prev,
              events: nextEvents,
              rowsCollected: newUnits,
            };
          });
        }
      )
      .subscribe();

    const interval = setInterval(async () => {
      try {
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
            status: toChatJobStatus(jobDoc.status),
            rowsCollected: jobDoc.delivered_units ?? jobDoc.rows_collected ?? jobDoc.rowsCollected ?? 0,
            chargedCredits: jobDoc.charged_credits ?? jobDoc.chargedCredits,
            reservedCredits: jobDoc.reserved_credits ?? jobDoc.reservedCredits,
            requestedRows: jobDoc.target_volume_max ?? prev.requestedRows,
            errorAr: jobDoc.error_message ?? jobDoc.error_ar ?? jobDoc.errorAr,
            // Latest events first from the server, restored to reading order for display.
            events: dedupeAndSortChronological(mapJobEvents(eventsRes.data)),
          };
        });

        const jId = jobDoc.id || jobDoc.$id;
        if (isTerminalJobStatus(jobDoc.status)) {
          void loadBalance();
        }
        if ((jobDoc.status === "completed" || jobDoc.status === "done") && !loadedResultJobs.current.has(jId)) {
          await loadJobResults(jId);
        }

        const now = Date.now();
        const leaseActive = jobDoc.lease_until && new Date(jobDoc.lease_until).getTime() > now;
        const backoffActive = jobDoc.next_attempt_at && new Date(jobDoc.next_attempt_at).getTime() > now;
        const lastNudge = lastNudgeAt.current.get(jId) || 0;
        if (
          (jobDoc.status === "queued" || jobDoc.status === "running") &&
          !leaseActive &&
          !backoffActive &&
          now - lastNudge >= 10_000
        ) {
          lastNudgeAt.current.set(jId, now);
          void fetch(`/api/jobs/${jId}/nudge`, { method: "POST" }).then(async (nudgeRes) => {
            if (nudgeRes.ok) return;
            const message = "تعذر الاتصال بمحرك التنفيذ. ستُعاد المحاولة تلقائياً مع بقاء النقاط محجوزة مؤقتاً.";
            setActiveJob((prev) => {
              if (!prev || prev.jobId !== jId || isTerminalJobStatus(prev.status)) return prev;
              if (prev.events.some((event) => event.textAr === message)) return prev;
              return {
                ...prev,
                events: dedupeAndSortChronological([
                  ...prev.events,
                  { $id: `nudge_retry_${Date.now()}`, textAr: message, kind: "info", createdAt: new Date().toISOString() },
                ]),
              };
            });
          }).catch(() => {});
        }
      } catch (err) {
        console.warn("Polling job status error:", err);
      }
    }, 2000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [activeJob, loadBalance, extractedRecords.length]);

  // Send message
  async function handleSendMessage(messageContent: string, attachedFile?: AttachedFile | null): Promise<boolean> {
    const textToSend = messageContent.trim();
    if ((!textToSend && !attachedFile) || loading || conversationLoading || sendInFlight.current) return false;
    sendInFlight.current = true;

    if (!user && attachedFile) {
      setMessages((prev) => [
        ...prev,
        {
          id: `warn_${Date.now()}`,
          role: "assistant",
          content: "رفع الملفات وفحص قوائم الاستبعاد متاح بعد تسجيل الدخول.",
          createdAt: new Date().toISOString(),
        },
      ]);
      sendInFlight.current = false;
      return false;
    }

    const userMsg: MessageItem = {
      id: `usr_${Date.now()}`,
      role: "user",
      content: textToSend,
      attachment: attachedFile ? {
        name: attachedFile.name,
        type: attachedFile.type,
        size: attachedFile.size,
      } : undefined,
      createdAt: new Date().toISOString(),
    };

    const isPriceOrPlanRequest = /(هيكلفني كام|احسبلي|احسب لي|السعر|بكام|كم نقطة|كم يكلف|تكلف كام|التكلفة|كم التكلفة|السعر كام|ابدأ|نفذ|تمام جهز الخطة|اعمل الخطة)/i.test(textToSend);
    const hasPriorResearch = Boolean(
      activeJob ||
      messages.some((m) =>
        m.planQuote ||
        (m.clarificationQuestions && m.clarificationQuestions.length > 0) ||
        m.outputType === "propose_plan" ||
        m.outputType === "ask_clarification" ||
        m.intent === "research"
      )
    );
    setLoadingStatusText(isPriceOrPlanRequest ? "أبحث وأحسب السعر..." : (hasPriorResearch ? "يفكّر في سؤالك ويجهّز الخطوة التالية..." : "يكتب الرد..."));
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);

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
          ...(attachedFile ? {
            uploadedFiles: [
              {
                name: attachedFile.name,
                type: attachedFile.type,
                content: attachedFile.base64,
              }
            ]
          } : {})
        }),
      });

      clearTimeout(timeoutId);

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "فشل الاتصال بالمساعد الذكي");
      }

      if (data.isGuest) {
        setGuestRemaining(data.remainingGuestMessages ?? 0);
      }

      if (data.conversationId) {
        setConversationId(data.conversationId);
        setConversationTitle((title) =>
          !title || customerFacingConversationTitle(title) === "محادثة جديدة"
            ? customerFacingConversationTitle(textToSend)
            : title
        );
        if (user) loadConversations();
      }

      const assistantMsg: MessageItem = {
        id: data.messageId || `asst_${Date.now()}`,
        role: "assistant",
        content: data.contentAr,
        outputType: data.outputType,
        intent: data.intent,
        planQuote: data.planQuote,
        revisionQuote: data.revisionQuote,
        clarificationQuestions: data.clarificationQuestions,
        clarificationItems: data.clarificationItems,
        clarificationIntro: data.clarificationIntro,
        suggestedAlternative: data.suggestedAlternative,
        refusalReason: data.refusalReason,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
      return true;
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
      return false;
    } finally {
      clearTimeout(timeoutId);
      sendInFlight.current = false;
      setLoading(false);
    }
  }

  async function handleSubmitClarification(assistantMessageId: string, answers: DiscoveryAnswer[]) {
    if (loading || !answers.length) return;
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
    const timeoutId = setTimeout(() => controller.abort(), 55000);

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
          intent: data.intent,
          planQuote: data.planQuote,
          revisionQuote: data.revisionQuote,
          clarificationQuestions: data.clarificationQuestions,
          clarificationItems: data.clarificationItems,
          clarificationIntro: data.clarificationIntro,
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
      const isTimeout = err.name === "AbortError";
      const errorContent = isTimeout
        ? "استغرق إرسال الإجابات وقتاً أطول من المتوقع. يرجى الضغط على زر إعادة المحاولة."
        : err.message || "تعذر إرسال إجابات الاستكشاف. يرجى المحاولة مرة أخرى.";
      setMessages((previous) => [...previous, {
        id: `err_${Date.now()}`,
        role: "assistant",
        content: errorContent,
        retryClarification: { assistantMessageId, answers },
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  function closeHistoryPanel() {
    setHistoryOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.has("history")) {
      url.searchParams.delete("history");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }

  async function handleOpenConversation(id: string, targetJobId?: string) {
    if (!user || loading || conversationLoading) return;
    const sequence = ++conversationLoadSequence.current;
    setConversationLoading(true);
    closeHistoryPanel();
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

      const savedQuoteIds = Array.from(new Set(documents
        .map((document) => document.quote?.quoteId || document.quote?.id)
        .filter((quoteId): quoteId is string => typeof quoteId === "string" && quoteId.length > 0)));
      const quoteStatusById = new Map<string, string>();
      if (savedQuoteIds.length > 0) {
        const { data: savedQuoteStatuses, error: quoteStatusError } = await supabase
          .from("plans_quotes")
          .select("id, status")
          .eq("user_id", user.id)
          .in("id", savedQuoteIds);
        if (!quoteStatusError) {
          for (const savedQuote of savedQuoteStatuses || []) {
            if (typeof savedQuote.id === "string" && typeof savedQuote.status === "string") {
              quoteStatusById.set(savedQuote.id, savedQuote.status);
            }
          }
        }
      }
      if (sequence !== conversationLoadSequence.current) return;

      const restoredMessages: MessageItem[] = documents
        .filter((document) => (document.role === "user" || document.role === "assistant") && document.status !== "thinking")
        .map((document) => {
          const savedQuote = document.quote;
          const quoteId = savedQuote?.quoteId || savedQuote?.id;
          return {
            id: document.id || document.$id,
            role: document.role as "user" | "assistant",
            content: String(document.content_ar || document.content || "").slice(0, 20000),
            clarificationItems: document.clarification_items,
            planQuote: savedQuote
              ? { ...savedQuote, status: quoteStatusById.get(quoteId) || "unknown" }
              : null,
            createdAt: String(document.created_at || document.createdAt || new Date().toISOString()),
          };
        });
      for (let index = 0; index < restoredMessages.length; index += 1) {
        const answers = parsePersistedClarificationAnswers(restoredMessages[index].content);
        if (!answers) continue;
        // Card submissions are stored as structured JSON. Keep the serialized payload out of chat.
        restoredMessages[index].hidden = true;
        restoredMessages[index].content = answers
          .map((answer) => `${answer.question}: ${Array.isArray(answer.value) ? answer.value.join("، ") : answer.value || "سيُطلب منك الاختيار"}`)
          .join(" · ");
        for (let previous = index - 1; previous >= 0; previous -= 1) {
          const message = restoredMessages[previous];
          if (message.role === "assistant" && message.clarificationItems) {
            message.completedClarificationAnswers = answers;
            break;
          }
        }
      }
      setMessages(restoredMessages);

      // Restore the run (progress / files) of the conversation's accepted quote or active job
      let quoteJobId = targetJobId;
      let quoteTargetMax: number | undefined;
      let quoteTemplateSlug: string | undefined;

      // 1. Look for quote in loaded messages
      if (!quoteJobId) {
        for (const doc of documents) {
          const qId = doc.quote?.quoteId || doc.quote?.id;
          if (qId) {
            quoteJobId = getJobIdForQuote(qId);
            quoteTargetMax = doc.quote?.targetVolumeMax;
            quoteTemplateSlug = doc.quote?.items?.[0]?.capabilitySlug;
            break;
          }
          if (doc.payload?.jobId || doc.jobId) {
            quoteJobId = doc.payload?.jobId || doc.jobId;
            break;
          }
        }
      }

      // 2. Fallback: check recent queued or running job for this user
      if (!quoteJobId) {
        const { data: recentJobs } = await supabase
          .from("jobs")
          .select("id, status")
          .eq("user_id", user.id)
          .in("status", ["queued", "running"])
          .order("created_at", orderDesc)
          .limit(1);
        if (recentJobs && recentJobs[0]?.id) {
          quoteJobId = recentJobs[0].id;
        }
      }

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
        if (jobDoc && sequence === conversationLoadSequence.current) {
          const jId = jobDoc.id || jobDoc.$id;
          setActiveJob({
            jobId: jId,
            status: toChatJobStatus(jobDoc.status),
            templateSlug: quoteTemplateSlug || jobDoc.endpoint_id || jobDoc.template_slug || jobDoc.templateSlug || "tiktok-profile",
            rowsCollected: jobDoc.delivered_units ?? jobDoc.rows_collected ?? jobDoc.rowsCollected ?? 0,
            chargedCredits: jobDoc.charged_credits ?? jobDoc.chargedCredits,
            reservedCredits: jobDoc.reserved_credits ?? jobDoc.reservedCredits,
            errorAr: jobDoc.error_message ?? jobDoc.error_ar ?? jobDoc.errorAr,
            requestedRows: quoteTargetMax ?? jobDoc.target_volume_max ?? undefined,
            events: dedupeAndSortChronological(mapJobEvents(eventsRes.data)),
          });
          if (jobDoc.status === "completed" || jobDoc.status === "done") await loadJobResults(jId);
          const savedCanvasOpen = (() => {
            try { return sessionStorage.getItem("diger_canvas_open") === "1"; } catch { return false; }
          })();
          if (targetJobId || jobDoc.status === "running" || jobDoc.status === "queued" || savedCanvasOpen) {
            setCanvasOpen(true);
          }
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
    setCanvasOpen(false);
    setHistoryOpen(false);
    try {
      sessionStorage.removeItem("diger_active_job_id");
      sessionStorage.removeItem("diger_canvas_open");
    } catch {}
  }

  // Save Direct Plan Edits
  async function handleSaveDirectEdit(
    currentQuote: PlanQuoteData,
    newLimit: number,
    newParam: string,
    newFormats: string[],
    newCountry?: string,
    newIndustry?: string
  ) {
    const primaryItem = currentQuote.items?.[0] || { capabilitySlug: "company-research", params: {} };
    const slug = primaryItem.capabilitySlug;

    const operations: any[] = [
      { action: "set_limit", capabilitySlug: slug, targetVolumeMax: Math.max(1, Number(newLimit) || 1) },
      { action: "set_formats", formats: newFormats },
    ];

    const cleanVal = typeof newParam === "string" ? newParam.trim() : "";
    const isProfile = slug.includes("profile") || slug.includes("user");
    const isCompany = slug.includes("companies") || slug.includes("company") || slug.includes("b2b");
    if (isCompany) {
      const params = (primaryItem.params || {}) as Record<string, unknown>;
      operations.push(...buildCompanyPlanEditOperations(slug, cleanVal, newCountry || "", newIndustry || "", {
        keyword: extractParamDisplayString(params, currentQuote.summaryAr, false),
        country: typeof params.country === "string" ? params.country : typeof params.location === "string" ? params.location : "",
        industry: typeof params.industry === "string" ? params.industry : "",
      }));
    } else if (cleanVal && cleanVal !== "[object Object]") {
      const isPostOrUrl = slug.includes("post") || slug.includes("comment") || slug.includes("video");

      if (isProfile) {
        operations.push({
          action: "set_param",
          capabilitySlug: slug,
          key: "username",
          value: cleanVal.replace(/^@/, "").trim(),
        });
      } else if (isPostOrUrl && (cleanVal.startsWith("http://") || cleanVal.startsWith("https://"))) {
        const urlKey = slug.includes("youtube") ? "videoUrl" : slug.includes("reddit") ? "postUrl" : "url";
        operations.push({
          action: "set_param",
          capabilitySlug: slug,
          key: urlKey,
          value: cleanVal,
        });
      } else {
        const paramKey = primaryItem.params && "keyword" in primaryItem.params ? "keyword" : "query";
        operations.push({
          action: "set_param",
          capabilitySlug: slug,
          key: paramKey,
          value: cleanVal,
        });
      }
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

    const updatedQuote: PlanQuoteData = data.planQuote || data.quote;
    if (!updatedQuote) {
      throw new Error("لم يتم استلام تفاصيل عرض السعر المحدث.");
    }

    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.planQuote?.quoteId === currentQuote.quoteId) {
          return {
            ...msg,
            content: `تم تعديل تفاصيل الخطة وتحديث عرض السعر:\n• السجلات المعتمدة: حتى ${updatedQuote.targetVolumeMax} سجل\n• التكلفة الإجمالية: ${updatedQuote.quotedPoints} نقطة`,
            planQuote: updatedQuote,
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
        status: data.workerDispatch?.started ? "running" : "queued",
        templateSlug: quote.items?.[0]?.capabilitySlug || "tiktok-profile",
        rowsCollected: 0,
        reservedCredits: data.reservedCredits,
        requestedRows: quote.targetVolumeMax,
        events: [
          {
            $id: `init_${Date.now()}`,
            textAr: "تم قبول الطلب وجاري بدء التنفيذ...",
            kind: "info",
            createdAt: new Date().toISOString(),
          },
        ],
      });
      setCanvasOpen(true);

      setMessages((prev) => [
        ...prev,
        {
          id: `start_${Date.now()}`,
          role: "assistant",
          content: `${data.messageAr || "تم قبول الطلب."} تم حجز ${data.reservedCredits} نقطة. يمكنك متابعة التنفيذ في سجل النشاط ولوحة النتائج.`,
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
      let blobUrl: string | null = null;
      try {
        const fileRes = await fetch(payload.signedUrl);
        if (fileRes.ok) {
          blobUrl = URL.createObjectURL(await fileRes.blob());
        }
      } catch {
        // Fall back to direct signed URL navigation
      }

      if (blobUrl) {
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = payload.downloadFileName || `diger_${activeJob.templateSlug}_${activeJob.jobId.slice(0, 8)}.${ext}`;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => { URL.revokeObjectURL(blobUrl!); link.remove(); }, 30000);
      } else {
        window.location.assign(payload.signedUrl);
      }
    } catch (err: any) {
      console.error("[chat:download_error]", err);
    } finally {
      setDownloadingKey(null);
    }
  }

  async function submitArtifactAction(action: { operation: ArtifactEditOperation } | { undoToVersionId: string }) {
    if (!activeJob?.jobId || artifactEditing || !user) return;
    const targetJobId = activeJob.jobId;
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
      } : {
        jobId: targetJobId,
        status: "done",
        templateSlug: "research-deliverable",
        rowsCollected: result.version.rowCount,
        events: [],
        artifactVersion: result.version,
        fileIds: result.version.fileIds,
        versionHistory: [{
          id: result.version.id,
          versionNum: result.version.versionNum,
          parentVersionId: null,
          rowCount: result.version.rowCount,
          isOriginal: false,
        }],
      });

      const dataResponse = await fetch(`/api/jobs/${targetJobId}/data`);
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

      const historyResponse = await fetch(`/api/jobs/${targetJobId}/artifacts`);
      const history = await historyResponse.json();
      if (history.success) setActiveJob((previous) => previous ? {
        ...previous,
        versionHistory: history.versions || [],
        artifactHistoryAvailable: history.historyAvailable,
      } : null);
      setMessages((previous) => [...previous, {
        id: `artifact_v${result.version.versionNum}_${Date.now()}`,
        role: "assistant",
        content: `اتحفظ التعديل كنسخة رقم ${result.version.versionNum} من النتيجة (تكلفة التعديل: ١٠ نقاط). تقدر ترجع لأي نسخة أقدم في أي وقت.`,
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

  async function handleApplyRevisionQuote(revQuote: RevisionQuoteData) {
    const targetJobId = revQuote.jobId && revQuote.jobId !== "current" ? revQuote.jobId : activeJob?.jobId;
    if (!targetJobId) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err_rev_${Date.now()}`,
          role: "assistant",
          content: "لم يتم العثور على مهمة مكتملة لتعديلها.",
          createdAt: new Date().toISOString(),
        },
      ]);
      return;
    }
    if (!activeJob) {
      setActiveJob({
        jobId: targetJobId,
        status: "done",
        templateSlug: "research-deliverable",
        rowsCollected: 0,
        events: [],
      });
    }
    await submitArtifactAction({ operation: revQuote.operation });
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
        setMessages((prev) => [
          ...prev,
          {
            id: `err_meth_${Date.now()}`,
            role: "assistant",
            content: data.error || "فشل توليد التوثيق المنهجي.",
            createdAt: new Date().toISOString(),
          },
        ]);
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
      const _alertMsg = methodologyAlertText(data.chargedPoints);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err_meth_${Date.now()}`,
          role: "assistant",
          content: "تعذر طلب صياغة المنهجية حالياً. يرجى المحاولة لاحقاً.",
          createdAt: new Date().toISOString(),
        },
      ]);
    }
  }

  function handleExplainMethodology() {
    const source = extractedProfile?.sourcePlatform ? String(extractedProfile.sourcePlatform) : "المصدر المحدد في الخطة";
    const collectedAt = extractedProfile?.collectedDate || "وقت إتمام الطلب";
    const methodology = typeof extractedProfile?.methodology === "string" && extractedProfile.methodology.trim()
      ? extractedProfile.methodology.trim()
      : "جُمعت الحقول التي أعادها المصدر، وطُبّعت أسماءها، مع إبقاء القيم غير المتاحة فارغة دون استنتاجها.";
    setMessages((previous) => [...previous, {
      id: `method_explain_${Date.now()}`,
      role: "assistant",
      content: `طريقة جمع البيانات\nالمصدر: ${source}\nتاريخ الجمع: ${collectedAt}\n\n${methodology}`,
      createdAt: new Date().toISOString(),
    }]);
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

  const sendRef = useRef<(text: string) => Promise<boolean>>(async () => false);
  sendRef.current = handleSendMessage;

  // Deep link from «طلباتي» / the wallet return: /dashboard/chat?c=<conversationId>&jobId=<jobId>
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (!user || deepLinkHandled.current) return;
    const search = new URLSearchParams(window.location.search);
    const convId = search.get("c");
    const retry = search.get("retry") === "1";
    let jobId = search.get("jobId");
    if (!jobId && convId && typeof window !== "undefined") {
      try {
        jobId = sessionStorage.getItem("diger_active_job_id");
      } catch {}
    }
    const shouldOpenCanvas = (() => {
      try {
        return sessionStorage.getItem("diger_canvas_open") === "1";
      } catch {
        return false;
      }
    })();

    if (!convId && !jobId) return;
    deepLinkHandled.current = true;

    if (convId && /^[A-Za-z0-9_-]{1,64}$/.test(convId)) {
      void handleOpenConversation(convId, jobId || undefined).then(() => {
        if (retry) setTimeout(() => void sendRef.current("أعد المحاولة بنفس الخطة. اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ."), 350);
      });
    } else if (jobId) {
      // Direct job link without conversation ID in query param
      void (async () => {
        try {
          const supabase = createClient();
          const [jobRes, eventsRes, msgRes] = await Promise.all([
            supabase.from("jobs").select("*").eq("id", jobId).maybeSingle(),
            supabase.from("job_events").select("*").eq("job_id", jobId).order("created_at", orderDesc).limit(EVENT_HISTORY_LIMIT),
            supabase.from("messages").select("conversation_id, quote").eq("user_id", user.id).not("quote", "is", null).order("created_at", orderDesc).limit(50),
          ]);
          const jobDoc: any = jobRes.data;
          if (jobDoc) {
            const jId = jobDoc.id || jobDoc.$id;
            setActiveJob({
              jobId: jId,
              status: toChatJobStatus(jobDoc.status),
              templateSlug: jobDoc.endpoint_id || jobDoc.template_slug || jobDoc.templateSlug || "tiktok-profile",
              rowsCollected: jobDoc.delivered_units ?? jobDoc.rows_collected ?? jobDoc.rowsCollected ?? 0,
              chargedCredits: jobDoc.charged_credits ?? jobDoc.chargedCredits,
              reservedCredits: jobDoc.reserved_credits ?? jobDoc.reservedCredits,
              errorAr: jobDoc.error_message ?? jobDoc.error_ar ?? jobDoc.errorAr,
              requestedRows: jobDoc.target_volume_max ?? undefined,
              events: dedupeAndSortChronological(mapJobEvents(eventsRes.data)),
            });
            if (jobDoc.status === "completed" || jobDoc.status === "done") await loadJobResults(jId);
            if (shouldOpenCanvas || search.get("jobId") || jobDoc.status === "running" || jobDoc.status === "queued") {
              setCanvasOpen(true);
            }

            // If we can find the matching conversation from messages, open it too!
            for (const m of (msgRes.data || []) as any[]) {
              const qId = m.quote?.quoteId || m.quote?.id;
              if (qId && getJobIdForQuote(qId) === jobId && m.conversation_id) {
                void handleOpenConversation(m.conversation_id, jobId);
                break;
              }
            }
          }
        } catch (err) {
          console.warn("Failed to load direct job link:", err);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  /* ── derived document state ───────────────────────────────────────── */
  const isClarification = (m: MessageItem) =>
    m.outputType === "ask_clarification" ||
    (Array.isArray(m.clarificationItems) ? m.clarificationItems.length > 0 : !!m.clarificationItems) ||
    (Array.isArray(m.clarificationQuestions) ? m.clarificationQuestions.length > 0 : !!m.clarificationQuestions);
  const isResearchActive = Boolean(
    activeJob ||
    messages.some((m) => m.planQuote || Boolean(m.jobId))
  );
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  const question = customerFacingConversationTitle(conversationTitle || (firstUserIdx >= 0 ? messages[firstUserIdx].content : ""));
  const startIdx = messages.findIndex((m) => !!m.jobId);
  const lastPlanIdx = messages.reduce((acc, m, i) => (m.planQuote ? i : acc), -1);
  const lastClarIdx = messages.reduce((acc, m, i) => (isClarification(m) ? i : acc), -1);
  const jobFinished = Boolean(activeJob && isTerminalJobStatus(activeJob.status) && activeJob.status !== "failed");
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
      return (
        <div key={m.id} className="mb-0 mt-3 flex w-fit max-w-full flex-col gap-1.5" style={{ animation: "up .3s both" }}>
          {m.content && (
            <p className="mb-0 w-fit max-w-full rounded-[18px] bg-sf2 px-4 py-2.5 text-sm font-light leading-[1.8] text-ink">
              {m.content}
            </p>
          )}
          {m.attachment && (
            <div className="flex w-fit items-center gap-2 rounded-full border border-ac/25 bg-ac/5 px-3 py-1 text-xs text-ink font-light">
              <svg className="h-3.5 w-3.5 text-ac" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
              <span className="font-medium">{m.attachment.name}</span>
              <span className="text-[11px] text-mut">({Math.round(m.attachment.size / 1024)} ك.ب)</span>
            </div>
          )}
        </div>
      );
    }
    if (isClarification(m)) {
      return (
        <div key={m.id}>
          <DetailsBlanks
            questions={m.clarificationItems || m.clarificationQuestions || []}
            intro={m.clarificationIntro ? customerFacingAssistantCopy(m.clarificationIntro) : undefined}
            completedAnswers={m.completedClarificationAnswers}
            disabled={loading}
            onComplete={(answers) => handleSubmitClarification(m.id, answers)}
          />
        </div>
      );
    }
    return (
      <div key={m.id}>
        {m.content && <p className="mb-0 mt-3 whitespace-pre-wrap text-[15px] font-light leading-[2] text-ink" style={{ animation: "up .3s both" }}>{customerFacingAssistantCopy(m.content)}</p>}
        {m.revisionQuote && (
          <RevisionQuoteCard
            quote={m.revisionQuote}
            onApply={handleApplyRevisionQuote}
            isApplying={artifactEditing}
            userBalance={balanceValue}
          />
        )}
        {m.errorRetryPrompt && (
          <button
            type="button" onClick={() => handleSendMessage(m.errorRetryPrompt!)}
            className="mt-2 min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink focus-visible:outline-2"
          >
            إعادة المحاولة الآن
          </button>
        )}
        {m.retryClarification && (
          <button
            type="button"
            onClick={() => handleSubmitClarification(m.retryClarification!.assistantMessageId, m.retryClarification!.answers)}
            className="mt-2 min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink focus-visible:outline-2"
          >
            إعادة إرسال الإجابات الآن
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
                  intro={m.clarificationIntro ? customerFacingAssistantCopy(m.clarificationIntro) : undefined}
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
      <div className="space-y-3">
        <ActivityTimeline
          status={activeJob.status}
          events={activeJob.events}
          rowsCollected={activeJob.rowsCollected}
          eventLimit={EVENT_HISTORY_LIMIT}
          spentPoints={activeJob.chargedCredits}
          reservedPoints={activeJob.reservedCredits}
          requestedRows={activeJob.requestedRows}
        />
        {!canvasOpen && (
          <div className="flex justify-start">
            <button
              type="button"
              onClick={() => setCanvasOpen(true)}
              className="flex items-center gap-2 rounded-full border border-ln2 bg-sf px-4 py-2 text-xs font-semibold text-ink hover:bg-sf2 transition-colors cursor-pointer"
            >
              <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>عرض لوحة النشاط والتنفيذ</span>
            </button>
          </div>
        )}
      </div>
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
      {historyOpen && (
        <>
          <button type="button" aria-label="إغلاق سجل المحادثات" onClick={closeHistoryPanel} className="fixed inset-0 z-[44] cursor-default border-0 bg-black/30" />
          <aside role="dialog" aria-label="سجل المحادثات" className="fixed inset-y-0 left-0 z-[45] flex w-[min(90vw,380px)] flex-col border-r border-ln bg-sf shadow-2xl" dir="rtl">
            <div className="flex min-h-16 items-center justify-between border-b border-ln px-4">
              <h2 className="m-0 text-base font-semibold text-ink">سجل المحادثات</h2>
              <button type="button" aria-label="إغلاق" onClick={closeHistoryPanel} className="h-10 w-10 cursor-pointer rounded-full border-0 bg-transparent text-lg text-mut hover:bg-sf2">×</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {conversationsLoading ? (
                <div role="status" aria-label="جاري تحميل المحادثات" className="space-y-2 p-3">
                  {[0, 1, 2].map((item) => <div key={item} className="h-14 animate-pulse rounded-xl bg-sf2" />)}
                </div>
              ) : conversationsList.length === 0 ? (
                <p className="m-0 px-3 py-8 text-center text-sm text-mut">لا توجد محادثات محفوظة بعد.</p>
              ) : conversationsList.map((item) => (
                <button
                  key={item.$id}
                  type="button"
                  onClick={() => void handleOpenConversation(item.$id)}
                  className={`mb-1 flex min-h-14 w-full cursor-pointer flex-col items-start justify-center rounded-xl border-0 px-3 text-right hover:bg-sf2 ${conversationId === item.$id ? "bg-sf2" : "bg-transparent"}`}
                >
                  <span className="w-full truncate text-sm font-medium text-ink">{customerFacingConversationTitle(item.title)}</span>
                  <span className="mt-1 text-[11px] text-fnt">{dayLabel(item.updatedAt)}</span>
                </button>
              ))}
            </div>
          </aside>
        </>
      )}
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
          {!user && (
            <div
              role="status"
              className="mx-auto mb-4 flex w-full max-w-[680px] items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-sf2 px-4 py-2.5 text-xs text-ink"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                <span>
                  وضع الزائر: متبقي لك {formatAr(guestRemaining ?? 3)} رسائل مجانية. تُحفظ محادثتك وتُنقل لحسابك تلقائياً عند التسجيل.
                </span>
              </div>
              <a
                href="/register"
                className="shrink-0 rounded-full bg-ac px-3 py-1 font-semibold text-onac text-xs hover:opacity-90 transition-opacity no-underline"
              >
                إنشاء حساب مجاني
              </a>
            </div>
          )}
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
              onStart={(prompt) => {
                setInputText(prompt);
                setTimeout(() => {
                  const input = document.getElementById("chat-composer-input") || document.querySelector('input[aria-label="اسأل ديجر"]');
                  if (input instanceof HTMLInputElement) {
                    input.focus();
                  }
                }, 50);
              }}
            />
          )}

          {!chatEmpty && !conversationLoading && messages.length > 0 && (
            isResearchActive ? (
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
            ) : (
              <div className="mx-auto w-full max-w-[680px] space-y-3 py-4">
                {messages.map((m) => renderNote(m))}
                {loading && (
                  <p role="status" className="mb-0 mt-4 text-[15px] font-light text-mut" style={{ animation: "breathe 1.4s infinite" }}>
                    {loadingStatusText}
                  </p>
                )}
              </div>
            )
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
              jobStatus={activeJob?.status}
              jobEvents={activeJob?.events}
              rowsCollected={activeJob?.rowsCollected}
              requestedRows={activeJob?.requestedRows}
              reservedPoints={activeJob?.reservedCredits}
              chargedPoints={activeJob?.chargedCredits}
              errorAr={activeJob?.errorAr}
              onDownload={handleDownload}
              downloadingKey={downloadingKey}
              onExplainMethodology={handleExplainMethodology}
              onRequestDocxMethodology={handleGenerateMethodology}
              onCloseMobile={() => setCanvasOpen(false)}
              onClose={() => setCanvasOpen(false)}
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
