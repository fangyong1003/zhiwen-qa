import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import { extractText, isSupportedFile } from "../../server/documents.ts";

function pdfFixture(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("document parser imports under ESM and extracts a real PDF", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhiwen-pdf-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fixture.pdf");
  await fs.writeFile(file, pdfFixture("Zhiwen PDF parser regression."));
  assert.match(await extractText(file, "fixture.pdf"), /Zhiwen PDF parser regression/);
});

test("text and spreadsheet extraction preserve knowledge content", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhiwen-doc-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const textFile = path.join(dir, "policy.txt");
  await fs.writeFile(textFile, "差旅报销需要提交发票与审批单。", "utf8");
  assert.equal(await extractText(textFile, "POLICY.TXT"), "差旅报销需要提交发票与审批单。");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目", "标准"], ["交通", "凭票报销"]]), "差旅规定");
  const excelFile = path.join(dir, "policy.xlsx");
  await fs.writeFile(excelFile, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  assert.match(await extractText(excelFile, "policy.xlsx"), /差旅规定\n项目,标准\n交通,凭票报销/);
  assert.equal(isSupportedFile("POLICY.PDF"), true);
  assert.equal(isSupportedFile("program.exe"), false);
});
