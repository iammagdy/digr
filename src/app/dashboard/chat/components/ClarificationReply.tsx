"use client";

import DiscoveryCard from "./DiscoveryCard";

interface ClarificationReplyProps {
  intro: string;
  questions: unknown;
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
