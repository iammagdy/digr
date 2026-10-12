import { GlassHeader } from "@/components/landing/GlassHeader";
import { HeroLens } from "@/components/landing/HeroLens";
import { Calculator, Faq, FinalCta, Sheets, Statements } from "@/components/landing/Sections";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-bg text-ink2" style={{ containerType: "inline-size" }}>
      <GlassHeader />
      <HeroLens />
      <Statements />
      <Sheets />
      <Calculator />
      <Faq />
      <FinalCta />
    </div>
  );
}
