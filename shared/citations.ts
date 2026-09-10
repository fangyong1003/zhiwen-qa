export interface Citation {
  documentId: string;
  title: string;
  filename: string;
  chunkIndex: number;
  excerpt: string;
  score: number;
  // Original number in the model's context. Legacy records use their array position.
  referenceNumber?: number;
  source?: "attachment";
  conversationId?: string;
}

export type UsedCitation = Citation & { referenceNumber: number };

function citationRanges(answer: string): [number, number][] {
  let fence: { marker: string; length: number } | undefined;
  const prose = answer.split(/\r?\n/).filter((line) => {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      const marker = delimiter[1][0];
      if (!fence) fence = { marker, length: delimiter[1].length };
      else if (marker === fence.marker && delimiter[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence;
  }).join("\n").replace(/(`+)[^\n]*?\1/g, "").normalize("NFKC");
  const ranges: [number, number][] = [];
  // Accept source markers, including grouped numbers, but not escaped text, Markdown links or link definitions.
  const markers = /(?<!\\|\[|!)(?:\[([\d\s,、;–—-]+)\]|【([\d\s,、;–—-]+)】)(?![\t ]*[:(])/g;
  for (const match of prose.matchAll(markers)) {
    for (const part of (match[1] ?? match[2]).split(/[,、;]/)) {
      const range = part.trim().match(/^([1-9]\d*)(?:\s*[-–—]\s*([1-9]\d*))?$/);
      if (!range) continue;
      const start = Number(range[1]);
      const end = Number(range[2] ?? range[1]);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start) ranges.push([start, end]);
    }
  }
  return ranges;
}

/** Retrieval candidates are not citations until the answer explicitly uses their numbers. */
export function usedCitations(answer: string, candidates: readonly Citation[] = []): UsedCitation[] {
  if (!answer || !Array.isArray(candidates)) return [];
  const ranges = citationRanges(answer);
  const seen = new Set<number>();
  const used: UsedCitation[] = [];
  candidates.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return;
    const referenceNumber = candidate.referenceNumber ?? index + 1;
    if (!Number.isSafeInteger(referenceNumber) || referenceNumber < 1 || seen.has(referenceNumber)) return;
    if (!ranges.some(([start, end]) => referenceNumber >= start && referenceNumber <= end)) return;
    seen.add(referenceNumber);
    used.push({ ...candidate, referenceNumber });
  });
  return used.sort((a, b) => a.referenceNumber - b.referenceNumber);
}
