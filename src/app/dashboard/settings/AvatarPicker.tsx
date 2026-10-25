"use client";

import { useRef, useState } from "react";
import { Avatar } from "@/components/app/Avatar";
import { AVATAR_MESSAGES_AR, AVATAR_TYPES } from "@/lib/avatar";
import { useAvatar } from "@/lib/avatarClient";

/** The picture row of the profile card. The buttons exist only when the picture feature is ready (see avatarClient); otherwise the letter circle shows alone. */
export function AvatarPickerView({ letters, url, supported, busy, message, onPick, onRemove }: {
  letters: string; url: string | null; supported: boolean; busy: boolean; message: { ok: boolean; text: string } | null;
  onPick: (file: File) => void; onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2" data-testid="avatar-picker">
      <div className="flex items-center gap-3.5">
        <Avatar letters={letters} url={url} size={60} fontSize={19} />
        {supported && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => input.current?.click()} disabled={busy} data-testid="avatar-change" className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] font-semibold text-ink disabled:opacity-60">
              {busy ? "جاري الحفظ..." : url ? "تغيير الصورة" : "إضافة صورة"}
            </button>
            {url && (
              <button type="button" onClick={onRemove} disabled={busy} data-testid="avatar-remove" className="min-h-11 cursor-pointer rounded-full border-0 bg-transparent px-3 text-[13px] text-bad disabled:opacity-60">حذف الصورة</button>
            )}
            <input
              ref={input} type="file" accept={AVATAR_TYPES.join(",")} className="sr-only" tabIndex={-1} aria-label="اختيار صورة الحساب" data-testid="avatar-input"
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onPick(file); }}
            />
          </div>
        )}
      </div>
      {supported && <p className="m-0 text-xs text-fnt">{AVATAR_MESSAGES_AR.hint}</p>}
      {message && <p role={message.ok ? "status" : "alert"} className={`m-0 text-[13px] ${message.ok ? "text-ok" : "text-bad"}`}>{message.text}</p>}
    </div>
  );
}

export function AvatarPicker({ userId, letters }: { userId: string; letters: string }) {
  const avatar = useAvatar(userId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (job: () => Promise<{ ok: true } | { ok: false; problem: keyof typeof AVATAR_MESSAGES_AR }>, done: string, failed?: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result = await job();
    setMessage(result.ok ? { ok: true, text: done } : { ok: false, text: failed ?? AVATAR_MESSAGES_AR[result.problem] });
    setBusy(false);
  };
  return (
    <AvatarPickerView
      letters={letters} url={avatar.url} supported={avatar.status === "ready"} busy={busy} message={message}
      onPick={(file) => void run(() => avatar.upload(file), AVATAR_MESSAGES_AR.saved)}
      onRemove={() => void run(() => avatar.remove(), AVATAR_MESSAGES_AR.removed, AVATAR_MESSAGES_AR.removeFailed)}
    />
  );
}
