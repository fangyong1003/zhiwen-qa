import path from "node:path";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT = 120000;

/** Validate container signatures and ZIP expansion before invoking document parsers. */
export function validateAttachmentBytes(bytes: Buffer, filename: string) {
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("附件不能为空且不能超过 10 MB。");
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".txt") {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("TXT 附件须使用 UTF-8 编码。"); }
    if (bytes.includes(0)) throw new Error("TXT 附件包含二进制内容。");
  } else if (ext === ".pdf") {
    if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("文件内容不是有效的 PDF。");
  } else if (ext === ".xls") {
    if (!bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) throw new Error("文件内容不是有效的 XLS。");
  } else if (ext === ".docx" || ext === ".xlsx") {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error("Office 文件结构无效。");
    const entries = bytes.readUInt16LE(end + 10);
    let cursor = bytes.readUInt32LE(end + 16);
    if (entries > 2000 || entries === 0 || cursor >= end) throw new Error("Office 文件过于复杂或结构无效。");
    let expanded = 0;
    let mainDocument = false;
    for (let index = 0; index < entries; index++) {
      if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Office 文件目录损坏。");
      const flags = bytes.readUInt16LE(cursor + 8);
      const size = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extraLength = bytes.readUInt16LE(cursor + 30);
      const commentLength = bytes.readUInt16LE(cursor + 32);
      expanded += size;
      if ((flags & 1) || expanded > 30 * 1024 * 1024 || cursor + 46 + nameLength + extraLength + commentLength > end) throw new Error("不支持加密、损坏或解压后超过 30 MB 的 Office 附件。");
      const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      if (/vbaProject\.bin$/i.test(name) || name.startsWith("/") || name.split("/").includes("..")) throw new Error("附件包含宏或不安全的文件路径。");
      if (name === (ext === ".docx" ? "word/document.xml" : "xl/workbook.xml")) mainDocument = true;
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (!mainDocument) throw new Error("附件格式与扩展名不一致。");
  } else throw new Error("仅支持 PDF、DOCX、XLSX、XLS 和 TXT 附件。");
}
