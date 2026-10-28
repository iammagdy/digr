import { currentLineAr, FILES_STEP_TITLE_AR, FINAL_STEP_LABEL_AR, REVIEW_STEP_TITLE_AR, type PanelStep } from "./missionView";
import { formatAr } from "./arabicDigits";
import type { MissionPanelContent } from "../components/mission/MissionPlanPanel";

/**
 * The three things the panel can show, as pure functions of what the server answered: the planning steps (before there is a plan), the PROPOSED plan's stages (a plan card is on the table, nothing
 * approved yet), and the running or finished mission. The page decides which one applies; none of them holds a text of its own beyond the fixed words of the steps.
 */
export const PANEL_TITLE_AR = "خطة المهمة";
/** Polling: every 2 to 3 seconds while the page is visible, slower when it is hidden. */
export const PANEL_POLL_VISIBLE_MS = 2500;
export const PANEL_POLL_HIDDEN_MS = 12000;
export const panelPollDelayMs = (hidden: boolean): number => (hidden ? PANEL_POLL_HIDDEN_MS : PANEL_POLL_VISIBLE_MS);

/** The stages of the model-planned plan on a quote card (its items carry the stored plan), or null when the plan is not a model-planned mission. */
export function stagesOfPlanQuote(quote: { items?: Array<{ params?: Record<string, any> }> } | null | undefined): Array<{ titleAr: string; effVolume: number; deliver: boolean; perParent?: number; askedPerParent?: number }> | null {
  const stored = quote?.items?.[0]?.params?._modelStep;
  const stages = stored?.stages;
  if (!stored || !Array.isArray(stages) || stages.length === 0 || stages.length !== stored.steps?.length) return null;
  return stages.map((s: any) => ({ titleAr: String(s.titleAr || ""), effVolume: Number(s.effVolume) || 0, deliver: Boolean(s.deliver), ...(Number(s.perParent) > 0 ? { perParent: Number(s.perParent) } : {}), ...(Number(s.askedPerParent) > 0 ? { askedPerParent: Number(s.askedPerParent) } : {}) }));
}

/** The proposed plan as steps, all waiting: what the mission WILL do once the customer approves, with the same counts the card shows (one source: the stored plan's stages). */
export function proposedPlanSteps(stages: ReadonlyArray<{ titleAr: string; effVolume?: number; deliver?: boolean }>): PanelStep[] {
  const steps: PanelStep[] = stages.map((s, i) => ({
    id: `stage-${i + 1}`, titleAr: s.titleAr, state: "waiting" as const,
    ...(s.effVolume && s.effVolume > 0 ? { detailAr: `حتى ${formatAr(s.effVolume)} صفًا ${s.deliver === false ? "تُستخدم في المرحلة التالية" : "يصلك"}` } : {}),
  }));
  steps.push({ id: "review", titleAr: REVIEW_STEP_TITLE_AR, detailAr: FINAL_STEP_LABEL_AR, state: "waiting" }, { id: "files", titleAr: FILES_STEP_TITLE_AR, detailAr: FINAL_STEP_LABEL_AR, state: "waiting" });
  return steps;
}

export function contentFromPlanQuote(quote: Parameters<typeof stagesOfPlanQuote>[0]): MissionPanelContent | null {
  const stages = stagesOfPlanQuote(quote);
  if (!stages) return null;
  const steps = proposedPlanSteps(stages);
  return { title: PANEL_TITLE_AR, steps, currentLineAr: currentLineAr(steps), live: false };
}

export interface PlanningResponse { steps?: PanelStep[]; currentLineAr?: string; finished?: "plan" | "asked" | "stopped" | null }

/** The planning steps, shown only once the planner has begun to look for sources (a plain question never opens the panel) and not after it answered with a question or gave up. */
export function contentFromPlanning(response: PlanningResponse | null | undefined, startedAt?: number): MissionPanelContent | null {
  if (!response?.steps || response.steps.length === 0) return null;
  if (response.finished === "asked" || response.finished === "stopped") return null;
  const began = response.steps.some((s) => s.id === "plan-2" && s.state === "done");
  if (!began) return null;
  return { title: PANEL_TITLE_AR, steps: response.steps, currentLineAr: response.currentLineAr || currentLineAr(response.steps), live: response.finished !== "plan", startedAt };
}

export interface MissionStatusResponse {
  mission?: boolean;
  phase?: string;
  view?: { steps: PanelStep[]; currentLineAr: string; delayAr: string | null; remainingAr?: string | null } | null;
  latest?: { stageTitleAr: string; columns: Array<{ key: string; titleAr: string }>; rows: string[][] } | null;
  notes?: Array<{ kind: string; textAr: string }>;
  startedAt?: number | null;
  summaryAr?: string[];
}

const NOTE_KINDS = new Set(["source_replaced", "stage_stopped", "final_ok", "final_gap", "review_partial"]);

/** The running or finished mission. `closePageAr` is passed only while the background driver is really live (the friendly sentence), never otherwise. */
export function contentFromMission(status: MissionStatusResponse | null | undefined, opts: { closePageAr?: string | null } = {}): MissionPanelContent | null {
  if (!status?.mission || !status.view) return null;
  const live = status.phase === "running" || status.phase === "queued";
  const notesAr = (status.notes ?? []).filter((n) => NOTE_KINDS.has(n.kind)).map((n) => n.textAr).slice(-3);
  return {
    title: PANEL_TITLE_AR, steps: status.view.steps, currentLineAr: status.view.currentLineAr, delayAr: status.view.delayAr, remainingAr: live ? status.view.remainingAr ?? null : null,
    latest: status.latest ?? null, notesAr, closePageAr: live ? opts.closePageAr ?? null : null, startedAt: status.startedAt ?? undefined, live, summaryAr: live ? [] : status.summaryAr ?? [],
  };
}
