import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
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

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
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
  });

  // Refresh session via getUser
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  const isDashboard = pathname.startsWith("/dashboard");
  const isAdmin = pathname.startsWith("/admin");

  if (isDashboard || isAdmin) {
    if (!user) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      return NextResponse.redirect(loginUrl);
    }

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
