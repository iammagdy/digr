import { GlassHeader } from "@/components/landing/GlassHeader";
import { HeroLens } from "@/components/landing/HeroLens";
import { Overview } from "@/components/landing/Overview";
import { DemoConversations, Faq, FinalCta, SampleFile } from "@/components/landing/Sections";

/**
 * Static: the same HTML for everyone, served from the edge cache, no function run and no call to the sign-in service per visit (the
 * landing page and the QR path take most of the traffic at the conference). Who is signed in is decided in the browser from the session
 * it already holds; until then the header keeps its place and shows no button (no wrong-button flash).
 */
export const dynamic = "force-static";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-bg text-ink2" style={{ containerType: "inline-size" }}>
      <GlassHeader />
      <HeroLens />
      <Overview />
      <DemoConversations />
      <SampleFile />
      <Faq />
      <FinalCta />
    </div>
  );
}
