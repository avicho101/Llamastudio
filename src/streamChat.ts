// Streaming chat engine: SSE parse + tool-call loop against llama-server.
import type { StreamOptions, ToolCallArg, ToolResult } from "./chatTypes";

function parseSSEChunk(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      /* skip partial */
    }
  }
  return out;
}

// Accumulate split tool_calls deltas (OpenAI-style) into complete calls.
function mergeToolDelta(
  acc: Map<string, ToolCallArg>,
  delta: any
): Map<string, ToolCallArg> {
  const tc = delta?.tool_calls?.[0];
  if (!tc) return acc;
  const id = tc.id ? String(tc.id) : String(tc.index ?? "0");
  const cur = acc.get(id) || { id, name: "", arguments: "" };
  if (tc.function?.name) cur.name += tc.function.name;
  if (tc.function?.arguments) cur.arguments += tc.function.arguments;
  acc.set(id, cur);
  return acc;
}

export async function streamChat(opts: StreamOptions): Promise<void> {
  const {
    baseUrl,
    apiKey,
    model,
    messages: initialMessages,
    tools,
    signal,
    onEvent,
    maxToolRounds = 6,
    toolExec,
  } = opts;

  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  let messages: any[] = [...initialMessages];

  for (let round = 0; round <= maxToolRounds; round++) {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length > 0 && round === 0) {
      // Only advertise tools on the first round; after a tool result the
      // model may still call tools, so keep advertising them.
      body.tools = tools;
      body.tool_choice = "auto";
    } else if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Tells the LlamaStudio ContextShift proxy to stream chunked instead
        // of buffering (Goose-compat path stays buffered).
        "X-LlamaStudio-Stream": "1",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j?.error?.message || msg;
      } catch {}
      onEvent({ type: "error", error: msg });
      return;
    }

    if (!res.body) {
      onEvent({ type: "error", error: "No response body" });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let reasoning = "";
    const toolAcc = new Map<string, ToolCallArg>();
    let finishReason = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Split on SSE boundaries (blank line).
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const items = parseSSEChunk(chunk);
          for (const it of items) {
            const choice = it?.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            if (delta.reasoning_content) {
              reasoning += delta.reasoning_content;
              onEvent({ type: "reasoning", reasoning: delta.reasoning_content });
            }
            if (delta.content) {
              content += delta.content;
              onEvent({ type: "delta", content: delta.content });
            }
            if (delta.tool_calls) {
              mergeToolDelta(toolAcc, delta);
            }
            // Some servers emit complete tool_calls on the message, not delta.
            if (!delta.tool_calls && choice.message?.tool_calls) {
              for (const tc of choice.message.tool_calls) {
                mergeToolDelta(toolAcc, { tool_calls: [tc] } as any);
              }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      }
      // flush remaining
      const items = parseSSEChunk(buf);
      for (const it of items) {
        const choice = it?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onEvent({ type: "reasoning", reasoning: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          onEvent({ type: "delta", content: delta.content });
        }
        if (delta.tool_calls) mergeToolDelta(toolAcc, delta);
        if (!delta.tool_calls && choice.message?.tool_calls) {
          for (const tc of choice.message.tool_calls) {
            mergeToolDelta(toolAcc, { tool_calls: [tc] } as any);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        onEvent({ type: "error", error: "stopped" });
        return;
      }
      onEvent({ type: "error", error: String(e) });
      return;
    }

    const toolCalls = Array.from(toolAcc.values()).filter((t) => t.name);
    const wantsTools = finishReason === "tool_calls" || toolCalls.length > 0;

    // Emit assistant message content once (done).
    onEvent({ type: "done", content, reasoning, toolCalls });

    // Tool execution round.
    if (wantsTools && toolCalls.length > 0 && toolExec) {
      const results: ToolResult[] = [];
      for (const call of toolCalls) {
        try {
          results.push(await toolExec(call, round));
        } catch (e) {
          results.push({
            toolCallId: call.id,
            name: call.name,
            content: `Error: ${String(e)}`,
            ok: false,
          });
        }
      }
      onEvent({ type: "tool_result", toolResults: results });
      // Append assistant tool_calls + tool results to conversation.
      messages = [
        ...messages,
        {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls as unknown as any[],
        },
        ...results.map((r) => ({
          role: "tool" as const,
          tool_call_id: r.toolCallId,
          content: r.content,
        })),
      ];
      // Loop for the next round (model continues after tool results).
      continue;
    }

    // Final: append assistant content message.
    if (!wantsTools) {
      messages = [...messages, { role: "assistant", content: content || "" }];
    }
    break;
  }

  if (signal?.aborted) {
    onEvent({ type: "error", error: "stopped" });
  }
}
