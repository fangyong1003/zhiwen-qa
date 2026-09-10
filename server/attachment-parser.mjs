import fs from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

try {
  const { validateAttachmentBytes, MAX_ATTACHMENT_TEXT } = await tsImport("./file-validation.ts", import.meta.url);
  validateAttachmentBytes(await fs.readFile(workerData.filePath), workerData.filename);
  const { extractText } = await tsImport("./documents.ts", import.meta.url);
  const text = (await extractText(workerData.filePath, workerData.filename)).trim();
  if (text.length < 10) throw new Error("未提取到足够文字；扫描文件请先完成 OCR。");
  if (text.length > MAX_ATTACHMENT_TEXT) throw new Error("附件提取文字超过 12 万字符，请拆分文件后上传。");
  parentPort.postMessage({ text });
} catch (error) {
  // Only validation messages are useful; parser internals may contain file contents or local paths.
  const message = error instanceof Error ? error.message : "";
  parentPort.postMessage({ error: /^(附件|文件内容|Office 文件|不支持加密|TXT 附件|仅支持|未提取到)/.test(message) ? message : "附件解析失败，请检查文件是否损坏或加密。" });
}
