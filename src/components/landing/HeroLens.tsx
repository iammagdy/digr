"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { savePendingQuestion } from "@/lib/pendingQuestion";
import { DEFAULT_Q } from "./data";

/**
 * The first screen: ONE sentence that says what this is, ONE question box and ONE primary action (the button of the box). No moving or blurred background, no
 * second button, no list of examples (the examples are on the next screens). The line under the box is the only place on the page that says nothing starts
 * and nothing is charged before the customer's approval.
 */
export function HeroLens() {
  const router = useRouter();
  const { user } = useUser();
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasText, setHasText] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = (inputRef.current?.value || "").trim() || DEFAULT_Q;
    savePendingQuestion(q);
    router.push(user ? "/dashboard/chat" : "/register");
  };

  return (
    <section className="relative flex flex-col items-center justify-center px-5 pb-16 pt-[120px] min-[760px]:pb-24 min-[760px]:pt-[150px]">
      <div className="relative w-full max-w-[760px] text-center">
        <p className="m-0 mx-auto max-w-[560px] text-[15px] font-normal leading-[1.9] text-ink2 min-[760px]:text-[17px]" data-testid="hero-sentence">
          اسأل بالعربية، واستلم بيانات منظّمة من مصادر متاحة في ملف إكسل أو بي دي إف.
        </p>
        <h1 className="mb-0 mt-[18px] font-display text-ink" style={{ fontSize: "clamp(44px,8cqi,104px)", lineHeight: 1.12, letterSpacing: 0 }}>
          ماذا تريد أن تعرف؟
        </h1>
        <form
          onSubmit={submit}
          data-testid="hero-form"
          className="relative mx-auto mt-10 flex max-w-[680px] flex-col gap-2 rounded-[28px] border border-ln bg-sf p-2 min-[560px]:flex-row min-[560px]:items-center min-[560px]:rounded-full"
          style={{ boxShadow: "var(--shadow)" }}
        >
          <input
            ref={inputRef}
            type="text"
            placeholder="مثال: ٥٠ شركة مقاولات في مصر"
            aria-label="سؤالك البحثي"
            maxLength={500}
            onChange={(e) => setHasText(e.target.value.length > 0)}
            className="min-h-[52px] w-full min-w-0 flex-1 border-0 bg-transparent px-5 text-[17px] font-light text-ink outline-none"
          />
          <button
            type="submit"
            data-testid="hero-primary"
            className="min-h-[52px] shrink-0 cursor-pointer rounded-full border-0 bg-ac px-8 text-[16px] text-onac transition-opacity duration-200"
            style={{ opacity: hasText ? 1 : 0.85 }}
          >
            ابدأ طلبك
          </button>
        </form>
        <p className="mb-0 mt-6 text-[13px] font-normal text-mut" data-testid="hero-no-charge">
          لا يبدأ أي جمع ولا يُخصم أي رصيد قبل موافقتك
        </p>
      </div>
    </section>
  );
}
