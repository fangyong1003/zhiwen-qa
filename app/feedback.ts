import { isFeedbackRating, type FeedbackRating } from "../shared/feedback";

export async function submitFeedback(messageId: string, rating: FeedbackRating): Promise<FeedbackRating> {
  let response: Response;
  try {
    response = await fetch("/api/feedback", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, rating }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // The server may have saved the vote before the connection was lost. A retry restores that first vote.
    throw new Error("未能确认评价结果，请检查网络后重试。");
  }
  if (response.status === 204) return rating;
  const body = await response.json().catch(() => ({})) as { rating?: unknown; error?: unknown };
  if (response.status === 409 && isFeedbackRating(body.rating)) return body.rating;
  throw new Error(typeof body.error === "string" ? body.error : "评价未能保存，请稍后重试。");
}
