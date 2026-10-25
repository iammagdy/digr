import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER = { id: "11111111-2222-4333-8444-555555555555", $id: "11111111-2222-4333-8444-555555555555", email: "maha@example.test", name: "مها السيد", emailVerification: true, labels: [], app_metadata: {}, user_metadata: {}, prefs: {} };
vi.mock("../src/hooks/useUser", () => ({ useUser: () => ({ user: USER, loading: false, logout: async () => {} }) }));
vi.mock("../src/hooks/useBalance", () => ({ useBalance: () => ({ balance: { status: "ready", points: 5000 }, refresh: async () => {} }) }));
vi.mock("../src/hooks/useOnline", () => ({ useOnline: () => true }));
vi.mock("../src/hooks/useNotifications", () => ({ useNotifications: () => ({ items: [], unread: 0, actionableUnread: 0, markAllRead: async () => {}, markRead: async () => {}, reload: async () => {} }) }));
vi.mock("../src/lib/theme", () => ({ useTheme: () => ({ theme: "light", toggleTheme: () => {}, setTheme: () => {} }) }));
vi.mock("../src/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}), storage: { from: () => ({}) } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/dashboard/requests" }));

import { AppShell } from "../src/components/app/AppShell";
import { Avatar } from "../src/components/app/Avatar";
import { SIDEBAR_ICONS, UI } from "../src/components/app/icons";
import { AvatarPickerView } from "../src/app/dashboard/settings/AvatarPicker";
import {
  AVATAR_BUCKET, AVATAR_MAX_BYTES, AVATAR_MESSAGES_AR, AVATAR_SOURCE_MAX_BYTES, avatarObjectPath, classifyUploadError, fitWithin, isOwnAvatarPath,
  validateAvatarResult, validateAvatarSource,
} from "../src/lib/avatar";
import { loadAvatar, removeAvatar, resetAvatarForTesting, uploadAvatar } from "../src/lib/avatarClient";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const UID = USER.id;

describe("1. the collapsed sidebar shows the real Diger mark", () => {
  const shell = src("src/components/app/AppShell.tsx");
  it("uses the existing LogoMark (the د + lens symbol, /brand/diger-mark.svg) instead of the letter D, still a link to the home page with an Arabic label", () => {
    expect(shell).toContain('import { Logo, LogoMark } from "@/components/Brand";');
    expect(shell).toContain('<Link href="/" aria-label="ديجر" data-testid="sidebar-mark"');
    expect(shell).toContain("<LogoMark size={32} />");
    expect(shell).not.toMatch(/>D<\/Link>/);
    expect(src("src/lib/brand.ts")).toContain('color: "/brand/diger-mark.svg", white: "/brand/diger-mark-white.svg"');
    // light and dark: the component draws the colour mark and the white one and the theme attribute picks one
    expect(src("src/components/Brand.tsx")).toContain("[[data-theme=dark]_&]:hidden");
  });
  it("the mark files are the supplied brand mark (د stroke in the brand teal, gold lens)", () => {
    const mark = readFileSync(new URL("../public/brand/diger-mark.svg", import.meta.url), "utf8");
    expect(mark).toContain('points="30,14 46,14 46,50 18,50"');
    expect(mark).toContain('stroke="#0E3B43"');
    expect(mark).toContain('stroke="#C8963E"');
  });
  it("the collapsed header stacks the mark and a smaller chevron, so the two fit the 76 px column", () => {
    expect(shell).toContain('"flex min-h-16 flex-col items-center justify-center px-2 py-1"');
    expect(shell).toContain('compactSidebar ? "relative h-6 w-6 after:absolute after:-inset-2" : "h-9 w-9"'); // a small chevron with a 40 px hit area
    expect(shell).toContain('data-testid="sidebar-mark" className="flex h-11 w-11 items-center justify-center"'); // a 44 px target around the 32 px mark
  });
});

