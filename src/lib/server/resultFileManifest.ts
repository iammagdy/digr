export interface GeneratedResultFiles {
  xlsx: string | null;
  pdf: string | null;
  csv: string | null;
}

/** Return only files actually generated during this job; other formats can be regenerated on demand. */
export function resultFileManifest(files: GeneratedResultFiles): GeneratedResultFiles {
  return { xlsx: files.xlsx, pdf: files.pdf, csv: files.csv };
}
