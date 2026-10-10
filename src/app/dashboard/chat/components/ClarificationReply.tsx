"use client";

import DiscoveryCard, { type DiscoveryQuestion } from "./DiscoveryCard";

interface ClarificationReplyProps {
  intro: string;
  questions: DiscoveryQuestion[] | string[];
  onSelectOption: (optionText: string) => void;
}

export default function ClarificationReply({
  intro,
  questions,
  onSelectOption,
}: ClarificationReplyProps) {
  return (
    <>
      <div className="whitespace-pre-wrap">{intro}</div>
      <DiscoveryCard questions={questions} onSelectOption={onSelectOption} />
    </>
  );
}
