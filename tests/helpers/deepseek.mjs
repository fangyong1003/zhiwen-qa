export const deepSeekAnswer = "DeepSeek：报销需要发票和审批单。\n参考来源：[1]";

export function deepSeekResponse(res, mode = "success") {
  if (typeof mode === "number") {
    res.writeHead(mode, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Fixture private API details", type: "fixture_error", code: String(mode) } }));
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.write(": keep-alive\n\n");
  const send = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
    id: "fixture-deepseek", object: "chat.completion.chunk", created: 0, model: "fixture-deepseek",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  if (mode === "stream_error") {
    return res.end(`data: ${JSON.stringify({ error: { message: "Fixture private API details" } })}\n\n`);
  }
  if (mode === "malformed") return res.end("data: not-json\n\n");
  send({ role: "assistant", content: "" });
  send({ reasoning_content: "Fixture private reasoning must not be shown or persisted" });
  if (mode !== "empty") {
    send({ content: "DeepSeek：报销需要发票和审批单。" });
    if (mode !== "interrupted") send({ content: "\n参考来源：[1]" });
  }
  if (mode !== "interrupted") {
    send({}, ["length", "content_filter", "tool_calls", "insufficient_system_resource"].includes(mode) ? mode : "stop");
  }
  res.end("data: [DONE]\n\n");
}
