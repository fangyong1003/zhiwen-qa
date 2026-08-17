"use client";

import { FormEvent, useState } from "react";

const initialAnswer = { question: "差旅费用报销的标准流程是什么？", lead: "差旅结束后 30 天内，在「企业服务台」提交报销单；主管审批后，由财务在每周四统一付款。", details: ["机票、火车票和酒店须附原始电子凭证；市内交通可合并上传行程单。", "单次住宿超过 ¥800 或出差延长超过 2 天，需在出行前取得直属负责人书面批准。", "客户招待费用请使用「业务招待」类别，不与普通差旅合并提交。"] };
const quickQuestions = ["新员工入职第一周需要完成什么？", "如何申请采购和使用公司卡？", "远程办公设备补贴如何领取？"];
const conversations = [{ title: "差旅费用报销", time: "刚刚", active: true }, { title: "客户数据分级", time: "昨天", active: false }, { title: "产品发布检查清单", time: "8 月 15 日", active: false }];
function SparkMark() { return <span className="spark-mark" aria-hidden="true">✦</span>; }

export default function Home() {
  const [question, setQuestion] = useState(initialAnswer.question);
  const [answer, setAnswer] = useState(initialAnswer);
  const [copied, setCopied] = useState(false);
  function ask(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const trimmed = question.trim(); if (!trimmed) return; setAnswer({ question: trimmed, lead: "我已根据内部知识库整理了相关流程，并标出了可核验的制度来源。以下答案适合作为办理前的快速参考。", details: ["先确认事项所属业务类别，再按照对应模板提交申请或凭证。", "涉及预算、个人信息或对外承诺时，请在提交前通知直属负责人复核。", "若制度版本存在差异，以最新发布日期的正式文件为准。"] }); }
  async function copyAnswer() { await navigator.clipboard?.writeText(`${answer.question}\n\n${answer.lead}\n${answer.details.join("\n")}`); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  return <main className="app-shell">
    <aside className="sidebar" aria-label="导航">
      <div className="brand"><SparkMark /><span>知问</span></div>
      <button className="new-chat"><span>＋</span>新建对话 <kbd>⌘ K</kbd></button>
      <nav className="nav-list" aria-label="主导航"><a className="nav-item active" href="#ask"><span className="nav-icon">◒</span>开始提问</a><a className="nav-item" href="#sources"><span className="nav-icon">▦</span>知识库</a><a className="nav-item" href="#history"><span className="nav-icon">◷</span>历史记录</a></nav>
      <div className="history" id="history"><p className="eyebrow">最近对话</p>{conversations.map((conversation) => <button className={`history-row ${conversation.active ? "selected" : ""}`} key={conversation.title}><span>{conversation.title}</span><small>{conversation.time}</small></button>)}</div>
      <div className="profile"><div className="avatar">林</div><div><strong>林晓</strong><small>产品设计部</small></div><button aria-label="账户菜单" className="more">•••</button></div>
    </aside>
    <section className="workspace">
      <header className="topbar"><div className="crumb"><span className="status-dot" />知识助手 <span>/</span> 内部知识库</div><div className="top-actions"><button className="icon-button" aria-label="帮助">?</button><button className="avatar small" aria-label="账户">林</button></div></header>
      <div className="content" id="ask">
        <div className="intro"><p className="eyebrow">公司知识，一问即得</p><h1>今天想弄清楚什么？</h1><p>答案基于已授权的内部资料生成，并附上来源供你核对。</p></div>
        <form className="ask-box" onSubmit={ask}><label htmlFor="question">向知识库提问</label><div className="question-row"><textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={2} placeholder="例如：如何申请出差？" /><button className="send" type="submit" aria-label="发送问题">↑</button></div><div className="ask-footer"><span><span className="locked">⌁</span> 仅检索你有权查看的资料</span><span>Enter 发送 · Shift + Enter 换行</span></div></form>
        <div className="suggestions" aria-label="建议问题">{quickQuestions.map((item) => <button key={item} onClick={() => { setQuestion(item); setAnswer({ ...initialAnswer, question: item, lead: "我正在从已授权的制度、流程与团队文档中为你梳理答案。", details: ["请从下方参考来源开始查看相关说明。", "如需办理，请按对应文档中的职责人与时限操作。", "遇到特殊情况，可在对话中继续补充背景。"] }); }}>{item}<span>↗</span></button>)}</div>
        <article className="answer-card" aria-live="polite"><div className="answer-header"><div><span className="answer-badge"><SparkMark /> 知问回答</span><p>基于 3 份已授权资料 · 置信度高</p></div><button className="copy" onClick={copyAnswer}>{copied ? "已复制" : "复制回答"}</button></div><h2>{answer.question}</h2><p className="answer-lead">{answer.lead}</p><ol>{answer.details.map((detail) => <li key={detail}>{detail}</li>)}</ol><div className="answer-actions"><button>✓ 有帮助</button><button>↻ 重新生成</button><button>↗ 分享给同事</button></div></article>
        <section className="sources" id="sources"><div className="sources-heading"><div><p className="eyebrow">可追溯来源</p><h2>回答参考了这些资料</h2></div><button>查看全部资料 <span>→</span></button></div><div className="source-grid"><article className="source"><div className="file-type">PDF</div><div><h3>差旅及费用报销管理办法</h3><p>财务中心 · 2026.07 更新</p></div><span>↗</span></article><article className="source"><div className="file-type doc">DOC</div><div><h3>2026 年度费用标准表</h3><p>行政部 · 2026.01 发布</p></div><span>↗</span></article><article className="source"><div className="file-type note">NOTE</div><div><h3>出差申请常见问题</h3><p>企业服务台 · 2026.06 更新</p></div><span>↗</span></article></div></section>
      </div><footer>知问可能会出错；办理正式事项前，请核对原始制度文件。</footer>
    </section>
  </main>;
}
