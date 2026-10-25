"use client";

import { pointsAr } from "@/lib/pointsFormat";
import { persistedFileShape } from "@/lib/fileShapeMessage";
import { pickRestoredJobId } from "@/lib/jobs/restoredJob";
import ReportProblemButton from "@/components/ReportProblemButton";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { useBalance } from "@/hooks/useBalance";
import { topupContinuationMessageAr } from "@/lib/lowBalance";
import { estimateFromSample, explorationResultMessageAr } from "@/lib/exploration";
import { approximateTotalPoints, remainingUnits, sampleRestMessageAr } from "@/lib/sampleFirst";
import { chunkMarksFromEvents, computeJobProgress } from "@/lib/jobProgress";
import { STALLED_LINE_AR, isJobStalled } from "@/lib/jobStall";
import type { LivePreviewSample } from "@/lib/liveJobView";
import { encodeFileSpec, type FileSpec } from "@/lib/fileSpec";
import { useCreditValue } from "@/hooks/useCreditValue";
import { useLlmEnabled } from "@/hooks/useLlmEnabled";
import { getPersonaConfig, PersonaType } from "@/functions/shared/personaConfigs";
import { chronological, EVENT_HISTORY_LIMIT, formatNumber, methodologyMessageText } from "@/lib/honestDisplay";
import { RETRY_SAME_PLAN_MESSAGE, REVIEW_PLAN_MESSAGE, customerFacingMessageText } from "@/lib/retryMessage";
import { openJobHref } from "@/lib/requestLinks";
import { PARTIAL_SENTENCE_AR } from "@/lib/jobs/requestStatus";
import { isUntitledConversation, titleFromFirstRequest } from "@/lib/conversationTitleFromRequest";
import { postApprovalMessageAr } from "@/lib/postApproval";
import { closePageLineAr } from "@/lib/driverMode";
import { useDriverMode } from "@/hooks/useDriverMode";
import { nextPollDelayMs } from "@/lib/pollSchedule";
import { getSlowFactor } from "@/lib/degradedClient";
import BusyBanner from "@/components/BusyBanner";
import { usePendingPromo } from "@/hooks/usePendingPromo";
import { formatAr } from "@/lib/arabicDigits";
import { countPlainAr, planCountLineAr } from "@/lib/planCounts";
import { dayLabel } from "@/lib/dayLabel";
import { clearPendingQuestion, readPendingQuestion } from "@/lib/pendingQuestion";
import { parsePersistedClarificationAnswers, type DiscoveryAnswer } from "./components/discoveryQuestions";
import type { ReviewSeverity, ReviewSuggestion, ResultReview } from "@/functions/shared/resultReview";
import type { ArtifactEditOperation } from "@/functions/shared/artifactEditing";

import OnboardingModal from "./components/OnboardingModal";
import { useShell } from "@/components/app/AppShell";
import DetailsBlanks from "./components/DetailsBlanks";
import PlanQuoteCard, { PlanQuoteData } from "./components/PlanQuoteCard";
import { PLAN_READY_DESKTOP_AR, PLAN_READY_MOBILE_AR } from "@/lib/consultantCopy";
import { buildCompanyPlanEditOperations, buildGenericCountryEditOperations, buildPeoplePlanEditOperations, planCountryParamKeys } from "@/lib/companyPlanEdits";
import { extractParamDisplayString } from "@/lib/planParameters";
import { customerFacingAssistantCopy } from "@/lib/customerFacingAssistantCopy";
import { customerFacingConversationTitle } from "@/lib/customerFacingConversationTitle";
import { buildChatTimeline } from "@/lib/chatTimeline";
import { type TerminalEvent as JobEvent } from "./components/ActivityTerminal";
import RunningIndicator from "./components/RunningIndicator";
import ResultsCanvas, { ExtractedRecord } from "./components/ResultsCanvas";
import EmptyChat from "./components/EmptyChat";
import { FilesSection } from "./components/RunSections";
import Composer, { AttachedFile } from "./components/Composer";
import { getJobIdForQuote } from "@/lib/md5";
import { getQuoteApprovalState, shouldShowPlanPanel } from "@/lib/quoteApprovalState";
import { isTerminalJobStatus, toChatJobStatus } from "@/lib/jobs/status";
import { shouldShowProgressNotice, applyJobRow } from "@/lib/jobs/progressNotice";
import { isCustomerVisibleJobEvent } from "@/lib/reviewCostEvent";
import { findUnresolvedResearchPlaceholder, unresolvedResearchPlaceholderMessageAr } from "@/lib/researchPlaceholders";
import { TURN_TIMEOUT_MS, WAIT_CANCEL_AFTER_MS, waitProgressText } from "@/lib/waitProgress";
import { customerFacingFailure, logClientFailure, readChatResponse, startFailureMessageAr, TEMPORARY_FAILURE_AR } from "@/lib/customerError";
import { startFailureText, type StartedJobState } from "@/lib/startFailure";

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
    // The owner's review-spend rows are internal: never part of the customer's activity list.
    if (!isCustomerVisibleJobEvent(e.event_type)) continue;
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
  /** After a delivered sample: the offer to quote the rest (a new quote on the remaining volume, without the sample's rows). */
  sampleRest?: { sampleQuoteId: string; fullVolume: number };
  /** A validated file spec for the result on screen («شيت لكل محافظة»): becomes a download of the shaped file. */
  fileShape?: { spec: Record<string, unknown>; descriptionAr: string; jobId?: string };
  clarificationQuestions?: string[];
  clarificationItems?: unknown;
  clarificationIntro?: string;
  completedClarificationAnswers?: DiscoveryAnswer[];
  suggestedAlternative?: any;
  refusalReason?: string;
  jobId?: string;
  /** The in-progress notice: shown only while the job it belongs to is still running. */
  progressNotice?: boolean;
  /** Internal turns (clarification-answer summaries) are shown through the details sentence instead. */
  hidden?: boolean;
  errorRetryPrompt?: string;
  retryClarification?: { assistantMessageId: string; answers: DiscoveryAnswer[] };
  createdAt: string;
}

interface ActiveJobState {
  jobId: string;
  updatedAt?: string;
  /** From the jobs row: what the progress line and the stalled line read (timestamps and a count). */
  startedAt?: string;
  leaseUntil?: string | null;
  nextAttemptAt?: string | null;
  attemptCount?: number;
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
  /** A missing id means that format was not produced for this job. */
  fileIds?: { xlsx?: string | null; pdf?: string | null; csv?: string | null } | null;
  versionHistory?: Array<{ id: string; versionNum: number; parentVersionId?: string | null; rowCount: number; isOriginal: boolean }>;
  artifactHistoryAvailable?: boolean;
  /** Real columns of the saved result (for «شيت لكل …» file shaping). */
  resultColumns?: Array<{ key: string; titleAr: string }>;
}

