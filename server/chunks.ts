export function splitText(input: string, chunkSize = 1000, overlap = 160) {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("chunkSize must be a positive integer");
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new RangeError("overlap must be an integer between 0 and chunkSize - 1");
  }

  const clean = input.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    let end = Math.min(clean.length, cursor + chunkSize);
    if (end < clean.length) {
      const naturalBreak = Math.max(clean.lastIndexOf("\n", end - 1), clean.lastIndexOf("。", end - 1), clean.lastIndexOf(" ", end - 1));
      if (naturalBreak > cursor + Math.floor(chunkSize * 0.55)) end = naturalBreak + 1;
    }
    const chunk = clean.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === clean.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return chunks;
}
