import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";

export interface GeminiSettings {
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

export async function streamGeminiAnswer(
  settings: GeminiSettings,
  question: string,
  history: { role: "user" | "assistant"; content: string }[],
  instructions: string,
  onDelta: (text: string) => void,
) {
  if (!settings.apiKey) throw new Error("尚未配置 GEMINI_API_KEY。请在 .env 中添加后重启服务。");
  const client = new GoogleGenAI({
    apiKey: settings.apiKey,
    vertexai: false,
    httpOptions: { ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}), timeout: 60000 },
  });

  try {
    const recentHistory = history.slice(-8);
    while (recentHistory[0]?.role === "assistant") recentHistory.shift();
    const stream = await client.models.generateContentStream({
      model: settings.model,
      contents: [
        ...recentHistory.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
        { role: "user", parts: [{ text: question }] },
      ],
      config: { systemInstruction: instructions },
    });
    let answer = "";
    let completed = false;
    for await (const chunk of stream) {
      if (chunk.promptFeedback?.blockReason) {
        throw new Error("Gemini 未能处理此问题，请调整提问后重试。");
      }
      const finishReason = chunk.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== FinishReason.STOP) {
        throw new Error(finishReason === FinishReason.MAX_TOKENS ? "Gemini 回答达到长度上限，请缩小问题范围后重试。" : "Gemini 未能完成回答，请调整提问后重试。");
      }
      // The SDK text accessor excludes thought parts and returns only answer text.
      const delta = chunk.text ?? "";
      if (delta) {
        answer += delta;
        onDelta(delta);
      }
      if (finishReason === FinishReason.STOP) completed = true;
    }
    if (!answer.trim()) throw new Error("Gemini 未返回文本回答，请重试。");
    if (!completed) throw new Error("Gemini 响应中断，请重试。");
    return answer;
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) throw new Error("Gemini 身份验证失败，请检查 GEMINI_API_KEY 及模型访问权限。");
      if (error.status === 404) throw new Error("Gemini 模型不可用，请检查 GEMINI_CHAT_MODEL 配置。");
      if (error.status === 429) throw new Error("Gemini 调用额度或频率已达上限，请稍后重试。");
      throw new Error(`Gemini 请求失败（HTTP ${error.status}），请稍后重试。`);
    }
    throw error;
  }
}
