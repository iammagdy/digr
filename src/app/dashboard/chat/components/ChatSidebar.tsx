"use client";

import { useState } from "react";
import Link from "next/link";
import { getPersonaConfig, PersonaType, PERSONA_CONFIGS } from "@/functions/shared/personaConfigs";

export interface ConversationItem {
  $id: string;
  title: string;
  updatedAt: string;
}

interface ChatSidebarProps {
  conversations: ConversationItem[];
  activeId: string | null;
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  onDeleteConversation?: (id: string) => void;
  userBalance: number | null;
  userPersona?: PersonaType;
  onChangePersona: (persona: PersonaType) => Promise<void>;
  isBusy?: boolean;
  isOpen: boolean;
  onCloseMobile: () => void;
}

export default function ChatSidebar({
  conversations,
  activeId,
  onSelectConversation,
  onNewChat,
  userBalance,
  userPersona,
  onChangePersona,
  isBusy = false,
  isOpen,
  onCloseMobile,
}: ChatSidebarProps) {
  const [search, setSearch] = useState("");
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaError, setPersonaError] = useState<string | null>(null);

  const filteredConversations = conversations.filter((c) =>
    (c.title || "محادثة جديدة").toLowerCase().includes(search.toLowerCase())
  );

  const personaConfig = getPersonaConfig(userPersona);

  async function handlePersonaChange(value: string) {
    setPersonaSaving(true);
    setPersonaError(null);
    try {
      await onChangePersona(value as PersonaType);
    } catch (error: any) {
      setPersonaError(error.message || "تعذر حفظ الشخصية");
    } finally {
      setPersonaSaving(false);
    }
  }

  return (
    <>
      {/* Mobile & Tablet Backdrop */}
        {isOpen && (
        <div
          onClick={onCloseMobile}
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-ink-900/40 lg:hidden backdrop-blur-xs"
        />
      )}

      {/* Sidebar Panel */}
      <aside
        className={`fixed lg:static inset-y-0 right-0 z-40 w-72 bg-sand-100/90 border-l border-sand-300 flex flex-col transition-transform duration-200 ease-out motion-reduce:transition-none lg:translate-x-0 ${
          isOpen ? "translate-x-0 shadow-xl" : "translate-x-full lg:shadow-none"
        }`}
      >
        {/* Brand & New Chat */}
        <div className="p-4 border-b border-sand-200">
          <div className="flex items-center justify-between mb-4">
            <Link href="/dashboard" className="flex items-center gap-2">
              <span className="text-xl font-bold tracking-tight text-ink-900">Digr</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-sand-200 text-sand-700 font-medium">
                استشارات بحثية
              </span>
            </Link>
            <button
              type="button"
              onClick={onCloseMobile}
              className="min-h-11 min-w-11 inline-flex items-center justify-center text-sand-500 hover:text-ink-900 md:hidden rounded-lg hover:bg-sand-200 focus-visible:outline-2 focus-visible:outline-primary"
              aria-label="إغلاق القائمة"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          <button
            type="button"
            onClick={onNewChat}
            disabled={isBusy}
            className="min-h-11 w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-primary hover:bg-primary-hover text-white text-sm font-semibold rounded-xl shadow-xs transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <span>+</span>
            <span>محادثة جديدة</span>
          </button>
        </div>

        {/* Search Input */}
        <div className="px-4 py-2 border-b border-sand-200/60">
          <input
            type="text"
            aria-label="بحث في المحادثات"
            placeholder="بحث في المحادثات..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-h-11 w-full px-3 py-1.5 text-xs bg-white border border-sand-300 rounded-lg placeholder:text-sand-400 focus:outline-hidden focus:border-primary focus-visible:outline-2 focus-visible:outline-primary"
          />
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filteredConversations.length === 0 ? (
            <div className="p-4 text-center text-xs text-sand-500" role="status">
              {search.trim() ? "لا توجد محادثات تطابق البحث" : activeId ? "المحادثة الحالية" : "لا توجد محادثات سابقة"}
            </div>
          ) : (
            filteredConversations.map((c) => {
              const isActive = c.$id === activeId;
              return (
                <button
                  key={c.$id}
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    onSelectConversation(c.$id);
                    onCloseMobile();
                  }}
                  aria-current={isActive ? "page" : undefined}
                  className={`min-h-11 w-full text-right px-3 py-2.5 rounded-xl text-xs sm:text-sm font-medium transition-colors truncate cursor-pointer block disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-primary ${
                    isActive
                      ? "bg-sand-200 text-ink-900 font-semibold shadow-2xs"
                      : "text-sand-700 hover:bg-sand-200/60 hover:text-ink-900"
                  }`}
                >
                  <div className="truncate">{c.title || "محادثة استخراج"}</div>
                </button>
              );
            })
          )}
        </div>

        {/* Navigation Quick Links */}
        <div className="p-3 border-t border-sand-200 bg-sand-50/60 space-y-1">
          <Link
            href="/dashboard/jobs"
            className="min-h-11 flex items-center justify-between px-3 py-2 text-xs font-medium text-sand-700 hover:text-ink-900 rounded-lg hover:bg-sand-200/50 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span>طلباتي وسجل الاستخراج</span>
            <span className="text-sand-400">←</span>
          </Link>
          <Link
            href="/dashboard/topup"
            className="min-h-11 flex items-center justify-between px-3 py-2 text-xs font-medium text-sand-700 hover:text-ink-900 rounded-lg hover:bg-sand-200/50 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span>شحن الرصيد (Instapay)</span>
            <span className="text-sand-400">←</span>
          </Link>
        </div>

        {/* Footer: User Persona & Balance Badge */}
        <div className="p-4 border-t border-sand-300 bg-sand-100 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-sand-600 mb-0.5">الرصيد المتاح:</div>
              <div className="flex items-center gap-1.5">
                <span className="text-base font-bold text-amber-points tabular-nums">
                  {userBalance !== null ? userBalance : "..."}
                </span>
                <span className="text-xs font-semibold text-amber-points">نقطة</span>
              </div>
            </div>
            <span className="text-xs font-medium text-ink-800">{personaConfig.titleAr.split(" ")[0]}</span>
          </div>
          <label htmlFor="persona-setting" className="block text-xs font-semibold text-sand-700">طريقة المساعد</label>
          <select
            id="persona-setting"
            aria-label="تغيير الشخصية"
            value={userPersona ?? "other"}
            disabled={personaSaving}
            onChange={(event) => handlePersonaChange(event.target.value)}
            className="min-h-11 w-full rounded-lg border border-sand-300 bg-white px-3 text-sm text-ink-900 outline-none focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
          >
            {Object.values(PERSONA_CONFIGS).map((persona) => (
              <option key={persona.key} value={persona.key}>{persona.titleAr}</option>
            ))}
          </select>
          {personaSaving && <div className="text-xs text-sand-600" aria-live="polite">جاري حفظ التخصيص...</div>}
          {personaError && <div className="text-xs text-danger" role="alert">{personaError}</div>}
        </div>
      </aside>
    </>
  );
}
