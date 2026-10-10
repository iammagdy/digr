"use client";

import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import Link from "next/link";
import { client, account, databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { Storage, Query } from "appwrite";
import { PersonaType } from "@/functions/shared/personaConfigs";

import OnboardingModal from "./components/OnboardingModal";
import ChatSidebar, { ConversationItem } from "./components/ChatSidebar";
import ClarificationReply from "./components/ClarificationReply";
import PlanQuoteCard, { PlanQuoteData } from "./components/PlanQuoteCard";
import ActivityTimeline, { JobEvent } from "./components/ActivityTimeline";
import ResultsCanvas, { ExtractedRecord } from "./components/ResultsCanvas";

const storage = new Storage(client);

interface MessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  outputType?: "propose_plan" | "edit_plan" | "ask_clarification" | "suggest_alternative" | "refuse" | "edit_artifact" | "answer_question" | "write_note";
  planQuote?: PlanQuoteData;
  clarificationQuestions?: string[];
  clarificationItems?: Array<{ question: string; options?: string[] }>;
  suggestedAlternative?: any;
  refusalReason?: string;
  jobId?: string;
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
}

const EXAMPLE_PROMPTS = [
  {
    title: "بروفايل حساب تيك توك",
    prompt: "أريد بيانات الملف العام لحساب على تيك توك وإحصائياته العامة",
    desc: "الخدمة المعتمدة المتاحة حالياً",
  },
  {
    title: "منشورات منصة X (قريباً)",
    prompt: "اجمع 100 تدوينة عن أبحاث الطاقة المتجددة من منصة X",
    desc: "معاينة البدائل المعتمدة وتسجيل الطلب",
  },
  {
    title: "مقاطع فيديو يوتيوب (قريباً)",
    prompt: "استخرج بيانات مقاطع الفيديو الأكثر تفاعلاً لقناة تعليمية",
    desc: "معاينة البدائل المعتمدة وتسجيل الطلب",
  },
  {
    title: "استشارة واستفسار عن الخدمات",
    prompt: "ما هي البيانات المتاحة التي يمكنني استخراجها لبحثي الأكاديمي؟",
    desc: "استشارة استكشافية مع المساعد",
  },
];