describe("3. every sidebar entry has its own icon", () => {
  it("no two entries share an icon, and the icons are the right kind", () => {
    const paths = Object.values(SIDEBAR_ICONS);
    expect(new Set(paths).size).toBe(paths.length);
    expect(SIDEBAR_ICONS.chat).toBe(UI.chat);
    expect(SIDEBAR_ICONS.requests).toBe(UI.folder);
    expect(SIDEBAR_ICONS.wallet).toBe(UI.wallet);
    expect(SIDEBAR_ICONS.settings).toBe(UI.gear);
    expect(SIDEBAR_ICONS.help).toBe(UI.help);
    expect(SIDEBAR_ICONS.newQuestion).toBe(UI.plus);
    // new shapes drawn in the same 24 px set: calculator, grid, headset, shield with a check
    expect(SIDEBAR_ICONS.calculator).toBe(UI.calculator);
    expect(SIDEBAR_ICONS.catalog).toBe(UI.grid);
    expect(SIDEBAR_ICONS.support).toBe(UI.headset);
    expect(SIDEBAR_ICONS.legal).toBe(UI.legal);
    expect(paths).not.toContain(UI.doc); // the file icon is no longer a sidebar icon
  });
  it("the signed-in sidebar draws a different icon for each of its entries (the drawer is the same list)", () => {
    const markup = renderToStaticMarkup(createElement(AppShell, null, createElement("div")));
    const aside = markup.slice(markup.indexOf("<aside"), markup.indexOf("</aside>"));
    const draws = Array.from(aside.matchAll(/<svg[^>]*>(?:<path d="([^"]+)"\/?>)/g)).map((m) => m[1]);
    // new question, six entries, three help links, and the arrow of the account row is a character, not an icon
    for (const path of Object.values(SIDEBAR_ICONS)) expect(draws, path).toContain(path);
    const labelsInOrder = ["المساعد البحثي", "طلباتي", "المحفظة", "حاسبة التكلفة", "كتالوج الخدمات", "الإعدادات", "مركز المساعدة", "تواصل مع الدعم", "الشروط والخصوصية"];
    for (const label of labelsInOrder) expect(aside).toContain(label);
    expect(new Set(draws).size).toBe(draws.length);
  });
  it("the shell takes every icon from SIDEBAR_ICONS (the drawer shares the list)", () => {
    const shell = src("src/components/app/AppShell.tsx");
    for (const key of ["chat", "requests", "wallet", "calculator", "catalog", "settings", "help", "support", "legal", "newQuestion"]) expect(shell).toContain(`SIDEBAR_ICONS.${key}`);
    const lists = shell.slice(shell.indexOf("const navItems"), shell.indexOf("const menu:")) + shell.slice(shell.indexOf("const helpLinks"), shell.indexOf("const sideVisible"));
    expect(lists).not.toMatch(/icon: UI\./); // every entry of the sidebar lists reads its icon from SIDEBAR_ICONS
    expect(shell.match(/const navItems/g)?.length).toBe(1); // one list for the sidebar and the drawer
  });
});

describe("2. the profile picture: the pure parts", () => {
  it("path, checks and limits follow the storage design", () => {
    expect(AVATAR_BUCKET).toBe("avatars");
    expect(AVATAR_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(avatarObjectPath(UID, "image/jpeg")).toBe(`${UID}/avatar.jpg`);
    expect(avatarObjectPath(UID, "image/png")).toBe(`${UID}/avatar.png`);
    expect(avatarObjectPath(UID, "image/webp")).toBe(`${UID}/avatar.webp`);
    expect(avatarObjectPath(UID, "image/gif")).toBeNull();
    expect(isOwnAvatarPath(UID, `${UID}/avatar.webp`)).toBe(true);
    expect(isOwnAvatarPath(UID, `other-user/avatar.webp`)).toBe(false);
    expect(isOwnAvatarPath(UID, `${UID}/../x/avatar.webp`)).toBe(false);
    expect(isOwnAvatarPath(UID, `${UID}/avatar.gif`)).toBe(false);
    expect(isOwnAvatarPath(UID, null)).toBe(false);
    expect(validateAvatarSource({ type: "image/gif", size: 1000 })).toBe("type");
    expect(validateAvatarSource({ type: "application/pdf", size: 1000 })).toBe("type");
    expect(validateAvatarSource({ type: "image/png", size: 0 })).toBe("unreadable");
    expect(validateAvatarSource({ type: "image/png", size: AVATAR_SOURCE_MAX_BYTES + 1 })).toBe("too_large");
    expect(validateAvatarSource({ type: "image/jpeg", size: 5 * 1024 * 1024 })).toBeNull(); // a phone photo: shrunk in the browser first
    expect(validateAvatarResult({ type: "image/webp", size: AVATAR_MAX_BYTES })).toBeNull();
    expect(validateAvatarResult({ type: "image/webp", size: AVATAR_MAX_BYTES + 1 })).toBe("too_large");
  });
  it("shrinking keeps the proportions, caps the longest side at 512 and never enlarges", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 512, height: 384 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 384, height: 512 });
    expect(fitWithin(300, 200)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(5000, 1)).toEqual({ width: 512, height: 1 });
  });
  it("a bucket or policy that is not there yet is «unavailable»; the customer texts are Arabic, with no path, id or English error", () => {
    expect(classifyUploadError({ message: "Bucket not found", statusCode: "404" })).toBe("unavailable");
    expect(classifyUploadError({ message: "new row violates row-level security policy" })).toBe("unavailable");
    expect(classifyUploadError({ message: "The object exceeded the maximum allowed size", statusCode: "413" })).toBe("too_large");
    expect(classifyUploadError({ message: "network down" })).toBe("failed");
    for (const text of Object.values(AVATAR_MESSAGES_AR)) {
      expect(text).toMatch(/[؀-ۿ]/);
      expect(text).not.toMatch(/[A-Za-z]{2,}|\p{Extended_Pictographic}|[0-9]|avatar|storage|bucket/iu);
    }
    expect(AVATAR_MESSAGES_AR.too_large).toContain("٢ ميجابايت");
  });
});

