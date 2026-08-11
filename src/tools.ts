// Frontend tool registry: definitions + executors for the chat agent.
import { invoke } from "@tauri-apps/api/core";
import type { ChatTool, ToolCtx, ToolCallArg, ToolResult } from "./chatTypes";

function jsonArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
}

function truncate(s: string, n = 6000): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n… [truncated, ${s.length - n} chars omitted]`;
}

const safeMath = (expr: string): string => {
  // Whitelist: numbers, operators, parens, common funcs. No eval of arbitrary code.
  const cleaned = expr.replace(/[^0-9+\-*/()., sqrtcossinlogabsminmaxpi e%<>!&|^~_]/gi, "");
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${cleaned})`);
    const v = fn();
    return typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v);
  } catch (e) {
    return `Math error: ${String(e)}`;
  }
};

export function buildTools(): ChatTool[] {
  const t: ChatTool[] = [
    {
      category: "time",
      enabled: true,
      def: {
        type: "function",
        function: {
          name: "get_current_time",
          description:
            "Get the current date and time (local machine time). Returns a human-readable timestamp.",
          parameters: { type: "object", properties: {} },
        },
      },
      executor: async () => new Date().toLocaleString(),
    },
    {
      category: "math",
      enabled: true,
      def: {
        type: "function",
        function: {
          name: "calculate",
          description:
            "Evaluate a mathematical expression. Supports + - * / ( ) and functions sqrt, sin, cos, log, abs, min, max, pi, e, %.",
          parameters: {
            type: "object",
            properties: {
              expression: {
                type: "string",
                description: "The math expression to evaluate",
              },
            },
            required: ["expression"],
          },
        },
      },
      executor: async (args) => safeMath(String(args.expression ?? "")),
    },
    {
      category: "web",
      enabled: false,
      def: {
        type: "function",
        function: {
          name: "fetch_url",
          description:
            "Fetch a URL and return its text content. Use for web pages / APIs. Requires internet access.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "The URL to fetch" },
            },
            required: ["url"],
          },
        },
      },
      executor: async (args) => {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) return "Error: only http(s) URLs allowed";
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          const text = await res.text();
          return truncate(text, 8000);
        } catch (e) {
          return `Fetch error: ${String(e)}`;
        }
      },
    },
    {
      category: "files",
      enabled: true,
      def: {
        type: "function",
        function: {
          name: "list_files",
          description:
            "List files and folders in a directory inside the workspace. Pass '.' or a relative path.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path (relative to workspace or absolute)" },
            },
            required: ["path"],
          },
        },
      },
      executor: async (args, c) => {
        const r = await invoke("chat_tool_exec", {
          tool: "list_files",
          workspace: c.fullAccess ? "" : c.workspace,
          fullAccess: c.fullAccess,
          arg: String(args.path ?? "."),
        });
        return truncate(JSON.stringify(r, null, 2), 6000);
      },
    },
    {
      category: "files",
      enabled: true,
      def: {
        type: "function",
        function: {
          name: "read_file",
          description:
            "Read a text file inside the workspace (max 256 KB). Pass a path relative to the workspace or absolute.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
            required: ["path"],
          },
        },
      },
      executor: async (args, c) => {
        const r = await invoke("chat_tool_exec", {
          tool: "read_file",
          workspace: c.fullAccess ? "" : c.workspace,
          fullAccess: c.fullAccess,
          arg: String(args.path ?? ""),
        });
        return truncate(JSON.stringify(r, null, 2), 8000);
      },
    },
    {
      category: "files",
      enabled: true,
      def: {
        type: "function",
        function: {
          name: "list_drives",
          description: "List available Windows drive letters (e.g. C:\\, D:\\).",
          parameters: { type: "object", properties: {} },
        },
      },
      executor: async () => {
        const r = await invoke("chat_tool_exec", {
          tool: "list_drives",
          workspace: "",
          arg: "",
        });
        return JSON.stringify(r);
      },
    },
  ];
  return t;
}

export function enabledDefs(tools: ChatTool[]) {
  return tools.filter((t) => t.enabled).map((t) => t.def);
}

export async function runTool(
  tools: ChatTool[],
  call: ToolCallArg,
  ctx: ToolCtx
): Promise<ToolResult> {
  const tool = tools.find((t) => t.def.function.name === call.function.name);
  if (!tool) {
    return {
      toolCallId: call.id,
      name: call.function.name,
      content: `Unknown tool: ${call.function.name}`,
      ok: false,
    };
  }
  if (!tool.enabled) {
    return {
      toolCallId: call.id,
      name: call.function.name,
      content: `Tool '${call.function.name}' is disabled in Skills settings.`,
      ok: false,
    };
  }
  try {
    const content = await tool.executor(jsonArgs(call.function.arguments), ctx);
    return { toolCallId: call.id, name: call.function.name, content, ok: true };
  } catch (e) {
    return {
      toolCallId: call.id,
      name: call.function.name,
      content: `Error: ${String(e)}`,
      ok: false,
    };
  }
}
