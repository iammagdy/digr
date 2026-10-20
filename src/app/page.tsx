import { GlassHeader } from "@/components/landing/GlassHeader";
import { HeroLens } from "@/components/landing/HeroLens";
import { Calculator, Faq, FinalCta, SampleFile, Sheets, Statements } from "@/components/landing/Sections";
import { createServerSideClient } from "@/lib/supabase/server";

export default async function LandingPage() {
  let initialSignedIn = false;
  try {
    const supabase = await createServerSideClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    initialSignedIn = Boolean(user);
  } catch {
    initialSignedIn = false;
  }

  return (
    <div className="min-h-screen bg-bg text-ink2" style={{ containerType: "inline-size" }}>
      <GlassHeader initialSignedIn={initialSignedIn} />
      <HeroLens />
      <Statements />
      <Sheets />
      <SampleFile />
      <Calculator />
      <Faq />
      <FinalCta initialSignedIn={initialSignedIn} />
    </div>
  );
}

