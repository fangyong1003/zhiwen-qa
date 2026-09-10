import OpenAI from "openai";

export interface DeepSeekSettings {
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

class DeepSeekResponseError extends Error {}

export async function streamDeepSeekAnswer(
  settings: DeepSeekSettings,
  question: string,
  history: { role: "user" | "assistant"; content: string }[],
  instructions: string,
  onDelta: (text: string) => void,
  externalSignal?: AbortSignal,
) {
  if (!settings.apiKey) throw new Error("尚未配置 DEEPSEEK_API_KEY。请在 .env 中添加后重启服务。");
  const client = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl || "https://api.deepseek.com",
    timeout: 60000,
    maxRetries: 0,
    logLevel: "off",
  });
  // Bound the entire stream, including a server that only sends keep-alive events.
  const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(externalSignal ? [externalSignal] : [])]);
  try {
    const recentHistory = history.slice(-8);
    while (recentHistory[0]?.role === "assistant") recentHistory.shift();
    const request = {
      model: settings.model,
      stream: true as const,
      // DeepSeek's extension to Chat Completions; keep knowledge QA in non-thinking mode.
      thinking: { type: "disabled" },
      max_tokens: 4096,
      messages: [
        { role: "system" as const, content: instructions },
        ...recentHistory.map(({ role, content }) => ({ role, content })),
        { role: "user" as const, content: question },
      ],
    };
    const stream = await client.chat.completions.create(request, { signal });
    let answer = "";
    let completed = false;
    for await (const part of stream) {
      signal.throwIfAborted();
      const choice = part.choices[0];
      const finishReason: string | null | undefined = choice?.finish_reason;
      if (finishReason && finishReason !== "stop") {
        if (finishReason === "length") throw new DeepSeekResponseError("DeepSeek 回答达到长度上限，请缩小问题范围后重试。");
        if (finishReason === "content_filter") throw new DeepSeekResponseError("DeepSeek 未能处理此问题，请调整提问后重试。");
        if (finishReason === "insufficient_system_resource") throw new DeepSeekResponseError("DeepSeek 推理资源不足，回答中断，请稍后重试。");
        throw new DeepSeekResponseError("DeepSeek 未能完成文本回答，请重试。");
      }
      // Only final-answer content is shown and persisted, never reasoning_content.
      const delta = choice?.delta?.content ?? "";
      if (delta) {
        answer += delta;
        onDelta(delta);
      }
      if (finishReason === "stop") completed = true;
    }
    if (signal.aborted) throw new Error("Request deadline exceeded");
    if (!answer.trim()) throw new DeepSeekResponseError("DeepSeek 未返回文本回答，请重试。");
    if (!completed) throw new DeepSeekResponseError("DeepSeek 响应中断，请重试。");
    return answer;
  } catch (error) {
    externalSignal?.throwIfAborted();
    if (error instanceof DeepSeekResponseError) throw error;
    if (signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError) throw new Error("DeepSeek 请求超时，请稍后重试。");
    if (error instanceof OpenAI.APIConnectionError) throw new Error("DeepSeek 连接失败，请检查服务端网络后重试。");
    if (error instanceof OpenAI.APIError && error.status) {
      if (error.status === 401 || error.status === 403) throw new Error("DeepSeek 身份验证失败，请检查 DEEPSEEK_API_KEY 及模型访问权限。");
      if (error.status === 402) throw new Error("DeepSeek 账户余额不足，请在 DeepSeek 控制台检查余额。");
      if (error.status === 400 || error.status === 404 || error.status === 422) throw new Error("DeepSeek 模型或请求参数不可用，请检查 DEEPSEEK_CHAT_MODEL 与接口配置。");
      if (error.status === 429) throw new Error("DeepSeek 请求频率或 Token 用量达到限额，请稍后重试。");
      if (error.status === 503) throw new Error("DeepSeek 服务繁忙，请稍后重试。");
      throw new Error(`DeepSeek 请求失败（HTTP ${error.status}），请稍后重试。`);
    }
    // Provider errors may contain request details; do not forward them to the browser or logs.
    throw new Error("DeepSeek 响应异常或连接中断，请稍后重试。");
  }
}
