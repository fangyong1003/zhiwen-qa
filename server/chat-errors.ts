export class ChatError extends Error {
  constructor(message: string, public status = 400, public code = "request_failed") { super(message); }
}
