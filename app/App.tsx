import { FormEvent, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { canSendQuestion, isSendKey } from "./composer";
import { WebSearchResults } from "./WebSearchResults";
import { KnowledgeSources } from "./KnowledgeSources";
import type { Citation } from "../shared/citations";
import type { FeedbackRating } from "../shared/feedback";
import { submitFeedback } from "./feedback";
import { MessageFeedback } from "./MessageFeedback";
import type { WebSearchResult } from "../shared/web-search";
import type { AnswerScope, Attachment, TurnRecord, TurnRequest } from "../shared/chat";
import { AttachmentTray } from "./AttachmentTray";
import { newRequestId, readChatEvents } from "./chat-stream";

type Role = "employee" | "admin";
type Provider = "openai" | "deepseek" | "gemini";
type User = { id: number; email: string; displayName: string; role: Role };
type Message = { id: string; role: "user" | "assistant"; content: string; citations?: Citation[]; created_at?: string; pending?: boolean; webSearch?: boolean; webResult?: WebSearchResult; feedback?: FeedbackRating | null; turn?: TurnRecord };
type Conversation = { id: string; title: string; updated_at: string };
type DocumentItem = { id: string; title: string; filename: string; size_bytes: number; status: "processing" | "ready" | "failed"; error_message?: string; created_at: string; uploader_name: string; chunk_count: number };
type Staff = { id: number; email: string; display_name: string; role: Role; is_active: boolean; created_at: string };
type Audit = { id: string; action: string; user_name?: string; user_email?: string; target_type?: string; created_at: string };
type View = "chat" | "documents" | "people" | "audit";
type ChatSession = { attachments: Attachment[]; scope: AnswerScope; onScope: (scope: AnswerScope) => void; onUpload: (files: File[]) => void; onDelete: (id: string) => void; onRetryAttachment: (id: string) => void; onRetry: (turn: TurnRecord, withoutSearch?: boolean) => void; onStop: (id?: string) => void; blocked: boolean; locked: boolean; uploading: boolean; progress: string; compressed: boolean };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", headers: { ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init?.headers }, ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "请求失败，请稍后重试。");
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

function Spark() { return <span className="spark" aria-hidden="true">✦</span>; }
function timeLabel(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function shortName(name: string) { return name.slice(0, 1).toUpperCase(); }

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("chat");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [provider, setProvider] = useState<Provider>("gemini");
  const [webSearch, setWebSearch] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const activeRef = useRef<string | null>(null);
  const runningRef = useRef<{ request: TurnRequest; controller: AbortController } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [scope, setScope] = useState<AnswerScope>("knowledge");
  const [uploading, setUploading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [progress, setProgress] = useState("");
  const [compressed, setCompressed] = useState(false);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeTitle = useMemo(() => conversations.find((item) => item.id === activeConversation)?.title, [conversations, activeConversation]);
  const isAdmin = user?.role === "admin";
  const remoteRunning = turns.some((turn) => turn.status === "running");
  const attachmentsPending = attachments.some((file) => file.status === "parsing" || file.status === "indexing");
  const busy = sending || uploading || opening;
  const blocked = uploading || opening || (remoteRunning && !sending) || (scope !== "knowledge" && (!attachments.length || attachments.some((file) => file.status !== "ready")));

  useEffect(() => {
    Promise.all([
      api<{ needsSetup: boolean }>("/api/setup").catch(() => ({ needsSetup: false })),
      api<{ user: User }>("/api/auth/me").catch(() => null),
    ]).then(([setup, me]) => {
      setNeedsSetup(setup.needsSetup);
      setUser(me?.user ?? null);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (user) void loadConversations(); }, [user]);
  useEffect(() => { if (isAdmin && view === "documents") void loadDocuments(); }, [view, isAdmin]);
  useEffect(() => { if (isAdmin && view === "people") void loadStaff(); }, [view, isAdmin]);
  useEffect(() => { if (isAdmin && view === "audit") void loadAudits(); }, [view, isAdmin]);
  useEffect(() => {
    if (!activeConversation || sending || (!attachmentsPending && !remoteRunning)) return;
    const timer = setInterval(() => { void syncConversation(activeConversation).catch(() => undefined); }, 1500);
    return () => clearInterval(timer);
  }, [activeConversation, attachmentsPending, remoteRunning, sending]);

  async function loadConversations() {
    try { setConversations((await api<{ conversations: Conversation[] }>("/api/conversations")).conversations); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取对话。"); }
  }
  async function syncConversation(id: string, restoreScope = false) {
    const [data, files, state] = await Promise.all([
      api<{ messages: Message[] }>(`/api/conversations/${id}`),
      api<{ attachments: Attachment[] }>(`/api/conversations/${id}/attachments`),
      api<{ turns: TurnRecord[]; compressed: boolean }>(`/api/conversations/${id}/turns`),
    ]);
    if (activeRef.current !== id || sendingRef.current) return;
    const restored: Message[] = [];
    for (const message of data.messages) {
      restored.push(message);
      const turn = state.turns.find((item) => item.user_message_id === message.id && item.status !== "completed");
      if (turn) restored.push({ id: `turn-${turn.id}`, role: "assistant", content: turn.partial_content, pending: turn.status === "running", turn });
    }
    setMessages(restored); setAttachments(files.attachments); setTurns(state.turns); setCompressed(state.compressed);
    if (restoreScope) setScope(files.attachments.length ? state.turns.at(-1)?.request.scope ?? "combined" : "knowledge");
  }
  async function openConversation(id: string) {
    if (busy) return;
    activeRef.current = id;
    setOpening(true); setMessages([]); setAttachments([]); setTurns([]); setError("");
    try {
      setActiveConversation(id);
      await syncConversation(id, true);
      setView("chat");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开对话。"); } finally { setOpening(false); }
  }
  async function loadDocuments() { try { setDocuments((await api<{ documents: DocumentItem[] }>("/api/admin/documents")).documents); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取资料。"); } }
  async function loadStaff() { try { setStaff((await api<{ users: Staff[] }>("/api/admin/users")).users); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取成员。"); } }
  async function loadAudits() { try { setAudits((await api<{ logs: Audit[] }>("/api/admin/audit")).logs); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取审计记录。"); } }

  function newChat() { if (busy) return; activeRef.current = null; setActiveConversation(null); setMessages([]); setAttachments([]); setTurns([]); setScope("knowledge"); setCompressed(false); setProgress(""); setQuestion(""); setProvider("gemini"); setWebSearch(false); setView("chat"); setError(""); }
  async function ensureConversation() {
    if (activeRef.current) return activeRef.current;
    const id = newRequestId();
    await api("/api/conversations", { method: "POST", body: JSON.stringify({ id }) });
    activeRef.current = id;
    setActiveConversation(id);
    void loadConversations();
    return id;
  }
  async function uploadAttachments(files: File[]) {
    if (busy || remoteRunning) return;
    if (attachments.length + files.length > 5 || files.some((file) => file.size > 10 * 1024 * 1024)) { setError("每会话最多 5 个附件，单文件不能超过 10 MB。"); return; }
    setUploading(true); setError("");
    try {
      const id = await ensureConversation();
      for (const file of files) {
        const body = new FormData(); body.append("file", file);
        const result = await api<{ attachment: Attachment }>(`/api/conversations/${id}/attachments`, { method: "POST", body });
        setAttachments((items) => [...items, result.attachment]);
        setScope("combined");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "上传附件失败。"); } finally { setUploading(false); }
  }
  async function deleteAttachment(id: string) {
    if (!activeRef.current || busy || remoteRunning || !window.confirm("删除原文件及其检索索引？之后不会再用于问答。已生成的历史回答不会自动删除。")) return;
    try {
      await api(`/api/conversations/${activeRef.current}/attachments/${id}`, { method: "DELETE" });
      setAttachments((items) => items.filter((file) => file.id !== id));
      if (attachments.length === 1) setScope("knowledge");
      setCompressed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除附件失败。"); }
  }
  async function retryAttachment(id: string) {
    if (!activeRef.current || busy || remoteRunning) return;
    try { await api(`/api/conversations/${activeRef.current}/attachments/${id}/retry`, { method: "POST" }); setAttachments((items) => items.map((file) => file.id === id ? { ...file, status: "parsing", error_message: null } : file)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "重试解析失败。"); }
  }
  async function sendQuestion(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!canSendQuestion(text, sendingRef.current) || blocked) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const conversationId = await ensureConversation();
      await runTurn({ requestId: newRequestId(), conversationId, question: text, provider, webSearch, scope, attachmentIds: scope === "knowledge" ? [] : attachments.map((file) => file.id) }, false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建对话。"); }
    finally { sendingRef.current = false; setSending(false); }
  }
  async function runTurn(request: TurnRequest, retry: boolean) {
    const pendingId = `turn-${request.requestId}`;
    const controller = new AbortController();
    runningRef.current = { request, controller };
    sendingRef.current = true;
    setSending(true); setError(""); setQuestion(""); setProgress("正在准备问题…");
    const turn: TurnRecord = { id: request.requestId, user_message_id: `user-${request.requestId}`, status: "running", partial_content: "", request };
    setMessages((items) => [...items.filter((item) => item.id !== pendingId), ...(!retry ? [{ id: turn.user_message_id, role: "user" as const, content: request.question, webSearch: request.webSearch }] : []), { id: pendingId, role: "assistant", content: "", citations: [], pending: true, webSearch: request.webSearch, turn }]);
    try {
      const response = await fetch("/api/chat/stream", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
      await readChatEvents(response, (type, raw) => {
        const data = raw as { text?: string; citations?: Citation[]; messageId?: string; userMessageId?: string; error?: string; code?: string; label?: string; compressed?: boolean; webSearch?: boolean; webResult?: WebSearchResult };
        if (type === "meta" && data.userMessageId) { turn.user_message_id = data.userMessageId; setMessages((items) => items.map((item) => item.id === `user-${request.requestId}` || item.id === data.userMessageId ? { ...item, id: data.userMessageId!, webSearch: request.webSearch } : item)); }
        if (type === "progress") setProgress(data.label ?? "处理中…");
        if (type === "context") setCompressed(Boolean(data.compressed));
        if (type === "delta") setMessages((items) => items.map((item) => item.id === pendingId ? { ...item, content: item.content + (data.text ?? "") } : item));
        if (type === "sources") setMessages((items) => items.map((item) => item.id === pendingId ? { ...item, citations: data.citations ?? [], webResult: data.webResult } : item));
        if (type === "done") { setMessages((items) => items.map((item) => item.id === pendingId ? { ...item, id: data.messageId ?? pendingId, pending: false, turn: undefined, webSearch: data.webSearch ?? request.webSearch, citations: data.citations ?? item.citations, webResult: data.webResult ?? item.webResult } : item)); void loadConversations(); }
        if (type === "error" || type === "cancelled") {
          turn.status = type === "cancelled" ? "cancelled" : "failed"; turn.error_code = data.code; turn.error_message = data.error;
          setMessages((items) => items.map((item) => item.id === pendingId ? { ...item, pending: false, turn: { ...turn } } : item));
        }
      });
    } catch (reason) {
      turn.status = controller.signal.aborted ? "cancelled" : "failed";
      turn.error_message = controller.signal.aborted ? "已停止生成，可重试。" : reason instanceof Error ? reason.message : "生成回答失败。";
      setMessages((items) => items.map((item) => item.id === pendingId ? { ...item, pending: false, turn: { ...turn } } : item));
    } finally {
      runningRef.current = null; sendingRef.current = false; setSending(false); setProgress("");
      // Successful streams keep their ephemeral web result; refresh only turn/attachment status here.
      const state = await api<{ turns: TurnRecord[] }>(`/api/conversations/${request.conversationId}/turns`).catch(() => null);
      if (state && activeRef.current === request.conversationId) setTurns(state.turns);
    }
  }
  async function retryTurn(turn: TurnRecord, withoutSearch = false) {
    if (sendingRef.current || busy || remoteRunning) return;
    if (withoutSearch) setWebSearch(false);
    await runTurn({ ...turn.request, webSearch: withoutSearch ? false : turn.request.webSearch }, true);
  }
  async function stopTurn(id = runningRef.current?.request.requestId) {
    if (!id) return;
    setProgress("正在停止…");
    try { await api(`/api/chat/turns/${id}/cancel`, { method: "POST" }); }
    catch (reason) { if (!runningRef.current) setError(reason instanceof Error ? reason.message : "停止失败，请重试。"); }
    finally { runningRef.current?.controller.abort(); if (activeRef.current && !sendingRef.current) await syncConversation(activeRef.current).catch(() => undefined); }
  }

  async function uploadDocument(file: File) {
    const body = new FormData(); body.append("file", file); setError("");
    try { await api("/api/admin/documents", { method: "POST", body }); } catch (reason) { setError(reason instanceof Error ? reason.message : "上传失败。"); } finally { await loadDocuments(); }
  }
  async function deleteDocument(id: string) { if (!window.confirm("删除后该资料将不再被检索，是否继续？")) return; try { await api(`/api/admin/documents/${id}`, { method: "DELETE" }); await loadDocuments(); } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败。"); } }
  async function reindexDocument(id: string) { try { await api(`/api/admin/documents/${id}/reindex`, { method: "POST" }); await loadDocuments(); } catch (reason) { setError(reason instanceof Error ? reason.message : "重建索引失败。"); } }
  async function rate(messageId: string, rating: FeedbackRating) {
    const saved = await submitFeedback(messageId, rating);
    setMessages((items) => items.map((item) => item.id === messageId ? { ...item, feedback: saved } : item));
    return saved;
  }
  async function logout() { await api("/api/auth/logout", { method: "POST" }).catch(() => undefined); activeRef.current = null; setActiveConversation(null); setAttachments([]); setTurns([]); setUser(null); setMessages([]); setConversations([]); setWebSearch(false); }

  const session: ChatSession = { attachments, scope, onScope: setScope, onUpload: uploadAttachments, onDelete: deleteAttachment, onRetryAttachment: retryAttachment, onRetry: retryTurn, onStop: stopTurn, blocked, locked: busy || remoteRunning, uploading, progress, compressed };

  if (loading) return <div className="centered"><Spark /><p>正在连接知问…</p></div>;
  if (!user) return <AuthScreen needsSetup={needsSetup} onDone={(newUser) => { setUser(newUser); setNeedsSetup(false); }} />;

  return <main className="shell">
    <aside className="side">
      <div className="brand"><Spark /><span>知问</span></div>
      <button className="new-button" onClick={newChat} disabled={busy}>＋ 新建对话 <kbd>⌘ K</kbd></button>
      <nav><button className={view === "chat" ? "nav active" : "nav"} onClick={() => setView("chat")}>◒ 开始提问</button>{isAdmin && <><button className={view === "documents" ? "nav active" : "nav"} onClick={() => setView("documents")}>▦ 知识库</button><button className={view === "people" ? "nav active" : "nav"} onClick={() => setView("people")}>♙ 成员与权限</button><button className={view === "audit" ? "nav active" : "nav"} onClick={() => setView("audit")}>◷ 审计记录</button></>}</nav>
      <div className="history"><p>最近对话</p>{conversations.length ? conversations.map((item) => <button key={item.id} onClick={() => void openConversation(item.id)} disabled={busy} className={activeConversation === item.id ? "history-item selected" : "history-item"}><span>{item.title}</span><small>{timeLabel(item.updated_at)}</small></button>) : <span className="muted small">还没有保存的对话</span>}</div>
      <div className="profile"><span className="avatar">{shortName(user.displayName)}</span><div><strong>{user.displayName}</strong><small>{user.role === "admin" ? "管理员" : "普通员工"}</small></div><button onClick={() => void logout()} disabled={sending} className="quiet" title="退出登录">↪</button></div>
    </aside>
    <section className="main"><header><div><span className="online" />内部知识助手 {activeTitle && <><i>/</i> {activeTitle}</>}</div><span className="user-email">{user.email}</span></header>{error && <div className="notice"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}{view === "chat" && <ChatView messages={messages} question={question} setQuestion={setQuestion} provider={provider} setProvider={setProvider} webSearch={webSearch} setWebSearch={setWebSearch} sending={sending} sendQuestion={sendQuestion} onRate={rate} session={session} />}{view === "documents" && <DocumentsView documents={documents} fileRef={fileRef} uploadDocument={uploadDocument} deleteDocument={deleteDocument} reindexDocument={reindexDocument} />}{view === "people" && <PeopleView staff={staff} reload={loadStaff} currentUser={user} />}{view === "audit" && <AuditView audits={audits} />}</section>
  </main>;
}

function AuthScreen({ needsSetup, onDone }: { needsSetup: boolean; onDone: (user: User) => void }) {
  const [mode, setMode] = useState(needsSetup ? "setup" : "login"); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const values = new FormData(event.currentTarget); const payload = { email: String(values.get("email")), password: String(values.get("password")), displayName: String(values.get("displayName") ?? "") }; try { setError(""); const result = await api<{ user: User }>(mode === "setup" ? "/api/setup" : "/api/auth/login", { method: "POST", body: JSON.stringify(payload) }); onDone(result.user); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败。"); } }
  return <div className="auth-wrap"><div className="auth-card"><div className="auth-brand"><Spark /><span>知问</span></div><p className="kicker">内部 AI 知识助手</p><h1>{mode === "setup" ? "创建首个管理员" : "登录知问"}</h1><p className="auth-copy">{mode === "setup" ? "系统仅在尚未存在账号时允许初始化。" : "使用管理员分配的账号访问公司共享知识库。"}</p><form onSubmit={submit}>{mode === "setup" && <label>姓名<input name="displayName" required maxLength={100} placeholder="例如：林晓" /></label>}<label>邮箱<input name="email" type="email" required placeholder="name@company.com" /></label><label>密码<input name="password" type="password" minLength={10} required placeholder="至少 10 位" /></label>{error && <p className="form-error">{error}</p>}<button className="primary" type="submit">{mode === "setup" ? "创建并进入系统" : "登录"}</button></form>{needsSetup && mode === "login" && <button className="link" onClick={() => setMode("setup")}>还未初始化？创建管理员</button>}</div></div>;
}

export function ChatView({ messages, question, setQuestion, provider, setProvider, webSearch, setWebSearch, sending, sendQuestion, onRate, session }: { messages: Message[]; question: string; setQuestion: (value: string) => void; provider: Provider; setProvider: (value: Provider) => void; webSearch: boolean; setWebSearch: (value: boolean) => void; sending: boolean; sendQuestion: (event: FormEvent) => void; onRate: (id: string, value: FeedbackRating) => Promise<FeedbackRating>; session?: ChatSession }) {
  const empty = messages.length === 0;
  const composing = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const previousQuestionId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const thread = threadRef.current;
    const questionId = messages.filter((message) => message.role === "user").at(-1)?.id;
    if (thread && (followMessages.current || questionId !== previousQuestionId.current)) {
      thread.scrollTop = thread.scrollHeight;
      followMessages.current = true;
    }
    previousQuestionId.current = questionId;
  }, [messages]);
  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!isSendKey(event.nativeEvent, composing.current)) return;
    event.preventDefault();
    if (session?.blocked) return;
    if (!event.repeat && canSendQuestion(question, sending)) event.currentTarget.form?.requestSubmit();
  }
  return <div className={`chat-view${empty ? "" : " has-messages"}`}>
    {empty && <div className="chat-intro"><p className="kicker">公司知识，一问即得</p><h1>今天想弄清楚什么？</h1><p>先查公司知识库，需要时也可以开启联网搜索。</p></div>}
    <div className="thread" ref={threadRef} role="log" aria-label="对话记录" aria-busy={sending} tabIndex={empty ? -1 : 0} onScroll={(event) => {
      const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
      followMessages.current = scrollHeight - scrollTop - clientHeight < 80;
    }}>{messages.map((message) => <article key={message.id} className={`message ${message.role}`}>
      <div className="message-label">{message.role === "user" ? "你" : <><Spark /> {message.turn?.request?.scope && message.turn.request.scope !== "knowledge" || message.citations?.some((citation) => citation.source === "attachment") ? "资料回答" : "知识库回答"}</>}{message.webSearch && <span className="search-badge">已开启联网</span>}</div>
      {message.pending && !message.content ? <div className="typing" role="status"><i /><i /><i /><span>{message.webSearch ? "正在检索资料和搜索网页…" : "正在检索知识库…"}</span></div> : <div className="message-content">{message.content}</div>}
      {message.turn && message.turn.status !== "completed" && <div className="turn-recovery">
        <p role="status">{message.pending ? session?.progress || "回答仍在生成，可等待保存结果或停止。" : message.turn.error_message || (message.turn.status === "cancelled" ? "已停止生成。" : "本次回答未完成。")}</p>
        {!message.pending && message.content && <small>以上为未完成的内容，不作为完整回答，也不会进入后续上下文。</small>}
        {message.turn.status === "running" ? <button type="button" onClick={() => session?.onStop(message.turn!.id)}>停止生成</button> : <>
          <button type="button" disabled={sending || session?.locked} onClick={() => session?.onRetry(message.turn!)}>重试此问题</button>
          {message.turn.error_code === "search_failed" && <button type="button" disabled={sending || session?.locked} onClick={() => session?.onRetry(message.turn!, true)}>关闭联网并继续</button>}
        </>}
      </div>}
      {message.role === "assistant" && !message.pending && (!message.turn || message.turn.status === "completed") && <>
        <div className="message-actions"><MessageFeedback messageId={message.id} rating={message.feedback} onRate={onRate} /><button onClick={() => navigator.clipboard.writeText(message.content)}>{message.citations?.some((citation) => citation.source === "attachment") ? "复制资料回答" : "复制知识库回答"}</button></div>
        <KnowledgeSources answer={message.content} citations={message.citations} />
        {message.webResult ? <WebSearchResults result={message.webResult} /> : message.webSearch && <p className="search-notice">本轮曾开启联网搜索。联网补充仅当次展示，不保存到历史记录。</p>}
      </>}
    </article>)}</div>
    <form className="composer" onSubmit={sendQuestion}>
      <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={onComposerKeyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} aria-label="输入问题" aria-describedby="composer-hint" placeholder="例如：差旅费用报销的标准流程是什么？" rows={2} disabled={sending} />
      {session && <AttachmentTray key={messages.length ? "active" : "draft"} compact={messages.length > 0} attachments={session.attachments} scope={session.scope} onScope={session.onScope} onUpload={session.onUpload} onDelete={session.onDelete} onRetry={session.onRetryAttachment} disabled={session.locked} uploading={session.uploading} />}
      {session?.compressed && <p className="context-note">较早的对话已压缩为摘要，最近对话和本轮相关资料优先保留。</p>}
      <div className="composer-controls">
        <label className={`search-toggle${webSearch ? " selected" : ""}`}><input type="checkbox" checked={webSearch} onChange={(event) => setWebSearch(event.target.checked)} disabled={sending} /><span>联网搜索</span></label>
        <label className="provider">模型<select value={provider} onChange={(event) => setProvider(event.target.value as Provider)} disabled={sending}><option value="gemini">Gemini</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option></select></label>
        {sending && session ? <button className="send stop-button" type="button" onClick={() => session.onStop()}>停止生成</button> : <button className="send" disabled={!canSendQuestion(question, sending) || session?.blocked} type="submit">{sending ? "生成中…" : "发送 ↑"}</button>}
      </div>
      <p id="composer-hint" className="composer-hint">{webSearch ? "联网会将当前问题交给 Google 搜索，可能产生额外用量；请勿输入机密内容。" : session?.scope === "attachments" ? "仅检索本会话附件，不查询公司共享知识库。" : session?.scope === "combined" ? "检索本会话附件及公司共享知识库。" : "仅检索公司共享知识库。"}<span>Enter 发送 · Shift+Enter 换行</span></p>
    </form>
  </div>;
}

function DocumentsView({ documents, fileRef, uploadDocument, deleteDocument, reindexDocument }: { documents: DocumentItem[]; fileRef: React.RefObject<HTMLInputElement | null>; uploadDocument: (file: File) => void; deleteDocument: (id: string) => void; reindexDocument: (id: string) => void }) {
  return <div className="panel"><div className="panel-head"><div><p className="kicker">知识库管理</p><h1>共享资料</h1><p>上传的资料会提取文本、生成向量并进入问答检索。</p></div><div><input ref={fileRef} className="hidden" type="file" accept=".pdf,.docx,.xlsx,.xls,.txt" onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadDocument(file); event.currentTarget.value = ""; }} /><button className="primary" onClick={() => fileRef.current?.click()}>＋ 上传资料</button></div></div><div className="upload-note">支持 PDF、DOCX、XLSX、XLS、TXT；单个文件最大 25 MB。扫描版 PDF 需要先完成 OCR。</div><div className="data-table"><div className="table-row table-title"><span>资料</span><span>状态</span><span>索引</span><span>上传者</span><span /></div>{documents.map((item) => <div className="table-row" key={item.id}><span><strong>{item.title}</strong><small>{item.filename} · {(item.size_bytes / 1024 / 1024).toFixed(1)} MB</small>{item.error_message && <small className="danger">{item.error_message}</small>}</span><span><i className={`status ${item.status}`} />{item.status === "ready" ? "可检索" : item.status === "processing" ? "处理中" : "失败"}</span><span>{item.chunk_count} 段</span><span>{item.uploader_name}</span><span className="row-actions"><button onClick={() => reindexDocument(item.id)}>重建索引</button><button className="danger-button" onClick={() => deleteDocument(item.id)}>删除</button></span></div>)}{!documents.length && <div className="empty-state">还没有知识资料。请上传第一份制度、流程或常见问题文档。</div>}</div></div>;
}

function PeopleView({ staff, reload, currentUser }: { staff: Staff[]; reload: () => Promise<void>; currentUser: User }) {
  const [error, setError] = useState("");
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); try { setError(""); await api("/api/admin/users", { method: "POST", body: JSON.stringify({ email: form.get("email"), displayName: form.get("displayName"), password: form.get("password"), role: form.get("role") }) }); element.reset(); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建成员。"); } }
  async function update(id: number, payload: Record<string, unknown>) { try { await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) }); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法更新成员。"); } }
  return <div className="panel"><div className="panel-head"><div><p className="kicker">访问控制</p><h1>成员与权限</h1><p>管理员可以管理知识库、成员和审计记录；普通员工仅能提问和查看引用资料。</p></div></div><form className="create-user" onSubmit={add}><input name="displayName" required placeholder="姓名" /><input name="email" type="email" required placeholder="邮箱" /><input name="password" type="password" minLength={10} required placeholder="初始密码（至少 10 位）" /><select name="role" defaultValue="employee"><option value="employee">普通员工</option><option value="admin">管理员</option></select><button className="primary">添加成员</button></form>{error && <p className="form-error">{error}</p>}<div className="data-table"><div className="table-row table-title"><span>成员</span><span>角色</span><span>状态</span><span>加入时间</span><span /></div>{staff.map((item) => <div className="table-row" key={item.id}><span><strong>{item.display_name}</strong><small>{item.email}</small></span><span><select value={item.role} onChange={(event) => update(item.id, { role: event.target.value })}><option value="employee">普通员工</option><option value="admin">管理员</option></select></span><span><button className={item.is_active ? "tag good" : "tag"} disabled={item.id === currentUser.id} onClick={() => update(item.id, { isActive: !item.is_active })}>{item.is_active ? "已启用" : "已停用"}</button></span><span>{timeLabel(item.created_at)}</span><span /></div>)}</div></div>;
}

function AuditView({ audits }: { audits: Audit[] }) { return <div className="panel"><div className="panel-head"><div><p className="kicker">安全与可追溯</p><h1>审计记录</h1><p>保留登录、提问、资料管理和权限变更的操作记录。</p></div></div><div className="audit-list">{audits.map((item) => <div key={item.id}><span className="audit-dot" /><strong>{item.user_name ?? "系统"}</strong><span>{auditLabel(item.action)}</span><small>{item.target_type ?? ""} · {timeLabel(item.created_at)}</small></div>)}{!audits.length && <div className="empty-state">暂无审计记录。</div>}</div></div>; }
function auditLabel(action: string) { return ({ login: "登录系统", logout: "退出系统", ask_question: "发起知识问答", upload_document: "上传资料", delete_document: "删除资料", reindex_document: "重建资料索引", create_user: "创建成员", update_user: "更新成员权限", feedback: "提交回答反馈", setup_complete: "完成系统初始化" } as Record<string, string>)[action] ?? action; }
