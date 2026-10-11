"use client";

import DiscoveryCard from "./DiscoveryCard";
import type { DiscoveryAnswer } from "./discoveryQuestions";

interface ClarificationReplyProps {
  intro: string;
  questions: unknown;
  completedAnswers?: DiscoveryAnswer[];
  disabled?: boolean;
  onComplete: (answers: DiscoveryAnswer[]) => void;
}

export default function ClarificationReply({
  intro,
  questions,
  completedAnswers,
  disabled,
  onComplete,
}: ClarificationReplyProps) {
  return (
    <>
      <div className="whitespace-pre-wrap">{intro}</div>
      <DiscoveryCard
        questions={questions}
        completedAnswers={completedAnswers}
        disabled={disabled}
        onSubmit={onComplete}
      />
    </>
  );
}
