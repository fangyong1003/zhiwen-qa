export type FeedbackRating = "up" | "down";

export function isFeedbackRating(value: unknown): value is FeedbackRating {
  return value === "up" || value === "down";
}
