"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { customerFacingFailure, readChatResponse, TEMPORARY_FAILURE_NO_CHARGE_AR } from "@/lib/customerError";
import type { CalculatorCard } from "@/lib/missionEstimate";
import { MISSION_READ_LIMIT_MS, startMissionPolling } from "@/lib/missionPoller";
import { createClient } from "@/lib/supabase/client";

interface CalculatorConversation {
  id: string;
  isGuest: boolean;
  replyScope: "single" | "split";
  text: string;
  missionIds: string[];
}

interface OwnedCard {
  missionId: string;
  card: CalculatorCard;
}

// The owned read route accepts up to six mission IDs per request.
const POLL_BATCH_SIZE = 6;
const PLAN_LIMIT_AR = "لو كان الحجز أعلى من الحد المتاح، افتح الخطة لمراجعة العدد المناسب.";
const textField = "min-h-12 w-full rounded-[14px] border border-ln2 bg-bg px-3.5 py-3 text-[15px] text-ink outline-none focus:border-ac";
const primary = "inline-flex min-h-11 items-center self-start rounded-full bg-ac px-5 text-sm text-onac no-underline disabled:opacity-50";
const terminal = (phase: CalculatorCard["phase"]) => ["running", "done", "partial", "unserved", "failed", "cancelled"].includes(phase);

