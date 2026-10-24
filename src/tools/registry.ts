import type { ToolResult } from "../state/knowledge";
import type { KnowledgeContext } from "../state/createKnowledgeTracker";
export async function dispatch(name: string, args: Record<string, unknown>, tracker?: KnowledgeContext): Promise<ToolResult> {
  if (name !== "update_understanding") return { summary: `Unknown tool: ${name}`, error: "unknown_tool" };
  if (!tracker) return { summary: "No lesson is active.", error: "missing_context" };
  return tracker.update(args ?? {});
}
