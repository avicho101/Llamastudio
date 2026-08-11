// Chat message & tool-calling types

export interface ToolCallArg {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  reasoning?: string; // reasoning_content when the model thinks
  toolCalls?: ToolCallArg[]; // assistant-side tool call requests
  toolCallId?: string; // for role=tool messages
  toolName?: string; // for role=tool messages
  error?: boolean;
  ts: number;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  ok: boolean;
}

// A tool registered in the frontend: metadata + executor.
export interface ChatTool {
  def: ToolDef;
  enabled: boolean;
  executor: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;
  category: "files" | "web" | "system" | "math" | "time";
}

export interface ToolCtx {
  workspace: string;
  fullAccess: boolean;
  baseUrl: string; // server base for web tools if any
}

export interface StreamEvent {
  type: "delta" | "reasoning" | "done" | "error" | "tool_calls" | "tool_result";
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCallArg[];
  toolResults?: ToolResult[];
  error?: string;
}

export interface StreamOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: { role: string; content: string }[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  onEvent: (ev: StreamEvent) => void;
  maxToolRounds?: number; // default 6
  toolExec?: (
    call: ToolCallArg,
    round: number
  ) => Promise<ToolResult>; // executes a tool call
  contextLength?: number;
}
