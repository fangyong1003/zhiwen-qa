import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Role = "employee" | "admin";
type Provider = "openai" | "deepseek";
type User = { id: number; email: string; displayName: string; role: Role };
type Citation = { documentId: string; title: string; filename: string; chunkIndex: number; excerpt: string; score: number };
type Message = { id: string; role: "user" | "assistant"; content: string; citations?: Citation[]; created_at?: string; pending?: boolean };
type Conversation = { id: string; title: string; updated_at: string };
type DocumentItem = { id: string; title: string; filename: string; size_bytes: number; status: "processing" | "ready" | "failed"; error_message?: string; created_at: string; uploader_name: string; chunk_count: number };
type Staff = { id: number; email: string; display_name: string; role: Role; is_active: boolean; created_at: string };
type Audit = { id: string; action: string; user_name?: string; user_email?: string; target_type?: string; created_at: string };
type View = "chat" | "documents" | "people" | "audit";

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
  const [provider, setProvider] = useState<Provider>("openai");
  const [sending, setSending] = useState(false);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeTitle = useMemo(() => conversations.find((item) => item.id === activeConversation)?.title, [conversations, activeConversation]);
  const isAdmin = user?.role === "admin";

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

  async function loadConversations() {
    try { setConversations((await api<{ conversations: Conversation[] }>("/api/conversations")).conversations); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取对话。"); }
  }
  async function openConversation(id: string) {
    try {
      setActiveConversation(id);
      const data = await api<{ messages: Message[] }>(`/api/conversations/${id}`);
      setMessages(data.messages);
      setView("chat");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开对话。"); }
  }
  async function loadDocuments() { try { setDocuments((await api<{ documents: DocumentItem[] }>("/api/admin/documents")).documents); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取资料。"); } }
  async function loadStaff() { try { setStaff((await api<{ users: Staff[] }>("/api/admin/users")).users); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取成员。"); } }
  async function loadAudits() { try { setAudits((await api<{ logs: Audit[] }>("/api/admin/audit")).logs); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取审计记录。"); } }

  function newChat() { setActiveConversation(null); setMessages([]); setQuestion(""); setView("chat"); setError(""); }
  async function sendQuestion(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || sending) return;
    setSending(true); setError(""); setQuestion("");
    const pendingId = `pending-${Date.now()}`;
    setMessages((items) => [...items, { id: `user-${Date.now()}`, role: "user", content: text }, { id: pendingId, role: "assistant", content: "", citations: [], pending: true }]);
    try {
      const response = await fetch("/api/chat/stream", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text, conversationId: activeConversation ?? undefined, provider }) });
      if (!response.ok || !response.body) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? "无法生成回答。"); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const consume = (block: string) => {
        const lines = block.split("\n"); const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim(); const raw = lines.find((line) => line.startsWith("data:"))?.slice(5).trim();
        if (!type || !raw) return;
        const data = JSON.parse(raw) as { text?: string; citations?: Citation[]; conversationId?: string; messageId?: string; error?: string };
        if (type === "delta") setMessages((items) => items.map((item) => item.id === pendingId ? { ...item, content: item.content + (data.text ?? "") } : item));
        if (type === "sources") setMessages((items) => items.map((item) => item.id === pendingId ? { ...item, citations: data.citations ?? [] } : item));
        if (type === "done") { setMessages((items) => items.map((item) => item.id === pendingId ? { ...item, id: data.messageId ?? pendingId, pending: false, citations: data.citations ?? item.citations } : item)); if (data.conversationId) setActiveConversation(data.conversationId); void loadConversations(); }
        if (type === "error") throw new Error(data.error ?? "生成回答失败。");
      };
      while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const blocks = buffer.split("\n\n"); buffer = blocks.pop() ?? ""; blocks.forEach(consume); }
    } catch (reason) {
      setMessages((items) => items.filter((item) => item.id !== pendingId));
      setError(reason instanceof Error ? reason.message : "生成回答失败。");
    } finally { setSending(false); }
  }

  async function uploadDocument(file: File) {
    const body = new FormData(); body.append("file", file); setError("");
    try { await api("/api/admin/documents", { method: "POST", body }); await loadDocuments(); } catch (reason) { setError(reason instanceof Error ? reason.message : "上传失败。"); }
  }
  async function deleteDocument(id: string) { if (!window.confirm("删除后该资料将不再被检索，是否继续？")) return; try { await api(`/api/admin/documents/${id}`, { method: "DELETE" }); await loadDocuments(); } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败。"); } }
  async function reindexDocument(id: string) { try { await api(`/api/admin/documents/${id}/reindex`, { method: "POST" }); await loadDocuments(); } catch (reason) { setError(reason instanceof Error ? reason.message : "重建索引失败。"); } }
  async function rate(messageId: string, rating: "up" | "down") { try { await api("/api/feedback", { method: "POST", body: JSON.stringify({ messageId, rating }) }); } catch (reason) { setError(reason instanceof Error ? reason.message : "反馈未保存。"); } }
  async function logout() { await api("/api/auth/logout", { method: "POST" }).catch(() => undefined); setUser(null); setMessages([]); setConversations([]); }

  if (loading) return <div className="centered"><Spark /><p>正在连接知问…</p></div>;
  if (!user) return <AuthScreen needsSetup={needsSetup} onDone={(newUser) => { setUser(newUser); setNeedsSetup(false); }} />;

  return <main className="shell">
    <aside className="side">
      <div className="brand"><Spark /><span>知问</span></div>
      <button className="new-button" onClick={newChat}>＋ 新建对话 <kbd>⌘ K</kbd></button>
      <nav><button className={view === "chat" ? "nav active" : "nav"} onClick={() => setView("chat")}>◒ 开始提问</button>{isAdmin && <><button className={view === "documents" ? "nav active" : "nav"} onClick={() => setView("documents")}>▦ 知识库</button><button className={view === "people" ? "nav active" : "nav"} onClick={() => setView("people")}>♙ 成员与权限</button><button className={view === "audit" ? "nav active" : "nav"} onClick={() => setView("audit")}>◷ 审计记录</button></>}</nav>
      <div className="history"><p>最近对话</p>{conversations.length ? conversations.map((item) => <button key={item.id} onClick={() => void openConversation(item.id)} className={activeConversation === item.id ? "history-item selected" : "history-item"}><span>{item.title}</span><small>{timeLabel(item.updated_at)}</small></button>) : <span className="muted small">还没有保存的对话</span>}</div>
      <div className="profile"><span className="avatar">{shortName(user.displayName)}</span><div><strong>{user.displayName}</strong><small>{user.role === "admin" ? "管理员" : "普通员工"}</small></div><button onClick={() => void logout()} className="quiet" title="退出登录">↪</button></div>
    </aside>
    <section className="main"><header><div><span className="online" />内部知识助手 {activeTitle && <><i>/</i> {activeTitle}</>}</div><span className="user-email">{user.email}</span></header>{error && <div className="notice"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}{view === "chat" && <ChatView messages={messages} question={question} setQuestion={setQuestion} provider={provider} setProvider={setProvider} sending={sending} sendQuestion={sendQuestion} onRate={rate} />}{view === "documents" && <DocumentsView documents={documents} fileRef={fileRef} uploadDocument={uploadDocument} deleteDocument={deleteDocument} reindexDocument={reindexDocument} />}{view === "people" && <PeopleView staff={staff} reload={loadStaff} currentUser={user} />}{view === "audit" && <AuditView audits={audits} />}</section>
  </main>;
}

function AuthScreen({ needsSetup, onDone }: { needsSetup: boolean; onDone: (user: User) => void }) {
  const [mode, setMode] = useState(needsSetup ? "setup" : "login"); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const values = new FormData(event.currentTarget); const payload = { email: String(values.get("email")), password: String(values.get("password")), displayName: String(values.get("displayName") ?? "") }; try { setError(""); const result = await api<{ user: User }>(mode === "setup" ? "/api/setup" : "/api/auth/login", { method: "POST", body: JSON.stringify(payload) }); onDone(result.user); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败。"); } }
  return <div className="auth-wrap"><div className="auth-card"><div className="auth-brand"><Spark /><span>知问</span></div><p className="kicker">内部 AI 知识助手</p><h1>{mode === "setup" ? "创建首个管理员" : "登录知问"}</h1><p className="auth-copy">{mode === "setup" ? "系统仅在尚未存在账号时允许初始化。" : "使用管理员分配的账号访问已授权资料。"}</p><form onSubmit={submit}>{mode === "setup" && <label>姓名<input name="displayName" required maxLength={100} placeholder="例如：林晓" /></label>}<label>邮箱<input name="email" type="email" required placeholder="name@company.com" /></label><label>密码<input name="password" type="password" minLength={10} required placeholder="至少 10 位" /></label>{error && <p className="form-error">{error}</p>}<button className="primary" type="submit">{mode === "setup" ? "创建并进入系统" : "登录"}</button></form>{needsSetup && mode === "login" && <button className="link" onClick={() => setMode("setup")}>还未初始化？创建管理员</button>}</div></div>;
}

function ChatView({ messages, question, setQuestion, provider, setProvider, sending, sendQuestion, onRate }: { messages: Message[]; question: string; setQuestion: (value: string) => void; provider: Provider; setProvider: (value: Provider) => void; sending: boolean; sendQuestion: (event: FormEvent) => void; onRate: (id: string, value: "up" | "down") => void }) {
  const empty = messages.length === 0;
  return <div className="chat-view">{empty && <div className="chat-intro"><p className="kicker">公司知识，一问即得</p><h1>今天想弄清楚什么？</h1><p>回答仅基于你已获授权的资料，并且提供来源供你核验。</p></div>}<div className="thread">{messages.map((message) => <article key={message.id} className={`message ${message.role}`}><div className="message-label">{message.role === "user" ? "你" : <><Spark /> 知问回答</>}</div>{message.pending && !message.content ? <div className="typing"><i /><i /><i /></div> : <div className="message-content">{message.content}</div>}{message.role === "assistant" && !message.pending && <><div className="message-actions"><button onClick={() => void onRate(message.id, "up")}>✓ 有帮助</button><button onClick={() => void onRate(message.id, "down")}>× 不准确</button><button onClick={() => navigator.clipboard.writeText(message.content)}>复制</button></div>{message.citations?.length ? <div className="citations"><p>参考来源</p>{message.citations.map((item, index) => <a key={`${item.documentId}-${item.chunkIndex}`} href={`/api/documents/${item.documentId}/download`}><b>[{index + 1}]</b><span>{item.title}<small>{item.excerpt}</small></span><em>↗</em></a>)}</div> : null}</>}</article>)}</div><form className="composer" onSubmit={sendQuestion}><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：差旅费用报销的标准流程是什么？" rows={3} disabled={sending} /><div><span>⌁ 仅检索你有权查看的资料</span><label className="provider">模型<select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option></select></label><button className="send" disabled={!question.trim() || sending} type="submit">{sending ? "生成中…" : "发送 ↑"}</button></div></form></div>;
}

function DocumentsView({ documents, fileRef, uploadDocument, deleteDocument, reindexDocument }: { documents: DocumentItem[]; fileRef: React.RefObject<HTMLInputElement | null>; uploadDocument: (file: File) => void; deleteDocument: (id: string) => void; reindexDocument: (id: string) => void }) {
  return <div className="panel"><div className="panel-head"><div><p className="kicker">知识库管理</p><h1>已授权资料</h1><p>上传的资料会提取文本、生成向量并进入问答检索。</p></div><div><input ref={fileRef} className="hidden" type="file" accept=".pdf,.docx,.xlsx,.xls,.txt" onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadDocument(file); event.currentTarget.value = ""; }} /><button className="primary" onClick={() => fileRef.current?.click()}>＋ 上传资料</button></div></div><div className="upload-note">支持 PDF、DOCX、XLSX、XLS、TXT；单个文件最大 25 MB。扫描版 PDF 需要先完成 OCR。</div><div className="data-table"><div className="table-row table-title"><span>资料</span><span>状态</span><span>索引</span><span>上传者</span><span /></div>{documents.map((item) => <div className="table-row" key={item.id}><span><strong>{item.title}</strong><small>{item.filename} · {(item.size_bytes / 1024 / 1024).toFixed(1)} MB</small>{item.error_message && <small className="danger">{item.error_message}</small>}</span><span><i className={`status ${item.status}`} />{item.status === "ready" ? "可检索" : item.status === "processing" ? "处理中" : "失败"}</span><span>{item.chunk_count} 段</span><span>{item.uploader_name}</span><span className="row-actions"><button onClick={() => reindexDocument(item.id)}>重建索引</button><button className="danger-button" onClick={() => deleteDocument(item.id)}>删除</button></span></div>)}{!documents.length && <div className="empty-state">还没有知识资料。请上传第一份制度、流程或常见问题文档。</div>}</div></div>;
}

function PeopleView({ staff, reload, currentUser }: { staff: Staff[]; reload: () => Promise<void>; currentUser: User }) {
  const [error, setError] = useState("");
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/admin/users", { method: "POST", body: JSON.stringify({ email: form.get("email"), displayName: form.get("displayName"), password: form.get("password"), role: form.get("role") }) }); event.currentTarget.reset(); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建成员。"); } }
  async function update(id: number, payload: Record<string, unknown>) { try { await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) }); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法更新成员。"); } }
  return <div className="panel"><div className="panel-head"><div><p className="kicker">访问控制</p><h1>成员与权限</h1><p>管理员可以管理知识库、成员和审计记录；普通员工仅能提问和查看引用资料。</p></div></div><form className="create-user" onSubmit={add}><input name="displayName" required placeholder="姓名" /><input name="email" type="email" required placeholder="邮箱" /><input name="password" type="password" minLength={10} required placeholder="初始密码（至少 10 位）" /><select name="role" defaultValue="employee"><option value="employee">普通员工</option><option value="admin">管理员</option></select><button className="primary">添加成员</button></form>{error && <p className="form-error">{error}</p>}<div className="data-table"><div className="table-row table-title"><span>成员</span><span>角色</span><span>状态</span><span>加入时间</span><span /></div>{staff.map((item) => <div className="table-row" key={item.id}><span><strong>{item.display_name}</strong><small>{item.email}</small></span><span><select value={item.role} onChange={(event) => update(item.id, { role: event.target.value })}><option value="employee">普通员工</option><option value="admin">管理员</option></select></span><span><button className={item.is_active ? "tag good" : "tag"} disabled={item.id === currentUser.id} onClick={() => update(item.id, { isActive: !item.is_active })}>{item.is_active ? "已启用" : "已停用"}</button></span><span>{timeLabel(item.created_at)}</span><span /></div>)}</div></div>;
}

function AuditView({ audits }: { audits: Audit[] }) { return <div className="panel"><div className="panel-head"><div><p className="kicker">安全与可追溯</p><h1>审计记录</h1><p>保留登录、提问、资料管理和权限变更的操作记录。</p></div></div><div className="audit-list">{audits.map((item) => <div key={item.id}><span className="audit-dot" /><strong>{item.user_name ?? "系统"}</strong><span>{auditLabel(item.action)}</span><small>{item.target_type ?? ""} · {timeLabel(item.created_at)}</small></div>)}{!audits.length && <div className="empty-state">暂无审计记录。</div>}</div></div>; }
function auditLabel(action: string) { return ({ login: "登录系统", logout: "退出系统", ask_question: "发起知识问答", upload_document: "上传资料", delete_document: "删除资料", reindex_document: "重建资料索引", create_user: "创建成员", update_user: "更新成员权限", feedback: "提交回答反馈", setup_complete: "完成系统初始化" } as Record<string, string>)[action] ?? action; }
