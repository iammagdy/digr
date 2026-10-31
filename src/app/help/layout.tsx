import type { ReactNode } from "react";
import SiteFrame from "@/components/app/SiteFrame";

export default function Layout({ children }: { children: ReactNode }) {
  return <SiteFrame>{children}</SiteFrame>;
}