/** A small fake of the two parts of the Supabase client the picture code uses, recording what it is asked to do. */
function fakeClient(options: { column?: boolean; savedPath?: string | null; uploadError?: { message: string } | null; updateError?: { message: string } | null; signed?: string | null } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const { column = true, savedPath = null, uploadError = null, updateError = null, signed = "https://signed.example.test/a?token=1" } = options;
  const client = {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (_c: string, id: string) => ({
          maybeSingle: async () => {
            calls.push(["select", table, columns, id]);
            return column ? { data: { avatar_path: savedPath }, error: null } : { data: null, error: { code: "42703", message: 'column profiles.avatar_path does not exist' } };
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => ({ eq: async (_c: string, id: string) => { calls.push(["update", table, patch, id]); return { error: updateError }; } }),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, blob: Blob, opts: Record<string, unknown>) => { calls.push(["upload", bucket, path, blob.type, opts]); return { error: uploadError }; },
        remove: async (paths: string[]) => { calls.push(["remove", bucket, paths]); return { error: null }; },
        createSignedUrl: async (path: string, seconds: number) => { calls.push(["sign", bucket, path, seconds]); return signed ? { data: { signedUrl: signed }, error: null } : { data: null, error: { message: "x" } }; },
      }),
    },
  };
  return { client: client as never, calls };
}
const pngFile = (size = 1000) => new File([new Uint8Array(size)], "p.png", { type: "image/png" });
const webpBlob = (size = 4000) => new Blob([new Uint8Array(size)], { type: "image/webp" });

