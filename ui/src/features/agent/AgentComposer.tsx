import { useState } from "react";

export function AgentComposer({ disabled, targetLabel, onSend }: {
  disabled: boolean;
  targetLabel: string | null;
  onSend: (input: { content: string; mode: "ask" | "compare" | "revise" | "plan"; intent?: "revise" | "rewrite-section" | "extend" | "fix-issue" }) => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<"ask" | "compare" | "revise" | "plan">("ask");
  const [intent, setIntent] = useState<"revise" | "rewrite-section" | "extend" | "fix-issue">("revise");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!content.trim() || disabled) return;
    setBusy(true); setError(null);
    try {
      await onSend({ content: content.trim(), mode, ...(mode === "revise" ? { intent } : {}) });
      setContent("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "指令发送失败");
    } finally { setBusy(false); }
  }
  return <div className="af-agent-composer">
    <div className="af-agent-target">目标：<strong>{targetLabel ?? "请先选择一个产物版本"}</strong></div>
    <div className="af-mode-tabs">
      {(["ask", "compare", "revise", "plan"] as const).map((item) => <button key={item} className={mode === item ? "is-active" : ""} onClick={() => setMode(item)}>{item === "ask" ? "询问" : item === "compare" ? "比较" : item === "revise" ? "修改" : "先看影响"}</button>)}
    </div>
    {mode === "revise" && <select value={intent} onChange={(event) => setIntent(event.target.value as typeof intent)}>
      <option value="revise">整体修订</option><option value="rewrite-section">重写指定段落</option><option value="extend">扩写</option><option value="fix-issue">修复问题</option>
    </select>}
    <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={mode === "revise" ? "例如：只改第三场对白，不动动作描述" : mode === "plan" ? "例如：先告诉我会影响哪些下游，不要执行" : "输入问题"} />
    {error && <p className="af-form-error">{error}</p>}
    <button className="af-primary" disabled={disabled || busy || !content.trim()} onClick={() => void submit()}>{busy ? "正在提交…" : mode === "revise" ? "创建修订作业" : mode === "plan" ? "生成影响计划" : "发送"}</button>
  </div>;
}
