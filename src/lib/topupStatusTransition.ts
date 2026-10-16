type TopupStatusSnapshot = { $id: string; status: string };

/** Returns true when an approved row has a known pending predecessor. */
export function hasApprovedTopupTransition(
  current: TopupStatusSnapshot[],
  previous: Map<string, string>,
  submitted: TopupStatusSnapshot | null,
): boolean {
  return current.some(
    (topup) =>
      topup.status === "approved" &&
      (previous.get(topup.$id) === "pending" ||
        (submitted?.$id === topup.$id && submitted.status === "pending")),
  );
}
