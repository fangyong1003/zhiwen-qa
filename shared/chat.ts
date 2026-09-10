export type AnswerScope = "knowledge" | "attachments" | "combined";
export type TurnStatus = "running" | "completed" | "failed" | "cancelled";
export interface Attachment {
  id: string;
  filename: string;
  size_bytes: number;
  status: "parsing" | "indexing" | "ready" | "failed";
  error_message?: string | null;
  chunk_count?: number;
}
export interface TurnRequest {
  requestId: string;
  conversationId: string;
  question: string;
  provider: "gemini" | "openai" | "deepseek";
  webSearch: boolean;
  scope: AnswerScope;
  attachmentIds: string[];
}
export interface TurnRecord {
  id: string;
  user_message_id: string;
  assistant_message_id?: string | null;
  status: TurnStatus;
  partial_content: string;
  error_message?: string | null;
  error_code?: string | null;
  request: TurnRequest;
}