describe("2. the profile picture: it works before the SQL is applied and after", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    resetAvatarForTesting();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("BEFORE the SQL: a missing column hides the control and never throws; the letter circle stays", async () => {
    const { client, calls } = fakeClient({ column: false });
    const state = await loadAvatar(client, UID);
    expect(state).toEqual({ status: "unsupported", url: null });
    expect(calls.map((c) => c[0])).toEqual(["select"]);
    // remembered for this tab: the next screen does not ask the database again
    expect(store.get("diger_avatar_unsupported")).toBe("1");
    const again = fakeClient({ column: false });
    expect((await loadAvatar(again.client, UID)).status).toBe("unsupported");
    expect(again.calls).toHaveLength(0);
  });

  it("BEFORE the SQL (column there, bucket not): the control shows and an upload answers with the calm notice", async () => {
    const { client } = fakeClient({ uploadError: { message: "Bucket not found" } });
    expect((await loadAvatar(client, UID)).status).toBe("ready");
    const result = await uploadAvatar(client, UID, pngFile(), async () => webpBlob());
    expect(result).toEqual({ ok: false, problem: "unavailable" });
  });

  it("AFTER the SQL: upload sends the shrunk file to {userId}/avatar.webp in the private bucket, saves the path, and the new signed address shows", async () => {
    const { client, calls } = fakeClient();
    await loadAvatar(client, UID);
    const result = await uploadAvatar(client, UID, pngFile(), async () => webpBlob());
    expect(result).toEqual({ ok: true });
    const upload = calls.find((c) => c[0] === "upload")!;
    expect(upload.slice(1, 4)).toEqual([AVATAR_BUCKET, `${UID}/avatar.webp`, "image/webp"]);
    expect(upload[4]).toMatchObject({ upsert: true, contentType: "image/webp" });
    expect(calls.find((c) => c[0] === "update")!.slice(1)).toEqual(["profiles", { avatar_path: `${UID}/avatar.webp` }, UID]);
    expect(calls.find((c) => c[0] === "sign")![3]).toBe(3600); // short-lived: one hour
    const state = await loadAvatar(fakeClient({ savedPath: `${UID}/avatar.webp` }).client, UID);
    expect(state).toEqual({ status: "ready", url: "https://signed.example.test/a?token=1" });
  });

  it("replacing a picture of another type removes the old object, and a failed save removes the new one", async () => {
    const first = fakeClient({ savedPath: `${UID}/avatar.png` });
    await loadAvatar(first.client, UID);
    await uploadAvatar(first.client, UID, pngFile(), async () => webpBlob());
    expect(first.calls.find((c) => c[0] === "remove")!.slice(1)).toEqual([AVATAR_BUCKET, [`${UID}/avatar.png`]]);
    resetAvatarForTesting();
    const second = fakeClient({ updateError: { message: "denied" } });
    await loadAvatar(second.client, UID);
    const result = await uploadAvatar(second.client, UID, pngFile(), async () => webpBlob());
    expect(result).toEqual({ ok: false, problem: "unavailable" });
    expect(second.calls.find((c) => c[0] === "remove")!.slice(1)).toEqual([AVATAR_BUCKET, [`${UID}/avatar.webp`]]);
  });

  it("wrong type, too large and unreadable files are refused before anything is sent", async () => {
    const { client, calls } = fakeClient();
    expect(await uploadAvatar(client, UID, new File([new Uint8Array(10)], "a.gif", { type: "image/gif" }))).toEqual({ ok: false, problem: "type" });
    expect(await uploadAvatar(client, UID, pngFile(AVATAR_SOURCE_MAX_BYTES + 1))).toEqual({ ok: false, problem: "too_large" });
    expect(await uploadAvatar(client, UID, pngFile(), async () => null)).toEqual({ ok: false, problem: "unreadable" });
    expect(await uploadAvatar(client, UID, pngFile(), async () => webpBlob(AVATAR_MAX_BYTES + 1))).toEqual({ ok: false, problem: "too_large" });
    expect(calls.filter((c) => c[0] === "upload")).toHaveLength(0);
  });

  it("removing the picture deletes the object and clears the path; with no picture it only clears the path", async () => {
    const { client, calls } = fakeClient({ savedPath: `${UID}/avatar.jpg` });
    await loadAvatar(client, UID);
    expect(await removeAvatar(client, UID)).toEqual({ ok: true });
    expect(calls.find((c) => c[0] === "remove")!.slice(1)).toEqual([AVATAR_BUCKET, [`${UID}/avatar.jpg`]]);
    expect(calls.find((c) => c[0] === "update")!.slice(1)).toEqual(["profiles", { avatar_path: null }, UID]);
  });

  it("a path of someone else's folder is never read, signed or shown", async () => {
    const { client, calls } = fakeClient({ savedPath: "another-user/avatar.png" });
    expect(await loadAvatar(client, UID)).toEqual({ status: "ready", url: null });
    expect(calls.some((c) => c[0] === "sign")).toBe(false);
  });
});

