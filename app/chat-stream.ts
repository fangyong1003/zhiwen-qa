export function newRequestId() {
  // getRandomValues also works on LAN HTTP origins where randomUUID is unavailable.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function readChatEvents(response: Response, onEvent: (type: string, data: Record<string, unknown>) => void) {
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "无法生成回答。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  const consume = (block: string) => {
    const lines = block.split(/\r?\n/);
    const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const raw = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!type || !raw) return;
    if (["done", "error", "cancelled"].includes(type)) terminal = true;
    onEvent(type, JSON.parse(raw));
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      blocks.forEach(consume);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!terminal) throw new Error("回答连接中断，可重试此问题。");
  } finally { await reader.cancel().catch(() => undefined); }
}
