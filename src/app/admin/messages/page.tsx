"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { Card, SubTabs } from "@/components/admin/ui";
import { MessageComposer } from "@/components/admin/MessageComposer";
import { CampaignList, isCampaignsNotReady, type CampaignListState, type CampaignLite } from "@/components/admin/CampaignList";

type Tab = "new" | "campaigns";
type Who = "single" | "campaign";
interface UserHit { id: string; name: string; email: string }

const TABS: Array<[Tab, string]> = [["new", "رسالة جديدة"], ["campaigns", "الحملات"]];
const WHO: Array<[Who, string]> = [["single", "عميل واحد"], ["campaign", "حملة"]];
const INPUT = "min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none";
const BTN = "min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink";

/**
 * «الرسائل والحملات» (DT-20261118-06 phase 2A): «رسالة جديدة» (one customer, through the existing single-customer route, or a campaign draft) and «الحملات»
 * (the saved drafts). The tab is in the address (?tab=campaigns). No campaign reaches a customer from this page in this update.
 */
export default function AdminMessagesPage() {
  const [tab, setTab] = useState<Tab>("new");
  const [who, setWho] = useState<Who>("single");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<UserHit[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [person, setPerson] = useState<UserHit | null>(null);
  const [editing, setEditing] = useState<CampaignLite | null>(null);
  const [list, setList] = useState<CampaignListState>({ kind: "loading" });

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "campaigns") setTab("campaigns");
  }, []);
  const pick = (t: Tab) => {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === "new") url.searchParams.delete("tab"); else url.searchParams.set("tab", t);
    window.history.replaceState(null, "", url.toString());
  };

  const load = useCallback(async () => {
    setList({ kind: "loading" });
    try {
      const r = await adminFetch<{ campaigns: CampaignLite[] }>("/api/admin/campaigns");
      setList({ kind: "ready", rows: Array.isArray(r.campaigns) ? r.campaigns : [] });
    } catch (e) {
      setList(isCampaignsNotReady(e) ? { kind: "notReady" } : { kind: "error", message: e instanceof Error ? e.message : "تعذّر تحميل الحملات." });
    }
  }, []);
  useEffect(() => { if (tab === "campaigns") void load(); }, [tab, load]);

  useEffect(() => {
    const term = q.trim();
    if (who !== "single" || term.length < 2) { setHits(null); setSearchError(""); return; }
    let alive = true;
    const t = setTimeout(() => {
      adminFetch<{ users: UserHit[] }>(`/api/admin/users?filter=all&page=1&q=${encodeURIComponent(term)}`)
        .then((r) => { if (alive) { setHits((r.users ?? []).slice(0, 8)); setSearchError(""); } })
        .catch((e) => { if (alive) { setHits(null); setSearchError(e instanceof Error ? e.message : "تعذّر البحث."); } });
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [q, who]);

  const open = (c: CampaignLite) => { setEditing(c); setWho("campaign"); pick("new"); };

  return (
    <div data-screen-label="Messages" className="flex flex-col gap-3">
      <SubTabs label="الرسائل والحملات" value={tab} items={TABS} onChange={pick} idPrefix="messages" />

      {tab === "new" && (
        <div role="tabpanel" aria-labelledby="messages-new" className="flex flex-col gap-3">
          <Card title="المستلمون">
            <SubTabs label="المستلمون" value={who} items={WHO} onChange={(w) => { setWho(w); if (w === "campaign") setPerson(null); }} idPrefix="messages-who" />
            {who === "single" && !person && (
              <div className="flex flex-col gap-2">
                <label htmlFor="messages-search" className="text-xs text-mut">ابحث عن عميل بالاسم أو البريد</label>
                <input id="messages-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-describedby={searchError ? "messages-search-err" : undefined} className={INPUT} />
                {searchError && <p id="messages-search-err" role="alert" className="m-0 text-xs text-bad">{searchError}</p>}
                {hits && hits.length === 0 && <p role="status" className="m-0 text-xs text-mut">لا يوجد مستخدمون مطابقون للبحث.</p>}
                {hits && hits.length > 0 && (
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {hits.map((u) => (
                      <li key={u.id}>
                        <button type="button" onClick={() => setPerson(u)} className="flex min-h-11 w-full cursor-pointer flex-col items-start justify-center rounded-xl border border-ln bg-sf px-3 py-1.5 text-start">
                          <span className="text-[13px] font-semibold text-ink">{u.name || "بدون اسم"}</span>
                          <span dir="ltr" className="text-xs text-mut">{u.email}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {who === "single" && person && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] text-ink">إلى: <span className="font-semibold">{person.name || "بدون اسم"}</span></span>
                <button type="button" onClick={() => setPerson(null)} className={BTN}>تغيير</button>
              </div>
            )}
            {who === "campaign" && editing && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] text-ink">تعديل: <span className="font-semibold">{editing.name}</span></span>
                <button type="button" onClick={() => setEditing(null)} className={BTN}>حملة جديدة</button>
              </div>
            )}
          </Card>
          {who === "single" && person && <Card title="الرسالة"><MessageComposer key={person.id} mode="single" userId={person.id} /></Card>}
          {who === "campaign" && <Card title="الرسالة"><MessageComposer key={editing?.id ?? "new"} mode="campaign" campaign={editing} /></Card>}
        </div>
      )}

      {tab === "campaigns" && (
        <div role="tabpanel" aria-labelledby="messages-campaigns">
          <Card title="الحملات">
            <CampaignList state={list} onOpen={open} onRetry={() => void load()} />
          </Card>
        </div>
      )}
    </div>
  );
}
