import { NextRequest, NextResponse } from "next/server";
import { Account, Client, TablesDB } from "node-appwrite";
import { getEnabledCapabilities } from "@/functions/shared/capabilityRegistry";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
    const sessionCookie =
      req.cookies.get(`a_session_${projectId}`)?.value ||
      req.cookies.get(`a_session_${projectId}_legacy`)?.value;
    if (!bearerJwt && !sessionCookie) {
      return NextResponse.json({ success: false, error: "غير مصرح" }, { status: 401 });
    }

    const userClient = new Client().setEndpoint(endpoint).setProject(projectId);
    if (bearerJwt) userClient.setJWT(bearerJwt);
    else if (sessionCookie) userClient.setSession(sessionCookie);
    try {
      await new Account(userClient).get();
    } catch {
      return NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة" }, { status: 401 });
    }

    const apiKey = process.env.APPWRITE_API_KEY;
    if (!apiKey) {
      console.info("chat_metadata_capabilities_unavailable");
      return NextResponse.json({ success: false, reasonCode: "capabilities_unavailable" }, { status: 503 });
    }
    const serverClient = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
    const capabilities = await getEnabledCapabilities(new TablesDB(serverClient));
    return NextResponse.json({
      success: true,
      enabledCapabilitySlugs: capabilities.map((capability) => capability.slug),
    });
  } catch {
    console.info("chat_metadata_capabilities_unavailable");
    return NextResponse.json({ success: false, reasonCode: "capabilities_unavailable" }, { status: 503 });
  }
}
