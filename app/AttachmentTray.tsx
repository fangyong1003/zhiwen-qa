import { useId, useRef, useState } from "react";
import type { AnswerScope, Attachment } from "../shared/chat";

export function AttachmentTray({ attachments, scope, onScope, onUpload, onDelete, onRetry, disabled, uploading, compact = false }: {
  attachments: Attachment[]; scope: AnswerScope; onScope: (scope: AnswerScope) => void;
  onUpload: (files: File[]) => void; onDelete: (id: string) => void; onRetry: (id: string) => void;
  disabled: boolean; uploading: boolean; compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const regionId = useId();
  const [expanded, setExpanded] = useState(!compact);
  const scopeName = scope === "knowledge" ? "仅公司知识库" : scope === "attachments" ? "仅会话附件" : "附件＋公司知识库";
  const fileNotice = attachments.some((file) => file.status === "failed") ? " · 存在处理失败的附件" : attachments.some((file) => file.status !== "ready") ? " · 处理中" : "";
  return <section className="attachment-tray" aria-label="会话私有附件">
    <div className="attachment-heading"><span>本次资料 <small>{expanded ? "仅本人当前会话可用" : `${scopeName} · ${attachments.length} 个附件${fileNotice}`}</small></span>
      <input ref={input} type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.txt" hidden onChange={(event) => { onUpload(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <div className="attachment-actions"><button type="button" onClick={() => { setExpanded(true); input.current?.click(); }} disabled={disabled || uploading || attachments.length >= 5}>{uploading ? "上传中…" : "＋ 添加附件"}</button>
        <button type="button" aria-expanded={expanded} aria-controls={regionId} onClick={() => setExpanded(!expanded)}>{expanded ? "收起资料" : "展开资料"}</button></div>
    </div>
    <div id={regionId} hidden={!expanded}>
    {attachments.length > 0 && <ul className="attachment-list">{attachments.map((file) => <li key={file.id}>
      <div><strong title={file.filename}>{file.filename}</strong><small role="status">{file.status === "ready" ? `可用于追问 · ${Math.max(0.1, file.size_bytes / 1024).toFixed(1)} KB` : file.status === "failed" ? file.error_message || "处理失败" : file.status === "parsing" ? "正在解析文件…" : "正在建立检索索引…"}</small></div>
      {file.status === "failed" && <button type="button" disabled={disabled} onClick={() => onRetry(file.id)}>重试解析</button>}
      <button type="button" disabled={disabled} aria-label={`删除附件 ${file.filename}`} onClick={() => onDelete(file.id)}>删除</button>
    </li>)}</ul>}
    <label className="source-scope">回答依据<select value={scope} onChange={(event) => onScope(event.target.value as AnswerScope)} disabled={disabled}>
      <option value="knowledge">仅公司知识库</option><option value="attachments" disabled={!attachments.length}>仅会话附件</option><option value="combined" disabled={!attachments.length}>附件＋公司知识库</option>
    </select></label>
    <p>支持 PDF、Word、Excel、TXT；单文件 10 MB，最多 5 个。附件不会加入共享知识库。</p>
    <p>解析文本会交给 Gemini 建立索引，相关内容按需交给所选问答模型。</p>
    </div>
  </section>;
}