async function chatHeaders(): Promise<Record<string, string>> {
  const { data } = await createClient().auth.getSession();
  const token = data.session?.access_token;
  return token ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` } : { "Content-Type": "application/json" };
}

function toConversation(data: Record<string, unknown>, previous: CalculatorConversation | null, cards: OwnedCard[]): CalculatorConversation {
  const id = data.conversationId;
  const scope = data.calculatorReplyScope;
  if (data.planning || data.planQuote || data.revisionQuote || typeof data.contentAr !== "string" ||
      typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
      (scope !== "single" && scope !== "split") || (previous && previous.id !== id)) {
    throw new Error("Invalid calculator turn");
  }
  const marker = data.agentMission as { id?: unknown } | undefined;
  const parts = Array.isArray(data.agentMissionParts) ? data.agentMissionParts : [];
  const ids = [marker?.id, ...parts.map((part) => part?.id)]
    .filter((value): value is string => typeof value === "string" && /^msn_[a-z0-9]{8,40}$/.test(value));
  const retained = previous?.missionIds.filter((missionId) => !cards.some((item) => item.missionId === missionId && terminal(item.card.phase))) ?? [];
  return { id, isGuest: data.isGuest === true, replyScope: scope, text: data.contentAr, missionIds: [...new Set([...retained, ...ids])] };
}

function CalculatorPriceCard({ card }: { card: CalculatorCard }) {
  const limited = card.limit?.over || (card.affordability !== undefined && card.affordability.mode !== "ready");
  return (
    <article className="flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-5" data-testid="estimate-result">
      {card.summaryAr ? <h3 className="m-0 text-lg text-ink">{card.summaryAr}</h3> : null}
      {card.countLinesAr.map((line) => <p key={line} className="m-0 text-sm text-ink2">{line}</p>)}
      {card.countLinesAr.length === 0 && card.stages.filter((stage) => stage.deliver).map((stage, index) => (
        <p key={index} className="m-0 text-sm text-ink2">{stage.titleAr} · {stage.rowsAr}</p>
      ))}
      {[...card.assumptionsAr, ...card.unservedAr].map((line, index) => <p key={index} className="m-0 text-sm text-mut">{line}</p>)}
      {card.priceFacts.length > 0 ? (
        <dl className="m-0 grid grid-cols-1 gap-2 min-[560px]:grid-cols-2">
          {card.priceFacts.map(({ labelAr, valueAr }) => (
            <div key={labelAr} className="rounded-[14px] border border-ln p-3">
              <dt className="text-sm text-mut">{labelAr}</dt>
              <dd className="m-0 mt-1 font-medium text-ink">{valueAr}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="m-0 text-sm text-ink2">{card.questionAr || card.currentLineAr}</p>}
      {card.priceNoteAr ? <p className="m-0 text-sm text-ink2">{card.priceNoteAr}</p> : null}
      {limited ? <p className="m-0 text-sm text-ink2">{PLAN_LIMIT_AR}</p> : null}
    </article>
  );
}

export default function MissionEstimator() {
  const [text, setText] = useState("");
  const [reply, setReply] = useState("");
  const [conversation, setConversation] = useState<CalculatorConversation | null>(null);
  const [cards, setCards] = useState<OwnedCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitController = useRef<AbortController | null>(null);

  useEffect(() => () => submitController.current?.abort(), []);
  useEffect(() => {
    if (!conversation?.missionIds.length) return;
    const lifetime = new AbortController();
    let active = true;
    let ended = false;
    let delay = 3_000;
    const ids = conversation.missionIds;
    const stop = startMissionPolling({
      keepGoing: () => !ended,
      nextDelayMs: () => delay,
      read: async () => {
        const timed = AbortSignal.any([lifetime.signal, AbortSignal.timeout(MISSION_READ_LIMIT_MS)]);
        const headers = await chatHeaders();
        const next: OwnedCard[] = [];
        for (let start = 0; start < ids.length; start += POLL_BATCH_SIZE) {
          const missionIds = ids.slice(start, start + POLL_BATCH_SIZE);
          const response = await fetch("/api/calculator/estimate", {
            method: "POST", headers, body: JSON.stringify({ missionIds }), signal: timed,
          });
          if (response.status === 429) {
            const seconds = Number(response.headers.get("Retry-After"));
            delay = seconds > 0 && Number.isFinite(seconds) ? seconds * 1_000 : 15_000;
            return;
          }
          if ([401, 403, 404].includes(response.status)) {
            if (active) {
              setCards([]);
              setError(TEMPORARY_FAILURE_NO_CHARGE_AR);
              ended = true;
            }
            return;
          }
          const data = await readChatResponse(response);
          if (!Array.isArray(data.cards) || data.cards.length !== missionIds.length ||
              data.cards.some((item: OwnedCard, index: number) => item.missionId !== missionIds[index])) {
            throw new Error("Invalid calculator readback");
          }
          next.push(...data.cards);
        }
        if (!active || timed.aborted) return;
        setCards(next);
        delay = next.some(({ card }) => card.phase === "waiting" || card.phase === "planning") ? 3_000 : 15_000;
        ended = next.every(({ card }) => terminal(card.phase));
      },
    });
    return () => { active = false; lifetime.abort(); stop(); };
  }, [conversation]);

  async function submit(value: string, previous: CalculatorConversation | null) {
    const message = value.trim();
    if (!message || submitController.current) return;
    const controller = new AbortController();
    submitController.current = controller;
    setBusy(true);
    setError(null);
    if (!previous) {
      setConversation(null);
      setCards([]);
      setReply("");
    }
    try {
      const headers = await chatHeaders();
      const response = await fetch("/api/chat", {
        method: "POST", headers, signal: controller.signal,
        body: JSON.stringify({
          source: "calculator", message,
          ...(previous ? { conversationId: previous.id } : {}),
          ...(!headers.Authorization ? { isGuest: true } : {}),
        }),
      });
      const data = await readChatResponse(response);
      if (!controller.signal.aborted) {
        setConversation(toConversation(data, previous, cards));
        setReply("");
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(customerFacingFailure(cause, { noCharge: true }).text);
    } finally {
      submitController.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const oneQuestion = cards.length === 1 && cards[0].card.phase === "question" ? cards[0].card : null;
  const canReply = conversation?.replyScope === "single" && (conversation.missionIds.length === 0 || oneQuestion !== null);
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(text, null);
  };

  return (
    <section data-testid="mission-estimator" className="flex flex-col gap-5 rounded-[22px] border border-ln bg-sf p-5 min-[560px]:p-6">
      <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <label htmlFor="estimate-request" className="text-sm font-medium text-ink">اكتب طلب البحث</label>
        <textarea id="estimate-request" rows={3} className={textField} value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className={primary} disabled={busy || !text.trim()}>جهّز خطتي</button>
      </form>
      {error ? <p role="alert" className="m-0 text-sm text-ink">{error}</p> : null}
      {conversation ? (
        <div role="status" className="flex flex-col gap-3">
          <p className="m-0 whitespace-pre-line text-sm text-ink2">{conversation.text}</p>
          {cards.map(({ missionId, card }) => <CalculatorPriceCard key={missionId} card={card} />)}
          {canReply ? (
            <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void submit(reply, conversation); }}>
              {oneQuestion?.questionOptionsAr.map((option) => (
                <button className="min-h-11 self-start rounded-full border border-ln px-4 text-sm" key={option} type="button" disabled={busy} onClick={() => void submit(option, conversation)}>{option}</button>
              ))}
              <label htmlFor="estimate-reply" className="text-sm font-medium text-ink">أرسل الإجابة</label>
              <input id="estimate-reply" className={textField} value={reply} onChange={(event) => setReply(event.target.value)} />
              <button className={primary} disabled={busy || !reply.trim()}>أرسل الإجابة</button>
            </form>
          ) : null}
          {conversation.isGuest
            ? <Link href="/register" className={primary}>سجّل لتعتمد</Link>
            : <Link href={`/dashboard/chat?c=${encodeURIComponent(conversation.id)}`} className={primary}>افتح الخطة في المحادثة</Link>}
        </div>
      ) : null}
    </section>
  );
}
