import { ApiError, GoogleGenAI } from "@google/genai";
import type { GeminiSettings } from "./gemini";

export type EmbeddingTask = "document" | "query";

export interface GeminiEmbeddingSettings extends GeminiSettings {
  dimensions: number;
}

class EmbeddingResponseError extends Error {}

export function embeddingSpace(settings: Pick<GeminiEmbeddingSettings, "model" | "dimensions">) {
  // Version the retrieval instructions too: equal dimensions alone do not imply compatible vectors.
  return `gemini:${settings.model}:${settings.dimensions}:qa-v1`;
}

export function isEmbeddingVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value) && value.length === dimensions && dimensions > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item))
    && value.some((item) => item !== 0) && Number.isFinite(Math.hypot(...value));
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (!isEmbeddingVector(a, b.length) || !isEmbeddingVector(b, a.length)) {
    throw new Error("向量数据无效或维度不一致，请重建文档索引。");
  }
  const leftNorm = Math.hypot(...a);
  const rightNorm = Math.hypot(...b);
  return a.reduce((sum, value, index) => sum + (value / leftNorm) * (b[index] / rightNorm), 0);
}

export async function createGeminiEmbeddings(settings: GeminiEmbeddingSettings, texts: string[], task: EmbeddingTask, signal?: AbortSignal) {
  if (!settings.apiKey) throw new Error("知识库索引和检索需要 GEMINI_API_KEY。请在 .env 中添加后重启服务。");
  if (!texts.length) return [];
  const client = new GoogleGenAI({
    apiKey: settings.apiKey,
    vertexai: false,
    httpOptions: { ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}), timeout: 60000 },
  });
  const legacyModel = settings.model === "gemini-embedding-001";
  const all: number[][] = [];
  try {
    for (let index = 0; index < texts.length; index += 64) {
      signal?.throwIfAborted();
      const batch = texts.slice(index, index + 64);
      const response = await client.models.embedContent({
        model: settings.model,
        // Separate Content objects prevent Embedding 2 from aggregating multiple chunks into one vector.
        contents: batch.map((text) => ({ role: "user", parts: [{
          text: legacyModel ? text : task === "query" ? `task: question answering | query: ${text}` : `title: none | text: ${text}`,
        }] })),
        config: {
          abortSignal: signal,
          outputDimensionality: settings.dimensions,
          ...(legacyModel ? { taskType: task === "query" ? "QUESTION_ANSWERING" : "RETRIEVAL_DOCUMENT" } : {}),
        },
      });
      if (response.embeddings?.length !== batch.length) throw new EmbeddingResponseError("Gemini 返回的向量数量与文本数量不一致，请重试。");
      for (const embedding of response.embeddings) {
        if (!isEmbeddingVector(embedding?.values, settings.dimensions)) throw new EmbeddingResponseError("Gemini 返回的向量无效或维度不正确，请检查 GEMINI_EMBEDDING_DIMENSIONS 配置。");
        const norm = Math.hypot(...embedding.values);
        all.push(embedding.values.map((value) => value / norm));
      }
    }
    return all;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) throw new Error("Gemini 向量接口身份验证失败，请检查 GEMINI_API_KEY 及模型访问权限。");
      if (error.status === 404) throw new Error("Gemini 向量模型不可用，请检查 GEMINI_EMBEDDING_MODEL 配置。");
      if (error.status === 429) throw new Error("Gemini 向量接口额度或频率已达上限，请稍后重试。");
      if (error.status === 400) throw new Error("Gemini 向量请求参数无效，请检查模型、维度配置或文本长度。");
      throw new Error(`Gemini 向量请求失败（HTTP ${error.status}），请稍后重试。`);
    }
    // Do not expose transport errors that may contain credentials or request content.
    if (error instanceof EmbeddingResponseError) throw error;
    throw new Error("Gemini 向量服务连接失败或超时，请检查网络与 GEMINI_BASE_URL 后重试。");
  }
}
