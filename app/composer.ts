interface ComposerKey {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
  repeat: boolean;
}

export function isSendKey(event: ComposerKey, composing: boolean): boolean {
  // keyCode 229 also protects the Enter that confirms an IME candidate in Safari.
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229;
}

export function canSendQuestion(question: string, sending: boolean): boolean {
  return question.trim().length >= 2 && !sending;
}