export default function ChatWorkspacePage() {
  const { user, refresh } = useUser();
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStatusText, setLoadingStatusText] = useState("يكتب الرد...");
  const loadingBaseText = useRef("يكتب الرد...");
  // The request of the turn on screen: «إيقاف الانتظار» aborts it, and the failure message then carries the retry.
  const turnAbort = useRef<AbortController | null>(null);
  // Jobs whose final balance was read again after the settlement (one extra read per job).
  const balanceSettledFor = useRef<Set<string>>(new Set());
  const [canStopWaiting, setCanStopWaiting] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("");
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationLoadError, setConversationLoadError] = useState(false);
  const [userPersona, setUserPersona] = useState<PersonaType>("researcher");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [conversationsList, setConversationsList] = useState<ConversationItem[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  // A few accepted rows of the running request, for the activity panel; kept with the job they belong to so another job never shows them.
  const [livePreview, setLivePreview] = useState<{ jobId: string; sample: LivePreviewSample | null } | null>(null);
  const [methodologyConfirmOpen, setMethodologyConfirmOpen] = useState(false);
  const [methodologyPurchasing, setMethodologyPurchasing] = useState(false);
  // Which jobs' methodology file is already bought, read from the ledger row `chg_meth_<jobId>` (survives reload, device and conversation).
  const [methodologyBoughtJobs, setMethodologyBoughtJobs] = useState<Record<string, boolean>>({});
  const [guestRemaining, setGuestRemaining] = useState<number | null>(null);

  // Active Job & Canvas Data
  const [startingQuoteId, setStartingQuoteId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ActiveJobState | null>(null);
  const driverMode = useDriverMode();
  const methodologyPurchased = Boolean(activeJob?.jobId && methodologyBoughtJobs[activeJob.jobId]);
  // Read the purchase from the ledger once a finished job is open, so the files area shows the download button after a reload.
  const methodologyCheckJobId = activeJob?.jobId && ["done", "completed"].includes(String(activeJob.status)) ? activeJob.jobId : null;
  // A turn that takes a while keeps saying that the work goes on (never a silent, frozen-looking page).
  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    setCanStopWaiting(false);
    const timer = setInterval(() => {
      setLoadingStatusText(waitProgressText(loadingBaseText.current, Date.now() - startedAt));
      setCanStopWaiting(Date.now() - startedAt >= WAIT_CANCEL_AFTER_MS);
    }, 2000);
    return () => { clearInterval(timer); setCanStopWaiting(false); };
  }, [loading]);
  useEffect(() => {
    if (!methodologyCheckJobId || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const jwtToken = await getAccessToken();
        const res = await fetch(`/api/jobs/${methodologyCheckJobId}/methodology`, { headers: jwtToken ? { Authorization: `Bearer ${jwtToken}` } : {} });
        const data = await res.json();
        if (!cancelled && data?.success && data.purchased) setMethodologyBoughtJobs((prev) => ({ ...prev, [methodologyCheckJobId]: true }));
      } catch {
        // Unknown: the button keeps its purchase wording; the server never charges a job twice.
      }
    })();
    return () => { cancelled = true; };
  }, [methodologyCheckJobId, user]);
  const activeJobRef = useRef<ActiveJobState | null>(null);
  activeJobRef.current = activeJob;
  const [terminalJobs, setTerminalJobs] = useState<Map<string, boolean>>(() => new Map());
  const markJobTerminal = (jId: string) => {
    setTerminalJobs((prev) => (prev.has(jId) ? prev : new Map(prev).set(jId, true)));
  };
  const [extractedRecords, setExtractedRecords] = useState<ExtractedRecord[]>([]);
  const [extractedProfile, setExtractedProfile] = useState<any>(null);
  const loadedResultJobs = useRef(new Set<string>());
  // The job currently on screen. Network replies for any other job (for example one started before «سؤال بحثي جديد») are dropped.
  const activeJobIdRef = useRef<string | null>(null);
  activeJobIdRef.current = activeJob?.jobId ?? null;
  async function isStillActiveJob(jobId: string): Promise<boolean> {
    if (activeJobIdRef.current === jobId) return true;
    // Opening a finished file sets the job and loads its rows in the same tick; give the state one frame to settle.
    await new Promise((resolve) => setTimeout(resolve, 60));
    return activeJobIdRef.current === jobId;
  }
  const lastNudgeAt = useRef(new Map<string, number>());
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [artifactEditing, setArtifactEditing] = useState(false);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationLoadSequence = useRef(0);
  const sendInFlight = useRef(false);

  // A new plan opens the panel (a bottom sheet on mobile). A plan already in a restored conversation does not: the
  // «افتح الخطة» button under it does. The first settled render only records which plan is already there.
  const announcedPlanId = useRef<string | null | undefined>(undefined);
  const latestPlanId = [...messages].reverse().find((m) => m.planQuote)?.planQuote?.quoteId ?? null;
  useEffect(() => {
    if (conversationLoading) {
      announcedPlanId.current = undefined;
      return;
    }
    if (announcedPlanId.current === undefined) {
      announcedPlanId.current = latestPlanId;
      // Coming back to a conversation whose newest plan still waits for approval (and can still be approved): its panel opens by itself. A plan that was
      // approved, expired or replaced does not (the «افتح الخطة» button is still under it).
      const waiting = [...messages].reverse().find((m) => m.planQuote)?.planQuote;
      if (waiting && getQuoteApprovalState(waiting.status, waiting.expiresAt, Date.now()).canApprove && shouldShowPlanPanel({
        latestQuote: { quoteId: waiting.quoteId, status: waiting.status, expiresAt: waiting.expiresAt },
        activeJob: activeJob ? { jobId: activeJob.jobId, status: activeJob.status } : null,
        restPlanQuoteId: null,
        jobIdForQuote: getJobIdForQuote,
      })) setCanvasOpen(true);
      return;
    }
    if (latestPlanId && latestPlanId !== announcedPlanId.current && !activeJob) setCanvasOpen(true);
    announcedPlanId.current = latestPlanId;
  }, [latestPlanId, conversationLoading, activeJob]);

  // Sync canvasOpen and activeJob to sessionStorage for reload persistence
  useEffect(() => {
    try {
      if (canvasOpen) {
        sessionStorage.setItem("diger_canvas_open", "1");
      } else {
        sessionStorage.removeItem("diger_canvas_open");
      }
    } catch {}
    window.dispatchEvent(new CustomEvent("diger:canvas-open", { detail: { open: canvasOpen } }));
  }, [canvasOpen]);

  // 1. Check Profile & Onboarding status
  useEffect(() => {
    async function checkProfile() {
      if (!user) return;
      if (user.user_metadata?.persona) setUserPersona(getPersonaConfig(user.user_metadata.persona).key);
      try {
        const supabase = createClient();
        const { data: prof } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .maybeSingle();
        if (prof) {
          if (!user.user_metadata?.persona && prof.persona) setUserPersona(getPersonaConfig(prof.persona).key);
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
  const { notice: promoNotice, dismiss: dismissPromoNotice } = usePendingPromo(Boolean(user?.emailVerification), () => { void loadBalance(); });
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
      // The first message is read only for a conversation that has no saved title of its own (most have one): the history list must not
      // download every message of twenty conversations on each visit.
      const conversationIds = (rows || [])
        .filter((row) => customerFacingConversationTitle(row.title || "") === "محادثة جديدة")
        .map((row) => row.id)
        .filter(Boolean);
      const firstUserMessages = new Map<string, string>();
      if (conversationIds.length) {
        const { data: messages } = await supabase
          .from("messages")
          .select("conversation_id, content, role, created_at")
          .eq("user_id", user.id)
          .eq("role", "user")
          .in("conversation_id", conversationIds)
          .order("created_at", { ascending: true })
          .limit(200);
        for (const message of messages || []) {
          if (!firstUserMessages.has(message.conversation_id) && typeof message.content === "string") {
            firstUserMessages.set(message.conversation_id, message.content);
          }
        }
      }
      const unique = new Map<string, ConversationItem>();
      for (const d of rows || []) {
        if (!unique.has(d.id)) {
          const savedTitle = customerFacingConversationTitle(d.title || "");
          const firstMessageTitle = customerFacingConversationTitle(firstUserMessages.get(d.id) || "");
          const title = savedTitle !== "محادثة جديدة" ? savedTitle : firstMessageTitle;
          unique.set(d.id, {
            $id: d.id,
            title: title || "محادثة جديدة",
            updatedAt: d.updated_at || new Date().toISOString(),
          });
        }
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
    markJobTerminal(jobId);
    void loadBalance();
    try {
      const [dataRes, versionsRes] = await Promise.all([
        fetch(`/api/jobs/${jobId}/data`),
        fetch(`/api/jobs/${jobId}/artifacts`),
      ]);
      const [dataJson, versionsJson] = await Promise.all([dataRes.json(), versionsRes.json()]);
      if (!(await isStillActiveJob(jobId))) {
        // The customer moved on (new research or another request): do not paint this job's rows into the new screen.
        loadedResultJobs.current.delete(jobId);
        return;
      }
      if (dataJson.success) {
        if (dataJson.profile) setExtractedProfile(dataJson.profile);
        if (dataJson.rows && Array.isArray(dataJson.rows)) setExtractedRecords(dataJson.rows);
        setActiveJob((previous) => previous && previous.jobId === jobId ? {
          ...previous,
          review: dataJson.review || null,
          reviewSeverity: dataJson.runFacts?.severity,
          artifactVersion: dataJson.artifactVersion || null,
          fileIds: dataJson.fileIds,
          resultColumns: Array.isArray(dataJson.columns)
            ? dataJson.columns.map((key: string) => ({ key, titleAr: dataJson.codebook?.find((c: any) => c.field === key)?.titleAr || key })).slice(0, 60)
            : undefined,
          versionHistory: versionsJson.success ? versionsJson.versions : [],
          artifactHistoryAvailable: versionsJson.success && versionsJson.historyAvailable,
        } : previous);
      }
    } catch (fetchErr) {
      console.warn("Failed to fetch real job data:", fetchErr);
    }
  }

  // 5. Poll and subscribe to active job status
  useEffect(() => {
    const jId = activeJob?.jobId;
    if (!jId) {
      return;
    }

    if (isTerminalJobStatus(activeJobRef.current?.status)) {
      markJobTerminal(jId);
      return;
    }

    const supabase = createClient();
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const followStartedAt = Date.now();

    const poll = async () => {
      if (stopped) return;
      if (isTerminalJobStatus(activeJobRef.current?.status)) {
        if (pollTimer) clearTimeout(pollTimer);
        markJobTerminal(jId);
        return;
      }

      try {
        const [jobRes, eventsRes] = await Promise.all([
          supabase.from("jobs").select("*").eq("id", jId).maybeSingle(),
          supabase
            .from("job_events")
            .select("*")
            .eq("job_id", jId)
            .order("created_at", orderDesc)
            .limit(EVENT_HISTORY_LIMIT),
        ]);
        if (stopped) return;
        const jobDoc: any = jobRes.data;
        if (!jobDoc) return;

        const isTerminal = isTerminalJobStatus(jobDoc.status);
        if (isTerminal) {
          markJobTerminal(jId);
          if (pollTimer) clearTimeout(pollTimer);
        }

        setActiveJob((prev) => {
          // A late reply for a job that is no longer the one on screen must not overwrite the current one.
          if (!prev || prev.jobId !== activeJob.jobId) return prev;
          const updated = applyJobRow(prev, jobDoc);
          const nextEvents = eventsRes.data
            ? dedupeAndSortChronological(mapJobEvents(eventsRes.data))
            : prev.events;
          return {
            ...updated,
            events: nextEvents,
          };
        });

        if (isTerminal) {
          void loadBalance();
          // The ledger rows of the settlement (the release of the hold and the charge of what was delivered) can land a moment after the job row
          // turns final, so the first read may still show the balance with the hold taken: ONE more read per job, from the final ledger state.
          if (!balanceSettledFor.current.has(jId)) {
            balanceSettledFor.current.add(jId);
            setTimeout(() => { void loadBalance(); }, 3000);
          }
        }
        if ((jobDoc.status === "completed" || jobDoc.status === "done") && !loadedResultJobs.current.has(jId)) {
          await loadJobResults(jId);
          void loadBalance();
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
          void fetch(`/api/jobs/${jId}/nudge`, { method: "POST" }).catch(() => {});
        }
      } catch (err) {
        console.warn("Polling job status error:", err);
      }
    };

    // Immediate poll on mount / job change
    void poll();

    // Quick while the customer watches the start, slower as the request ages, rare in a hidden tab, always with jitter (stops on terminal).
    const scheduleNext = () => {
      if (stopped) return;
      const delay = nextPollDelayMs({ elapsedMs: Date.now() - followStartedAt, hidden: typeof document !== "undefined" && document.hidden, random: Math.random(), slow: getSlowFactor() });
      pollTimer = setTimeout(async () => { await poll(); if (!stopped && !isTerminalJobStatus(activeJobRef.current?.status)) scheduleNext(); }, delay);
    };
    scheduleNext();

    // Immediate poll on visibilitychange and focus
    const onVisibleOrFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void poll();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibleOrFocus);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onVisibleOrFocus);
    }

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibleOrFocus);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onVisibleOrFocus);
      }
    };
  }, [activeJob?.jobId, loadBalance]);

  // Live preview of the running request: after each new page (the accepted count changes) the panel asks for a few accepted rows. A failed or
  // empty answer leaves the counts-only view; nothing here writes or charges.
  useEffect(() => {
    const jId = activeJob?.jobId;
    const live = activeJob?.status === "running" || activeJob?.status === "queued";
    if (!jId || !live || !canvasOpen) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/jobs/${jId}/preview`);
        const json = await res.json();
        if (!cancelled && json?.success) setLivePreview({ jobId: jId, sample: json.sample ?? null });
      } catch {
        // counts only
      }
    }, 1200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeJob?.jobId, activeJob?.status, activeJob?.rowsCollected, canvasOpen]);

  // Send message
  async function handleSendMessage(messageContent: string, attachedFile?: AttachedFile | null): Promise<boolean> {
    const textToSend = messageContent.trim();
    if ((!textToSend && !attachedFile) || loading || conversationLoading || sendInFlight.current) return false;
    if (findUnresolvedResearchPlaceholder(textToSend)) {
      setMessages((prev) => [...prev, {
        id: `placeholder_${Date.now()}`,
        role: "assistant",
        content: unresolvedResearchPlaceholderMessageAr(),
        createdAt: new Date().toISOString(),
      }]);
      return false;
    }
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
    const baseStatus = isPriceOrPlanRequest ? "أبحث وأحسب السعر..." : (hasPriorResearch ? "يفكّر في سؤالك ويجهّز الخطوة التالية..." : "يكتب الرد...");
    loadingBaseText.current = baseStatus;
    setLoadingStatusText(baseStatus);
    setMessages((prev) => [...prev, userMsg]);
    // Clear as soon as the message is accepted locally. The request may take
    // several seconds; keep the text in the conversation bubble while the
    // controlled composer becomes ready for the next message.
    setInputText("");
    setLoading(true);

    const controller = new AbortController();
    turnAbort.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);

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
          ...(activeJob?.resultColumns?.length ? { resultColumns: activeJob.resultColumns } : {}),
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

      const data = await readChatResponse(res);

      if (data.isGuest) {
        setGuestRemaining(data.remainingGuestMessages ?? 0);
      }

      if (data.conversationId) {
        setConversationId(data.conversationId);
        syncConversationUrl(data.conversationId);
        if (data.conversationTitle) setConversationTitle(customerFacingConversationTitle(data.conversationTitle));
        if (user) loadConversations();
      }

      const assistantMsg: MessageItem = {
        id: data.messageId || `asst_${Date.now()}`,
        role: "assistant",
        content: data.contentAr,
        outputType: data.outputType,
        intent: data.intent,
        planQuote: data.planQuote,
        fileShape: data.fileShape,
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
      const failure = customerFacingFailure(err, { noCharge: true });
      logClientFailure("send", failure.code);
      const errorContent = failure.text;

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
    loadingBaseText.current = "أجهّز الخطوة التالية...";
    setLoadingStatusText(loadingBaseText.current);
    setLoading(true);
    const controller = new AbortController();
    turnAbort.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);

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
          ...(activeJob?.resultColumns?.length ? { resultColumns: activeJob.resultColumns } : {}),
        }),
      });
      const data = await readChatResponse(res);

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
        syncConversationUrl(data.conversationId);
        if (data.conversationTitle) setConversationTitle(customerFacingConversationTitle(data.conversationTitle));
      }
      loadConversations();
    } catch (err: any) {
      const failure = customerFacingFailure(err, { noCharge: true });
      logClientFailure("answers", failure.code);
      const errorContent = failure.text;
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

  function syncConversationUrl(id: string | null, jobId?: string) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("c", id);
    else url.searchParams.delete("c");
    if (jobId) url.searchParams.set("jobId", jobId);
    else url.searchParams.delete("jobId");
    url.searchParams.delete("retry");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function handleOpenConversation(id: string, targetJobId?: string) {
    if (!user || loading || conversationLoading) return;
    const sequence = ++conversationLoadSequence.current;
    setConversationLoading(true);
    closeHistoryPanel();
    syncConversationUrl(id, targetJobId);
    setConversationLoadError(false);
    setConversationId(id);
    let openedTitle = conversationsList.find((item) => item.$id === id)?.title ?? "";
    setConversationTitle(openedTitle);
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
        openedTitle = doc.title || "";
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
            fileShape: persistedFileShape(document.plan),
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

      // An old conversation that never got a title (its first message was a greeting or a card answer) is named after its first real request.
      if (isUntitledConversation(openedTitle)) {
        const derivedTitle = titleFromFirstRequest(restoredMessages);
        if (derivedTitle) {
          setConversationTitle(derivedTitle);
          setConversationsList((previous) => previous.map((item) => (item.$id === id ? { ...item, title: derivedTitle } : item)));
          // Saved best effort so the history list shows it next time; a refusal changes nothing the customer sees.
          void Promise.resolve(createClient().from("conversations").update({ title: derivedTitle }).eq("id", id).eq("user_id", user.id)).catch(() => undefined);
        }
      }

      // Restore only jobs referenced by this conversation. A user can have
      // several chats running at once, so a global "latest job" fallback can
      // attach another conversation's results to this one.
      const relatedJobs: Array<{ jobId: string; quote?: any }> = [];
      let quoteTargetMax: number | undefined;
      let quoteTemplateSlug: string | undefined;
      for (const doc of documents) {
        const quote = doc.quote;
        const qId = quote?.quoteId || quote?.id;
        if (typeof qId === "string" && qId.length > 0) {
          relatedJobs.push({ jobId: getJobIdForQuote(qId), quote });
        }
        const payloadJobId = doc.payload?.jobId || doc.jobId;
        if (typeof payloadJobId === "string" && payloadJobId.length > 0) {
          relatedJobs.push({ jobId: payloadJobId, quote });
        }
      }
      const uniqueRelatedJobs = Array.from(new Map(relatedJobs.map((item) => [item.jobId, item])).values());
      // A plan card that was never approved has no job: the job to show is the latest one that exists.
      const existingJobIds = new Set<string>();
      if (!targetJobId && uniqueRelatedJobs.length > 1) {
        const { data: existingJobs } = await supabase.from("jobs").select("id").in("id", uniqueRelatedJobs.map((item) => item.jobId));
        for (const row of existingJobs || []) if (typeof row?.id === "string") existingJobIds.add(row.id);
      }
      const restoredJobId = pickRestoredJobId(uniqueRelatedJobs.map((item) => item.jobId), existingJobIds, targetJobId);
      const selectedJob = uniqueRelatedJobs.find((item) => item.jobId === restoredJobId);
      const quoteJobId = selectedJob?.jobId;
      if (selectedJob?.quote) {
        quoteTargetMax = selectedJob.quote.targetVolumeMax;
        quoteTemplateSlug = selectedJob.quote.items?.[0]?.capabilitySlug;
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
          if (isTerminalJobStatus(jobDoc.status)) {
            markJobTerminal(jId);
          }
          setActiveJob({
            jobId: jId,
            updatedAt: jobDoc.updated_at ?? undefined,
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
    syncConversationUrl(null);
    try {
      sessionStorage.removeItem("diger_canvas_open");
      sessionStorage.removeItem("diger_active_job_id");
    } catch {}
  }

  // Save Direct Plan Edits
  async function handleSaveDirectEdit(
    currentQuote: PlanQuoteData,
    newLimit: number,
    newParam: string,
    newFormats: string[],
    newCountry?: string,
    newIndustry?: string,
    exploration?: { fullVolume: number; fullQuotedPoints: number },
    pointsCap?: number
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
    } else if (slug.includes("people")) {
      // Decision makers: the country (ISO code) and the job title, each under the parameter the service reads.
      operations.push(...buildPeoplePlanEditOperations(slug, cleanVal, newCountry || ""));
    } else {
      // Any other plan that carries a country or location parameter (a social region filter, a service with its own location): the edited country
      // replaces it, in the form the parameter already uses, whether or not the topic field changed.
      if (newCountry && planCountryParamKeys(primaryItem.params as Record<string, unknown>).length > 0) {
        operations.push(...buildGenericCountryEditOperations(slug, newCountry, primaryItem.params as Record<string, unknown>));
      }
    }
    if (!isCompany && !slug.includes("people") && cleanVal && cleanVal !== "[object Object]") {
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
        ...(exploration ? { exploration } : {}),
        ...(pointsCap && pointsCap > 0 ? { pointsCap } : {}),
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
            content: `تم تعديل تفاصيل الخطة وتحديث عرض السعر:\n• السجلات المعتمدة: ${planCountLineAr(updatedQuote.items, updatedQuote.targetVolumeMax)}\n• التكلفة الإجمالية: ${pointsAr(updatedQuote.quotedPoints)}`,
            planQuote: updatedQuote,
          };
        }
        return msg;
      })
    );
  }

  // «استكشاف أولًا»: swap the plan for a small priced sample of itself, so the full volume is decided with facts.
  async function handleExplore(quote: PlanQuoteData) {
    const offer = quote.explorationOffer;
    if (!offer) return;
    try {
      await handleSaveDirectEdit(
        quote, offer.sampleUnits, "", quote.outputFormats?.length ? quote.outputFormats : ["xlsx"],
        undefined, undefined, { fullVolume: offer.fullUnits, fullQuotedPoints: quote.quotedPoints },
      );
    } catch (err: any) {
      setMessages((prev) => [...prev, { id: `err_explore_${Date.now()}`, role: "assistant", content: customerFacingFailure(err, { fallback: "تعذر تجهيز الاستكشاف. حاول مرة أخرى." }).text, createdAt: new Date().toISOString() }]);
    }
  }

  // Start Job Execution
  /** Whether the job of a quote exists (its reserve is made in the same step, so no job means nothing is held). */
  async function lookupQuoteJobState(quoteId: string): Promise<StartedJobState> {
    const jobId = getJobIdForQuote(quoteId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data, error } = await createClient().from("jobs").select("id").eq("id", jobId).maybeSingle();
        if (error) return "unknown";
        if (data?.id) return "exists";
      } catch {
        return "unknown";
      }
      // The request may still be finishing on the server: look again before saying it did not start.
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return "none";
  }

  async function handleStartExecution(quote: PlanQuoteData) {
    if (startingQuoteId || !user) return;
    setStartingQuoteId(quote.quoteId);

    try {
      let data: any;
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
            explicitApproval: true,
            jwt: jwtToken,
          }),
        });

        data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || "فشل بدء تنفيذ الخطة");
        }
      } catch (err: any) {
        // A dropped answer is not a failed start: the job of the quote is looked up first, and only the truth is said.
        const deliberate = customerFacingFailure(err).text !== TEMPORARY_FAILURE_AR;
        const jobState = deliberate ? "unknown" : await lookupQuoteJobState(quote.quoteId);
        const text = startFailureText({ deliberateText: deliberate ? customerFacingFailure(err).text : null, jobState });
        if (text !== null) {
          setMessages((prev) => [
            ...prev,
            { id: `err_start_${Date.now()}`, role: "assistant", content: text, createdAt: new Date().toISOString() },
          ]);
          return;
        }
        // The request did start; only the answer was lost. It is shown as started, and its real progress comes from its own events.
        data = { success: true, jobId: getJobIdForQuote(quote.quoteId), workerDispatch: { started: true }, reservedCredits: quote.quotedPoints };
      }

      loadBalance();
      if (quote.exploration) explorationByJob.current.set(data.jobId, quote);
      setRestPlanQuoteId(null);

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
          content: postApprovalMessageAr(data.driverMode),
          progressNotice: true,
          jobId: data.jobId,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (err: any) {
      // Only the display of an accepted request can fail here: it is not a failed start, so the balance is not blamed.
      setMessages((prev) => [
        ...prev,
        {
          id: `err_start_${Date.now()}`,
          role: "assistant",
          content: startFailureMessageAr(err),
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setStartingQuoteId(null);
    }
  }

  // Download File Handler
  async function handleDownload(ext: "xlsx" | "pdf" | "csv", spec?: FileSpec, jobIdOverride?: string) {
    const downloadJobId = jobIdOverride || activeJob?.jobId;
    if (!downloadJobId || downloadingKey) return;
    setDownloadingKey(spec ? `${ext}:shaped` : ext);

    try {
      const jwtToken = await getAccessToken();
      const headers: Record<string, string> = {};
      if (jwtToken) headers["Authorization"] = `Bearer ${jwtToken}`;
      const res = await fetch(`/api/jobs/${downloadJobId}/download?format=${ext}${spec ? `&spec=${encodeFileSpec(spec)}` : ""}`, { headers });
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

      // The download route saves a format made on request; it is now one of this job's ready files.
      // A shaped file is a separate download and never changes which files the job has.
      if (!spec) {
        setActiveJob((previous) => previous && previous.jobId === downloadJobId
          ? { ...previous, fileIds: { ...(previous.fileIds || { xlsx: "ready" }), [ext]: "ready" } }
          : previous);
      }

      if (blobUrl) {
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = payload.downloadFileName || `diger_${activeJob?.templateSlug || "results"}_${downloadJobId.slice(0, 8)}.${ext}`;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => { URL.revokeObjectURL(blobUrl!); link.remove(); }, 30000);
      } else {
        window.location.assign(payload.signedUrl);
      }
    } catch (err: any) {
      console.error("[chat:download_error]", err);
      if (spec) {
        // The reason (for example a split into too many sheets) is Arabic and written by the server: show it in the chat.
        setMessages((prev) => [...prev, { id: `err_shape_${Date.now()}`, role: "assistant", content: customerFacingFailure(err, { fallback: "تعذر تجهيز الملف بالتنسيق المطلوب." }).text, createdAt: new Date().toISOString() }]);
      }
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
        content: customerFacingFailure(error, { fallback: "تعذر حفظ التعديل. النتيجة الأصلية لم تتغير." }).text,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setArtifactEditing(false);
    }
  }

  // Request Academic Methodology (10 points flow)
  function handleGenerateMethodology() {
    if (!activeJob?.jobId || !user) return;
    // Already bought: download it. The dialog (a second purchase) is never shown, and the server charges nothing again.
    if (methodologyPurchased) {
      void confirmGenerateMethodology();
      return;
    }
    setMethodologyConfirmOpen(true);
  }

  function saveMethodologyFile(downloadUrl: string, jobId: string) {
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `منهجية البحث - ${jobId.slice(0, 8)}.pdf`;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => link.remove(), 1000);
  }

  async function confirmGenerateMethodology() {
    if (!activeJob?.jobId || !user || methodologyPurchasing) return;
    setMethodologyPurchasing(true);
    try {
      const jwtToken = await getAccessToken();

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtToken) headers["Authorization"] = `Bearer ${jwtToken}`;

      const res = await fetch(`/api/jobs/${activeJob.jobId}/methodology`, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmed: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setMethodologyConfirmOpen(false);
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

      const boughtJobId = activeJob.jobId;
      setMethodologyBoughtJobs((prev) => ({ ...prev, [boughtJobId]: true }));
      if (typeof data.downloadUrl === "string" && data.downloadUrl) saveMethodologyFile(data.downloadUrl, boughtJobId);
      // A first purchase is confirmed in the conversation (no link in the text); a repeat download is silent and charges nothing.
      if (Number(data.chargedPoints) > 0) {
        const methodologyMsg: MessageItem = {
          id: `meth_${Date.now()}`,
          role: "assistant",
          content: methodologyMessageText(data.chargedPoints, data.remainingBalance, data.methodologyText),
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, methodologyMsg]);
      }
      loadBalance();
      setMethodologyConfirmOpen(false);
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
    } finally {
      setMethodologyPurchasing(false);
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
    handleSendMessage(REVIEW_PLAN_MESSAGE);
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
    else if (suggestion.type === "new_collection") request = `اعرض خطة جديدة حتى ${countPlainAr(Number(params.maxRows) || 1, "records")} لاستكمال: ${params.query}`;
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
      setMessages((prev) => [...prev, { id: `err_refresh_${Date.now()}`, role: "assistant", content: customerFacingFailure(err, { fallback: "تعذر تحديث السعر. حاول مرة أخرى." }).text, createdAt: new Date().toISOString() }]);
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
    const jobId = search.get("jobId");
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
        if (retry) {
          // The link asked for one retry; the parameter is removed so a reload or a copied link never asks again.
          try {
            const url = new URL(window.location.href);
            url.searchParams.delete("retry");
            window.history.replaceState(null, "", url.toString());
          } catch {
            // the address stays as it is
          }
          setTimeout(() => void sendRef.current(RETRY_SAME_PLAN_MESSAGE), 350);
        }
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
              updatedAt: jobDoc.updated_at ?? undefined,
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
  const jobFinished = Boolean(activeJob && isTerminalJobStatus(activeJob.status) && activeJob.status !== "failed");
  const balanceValue = userBalance.status === "ready" ? userBalance.value : null;

  // After an approved top-up the same plan becomes affordable: say so here, once per plan, and keep it approvable.
  const announcedTopupFor = useRef(new Set<string>());
  // Sample («استكشاف») runs: when one finishes, explain what its numbers mean for the full plan, once.
  const explorationByJob = useRef(new Map<string, PlanQuoteData>());
  const explorationAnnounced = useRef(new Set<string>());
  useEffect(() => {
    if (!activeJob || !jobFinished || activeJob.review === undefined) return;
    const sample = explorationByJob.current.get(activeJob.jobId);
    if (!sample?.exploration || explorationAnnounced.current.has(activeJob.jobId)) return;
    explorationAnnounced.current.add(activeJob.jobId);
    const estimate = estimateFromSample({
      delivered: activeJob.rowsCollected,
      requested: activeJob.requestedRows || sample.targetVolumeMax,
      rows: extractedRecords as unknown as Array<Record<string, any>>,
      fullUnits: sample.exploration.fullVolume,
      unitPricePoints: sample.unitPricePoints,
    });
    // The rest of the request: what came, what is left (without the rows already delivered) and the approximate total with the sample.
    const left = remainingUnits(sample.exploration.fullVolume, activeJob.rowsCollected);
    const offerRest = !estimate.sourceExhausted && left > 0;
    const content = offerRest
      ? sampleRestMessageAr({
          deliveredInSample: activeJob.rowsCollected,
          sampleChargedPoints: activeJob.chargedCredits ?? 0,
          remainingUnits: left,
          approximateTotalPoints: approximateTotalPoints({ sampleChargedPoints: activeJob.chargedCredits ?? 0, remainingUnits: left, unitPricePoints: sample.unitPricePoints }),
        })
      : explorationResultMessageAr(estimate, sample.exploration.fullVolume);
    setMessages((prev) => [...prev, {
      id: `explore_done_${activeJob.jobId}`, role: "assistant", content, createdAt: new Date().toISOString(),
      ...(offerRest ? { sampleRest: { sampleQuoteId: sample.quoteId, fullVolume: sample.exploration!.fullVolume } } : {}),
    }]);
  }, [activeJob, jobFinished, extractedRecords]);

  // «اطلب الباقي»: a new quote on the remaining volume, excluding the sample's rows. Nothing is reserved until it is approved.
  const [requestingRest, setRequestingRest] = useState(false);
  // The plan for the rest of a request is open for approval while the sample's results are still on screen.
  const [restPlanQuoteId, setRestPlanQuoteId] = useState<string | null>(null);
  async function handleRequestRest(sampleQuoteId: string, fullVolume: number) {
    if (requestingRest || !user) return;
    setRequestingRest(true);
    try {
      const jwtToken = await getAccessToken();
      const res = await fetch("/api/chat/sample-remainder", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(jwtToken ? { Authorization: `Bearer ${jwtToken}` } : {}) },
        body: JSON.stringify({ sampleQuoteId, fullVolume }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.error || "تعذر تجهيز الباقي حالياً. حاول مرة أخرى.");
      const planQuote: PlanQuoteData | undefined = data.planQuote || data.quote;
      // The sample's results stay open; the panel switches to the new plan until it is approved (its own run replaces the sample's).
      if (planQuote?.quoteId) { setRestPlanQuoteId(planQuote.quoteId); setCanvasOpen(true); }
      setMessages((prev) => [...prev, { id: `rest_${planQuote?.quoteId || Date.now()}`, role: "assistant", content: String(data.messageAr || ""), ...(planQuote ? { planQuote } : {}), createdAt: new Date().toISOString() }]);
    } catch (err: any) {
      setMessages((prev) => [...prev, { id: `err_rest_${Date.now()}`, role: "assistant", content: customerFacingFailure(err, { fallback: "تعذر تجهيز الباقي حالياً. حاول مرة أخرى." }).text, createdAt: new Date().toISOString() }]);
    } finally {
      setRequestingRest(false);
    }
  }
  useEffect(() => {
    if (balanceValue === null || activeJob) return;
    const lastPlan = [...messages].reverse().find((m) => m.planQuote)?.planQuote;
    if (!lastPlan || lastPlan.isAffordable || announcedTopupFor.current.has(lastPlan.quoteId)) return;
    const text = topupContinuationMessageAr({ balance: balanceValue, quotedPoints: lastPlan.quotedPoints });
    if (!text) return;
    announcedTopupFor.current.add(lastPlan.quoteId);
    setMessages((prev) => [...prev, { id: `topup_ok_${lastPlan.quoteId}`, role: "assistant", content: text, createdAt: new Date().toISOString() }]);
  }, [balanceValue, messages, activeJob]);
  // The real profile name only. The e-mail prefix that the account hook falls back to is not a name (owner decision D2).
  const firstName = String(user?.user_metadata?.name || user?.user_metadata?.full_name || "").trim().split(/\s+/)[0] || "";
  const chatEmpty = messages.length === 0 && !conversationLoading && !conversationLoadError;

  const renderNote = (m: MessageItem) => {
    if (m.hidden) return null;
    if (m.role === "user") {
      return (
        <div key={m.id} className="mb-0 mt-3 flex w-fit max-w-full flex-col gap-1.5" style={{ animation: "up .3s both" }}>
          {m.content && (
            <p className="mb-0 w-fit max-w-full break-words rounded-[18px] bg-sf2 px-4 py-2.5 text-sm font-light leading-[1.8] text-ink">
              {customerFacingMessageText(m.content)}
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
            planExists={messages.slice(messages.findIndex((entry) => entry.id === m.id) + 1).some((entry) => Boolean(entry.planQuote))}
            disabled={loading}
            onComplete={(answers) => handleSubmitClarification(m.id, answers)}
          />
        </div>
      );
    }
    return (
      <div key={m.id}>
        {m.content && (!m.progressNotice || shouldShowProgressNotice(m, activeJob, terminalJobs)) && (
          <p className="mb-0 mt-3 whitespace-pre-wrap break-words text-[15px] font-light leading-[2] text-ink" style={{ animation: "up .3s both" }}>
            {m.planQuote
              ? <><span className="lg:hidden">{PLAN_READY_MOBILE_AR}</span><span className="hidden lg:inline">{PLAN_READY_DESKTOP_AR}</span></>
              : customerFacingAssistantCopy(m.content)}
          </p>
        )}
        {m.fileShape && (m.fileShape.jobId || activeJob) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="download-shaped-file"
              onClick={() => void handleDownload("xlsx", m.fileShape!.spec as FileSpec, m.fileShape!.jobId)}
              disabled={downloadingKey !== null}
              className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-5 text-[13px] text-onac disabled:cursor-wait disabled:opacity-60"
            >
              {downloadingKey === "xlsx:shaped" ? "جاري تجهيز الملف..." : "تحميل الملف المخصص"}
            </button>
            <span className="text-xs font-light text-fnt">{m.fileShape.descriptionAr}</span>
          </div>
        )}
        {m.sampleRest && (
          <button
            type="button"
            data-testid="request-rest-btn"
            disabled={requestingRest}
            onClick={() => void handleRequestRest(m.sampleRest!.sampleQuoteId, m.sampleRest!.fullVolume)}
            className="mt-2 min-h-11 cursor-pointer rounded-full border-0 bg-ac px-5 text-[13px] text-onac disabled:cursor-wait disabled:opacity-60"
          >
            {requestingRest ? "جاري تجهيز الباقي..." : "اطلب الباقي"}
          </button>
        )}
        {m.planQuote && !canvasOpen && (
          <button
            type="button"
            data-testid="open-plan-btn"
            onClick={() => setCanvasOpen(true)}
            aria-controls="results-canvas"
            className="mt-2 min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink focus-visible:outline-2"
          >
            افتح الخطة
          </button>
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

  // The plan lives in the results panel (a bottom sheet on mobile), never in the chat stream: the latest plan is the one to act on.
  const latestPlanQuote = [...messages].reverse().find((m) => m.planQuote)?.planQuote ?? null;
  const planCard = (quote: PlanQuoteData, locked: boolean) => (
    <PlanQuoteCard
      quote={quote}
      conversationTitle={conversationTitle}
      onStart={handleStartExecution}
      onSaveEdit={(q, limit, param, formats, country, industry, cap) => handleSaveDirectEdit(q, limit, param, formats, country, industry, undefined, cap)}
      onAcceptDownscaled={(units) => handleSendMessage(`أوافق على الخطة المخفضة حتى ${countPlainAr(units, "records")} تناسب رصيدي المتاح`)}
      isStarting={startingQuoteId === quote.quoteId}
      available={balanceValue}
      creditValue={creditValue}
      onTopupShort={handleTopupShort}
      onExplore={handleExplore}
      onOpenPrevious={({ jobId, conversationId: previousConversationId }) => (previousConversationId ? void handleOpenConversation(previousConversationId, jobId) : window.location.assign(openJobHref({ jobId })))}
      onRefresh={handleRefreshQuote}
      locked={locked}
    />
  );
  // The contact fields the plan of the open request promised (its quote is the one whose job is the open one).
  const promisedContactFieldsOfJob: string[] = (() => {
    if (!activeJob) return [];
    const quote = messages.map((m) => m.planQuote).find((q) => q && getJobIdForQuote(q.quoteId) === activeJob.jobId);
    const fields = quote?.items?.[0]?.params?.requiredContactFields;
    return Array.isArray(fields) ? fields.filter((f: unknown): f is string => typeof f === "string") : [];
  })();
  const panelShowsPlan = shouldShowPlanPanel({
    latestQuote: latestPlanQuote ? { quoteId: latestPlanQuote.quoteId, status: latestPlanQuote.status, expiresAt: latestPlanQuote.expiresAt } : null,
    activeJob: activeJob ? { jobId: activeJob.jobId, status: activeJob.status } : null,
    restPlanQuoteId,
    jobIdForQuote: getJobIdForQuote,
  });

  // The remaining time comes from the real pace of this job (when each count of delivered records was seen), never a guess.
  // Live progress from the REAL chunks the job has finished (rolling average, widened when it slows or retries), and the stalled line.
  const jobIsLive = Boolean(activeJob && (activeJob.status === "running" || activeJob.status === "queued") && activeJob.requestedRows);
  const progress = jobIsLive && activeJob
    ? computeJobProgress({
        delivered: activeJob.rowsCollected,
        target: activeJob.requestedRows as number,
        marks: chunkMarksFromEvents((activeJob.events || []).map((e: any) => ({ message: e.textAr, units: e.count, created_at: e.createdAt }))),
        startedAt: activeJob.startedAt ? Date.parse(activeJob.startedAt) : undefined,
        retrying: Boolean(activeJob.nextAttemptAt && new Date(activeJob.nextAttemptAt).getTime() > Date.now()) || Number(activeJob.attemptCount || 0) > 0,
      })
    : null;
  // The approval message already says whether the page may be closed; the same sentence is not repeated under it while that message is on screen.
  const postApprovalNoticeVisible = messages.some((m) => shouldShowProgressNotice(m, activeJob, terminalJobs));
  const jobStalled = Boolean(jobIsLive && activeJob && isJobStalled({ status: activeJob.status === "running" ? "running" : "queued", updated_at: activeJob.updatedAt, lease_until: activeJob.leaseUntil }, Date.now()));

  const runNode = activeJob ? (
    activeJob.status !== "failed" ? (
      <div className="space-y-3">
        {/* The live activity list lives in the results panel only; the chat keeps this short status line and the way to open the panel. */}
        <div className="mt-4" data-testid="chat-run-status">
          {activeJob.status === "running" || activeJob.status === "queued" ? (
            // one in-progress sign on the screen: while the activity panel is open it carries its own, so the chat shows none
            canvasOpen ? null : <RunningIndicator />
          ) : (
            <p role="status" className="m-0 text-xs font-medium text-ink2">{activeJob.status === "done" ? (activeJob.requestedRows && activeJob.rowsCollected < activeJob.requestedRows ? PARTIAL_SENTENCE_AR : "اكتمل طلبك") : "توقف طلبك"}</p>
          )}
        </div>
        {progress && (
          <p className="m-0 text-xs font-light leading-[1.8] text-mut" data-testid="job-progress">{progress.lineAr}{progress.remainingAr ? "، تقديري ويتحدث مع كل دفعة." : "."}</p>
        )}
        {jobIsLive && !postApprovalNoticeVisible && (
          <p className="m-0 text-xs font-light leading-[1.8] text-mut" data-testid="job-close-page">{closePageLineAr(driverMode)}</p>
        )}
        {jobStalled && (
          <p role="status" className="m-0 text-xs font-medium leading-[1.8] text-ink" data-testid="job-stalled">{STALLED_LINE_AR}</p>
        )}
        {!canvasOpen && (
          <div className="flex justify-start">
            <button
              type="button"
              onClick={() => setCanvasOpen(true)}
              className="flex items-center gap-2 rounded-full border border-ln2 bg-sf px-4 py-2 text-xs font-semibold text-ink hover:bg-sf2 transition-colors cursor-pointer"
            >
              <span className={`flex h-2 w-2 rounded-full ${activeJob.status === "running" || activeJob.status === "queued" ? "bg-emerald-500 animate-pulse" : "bg-ok"}`} />
              <span>{activeJob.status === "running" || activeJob.status === "queued" ? "عرض لوحة النشاط والتنفيذ" : "عرض سجل التنفيذ"}</span>
            </button>
          </div>
        )}
      </div>
    ) : null
  ) : null;

  const jobNeedsReport = Boolean(
    activeJob && isTerminalJobStatus(activeJob.status) &&
    (activeJob.status === "failed" || (activeJob.requestedRows && activeJob.rowsCollected < activeJob.requestedRows)),
  );
  const filesNode = (
    <>
      {activeJob && jobNeedsReport && <ReportProblemButton jobId={activeJob.jobId} className="mt-3" />}
      {activeJob && jobFinished && (
        <FilesSection
          rows={activeJob.rowsCollected}
          requested={activeJob.requestedRows}
          charged={activeJob.chargedCredits}
          reserved={activeJob.reservedCredits}
          fileIds={activeJob.fileIds}
          downloadingKey={downloadingKey}
          onDownload={handleDownload}
          onOpenCanvas={() => setCanvasOpen((v) => !v)}
          canvasOpen={canvasOpen}
        />
      )}
    </>
  );

  const chatTimeline = buildChatTimeline<MessageItem>(messages, activeJob);

  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden bg-bg font-sans text-ink">
      {historyOpen && (
        <>
          <button type="button" aria-label="إغلاق سجل المحادثات" onClick={closeHistoryPanel} className="fixed inset-0 z-[44] cursor-default border-0 bg-black/30" />
          <aside role="dialog" aria-label="سجل المحادثات" className="fixed inset-y-0 left-0 z-[45] flex w-[min(90vw,380px)] flex-col border-r border-ln bg-sf shadow-2xl" dir="rtl">
            <div className="flex min-h-16 items-center justify-between border-b border-ln px-4">
              <h2 className="m-0 text-base font-semibold text-ink">سجل المحادثات</h2>
              <button type="button" aria-label="إغلاق" onClick={closeHistoryPanel} className="h-11 w-11 cursor-pointer rounded-full border-0 bg-transparent text-lg text-mut hover:bg-sf2">×</button>
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
        initialProfile={user?.user_metadata}
        onComplete={async (p) => {
          setUserPersona(p);
          await refresh();
          setShowOnboarding(false);
        }}
        onSkip={() => setShowOnboarding(false)}
      />

      {/* 2. Chronological conversation + composer */}
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
          <BusyBanner />
          {promoNotice && (
            <div role="status" data-testid="promo-notice" className="mx-auto mb-3 flex w-full max-w-[680px] items-start justify-between gap-3 rounded-[18px] bg-sf2 px-4 py-3 text-[13px] leading-[1.9]" style={{ color: promoNotice.ok ? "var(--ok)" : "var(--bad)" }}>
              <span>{promoNotice.text}</span>
              <button type="button" onClick={dismissPromoNotice} className="min-h-11 shrink-0 cursor-pointer border-0 bg-transparent px-2 text-xs text-mut">إخفاء</button>
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
              balance={balanceValue}
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
            <div className="mx-auto w-full max-w-[680px] space-y-3 py-4">
              {!llmEnabled && (
                <div role="status" className="mb-[18px] flex items-start gap-2.5 rounded-[18px] bg-sf2 px-4 py-3 text-[13px] leading-[1.8] text-ink2">
                  <span>المساعد الذكي يعمل الآن بالوضع المبسّط: أسئلة ثابتة وخطة قياسية. السعر والموافقة والتنفيذ تعمل بشكل طبيعي.</span>
                </div>
              )}
              {chatTimeline.map((item) => renderNote(item as MessageItem))}
              {loading && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <p role="status" className="m-0 text-[15px] font-light text-mut" style={{ animation: "breathe 1.4s infinite" }}>
                    {loadingStatusText}
                  </p>
                  {canStopWaiting && (
                    <button type="button" data-testid="stop-waiting" onClick={() => turnAbort.current?.abort()} className="min-h-11 cursor-pointer rounded-full border border-ln bg-transparent px-4 text-[13px] text-ink">إيقاف الانتظار</button>
                  )}
                </div>
              )}
              {runNode}
              {filesNode}
              </div>
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
          <div id="results-canvas" role="region" aria-label={panelShowsPlan ? "لوحة الخطة" : "لوحة النتائج"} className="fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] max-h-[85vh] w-full flex-col overflow-hidden rounded-t-[28px] bg-sf pb-[env(safe-area-inset-bottom)] shadow-2xl motion-reduce:animate-none lg:pb-0 lg:static lg:inset-auto lg:h-full lg:max-h-none lg:w-[460px] lg:rounded-none lg:border-s lg:border-ln lg:shadow-none" style={{ animation: "sheetUp .25s cubic-bezier(.2,.7,.2,1) both" }}>
            {panelShowsPlan && latestPlanQuote ? (
              <div className="flex h-full min-h-0 flex-col bg-sf" data-testid="plan-panel">
                <div className="flex items-center justify-between border-b border-sand-200 bg-sand-50/70 px-4 py-3">
                  <h2 className="text-sm font-bold text-ink-900">الخطة والسعر</h2>
                  <button
                    type="button"
                    onClick={() => setCanvasOpen(false)}
                    aria-label="إغلاق لوحة الخطة"
                    className="touch-target inline-flex items-center justify-center rounded-xl text-sand-500 hover:bg-sand-200 hover:text-ink-900"
                  >
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" />
                    </svg>
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">{planCard(latestPlanQuote, false)}</div>
              </div>
            ) : (
            <ResultsCanvas
              records={extractedRecords}
              profile={extractedProfile}
              jobId={activeJob?.jobId || null}
              jobStatus={activeJob?.status}
              jobEvents={activeJob?.events}
              eventLimit={EVENT_HISTORY_LIMIT}
              livePreview={livePreview && livePreview.jobId === activeJob?.jobId ? livePreview.sample : null}
              rowsCollected={activeJob?.rowsCollected}
              requestedRows={activeJob?.requestedRows}
              reservedPoints={activeJob?.reservedCredits}
              chargedPoints={activeJob?.chargedCredits}
              errorAr={activeJob?.status === "failed" ? undefined : activeJob?.errorAr}
              onDownload={handleDownload}
              fileIds={activeJob?.fileIds}
              downloadingKey={downloadingKey}
              onExplainMethodology={handleExplainMethodology}
              onRequestDocxMethodology={handleGenerateMethodology}
              methodologyPurchased={methodologyPurchased}
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
              planNode={latestPlanQuote ? planCard(latestPlanQuote, true) : undefined}
              promisedContactFields={promisedContactFieldsOfJob}
            />
            )}
          </div>
        </>
      )}
      {methodologyConfirmOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/45 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !methodologyPurchasing) setMethodologyConfirmOpen(false); }}>
          <section role="alertdialog" aria-modal="true" aria-labelledby="methodology-purchase-title" className="w-full max-w-md rounded-2xl border border-ln bg-sf p-5 shadow-2xl" dir="rtl">
            <h2 id="methodology-purchase-title" className="m-0 text-lg font-semibold text-ink">صياغة المنهجية الرسمية</h2>
            <p className="mb-0 mt-2 text-sm leading-7 text-ink2">تُضاف المنهجية إلى نتيجة هذا الطلب مقابل ١٠ نقاط. لن يتم الخصم إلا بعد تجهيزها.</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" disabled={methodologyPurchasing} onClick={() => void confirmGenerateMethodology()} className="min-h-11 rounded-full border-0 bg-ac px-5 text-sm text-onac disabled:opacity-60">{methodologyPurchasing ? "جارٍ التجهيز…" : "تأكيد وطلب المنهجية"}</button>
              <button type="button" disabled={methodologyPurchasing} onClick={() => setMethodologyConfirmOpen(false)} className="min-h-11 rounded-full border border-ln2 bg-transparent px-4 text-sm text-ink">إلغاء</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
