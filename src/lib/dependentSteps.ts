import { z } from "zod";
import { toArabicDigits } from "./arabicDigits";
import { DISCOVER_VIDEOS_PER_CHANNEL, MAX_MISSION_VIDEOS, channelsOf } from "./socialSources";

/**
 * Dependent steps of one mission (channels -> top videos -> comments) as ONE plan.
 *
 * The validation is the sound, pure core of the unmerged `feat/dependent-plans` branch (backward-only dependencies, stable
 * unique ids, a bounded fan-out, bounded volumes, an open-ended step must carry an explicit cap), ported to the current
 * codebase without its Appwrite coupling. A mission runs as a SINGLE job item: the worker's social adapter reads the
 * channels, ranks and keeps the top videos, then collects their comments inside one chunked job, so the existing
 * one-item reserve / settle / release path is used unchanged. These steps describe and validate that plan.
 */
export const MAX_DEPENDENT_STEPS = 8;
/** Largest fan-out from one step into the next. Larger than the branch's 50: a mission's video list travels in the chunk cursor, so it is capped at MAX_MISSION_VIDEOS. */
export const MAX_FAN_OUT = MAX_MISSION_VIDEOS;
export const MAX_STEP_VOLUME = 5000;

const StepId = z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/);

export const DependentStepSchema = z.object({
  stepId: StepId,
  capabilitySlug: z.string().min(1).max(96),
  params: z.record(z.string(), z.unknown()),
  targetVolumeMin: z.number().int().min(1).max(MAX_STEP_VOLUME),
  targetVolumeMax: z.number().int().min(1).max(MAX_STEP_VOLUME),
  dependsOn: z.array(StepId).max(4).optional(),
  inputFrom: z.object({ stepId: StepId, field: z.string().min(1).max(64), paramKey: z.string().min(1).max(64) }).strict().optional(),
  fanOutCap: z.number().int().min(1).max(MAX_FAN_OUT).optional(),
  volumeMode: z.enum(["bounded", "open_ended"]).optional(),
}).strict();

export type DependentStep = z.infer<typeof DependentStepSchema>;

export function validateDependentSteps(steps: readonly DependentStep[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (steps.length === 0) return { valid: false, errors: ["الخطة بلا خطوات."] };
  if (steps.length > MAX_DEPENDENT_STEPS) errors.push(`الحد الأقصى ${toArabicDigits(MAX_DEPENDENT_STEPS)} خطوات للخطة الواحدة.`);
  const parsed = steps.map((step) => DependentStepSchema.safeParse(step));
  parsed.forEach((result, index) => {
    if (!result.success) errors.push(`بيانات الخطوة ${toArabicDigits(index + 1)} غير صالحة.`);
  });
  if (parsed.some((result) => !result.success)) return { valid: false, errors };

  const ids = steps.map((step) => step.stepId);
  if (new Set(ids).size !== ids.length) errors.push("معرّفات الخطوات يجب أن تكون فريدة.");
  const position = new Map(ids.map((id, index) => [id, index]));
  steps.forEach((step, index) => {
    if (step.targetVolumeMin > step.targetVolumeMax) errors.push(`الحد الأدنى في الخطوة ${toArabicDigits(index + 1)} أكبر من الحد الأقصى.`);
    const dependencies = step.dependsOn || [];
    if (new Set(dependencies).size !== dependencies.length) errors.push(`تكرار في اعتماد الخطوة ${toArabicDigits(index + 1)}.`);
    for (const dependency of dependencies) {
      const at = position.get(dependency);
      if (at === undefined || at >= index) errors.push(`الخطوة ${toArabicDigits(index + 1)} تعتمد على خطوة غير موجودة أو غير سابقة.`);
    }
    if (step.inputFrom) {
      if (!dependencies.includes(step.inputFrom.stepId)) errors.push(`مصدر مدخلات الخطوة ${toArabicDigits(index + 1)} يجب أن يكون ضمن ما تعتمد عليه.`);
      if (!step.fanOutCap) errors.push(`الخطوة ${toArabicDigits(index + 1)} تحتاج سقفًا لعدد ما يتفرع منها.`);
    }
    if (step.volumeMode === "open_ended") errors.push(`الخطوة ${toArabicDigits(index + 1)} مفتوحة الحجم؛ حدّد سقفًا صريحًا قبل عرض السعر.`);
  });
  return { valid: errors.length === 0, errors };
}

/** The two executable stages of a channel mission, as dependent steps: the videos, then the comments of each kept video. */
export function missionSteps(
  platform: "youtube" | "tiktok" | "facebook" | "instagram" | "x" | "reddit" | "linkedin",
  params: Record<string, any>,
  volume: number,
): DependentStep[] {
  const channels = channelsOf(params);
  const top = Math.max(1, Number(params.topPerChannel) || 10);
  const keptVideos = Math.min(MAX_MISSION_VIDEOS, channels.length * top);
  return [
    {
      stepId: "videos",
      capabilitySlug: `social-${platform}-videos`,
      params: { channels, ...(params.rankBy ? { rankBy: params.rankBy } : {}), topPerChannel: top, ...(params.topic ? { topic: params.topic } : {}) },
      targetVolumeMin: 1,
      targetVolumeMax: Math.max(1, keptVideos),
      volumeMode: "bounded",
    },
    {
      stepId: "comments",
      capabilitySlug: `social-${platform}-comments`,
      params: {},
      targetVolumeMin: 1,
      targetVolumeMax: Math.max(1, Math.min(MAX_STEP_VOLUME, Math.floor(volume))),
      dependsOn: ["videos"],
      inputFrom: { stepId: "videos", field: "id", paramKey: "video" },
      fanOutCap: Math.max(1, keptVideos),
      volumeMode: "bounded",
    },
  ];
}

/** The mission's steps in plain Arabic for the plan: what runs, in order, and how far each stage reaches. */
export function missionStepsAr(params: Record<string, any>, volume: number): string[] {
  const channels = channelsOf(params);
  const top = Number(params.topPerChannel) > 0 ? Number(params.topPerChannel) : 0;
  const n = (value: number) => toArabicDigits(value);
  const topic = typeof params.topic === "string" && params.topic.trim() ? `، ونُبقي ما يخص «${params.topic.trim()}» فقط` : "";
  return [
    channels.length > 1 ? `نحدد القنوات المطلوبة (${n(channels.length)} قنوات).` : "نحدد القناة المطلوبة.",
    `نقرأ أحدث ${n(DISCOVER_VIDEOS_PER_CHANNEL)} فيديو متاحًا لكل قناة${params.rankBy === "views" ? " ونرتبها بالمشاهدات" : ""}${topic}${top ? `، ونُبقي أعلى ${n(top)} فيديوهات من كل قناة` : ""}.`,
    `نجمع تعليقات كل فيديو مع رابطه، حتى ${n(Math.floor(volume))} تعليقًا إجمالًا.`,
    "نزيل التكرار وننظم الملف.",
  ];
}
