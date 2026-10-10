"use client";

import { useState } from "react";
import Link from "next/link";
import { PersonaType, PERSONA_CONFIGS } from "@/functions/shared/personaConfigs";

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
  onOpenOnboarding?: () => void;
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
  onOpenOnboarding,
  isOpen,
  onCloseMobile,
}: ChatSidebarProps) {
  const [search, setSearch] = useState("");

  const filteredConversations = conversations.filter((c) =>
    (c.title || "محادثة جديدة").toLowerCase().includes(search.toLowerCase())
  );

  const personaConfig = userPersona ? PERSONA_CONFIGS[userPersona] : PERSONA_CONFIGS.student;

  return (
    <>
      {/* Mobile & Tablet Backdrop */}
      {isOpen && (
        <div
          onClick={onCloseMobile}
          className="fixed inset-0 z-40 bg-ink-900/40 lg:hidden backdrop-blur-xs"
        />
      )}

      {/* Sidebar Panel */}
      <aside
        className={`fixed lg:static inset-y-0 right-0 z-40 w-72 bg-sand-100/90 border-l border-sand-300 flex flex-col transition-transform duration-200 ease-out lg:translate-x-0 ${
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
              onClick={onCloseMobile}
              className="p-1.5 text-sand-500 hover:text-ink-900 md:hidden rounded-lg hover:bg-sand-200"
              aria-label="إغلاق القائمة"
            >
              ✕
            </button>
          </div>

          <button
            type="button"
            onClick={onNewChat}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-primary hover:bg-primary-hover text-white text-sm font-semibold rounded-xl shadow-xs transition-colors cursor-pointer"
          >
            <span>+</span>
            <span>محادثة جديدة</span>
          </button>
        </div>

        {/* Search Input */}
        <div className="px-4 py-2 border-b border-sand-200/60">
          <input
            type="text"
            placeholder="بحث في المحادثات..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-1.5 text-xs bg-white border border-sand-300 rounded-lg placeholder:text-sand-400 focus:outline-hidden focus:border-primary"
          />
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filteredConversations.length === 0 ? (
            <div className="p-4 text-center text-xs text-sand-500">
              لا توجد محادثات سابقة
            </div>
          ) : (
            filteredConversations.map((c) => {
              const isActive = c.$id === activeId;
              return (
                <button
                  key={c.$id}
                  onClick={() => {
                    onSelectConversation(c.$id);
                    onCloseMobile();
                  }}
                  className={`w-full text-right px-3 py-2.5 rounded-xl text-xs sm:text-sm font-medium transition-colors truncate cursor-pointer block ${
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
            className="flex items-center justify-between px-3 py-2 text-xs font-medium text-sand-700 hover:text-ink-900 rounded-lg hover:bg-sand-200/50 transition-colors"
          >
            <span>طلباتي وسجل الاستخراج</span>
            <span className="text-sand-400">←</span>
          </Link>
          <Link
            href="/dashboard/topup"
            className="flex items-center justify-between px-3 py-2 text-xs font-medium text-sand-700 hover:text-ink-900 rounded-lg hover:bg-sand-200/50 transition-colors"
          >
            <span>شحن الرصيد (Instapay)</span>
            <span className="text-sand-400">←</span>
          </Link>
        </div>

        {/* Footer: User Persona & Balance Badge */}
        <div className="p-4 border-t border-sand-300 bg-sand-100 flex items-center justify-between">
          <div>
            <div className="text-xs text-sand-600 mb-0.5">الرصيد المتاح:</div>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-bold text-amber-points tabular-nums">
                {userBalance !== null ? userBalance : "..."}
              </span>
              <span className="text-xs font-semibold text-amber-points">نقطة</span>
            </div>
          </div>

            <button
              onClick={onOpenOnboarding}
              className="text-2xs px-2.5 py-1 bg-white hover:bg-sand-50 border border-sand-300 text-ink-800 rounded-full font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5"
              title="تعديل نمط المساعد"
            >
              <span>{personaConfig.titleAr.split(" ")[0]}</span>
              <svg className="w-3 h-3 text-sand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
        </div>
      </aside>
    </>
  );
}
