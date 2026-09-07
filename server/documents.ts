import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

// pdf-parse 1.x runs a bundled demo without a CommonJS parent. Load it as a library.
const loadCommonJS = createRequire(import.meta.url);
const pdfParse = loadCommonJS("pdf-parse") as (bytes: Uint8Array) => ReturnType<typeof import("pdf-parse")>;

const supportedExtensions = new Set([".pdf", ".docx", ".xlsx", ".xls", ".txt"]);

export function isSupportedFile(filename: string) {
  return supportedExtensions.has(path.extname(filename).toLowerCase());
}

export async function extractText(filePath: string, filename: string) {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".txt") return buffer.toString("utf8");
  if (ext === ".pdf") {
    // PDF.js 1.x clones typed arrays using their constructor; Node Buffer can then
    // introduce a pooled backing store. A plain Uint8Array keeps PDF offsets intact.
    return (await pdfParse(new Uint8Array(buffer))).text;
  }
  if (ext === ".docx") return (await mammoth.extractRawText({ buffer })).value;
  if (ext === ".xlsx" || ext === ".xls") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return workbook.SheetNames.map((sheetName) => `工作表：${sheetName}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])}`).join("\n\n");
  }
  throw new Error("仅支持 PDF、Word（.docx）、Excel（.xlsx/.xls）和 TXT 文件。");
}
