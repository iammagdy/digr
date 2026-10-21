import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath } from "./lib/publicPaths";
import { withLocalClaims } from "./lib/server/localClaims";

export async function middleware(request: NextRequest) {
  // Public pages and status endpoints never need the session: no call to the sign-in service for them.
  if (isPublicPath(request.nextUrl.pathname)) return NextResponse.next({ request });

  // An API call that carries its own bearer token never depends on the cookie refresh below, and its route checks the token itself:
  // the middleware's own call to the sign-in service would be a second, identical check for every chat message and every poll.
  if (request.nextUrl.pathname.startsWith("/api/") && request.headers.get("authorization")?.startsWith("Bearer ")) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return supabaseResponse;
  }

  const supabase = withLocalClaims(createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  }));

  // Refresh session via getUser
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (user && (pathname === "/login" || pathname === "/register")) {
    const isEmailVerified = !!(user.email_confirmed_at || user.user_metadata?.email_verified);
    const destUrl = request.nextUrl.clone();
    destUrl.pathname = isEmailVerified ? "/dashboard/chat" : "/verify";
    return NextResponse.redirect(destUrl);
  }

  const isChat = pathname === "/dashboard/chat";
  const isDashboard = pathname.startsWith("/dashboard");
  const isAdmin = pathname.startsWith("/admin");

  if (isAdmin || isDashboard) {
    if (!user) {
      const hasGuestCookie = request.cookies.has("guest_session_id");
      const isGuestOptIn = request.nextUrl.searchParams.get("guest") === "true";
      if (isChat && (hasGuestCookie || isGuestOptIn)) {
        if (isGuestOptIn && !hasGuestCookie) {
          supabaseResponse.cookies.set("guest_session_id", `gst_${crypto.randomUUID()}`, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 30 * 24 * 60 * 60,
            path: "/",
          });
        }
      } else {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = "/login";
        return NextResponse.redirect(loginUrl);
      }
    }
  }

  if ((isDashboard || isAdmin) && user) {
    const isEmailVerified = !!(user.email_confirmed_at || user.user_metadata?.email_verified);

    // 403 on unverified email
    if (!isEmailVerified) {
      if (
        request.headers.get("accept")?.includes("application/json") ||
        pathname.startsWith("/api/") ||
        isAdmin
      ) {
        return NextResponse.json(
          { error: "فعّل بريدك الإلكتروني أولًا لبدء البحث." },
          { status: 403 }
        );
      }
      const verifyUrl = request.nextUrl.clone();
      verifyUrl.pathname = "/verify";
      return NextResponse.redirect(verifyUrl);
    }

    // Role verification for admin paths
    if (isAdmin) {
      const userIsAdmin = user.app_metadata?.role === "admin";
      if (!userIsAdmin) {
        if (request.headers.get("accept")?.includes("application/json")) {
          return NextResponse.json(
            { error: "ممنوع — هذه الواجهة مخصصة لمديري النظام فقط." },
            { status: 403 }
          );
        }
        const chatUrl = request.nextUrl.clone();
        chatUrl.pathname = "/dashboard/chat";
        return NextResponse.redirect(chatUrl);
      }
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/admin/:path*",
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ttf)$).*)",
  ],
};