describe("2. the screens", () => {
  const view = (props: Partial<Parameters<typeof AvatarPickerView>[0]> = {}) =>
    renderToStaticMarkup(createElement(AvatarPickerView, { letters: "م س", url: null, supported: true, busy: false, message: null, onPick: () => {}, onRemove: () => {}, ...props }));

  it("the settings card shows the letter circle alone while the feature is not ready, and the controls once it is", () => {
    const off = view({ supported: false });
    expect(off).toContain("م س");
    expect(off).not.toMatch(/data-testid="avatar-change"|type="file"|data-testid="avatar-remove"/);
    const on = view();
    expect(on).toContain('data-testid="avatar-change"');
    expect(on).toContain("إضافة صورة");
    expect(on).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(on).not.toContain('data-testid="avatar-remove"'); // nothing to remove yet
    const withPicture = view({ url: "https://signed.example.test/a?token=1" });
    expect(withPicture).toContain("تغيير الصورة");
    expect(withPicture).toContain('data-testid="avatar-remove"');
    expect(withPicture).toContain("حذف الصورة");
  });
  it("shows the calm Arabic message (an alert for a failure) and never a path or an id", () => {
    const failed = view({ message: { ok: false, text: AVATAR_MESSAGES_AR.type } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(AVATAR_MESSAGES_AR.type);
    const markup = view({ url: "https://signed.example.test/a?token=1" });
    expect(markup).not.toContain(UID);
    expect(markup).not.toMatch(/avatar_path|avatars\//);
  });
  it("the circle draws the picture over the letters, and the sidebar footer and the settings card both use it", () => {
    const withPicture = renderToStaticMarkup(createElement(Avatar, { letters: "م س", url: "https://signed.example.test/a?token=1", size: 36 }));
    expect(withPicture).toContain("<img");
    expect(withPicture).toContain("م س");
    expect(withPicture).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(createElement(Avatar, { letters: "م س", url: null }))).not.toContain("<img");
    expect(src("src/components/app/AppShell.tsx")).toContain("<Avatar letters={initials(user.name || user.email)} url={avatar.url} size={36} />");
    expect(src("src/app/dashboard/settings/page.tsx")).toContain("<AvatarPicker userId={user.id}");
    const footer = renderToStaticMarkup(createElement(AppShell, null, createElement("div")));
    expect(footer).toContain('data-testid="avatar"');
    expect(footer).not.toContain(UID);
  });
});

describe("2. the SQL is a proposal only, with a rollback, and touches nothing of the money tables", () => {
  const files = ["00_verify_before_apply.sql", "01_profiles_avatar_path.sql", "01_profiles_avatar_path.rollback.sql", "02_avatars_bucket_and_policies.sql", "02_avatars_bucket_and_policies.rollback.sql", "README.md"];
  const read = (name: string) => src(`docs/proposals/avatars/${name}`);
  it("lives under docs/proposals, not in supabase/migrations", () => {
    for (const name of files) expect(read(name).length).toBeGreaterThan(100);
    expect(src("docs/proposals/avatars/README.md")).toContain("NOT APPLIED");
    expect(read("01_profiles_avatar_path.sql")).toContain("NOT APPLIED");
    expect(read("02_avatars_bucket_and_policies.sql")).toContain("NOT APPLIED");
  });
  it("the bucket is private, 2 MB, three image types, and every policy is for the signed-in role and the user's own folder", () => {
    const sql = read("02_avatars_bucket_and_policies.sql");
    expect(sql).toContain("VALUES ('avatars', 'avatars', false, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])");
    expect(sql.match(/CREATE POLICY/g)?.length).toBe(4);
    expect(sql.match(/TO authenticated/g)?.length).toBe(4);
    expect(sql).not.toMatch(/TO (?:anon|public)|FOR ALL/i);
    expect(sql.match(/\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/g)!.length).toBeGreaterThanOrEqual(5);
  });
  it("the column is nullable, update is granted for that one column only, and a CHECK keeps the path in the user's own folder", () => {
    const sql = read("01_profiles_avatar_path.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS avatar_path text;");
    expect(sql).toContain("GRANT UPDATE (avatar_path) ON public.profiles TO authenticated;");
    expect(sql).toContain("REVOKE UPDATE (avatar_path) ON public.profiles FROM PUBLIC, anon;");
    expect(sql).toContain("CHECK (avatar_path IS NULL OR avatar_path ~ ('^' || id::text || '/avatar\\.(jpg|png|webp)$'))");
  });
  it("no money table, ledger, job, quote or cost table and no function is touched, and each file has a rollback", () => {
    for (const name of files.filter((n) => n.endsWith(".sql") && !n.startsWith("00_"))) {
      const sql = read(name).replace(/^--.*$/gm, "");
      expect(sql, name).not.toMatch(/credit_ledger|jobs\b|topups|plans_quotes|provider_costs|settings_private|CREATE (?:OR REPLACE )?FUNCTION|SECURITY DEFINER/i);
    }
    expect(read("01_profiles_avatar_path.rollback.sql")).toContain("DROP COLUMN IF EXISTS avatar_path");
    expect(read("02_avatars_bucket_and_policies.rollback.sql")).toContain('DROP POLICY IF EXISTS "avatars_insert_own"');
    expect(read("00_verify_before_apply.sql").replace(/^--.*$/gm, "").replace(/'[^']*'/g, "''")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i);
    expect(readdirSync(new URL("../supabase/migrations", import.meta.url)).filter((name) => /avatar/i.test(name))).toEqual([]); // nothing was added to the migrations the repository applies
  });
});
