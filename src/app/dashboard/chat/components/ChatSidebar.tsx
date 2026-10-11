"use client";

import { useState } from "react";
import Link from "next/link";
import { getPersonaConfig, PersonaType, PERSONA_CONFIGS } from "@/functions/shared/personaConfigs";
import { Alert } from "@/components/ui";

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
      setPersonaError(error.message || "تعذّر حفظ الشخصية");
    } finally {
      setPersonaSaving(false);
    }
  }

  return (
    <>
      {isOpen && (
        <div
          onClick={onCloseMobile}
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-ink-900/45 backdrop-blur-xs lg:hidden"
        />
      )}

      <aside
        aria-label="المحادثات والإعدادات"
        className={`fixed inset-y-0 start-0 z-40 flex w-80 max-w-[85vw] flex-col bg-pine-950 text-white transition-transform duration-200 ease-out motion-reduce:transition-none lg:static lg:z-auto lg:w-72 lg:translate-x-0 lg:shadow-none ${
          isOpen ? "translate-x-0 shadow-2xl" : "translate-x-full"
        }`}
      >
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div className="absolute -top-20 -start-20 h-56 w-56 rounded-full bg-accent/15 blur-3xl" />
        </div>

        {/* Header */}
        <div className="relative border-b border-white/10 p-4">
          <div className="mb-4 flex items-center justify-between">
            <Link href="/dashboard" className="flex items-center gap-2" onClick={onCloseMobile}>
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-sm font-bold ring-1 ring-white/20">دِ</span>
              <span className="text-lg font-bold tracking-tight">Digr</span>
            </Link>
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="إغلاق القائمة"
              className="touch-target inline-flex items-center justify-center rounded-xl text-sand-300 hover:bg-white/10 hover:text-white lg:hidden"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            onClick={onNewChat}
            disabled={isBusy}
            className="touch-target flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-accent px-4 py-3 text-sm font-bold text-white shadow-[var(--shadow-ink)] transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            محادثة بحث جديدة
          </button>
          <div className="relative mt-3">
            <input
              type="search"
              aria-label="بحث في المحادثات"
              placeholder="بحث في المحادثات..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-h-11 w-full rounded-xl border border-white/10 bg-white/8 px-3.5 pe-10 text-sm text-white placeholder:text-sand-400 outline-none focus:border-accent"
            />
            <svg className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* Conversations */}
        <div className="relative flex-1 space-y-1 overflow-y-auto p-3" role="list" aria-label="قائمة المحادثات">
          {filteredConversations.length === 0 ? (
            <p className="p-4 text-center text-xs text-sand-400" role="status">
              {search.trim() ? "لا توجد محادثات تطابق البحث" : "لا توجد محادثات سابقة بعد"}
            </p>
          ) : (
            filteredConversations.map((c) => {
              const isActive = c.$id === activeId;
              return (
                <button
                  key={c.$id}
                  type="button"
                  role="listitem"
                  disabled={isBusy}
                  onClick={() => {
                    onSelectConversation(c.$id);
                    onCloseMobile();
                  }}
                  aria-current={isActive ? "page" : undefined}
                  className={`touch-target block w-full cursor-pointer truncate rounded-xl px-3.5 py-3 text-right text-sm transition-colors disabled:cursor-wait disabled:opacity-60 ${
                    isActive ? "bg-white/12 font-bold text-white" : "text-sand-300 hover:bg-white/6 hover:text-white"
                  }`}
                >
                  {c.title || "محادثة استخراج"}
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="relative space-y-3 border-t border-white/10 p-4">
          <Link href="/dashboard/topup" onClick={onCloseMobile} className="tnum flex items-center justify-between rounded-2xl bg-white/8 px-3.5 py-3 ring-1 ring-white/10 transition-colors hover:bg-white/12">
            <span className="text-xs text-sand-300">رصيد النقاط</span>
            <span className="text-base font-bold text-amber-points">{userBalance !== null ? userBalance.toLocaleString("ar-EG") : "…"} <span className="text-xs">نقطة +</span></span>
          </Link>
          <div>
            <label htmlFor="persona-setting" className="mb-1.5 block text-xs font-semibold text-sand-300">
              طريقة المساعد <span className="font-normal text-sand-500">— {personaConfig.titleAr.split(" ")[0]}</span>
            </label>
            <select
              id="persona-setting"
              value={userPersona ?? "other"}
              disabled={personaSaving}
              onChange={(event) => handlePersonaChange(event.target.value)}
              className="min-h-11 w-full cursor-pointer rounded-xl border border-white/10 bg-white/8 px-3 text-sm text-white outline-none focus:border-accent disabled:opacity-60 [&>option]:text-ink-900"
            >
              {Object.values(PERSONA_CONFIGS).map((persona) => (
                <option key={persona.key} value={persona.key}>{persona.titleAr}</option>
              ))}
            </select>
            {personaSaving && <p className="mt-1.5 text-xs text-sand-400" aria-live="polite">جاري حفظ التخصيص...</p>}
            {personaError && (
              <div className="mt-2"><Alert tone="danger">{personaError}</Alert></div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
