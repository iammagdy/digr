"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  AVATAR_BUCKET, AVATAR_MAX_SIDE, avatarObjectPath, classifyUploadError, fitWithin, isOwnAvatarPath, validateAvatarResult, validateAvatarSource,
  type AvatarProblem,
} from "@/lib/avatar";

/**
 * The profile picture in the browser. Everything degrades to «no picture» (the letter circle): until the owner has applied the SQL (the
 * `avatar_path` column and the private bucket) the control is hidden (`status: "unsupported"`) and nothing throws.
 */
type Client = Pick<ReturnType<typeof createClient>, "from" | "storage">;

export interface AvatarState {
  /** loading: not read yet; unsupported: the column is missing, so the upload control is hidden; ready: the control may show. */
  status: "loading" | "unsupported" | "ready";
  /** A short-lived signed address of the picture, or null (the letter circle shows). */
  url: string | null;
}

const SIGNED_URL_SECONDS = 3600;
const UNSUPPORTED_FLAG = "diger_avatar_unsupported";

let state: AvatarState = { status: "loading", url: null };
let loadedFor: string | null = null;
let currentPath: string | null = null;
const listeners = new Set<() => void>();

function publish(next: AvatarState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function flagged(): boolean {
  try { return sessionStorage.getItem(UNSUPPORTED_FLAG) === "1"; } catch { return false; }
}
function setFlag() {
  try { sessionStorage.setItem(UNSUPPORTED_FLAG, "1"); } catch { /* no storage: the check just runs again next time */ }
}

async function signedUrl(client: Client, path: string): Promise<string | null> {
  try {
    const { data, error } = await client.storage.from(AVATAR_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    return error || !data?.signedUrl ? null : data.signedUrl;
  } catch {
    return null;
  }
}

/** Reads the saved picture of this user (one small read of the profile row, one signed address). Never throws. */
export async function loadAvatar(client: Client, userId: string): Promise<AvatarState> {
  loadedFor = userId;
  if (flagged()) { currentPath = null; publish({ status: "unsupported", url: null }); return state; }
  try {
    const { data, error } = await client.from("profiles").select("avatar_path").eq("id", userId).maybeSingle();
    if (error) {
      // a missing column answers with 42703 (undefined_column): remembered for this tab, so the page does not ask again on every screen
      if (String((error as { code?: string }).code) === "42703" || /avatar_path/i.test(String(error.message))) setFlag();
      currentPath = null;
      publish({ status: "unsupported", url: null });
      return state;
    }
    const path = (data as { avatar_path?: unknown } | null)?.avatar_path;
    currentPath = isOwnAvatarPath(userId, path) ? path : null;
    publish({ status: "ready", url: currentPath ? await signedUrl(client, currentPath) : null });
  } catch {
    currentPath = null;
    publish({ status: "unsupported", url: null });
  }
  return state;
}

/** Shrinks the picked picture in the browser: the longest side at most 512 px, WebP (JPEG where WebP cannot be written), white behind a JPEG. */
export async function downscaleToBlob(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, AVATAR_MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const encode = (type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    const webp = await encode("image/webp", 0.86);
    if (webp && webp.type === "image/webp") return webp;
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    return await encode("image/jpeg", 0.88);
  } catch {
    return null;
  }
}

export type AvatarResult = { ok: true } | { ok: false; problem: AvatarProblem };

/** Checks, shrinks and uploads the picture, then saves its path on the profile. The previous object (another extension) is removed. */
export async function uploadAvatar(client: Client, userId: string, file: File, shrink: (file: File) => Promise<Blob | null> = downscaleToBlob): Promise<AvatarResult> {
  const first = validateAvatarSource(file);
  if (first) return { ok: false, problem: first };
  const blob = await shrink(file);
  if (!blob) return { ok: false, problem: "unreadable" };
  const second = validateAvatarResult(blob);
  if (second) return { ok: false, problem: second };
  const path = avatarObjectPath(userId, blob.type);
  if (!path) return { ok: false, problem: "unreadable" };
  try {
    const bucket = client.storage.from(AVATAR_BUCKET);
    const up = await bucket.upload(path, blob, { upsert: true, contentType: blob.type, cacheControl: "3600" });
    if (up.error) return { ok: false, problem: classifyUploadError(up.error as { message?: string }) };
    const saved = await client.from("profiles").update({ avatar_path: path }).eq("id", userId);
    if (saved.error) {
      if (path !== currentPath) await bucket.remove([path]).catch(() => undefined);
      return { ok: false, problem: "unavailable" };
    }
    const previous = currentPath;
    currentPath = path;
    if (previous && previous !== path && isOwnAvatarPath(userId, previous)) await bucket.remove([previous]).catch(() => undefined);
    publish({ status: "ready", url: await signedUrl(client, path) });
    return { ok: true };
  } catch {
    return { ok: false, problem: "failed" };
  }
}

/** Removes the picture: the object first, then the path on the profile. The letter circle shows again. */
export async function removeAvatar(client: Client, userId: string): Promise<AvatarResult> {
  try {
    const path = currentPath;
    if (path && isOwnAvatarPath(userId, path)) {
      const gone = await client.storage.from(AVATAR_BUCKET).remove([path]);
      if (gone.error) return { ok: false, problem: "failed" };
    }
    const saved = await client.from("profiles").update({ avatar_path: null }).eq("id", userId);
    if (saved.error) return { ok: false, problem: "failed" };
    currentPath = null;
    publish({ status: "ready", url: null });
    return { ok: true };
  } catch {
    return { ok: false, problem: "failed" };
  }
}

/** Forgets what was read (a different person signed in, or the test reset). */
export function resetAvatarForTesting() {
  state = { status: "loading", url: null };
  loadedFor = null;
  currentPath = null;
  try { sessionStorage.removeItem(UNSUPPORTED_FLAG); } catch { /* none */ }
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const LOADING: AvatarState = { status: "loading", url: null };

/** The picture of the signed-in user, shared by every place that shows the letter circle (the sidebar and the settings page). */
export function useAvatar(userId: string | undefined) {
  const shared = useSyncExternalStore(subscribe, () => state, () => LOADING);
  // another person signed in on this tab: nothing of the previous picture shows while the new one is read
  const snapshot = userId && loadedFor !== userId ? LOADING : shared;
  useEffect(() => {
    if (!userId || loadedFor === userId) return;
    void loadAvatar(createClient(), userId);
  }, [userId]);
  return {
    ...snapshot,
    upload: (file: File) => uploadAvatar(createClient(), userId ?? "", file),
    remove: () => removeAvatar(createClient(), userId ?? ""),
    hasPicture: !!snapshot.url,
  };
}
