export interface WebSource {
  title: string;
  url: string;
}

export interface WebSearchResult {
  searched: boolean;
  text: string;
  sources: WebSource[];
  searchSuggestions?: string;
}

export function safeWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
