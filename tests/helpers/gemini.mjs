export function geminiResponse(res, mode = "success", answer = ["Gemini：报销需要发票和审批单。", "\n参考来源：[1]"]) {
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
  send({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: answer[0] }] } }] });
  if (mode === "slow") {
    const timer = setTimeout(() => { send({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: answer[1] }] }, finishReason: "STOP" }] }); res.end(); }, 4000);
    res.once("close", () => clearTimeout(timer));
    return;
  }
  if (mode !== "interrupted") {
    send({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: answer[1] }] }, finishReason: mode === "truncated" ? "MAX_TOKENS" : "STOP" }] });
  }
  res.end();
}

export function geminiEmbeddingResponse(res, input, mode = "success") {
  res.setHeader("Content-Type", "application/json");
  if (typeof mode === "number") {
    res.statusCode = mode;
    return res.end(JSON.stringify({ error: { code: mode, message: "Fixture embedding error: internal details must not reach users", status: "INVALID_ARGUMENT" } }));
  }
  const embeddings = input.requests.map((request) => {
    const text = request.content.parts[0].text;
    const values = Array(request.outputDimensionality).fill(0);
    values[0] = 1;
    values[1] = text.includes("报销") ? 1 : 0;
    values[2] = text.length / 100;
    if (mode === "wrong-dimensions") values.pop();
    if (mode === "invalid-values") values[0] = null;
    if (mode === "zero-vector") values.fill(0);
    return { values };
  });
  if (mode === "wrong-count") embeddings.pop();
  if (mode === "missing-vector") embeddings[0] = null;
  res.end(JSON.stringify({ embeddings }));
}

export function googleSearchResponse(res, mode = "success") {
  res.setHeader("Content-Type", "application/json");
  if (typeof mode === "number") {
    res.statusCode = mode;
    return res.end(JSON.stringify({ error: { code: mode, message: "Fixture search secret must not reach users", status: "INVALID_ARGUMENT" } }));
  }
  if (mode === "blocked") return res.end(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }));
  res.end(JSON.stringify({ candidates: [{
    index: 0,
    finishReason: mode === "truncated" ? "MAX_TOKENS" : "STOP",
    content: { role: "model", parts: [{ text: "Private fixture thought", thought: true }, { text: mode === "empty" ? "" : "公开网页说明：请查阅官方公布的最新资料。" }] },
    groundingMetadata: mode === "ungrounded" ? {} : {
      webSearchQueries: ["官方公开资料"],
      groundingChunks: [
        { web: { uri: "https://example.org/public-guide", title: "公开资料指南" } },
        { web: { uri: "https://example.org/public-guide", title: "重复来源" } },
        { web: { uri: "javascript:alert(1)", title: "不安全来源" } },
        { web: { uri: "https://user:password@example.org/", title: "携带凭据的链接" } },
        { web: { uri: "https://example.net/reference" } },
      ],
      searchEntryPoint: { renderedContent: '<a href="https://www.google.com/search?q=public+guide">Google 搜索建议</a>' },
    },
  }] }));
}
