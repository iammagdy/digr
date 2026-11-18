/**
 * THE HEADER'S FIRST PAINT (DT-20261118-07). The landing page is static (the same HTML for everyone), so the server cannot say who is signed in, and the header used to show no button until the browser had hydrated and read the session
 * (about 5 seconds on a slow phone, and longer for a signed-in visitor whose access token had expired: the public page skips the middleware, so the browser itself refreshes the token before the session is known).
 * This runs before first paint (inlined in <head>, like the theme script): it only looks whether the browser holds the sign-in cookie (no request, no check), and marks <html data-auth="in|out">. The header carries both buttons and CSS shows the one that matches.
 * It is a hint for the look of two links, never a permission: the real session decides after hydration, and every page and API call it leads to is still checked on the server (src/middleware.ts, the routes).
 */
export const AUTH_HINT_SCRIPT = `(function(){var d=document.documentElement;try{d.setAttribute("data-auth",/(?:^|;\\s*)sb-[^=;]*-auth-token(?:\\.\\d+)?=/.test(document.cookie)?"in":"out")}catch(e){d.setAttribute("data-auth","out")}})()`;
