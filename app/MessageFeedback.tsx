import { useRef, useState } from "react";
import type { FeedbackRating } from "../shared/feedback";

export function MessageFeedback({ messageId, rating, onRate }: {
  messageId: string;
  rating?: FeedbackRating | null;
  onRate: (id: string, value: FeedbackRating) => Promise<FeedbackRating>;
}) {
  const [savedRating, setSavedRating] = useState<FeedbackRating | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const selected = rating ?? savedRating;

  async function submit(value: FeedbackRating) {
    if (locked.current || selected) return;
    locked.current = true;
    setSubmitting(true);
    setError("");
    try {
      setSavedRating(await onRate(messageId, value));
    } catch (reason) {
      locked.current = false;
      setError(reason instanceof Error ? reason.message : "评价未能保存，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="message-feedback">
    <div className="feedback-options" role="group" aria-label="评价这条回答" aria-busy={submitting}>
      <button type="button" className={selected === "up" ? "selected" : ""} disabled={submitting || Boolean(selected)} aria-pressed={selected === "up"} onClick={() => void submit("up")}>✓ 有帮助</button>
      <button type="button" className={selected === "down" ? "selected" : ""} disabled={submitting || Boolean(selected)} aria-pressed={selected === "down"} onClick={() => void submit("down")}>× 不准确</button>
    </div>
    <p className="feedback-status" role="status">{submitting ? "正在提交评价…" : selected ? "已评价 · 每条回答仅可评价一次" : ""}</p>
    {error && !selected && <p className="feedback-error" role="alert">{error}</p>}
  </div>;
}
