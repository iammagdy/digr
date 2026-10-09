"use client";

import { useState, useCallback } from "react";
import { client } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { AppwriteException } from "appwrite";

export default function DashboardPage() {
  const { user } = useUser();
  const [pingStatus, setPingStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [pingMessage, setPingMessage] = useState("");

  const sendPing = useCallback(async () => {
    if (pingStatus === "loading") return;
    setPingStatus("loading");
    setPingMessage("");
    try {
      await client.ping();
      setPingStatus("success");
      setPingMessage("الاتصال بـ Appwrite ناجح ✓");
    } catch (err) {
      setPingStatus("error");
      setPingMessage(
        err instanceof AppwriteException
          ? err.message
          : "فشل الاتصال بالخادم",
      );
    }
  }, [pingStatus]);

  return (
    <div className="space-y-8">
      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-bold text-sand-900">
          مرحبًا{user?.name ? `، ${user.name}` : ""}
        </h1>
        <p className="mt-1 text-sm text-sand-500">لوحة التحكم</p>
      </div>

      {/* Stats cards — balance will be wired in Phase 2 */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-sand-200 bg-white p-5">
          <p className="text-xs font-medium text-sand-500">رصيدك</p>
          <p className="mt-1 text-2xl font-bold text-sand-900">—</p>
          <p className="mt-1 text-xs text-sand-400">يتوفر في المرحلة القادمة</p>
        </div>
        <div className="rounded-xl border border-sand-200 bg-white p-5">
          <p className="text-xs font-medium text-sand-500">طلبات نشطة</p>
          <p className="mt-1 text-2xl font-bold text-sand-900">—</p>
        </div>
        <div className="rounded-xl border border-sand-200 bg-white p-5">
          <p className="text-xs font-medium text-sand-500">طلبات مكتملة</p>
          <p className="mt-1 text-2xl font-bold text-sand-900">—</p>
        </div>
      </div>

      {/* Ping test card */}
      <div className="rounded-xl border border-sand-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-sand-900">
          اختبار الاتصال
        </h2>
        <p className="mt-1 text-sm text-sand-500">
          أرسل Ping للتأكد من اتصال التطبيق بـ Appwrite
        </p>

        <div className="mt-4 flex items-center gap-4">
          <button
            onClick={sendPing}
            disabled={pingStatus === "loading"}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {pingStatus === "loading" ? "جاري الإرسال..." : "أرسل Ping"}
          </button>

          {pingMessage && (
            <span
              className={`text-sm ${
                pingStatus === "success" ? "text-success" : "text-danger"
              }`}
            >
              {pingMessage}
            </span>
          )}
        </div>

        {/* Connection info */}
        <div className="mt-4 rounded-lg bg-sand-50 p-4">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-sand-400">Endpoint</span>
              <p className="mt-0.5 font-mono text-sand-600" dir="ltr">
                {process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT}
              </p>
            </div>
            <div>
              <span className="text-sand-400">Project ID</span>
              <p className="mt-0.5 font-mono text-sand-600" dir="ltr">
                {process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID}
              </p>
            </div>
            <div>
              <span className="text-sand-400">البريد الإلكتروني</span>
              <p className="mt-0.5 text-sand-600" dir="ltr">
                {user?.email}
              </p>
            </div>
            <div>
              <span className="text-sand-400">User ID</span>
              <p className="mt-0.5 font-mono text-sand-600" dir="ltr">
                {user?.$id}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
