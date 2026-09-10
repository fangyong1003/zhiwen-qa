import { usedCitations, type Citation } from "../shared/citations";

export function KnowledgeSources({ answer, citations }: { answer: string; citations?: Citation[] }) {
  const sources = usedCitations(answer, citations);
  if (!sources.length) return null;
  return <div className="citations">
    <p>{sources.some((item) => item.source === "attachment") ? "回答来源 · 含会话私有附件" : "知识库来源"}</p>
    {sources.map((item) => <a key={`${item.documentId}-${item.chunkIndex}-${item.referenceNumber}`} href={item.source === "attachment" ? `/api/conversations/${encodeURIComponent(item.conversationId ?? "")}/attachments/${encodeURIComponent(item.documentId)}/download` : `/api/documents/${item.documentId}/download`}>
      <b>[{item.referenceNumber}]</b><span>{item.title}<small>{item.excerpt}</small></span><em aria-hidden="true">↗</em>
    </a>)}
  </div>;
}