export default function ChatWorkspacePage() {
  const { user } = useUser();
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const [userPersona, setUserPersona] = useState<PersonaType>("student");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [conversationsList, setConversationsList] = useState<ConversationItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [requestedFeatures, setRequestedFeatures] = useState<Record<string, boolean>>({});

  // Active Job & Canvas Data
  const [startingQuoteId, setStartingQuoteId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ActiveJobState | null>(null);
  const [extractedRecords, setExtractedRecords] = useState<ExtractedRecord[]>([]);
  const [extractedProfile, setExtractedProfile] = useState<any>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 1. Check Profile & Onboarding status
  useEffect(() => {
    async function checkProfile() {
      if (!user) return;
      try {
        const res = await databases.listDocuments("digr", "profiles", [
          Query.equal("userId", user.$id),
          Query.limit(1),
        ]);
        if (res.documents.length > 0) {
          const prof: any = res.documents[0];
          if (prof.persona) setUserPersona(prof.persona as PersonaType);
          if (prof.onboardingCompleted === false) {
            setShowOnboarding(true);
          }
        }
      } catch (err) {
        console.warn("Error fetching profile:", err);
      }
    }
    checkProfile();
  }, [user]);

  // 2. Load User Balance
  const loadBalance = useCallback(async () => {
    if (!user) return;
    try {
      let total = 0;
      let offset = 0;
      const limit = 100;
      while (true) {
        const res = await databases.listDocuments("digr", "credit_ledger", [
          Query.equal("userId", user.$id),
          Query.limit(limit),
          Query.offset(offset),
        ]);
        for (const doc of res.documents) {
          total += (doc.delta as number) || 0;
        }
        if (res.documents.length < limit) break;
        offset += limit;
      }
      setUserBalance(total);
    } catch {
      setUserBalance(0);
    }
  }, [user]);

  useEffect(() => {
    loadBalance();
  }, [loadBalance]);

  // 3. Load Conversations
  const loadConversations = useCallback(async () => {
    if (!user) return;
    try {
      const res = await databases.listDocuments("digr", "conversations", [
        Query.equal("userId", user.$id),
        Query.orderDesc("updatedAt"),
        Query.limit(20),
      ]);
      setConversationsList(
        res.documents.map((d: any) => ({
          $id: d.$id,
          title: d.title || "محادثة استخراج",
          updatedAt: d.updatedAt,
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, activeJob, viewportHeight]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const syncViewportHeight = () => setViewportHeight(Math.round(viewport.height));
    syncViewportHeight();
    viewport.addEventListener("resize", syncViewportHeight);
    return () => viewport.removeEventListener("resize", syncViewportHeight);
  }, []);

  // 5. Poll active job status
  useEffect(() => {
    if (!activeJob || activeJob.status === "done" || activeJob.status === "failed" || activeJob.status === "cancelled") {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const jobDoc: any = await databases.getDocument("digr", "jobs", activeJob.jobId);
        const eventsRes = await databases.listDocuments("digr", "job_events", [
          Query.equal("jobId", activeJob.jobId),
          Query.orderAsc("createdAt"),
          Query.limit(20),
        ]);

        setActiveJob((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            status: jobDoc.status,
            rowsCollected: jobDoc.rowsCollected || 0,
            chargedCredits: jobDoc.chargedCredits,
            reservedCredits: jobDoc.reservedCredits,
            errorAr: jobDoc.errorAr,
            events: eventsRes.documents as unknown as JobEvent[],
          };
        });

        if (jobDoc.status === "done" && extractedRecords.length === 0) {
          loadBalance();
          setCanvasOpen(true);
          try {
            const dataRes = await fetch(`/api/jobs/${jobDoc.$id}/data`);
            const dataJson = await dataRes.json();
            if (dataJson.success) {
              if (dataJson.profile) setExtractedProfile(dataJson.profile);
              if (dataJson.rows && Array.isArray(dataJson.rows)) {
                setExtractedRecords(dataJson.rows);
              }
            }
          } catch (fetchErr) {
            console.warn("Failed to fetch real job data:", fetchErr);
          }
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
    if (!textToSend || loading || !user) return;

    const userMsg: MessageItem = {
      id: `usr_${Date.now()}`,
      role: "user",
      content: textToSend,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText("");
    setLoading(true);
    setPlusMenuOpen(false);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
      let jwtToken: string | undefined = undefined;
      try {
        const jwtRes = await account.createJWT();
        jwtToken = jwtRes.jwt;
      } catch {}

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
        ? "استغرق المساعد وقتاً أطول من المتوقع (أكثر من 20 ثانية). يرجى الضغط على زر إعادة المحاولة."
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

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    handleSendMessage(inputText);
  }

  function handleStartNewChat() {
    setMessages([]);
    setConversationId(null);
    setInputText("");
    setActiveJob(null);
    setExtractedRecords([]);
    setExtractedProfile(null);
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

    let jwtToken: string | undefined = undefined;
    try {
      const jwtRes = await account.createJWT();
      jwtToken = jwtRes.jwt;
    } catch {}

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
      let jwtToken: string | undefined = undefined;
      try {
        const jwtRes = await account.createJWT();
        jwtToken = jwtRes.jwt;
      } catch {}

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
      const fileId = `${ext}_${activeJob.jobId}`;
      const downloadUrl = storage.getFileDownload("results", fileId).toString();
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `digr_${activeJob.templateSlug}_${activeJob.jobId.slice(0, 8)}.${ext}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      alert(`تعذر تحميل الملف: ${err.message}`);
    } finally {
      setDownloadingKey(null);
    }
  }

  // Request Academic Methodology (10 points flow)
  async function handleGenerateMethodology() {
    if (!activeJob?.jobId || !user) return;
    try {
      let jwtToken: string | undefined;
      try {
        const jwtRes = await account.createJWT();
        jwtToken = jwtRes.jwt;
      } catch {}

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
        content: `تم توثيق المنهجية الأكاديمية بنجاح وخصم ${data.chargedPoints} نقاط (رصيدك الحالي: ${data.remainingBalance} نقطة):\n\n${data.methodologyText}`,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, methodologyMsg]);
      loadBalance();
      alert("تمت صياغة المنهجية الأكاديمية بنجاح واقتطاع 10 نقاط من الرصيد.");
    } catch (err: any) {
      alert("تعذر طلب صياغة المنهجية: " + err.message);
    }
  }

  // Handle Upload Untrusted List
  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Strict size limit: 200 KB max
    if (file.size > 200 * 1024) {
      alert("حجم الملف يتجاوز الحد الأقصى المسموح به (200 كيلوبايت)");
      e.target.value = "";
      return;
    }

    // Strict extension check
    if (!file.name.match(/\.(csv|txt)$/i)) {
      alert("نوع الملف غير مدعوم. يُسمح بملفات CSV أو TXT فقط");
      e.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        // Treat content as strictly untrusted: sanitize characters, cap count and length
        const sanitizedIdentifiers = text
          .split(/[\r\n,]+/)
          .map((l) => l.replace(/[^a-zA-Z0-9_.-]/g, "").trim())
          .filter((l) => l.length > 0 && l.length <= 64)
          .slice(0, 20);

        if (sanitizedIdentifiers.length > 0) {
          const sample = sanitizedIdentifiers.slice(0, 3).join(", ");
          handleSendMessage(
            `أرفقت قائمة تضم ${sanitizedIdentifiers.length} حساب: [${sample}${sanitizedIdentifiers.length > 3 ? "..." : ""}]، يرجى فحص الحساب الأول وإعداد خطة استخراج`
          );
        } else {
          alert("لم يتم العثور على معرّفات صالحة داخل الملف");
        }
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <div
      className="flex h-dvh min-h-0 w-full bg-sand-50 text-ink-900 overflow-hidden font-sans"
      style={viewportHeight ? { height: `${viewportHeight}px` } : undefined}
    >
      {/* 1. Onboarding Modal */}
      <OnboardingModal
        isOpen={showOnboarding}
        onComplete={(p) => {
          setUserPersona(p);
          setShowOnboarding(false);
        }}
        onSkip={() => setShowOnboarding(false)}
      />

      {/* 2. Left Sidebar (Collapsible) */}
      <ChatSidebar
        conversations={conversationsList}
        activeId={conversationId}
        onSelectConversation={(id) => {
          setConversationId(id);
          // In production, would fetch messages for this conversation
        }}
        onNewChat={handleStartNewChat}
        userBalance={userBalance}
        userPersona={userPersona}
        onOpenOnboarding={() => setShowOnboarding(true)}
        isOpen={sidebarOpen}
        onCloseMobile={() => setSidebarOpen(false)}
      />

      {/* 3. Main Chat Column */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col h-full overflow-hidden border-l border-sand-300">
        {/* Top Header - Compact Single Line (Never Wraps) */}
        <header className="h-14 shrink-0 min-w-0 px-2 sm:px-6 bg-white border-b border-sand-200 flex items-center justify-between shadow-2xs">
          <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 shrink">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 lg:hidden text-sand-600 hover:text-ink-900 rounded-lg hover:bg-sand-100"
              aria-label="فتح القائمة الجانبية"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="min-w-0">
              <h1 className="text-xs sm:text-base font-bold text-ink-900 truncate">
                مساعد Digr البحثي
              </h1>
              <p className="hidden md:block text-3xs sm:text-2xs text-sand-500">
                استشارات وتصميم خطط جمع البيانات العامة المعتمدة
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            {/* Balance Badge */}
            <Link
              href="/dashboard/topup"
              className="flex items-center gap-1 px-2 py-1 sm:px-3 sm:py-1.5 bg-amber-points-bg hover:bg-amber-points-bg/80 border border-amber-points/30 rounded-xl transition-colors text-2xs sm:text-xs"
              title="رصيد الحساب وشحن النقاط"
            >
              <span className="font-bold text-amber-points tabular-nums">
                {userBalance !== null ? userBalance : "..."}
              </span>
              <span className="font-semibold text-amber-points">نقطة</span>
              <span className="text-sand-400 font-bold">+</span>
            </Link>

            {/* Results Toggle (Desktop & Mobile) */}
            <button
              type="button"
              onClick={() => setCanvasOpen(!canvasOpen)}
              className={`px-2.5 py-1 sm:px-3 sm:py-1.5 text-2xs sm:text-xs font-semibold rounded-xl border transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
                canvasOpen
                  ? "bg-sand-200 border-sand-400 text-ink-900"
                  : "bg-white border-sand-300 text-sand-700 hover:bg-sand-100"
              }`}
            >
              <svg className="w-3.5 h-3.5 text-sand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="hidden sm:inline">لوحة النتائج</span>
              <span className="sm:hidden">النتائج</span>
            </button>
          </div>
        </header>

        {/* Messages Stream */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6 space-y-4">
          {/* Empty First Screen State */}
          {messages.length === 0 && (
            <div className="max-w-xl mx-auto pt-8 sm:pt-16 text-center space-y-6">
              <div className="space-y-2">
                <div className="inline-flex p-3 rounded-2xl bg-sand-200/80 text-primary">
                  <svg className="w-6 h-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <h2 className="text-xl sm:text-2xl font-bold text-ink-900 tracking-tight">
                  أهلاً بك في Digr
                </h2>
                <p className="text-xs sm:text-sm text-sand-600 max-w-md mx-auto">
                  صف لي البيانات العامة التي تحتاجها لبحثك، وسأساعدك في تصميم خطة الجمع وتوثيق المنهجية وتسليم ملفات نظيفة.
                </p>
              </div>

              {/* 4 Prompt Chips */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-right pt-4">
                {EXAMPLE_PROMPTS.map((ex, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      setInputText(ex.prompt);
                      inputRef.current?.focus();
                    }}
                    className="p-3.5 bg-white hover:bg-sand-100/80 border border-sand-300 hover:border-sand-400 rounded-xl text-xs transition-all shadow-2xs group cursor-pointer text-right"
                  >
                    <div className="font-bold text-ink-900 group-hover:text-primary mb-1">
                      {ex.title}
                    </div>
                    <div className="text-3xs text-sand-500 line-clamp-1">
                      {ex.prompt}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages List */}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${
                msg.role === "user" ? "items-start" : "items-end"
              }`}
            >
              <div
                className={`max-w-2xl w-full p-4 rounded-2xl text-xs sm:text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-sand-200/80 text-ink-900 rounded-tr-xs"
                    : "bg-white border border-sand-300/80 text-ink-900 shadow-2xs rounded-tl-xs"
                }`}
              >
                {msg.outputType === "ask_clarification" ? (
                  <ClarificationReply
                    intro={msg.content}
                    questions={msg.clarificationItems || msg.clarificationQuestions || []}
                    onSelectOption={handleSendMessage}
                  />
                ) : (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                )}

                {/* Error with Retry Button */}
                {msg.errorRetryPrompt && (
                  <div className="mt-3 pt-2 border-t border-sand-200">
                    <button
                      type="button"
                      onClick={() => handleSendMessage(msg.errorRetryPrompt!)}
                      className="px-3 py-1.5 bg-sand-100 hover:bg-sand-200 text-ink-900 border border-sand-300 rounded-lg text-xs font-semibold cursor-pointer inline-flex items-center gap-1.5 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5 text-sand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>إعادة المحاولة الآن</span>
                    </button>
                  </div>
                )}

                {/* Interactive Plan Quote Card */}
                {msg.planQuote && (
                  <PlanQuoteCard
                    quote={msg.planQuote}
                    onStart={handleStartExecution}
                    onSaveEdit={handleSaveDirectEdit}
                    onAcceptDownscaled={(units) =>
                      handleSendMessage(`أوافق على الخطة المخفضة حتى ${units} سجل تناسب رصيدي المتاح`)
                    }
                    isStarting={startingQuoteId === msg.planQuote.quoteId}
                  />
                )}

                {/* Suggested Alternative / Request Service Card */}
                {msg.outputType === "suggest_alternative" && msg.suggestedAlternative && (
                  <div className="mt-3 p-3.5 bg-sand-50 border border-sand-300 rounded-xl space-y-2.5">
                    <div className="text-xs text-sand-700 flex items-center gap-1.5">
                      <svg className="w-4 h-4 text-amber-points shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      <span>يمكنك تسجيل رغبتك بتفعيل هذه الخدمة وسنبلغك فور اعتمادها:</span>
                    </div>
                    <button
                      type="button"
                      disabled={requestedFeatures[msg.suggestedAlternative.unsupportedService]}
                      onClick={() => {
                        setRequestedFeatures((prev) => ({
                          ...prev,
                          [msg.suggestedAlternative.unsupportedService]: true,
                        }));
                      }}
                      className="px-3 py-1.5 bg-white hover:bg-sand-100 border border-sand-300 rounded-lg text-xs font-semibold text-ink-800 transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {requestedFeatures[msg.suggestedAlternative.unsupportedService] ? (
                        <span className="text-success inline-flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          <span>تم تسجيل طلبك بنجاح</span>
                        </span>
                      ) : (
                        <span>طلب تفعيل خدمة ({msg.suggestedAlternative.unsupportedService})</span>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Live Activity Timeline */}
          {activeJob && (
            <div className="max-w-2xl w-full mx-auto">
              <ActivityTimeline
                status={activeJob.status}
                events={activeJob.events}
                rowsCollected={activeJob.rowsCollected}
              />
            </div>
          )}

          {/* Thinking Indicator */}
          {loading && (
            <div className="flex items-center gap-2 p-3 text-xs text-sand-500 bg-white border border-sand-200 rounded-2xl w-fit shadow-2xs">
              <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
              <span>جاري التفكير وتحليل متطلبات البحث...</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Pinned Composer */}
        <div className="shrink-0 p-3 sm:p-4 bg-white border-t border-sand-200 safe-bottom">
          <form
            onSubmit={handleFormSubmit}
            className="relative max-w-3xl mx-auto flex items-end gap-2 bg-sand-50 border border-sand-300 focus-within:border-primary rounded-2xl p-2 transition-all shadow-2xs"
          >
            {/* Hidden File Input for Untrusted CSV/TXT lists */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept=".csv,.txt"
              className="hidden"
            />

            {/* "+" Actions Menu Button */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setPlusMenuOpen(!plusMenuOpen)}
                className="w-9 h-9 flex items-center justify-center rounded-xl text-sand-600 hover:text-ink-900 hover:bg-sand-200/80 transition-colors cursor-pointer"
                title="خيارات إضافية"
              >
                <svg className="w-5 h-5 text-sand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </button>

              {plusMenuOpen && (
                <div className="absolute bottom-11 right-0 w-52 bg-white border border-sand-300 rounded-xl shadow-lg p-1.5 space-y-1 z-20 animate-in fade-in zoom-in-95">
                  <button
                    type="button"
                    onClick={() => {
                      fileInputRef.current?.click();
                      setPlusMenuOpen(false);
                    }}
                    className="w-full text-right px-3 py-2 text-xs text-ink-900 hover:bg-sand-100 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <svg className="w-4 h-4 text-sand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                    <span>إرفاق قائمة حسابات (CSV أو TXT) - تجريبي</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      handleSendMessage("أريد استخراج البيانات بصيغة ملفات Excel و PDF معاً");
                      setPlusMenuOpen(false);
                    }}
                    className="w-full text-right px-3 py-2 text-xs text-ink-900 hover:bg-sand-100 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <svg className="w-4 h-4 text-sand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                    </svg>
                    <span>تفضيلات المخرجات</span>
                  </button>
                </div>
              )}
            </div>

            {/* Textarea Input */}
            <textarea
              ref={inputRef}
              rows={2}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage(inputText);
                }
              }}
              placeholder="مثال: أريد بيانات الملف العام لحساب على تيك توك"
              className="min-w-0 flex-1 bg-transparent p-2 text-xs leading-5 sm:text-sm text-ink-900 placeholder:text-sand-400 focus:outline-hidden resize-none max-h-20"
            />

            {/* Send Button */}
            <button
              type="submit"
              disabled={loading || !inputText.trim()}
              className="w-9 h-9 flex items-center justify-center bg-primary hover:bg-primary-hover text-white rounded-xl shadow-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shrink-0"
              aria-label="إرسال"
            >
              <svg className="w-4 h-4 text-white rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>
          </form>
        </div>
      </div>

      {/* 4. Results Workspace Column (Drawer with Backdrop on Mobile & Tablet / Side-by-side on Desktop) */}
      {canvasOpen && (
        <>
          <div
            onClick={() => setCanvasOpen(false)}
            className="fixed inset-0 z-40 bg-ink-900/40 lg:hidden backdrop-blur-xs"
          />
          <div className="fixed inset-x-0 bottom-0 z-50 h-[85dvh] max-h-[85vh] w-full rounded-t-2xl bg-white shadow-2xl animate-in slide-in-from-bottom duration-200 flex flex-col overflow-hidden lg:static lg:inset-auto lg:h-full lg:max-h-none lg:w-[460px] lg:rounded-none lg:shadow-none lg:animate-none">
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
            />
          </div>
        </>
      )}
    </div>
  );
}
