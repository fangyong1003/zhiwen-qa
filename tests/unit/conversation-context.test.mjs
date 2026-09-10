import assert from "node:assert/strict";
import test from "node:test";
import { budgetPrompt, clipText, prepareConversationContext, textBudget } from "../../server/conversation-context.ts";

const messages = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `报销审批讨论 ${index}`, sequence_no: index + 1 }));

test("short explicit questions keep recent context without paying for a planner call", async () => {
  const plan = await prepareConversationContext(messages.slice(0, 2), "", 0, "报销发票需要哪些信息？", [], async () => { throw new Error("unexpected model call"); });
  assert.equal(plan.query, "报销发票需要哪些信息？");
  assert.equal(plan.compressed, false);
  assert.equal(plan.history.length, 2);
});

test("long conversations compress older turns and retain recent verbatim messages", async () => {
  let input;
  const plan = await prepareConversationContext(messages, "用户预算 300 元。", 0, "报销发票要求是什么？", [], async (instructions, text) => {
    assert.match(instructions, /CONVERSATION_SUMMARY/);
    input = JSON.parse(text);
    return JSON.stringify({ summary: "用户预算 300 元；待核对审批规则。" });
  });
  assert.equal(input.previousSummary, "用户预算 300 元。");
  assert.equal(input.history.length, 6);
  assert.equal(plan.through, 6);
  assert.deepEqual(plan.history, messages.slice(-6));
  assert.equal(plan.summary, "用户预算 300 元；待核对审批规则。");
  assert.equal(plan.compressed, true);
});

test("follow-ups are rewritten for retrieval without replacing the user's question", async () => {
  const plan = await prepareConversationContext(messages.slice(0, 2), "", 0, "这个需要谁审批？", ["报销制度.pdf"], async (instructions, input) => {
    assert.match(instructions, /CONVERSATION_QUERY/);
    assert.equal(JSON.parse(input).question, "这个需要谁审批？");
    return JSON.stringify({ query: "差旅报销需要谁审批？", clarification: null });
  });
  assert.equal(plan.query, "差旅报销需要谁审批？");
  assert.equal(plan.clarification, null);
});

test("ambiguous requests ask a question and do not invent facts", async () => {
  const missing = await prepareConversationContext([], "", 0, "这个怎么处理？", [], async () => { throw new Error("unexpected call"); });
  assert.match(missing.clarification, /哪项事项/);
  const ambiguous = await prepareConversationContext(messages.slice(0, 2), "", 0, "那个多少钱？", [], async () => JSON.stringify({ query: "那个多少钱？", clarification: "你指的是交通费还是住宿费？" }));
  assert.match(ambiguous.clarification, /交通费/);
});

test("invalid summary results fail instead of silently losing memory", async () => {
  await assert.rejects(prepareConversationContext(messages, "已有记忆", 0, "报销要求？", [], async () => "not JSON"));
  assert.equal(messages.length, 12);
});

test("context budgets cap instructions, memory, history and evidence without splitting UTF-8", () => {
  assert.equal(clipText("你🙂好", 7), "你🙂");
  assert.equal(clipText("你", 2), "");
  const sources = Array.from({ length: 20 }, (_, index) => ({ id: index, title: `附件 ${index}`, content: "资料正文。".repeat(1000) }));
  const prompt = budgetPrompt("请总结", "摘要。".repeat(2000), messages.map((item) => ({ ...item, content: "历史。".repeat(5000) })), sources, 16000, (context) => `只使用本轮资料：\n${context.map((item, i) => `[${i + 1}] ${item.title}\n${item.content}`).join("\n")}`);
  assert.ok(prompt.estimated <= 16000);
  assert.ok(prompt.history.length <= 6);
  assert.ok(textBudget(prompt.instructions) < 16000);
  assert.equal(prompt.context[0].id, 0);
  assert.ok(!prompt.instructions.includes("�"));
});

test("oversized questions are rejected before a model request", () => {
  assert.throws(() => budgetPrompt("问题".repeat(10000), "", [], [], 16000, () => "系统指令"), /过长/);
});
