import type { ReactNode } from "react";
import SiteFrame from "@/components/app/SiteFrame";

export const metadata = { title: "حاسبة التكلفة" };

export default function CalculatorLayout({ children }: { children: ReactNode }) {
  return <SiteFrame>{children}</SiteFrame>;
}
