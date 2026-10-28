/**
 * The result of an admin reverse lookup as the screen keeps it: each field with the endpoint that gave it (client-safe, no server imports), and the merge a «بحث أعمق» does.
 * An earlier answer is never overwritten: a later one only fills the fields that are still empty, and each field remembers its source.
 */
export const FIELD_KEYS = ["name", "company", "title", "profileUrl", "country"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];
export type LookupIdentity = Record<FieldKey, string>;
export type LookupFields = Partial<Record<FieldKey, { value: string; source: string }>>;

export const FIELD_LABEL_AR: Record<FieldKey, string> = { name: "الاسم", company: "الشركة", title: "المسمى", profileUrl: "رابط الملف", country: "الدولة" };

export const emptyIdentity = (): LookupIdentity => ({ name: "", company: "", title: "", profileUrl: "", country: "" });

/** An answer is useful when it names the person or the company or links a profile (a country alone is not an answer). */
export const isUsefulIdentity = (i: Partial<LookupIdentity> | undefined | null): boolean => Boolean(i && (i.name || i.company || i.title || i.profileUrl));

export function mergeFields(previous: LookupFields | undefined, source: string, identity: Partial<LookupIdentity>): LookupFields {
  const out: LookupFields = { ...(previous ?? {}) };
  for (const key of FIELD_KEYS) {
    const value = String(identity[key] ?? "").trim();
    if (value && !out[key]) out[key] = { value, source };
  }
  return out;
}

export const identityOfFields = (fields: LookupFields): LookupIdentity => {
  const out = emptyIdentity();
  for (const key of FIELD_KEYS) out[key] = fields[key]?.value ?? "";
  return out;
};

export const fieldCount = (fields: LookupFields): number => FIELD_KEYS.filter((k) => fields[k]?.value).length;
