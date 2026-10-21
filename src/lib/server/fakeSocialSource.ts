/**
 * A deterministic TikTok-like source for the pressure test (see fakeProviderMode.ts): a keyword search that lists videos and a
 * cursor-paged comment feed per video, with a small configurable delay. Only TikTok search and comments are served; anything else
 * answers «not served» so a test never mistakes the fake for another service. Pure apart from the delay.
 */
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "./socialAdapter";
import { createBuiltInMockAdapter, type ProviderAdapterFn } from "./tregAdapter";
import { getSocialCapability } from "../socialSources";

const VIDEO_ID_PREFIX = "7300000000000";

export interface FakeSocialOptions {
  commentsPerVideo: number;
  videos: number;
  pageSize: number;
  latencyMs: number;
}

export function fakeSocialOptionsFromEnv(env: Record<string, string | undefined> = process.env): FakeSocialOptions {
  const num = (value: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return {
    commentsPerVideo: num(env.FAKE_PROVIDER_COMMENTS_PER_VIDEO, 200, 1, 2000),
    videos: num(env.FAKE_PROVIDER_VIDEOS, 40, 1, 200),
    pageSize: num(env.FAKE_PROVIDER_PAGE_SIZE, 20, 10, 50),
    latencyMs: num(env.FAKE_PROVIDER_LATENCY_MS, 250, 0, 5000),
  };
}

export function createFakeSocialCall(options: FakeSocialOptions = fakeSocialOptionsFromEnv()): SocialCall {
  let callNumber = 0;
  return async (source, params, context): Promise<SocialCallOutcome> => {
    callNumber += 1;
    const id = `fake${callNumber}`;
    if (options.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(options.latencyMs, Math.max(0, context.timeoutMs - 50))));
    const pageSize = Math.min(options.pageSize, source.maxPerCall || options.pageSize);
    if (/tiktok/.test(source.endpointId) && /search/.test(source.endpointId)) {
      const offset = Number(params.offset ?? params.cursor ?? 0);
      const count = Math.min(Number(params.count ?? pageSize), pageSize);
      const videos = Array.from({ length: Math.max(0, Math.min(count, options.videos - offset)) }, (_, i) => ({
        aweme_id: `${VIDEO_ID_PREFIX}${String(offset + i).padStart(6, "0")}`, desc: `فيديو ${offset + i} عن موضوع البحث`, play_count: 100000 - offset - i,
      }));
      return { ok: true, httpStatus: 200, data: { data: { videos } }, costMicro: 0, tregCallId: id };
    }
    if (/tiktok/.test(source.endpointId) && /comments/.test(source.endpointId)) {
      const video = Number(String(params.aweme_id ?? "").slice(VIDEO_ID_PREFIX.length) || 0);
      const cursor = Number(params.cursor ?? 0);
      const count = Math.min(Number(params.count ?? pageSize), pageSize);
      const end = Math.min(options.commentsPerVideo, cursor + count);
      const comments = Array.from({ length: Math.max(0, end - cursor) }, (_, i) => {
        const n = cursor + i;
        return { cid: `c_${video}_${n}`, comment_id: `c_${video}_${n}`, text: `تعليق رقم ${n} على الفيديو ${video} عن موضوع البحث`, create_time: 1_790_000_000 + n, digg_count: n % 7 };
      });
      return { ok: true, httpStatus: 200, data: { data: { comments, cursor: end, has_more: end < options.commentsPerVideo ? 1 : 0 } }, costMicro: 0, tregCallId: id };
    }
    return { ok: false, httpStatus: 404, data: null, costMicro: 0, tregCallId: id, errorCode: "fake_provider_not_served", errorMessageAr: "هذا المصدر غير متاح في وضع الاختبار." };
  };
}

/** Social jobs run the REAL social chunk runner on the fake source; every other kind of job (companies, people) uses the built-in mock. */
export function createFakeProviderAdapter(options?: FakeSocialOptions): ProviderAdapterFn {
  const call = createFakeSocialCall(options);
  const other = createBuiltInMockAdapter({});
  return (input) => (getSocialCapability(input.capabilitySlug) ? runSocialChunk(input, { call }) : other(input));
}
