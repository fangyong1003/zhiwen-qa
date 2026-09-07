export function geminiResponse(res, mode = "success") {
  if (typeof mode === "number") {
    res.writeHead(mode, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { code: mode, message: "Fixture API error: internal details must not reach users", status: "PERMISSION_DENIED" } }));
  }
  res.setHeader("Content-Type", "text/event-stream");
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (mode === "blocked") {
    send({ promptFeedback: { blockReason: "SAFETY" } });
    return res.end();
  }
  if (mode === "empty") {
    send({ candidates: [{ index: 0, finishReason: "STOP" }] });
    return res.end();
  }
  send({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Fixture thought should be excluded", thought: true }] } }] });
  send({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Gemini：报销需要发票和审批单。" }] } }] });
  if (mode !== "interrupted") {
    send({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "\n参考来源：[1]" }] }, finishReason: mode === "truncated" ? "MAX_TOKENS" : "STOP" }] });
  }
  res.end();
}
