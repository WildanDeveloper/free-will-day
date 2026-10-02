/**
 * Model client. One interface, two wire formats.
 *
 * Both styles support a custom base URL, so any OpenAI- or Anthropic-shaped
 * gateway works: OpenRouter, vLLM, LiteLLM, or a self-hosted proxy. If
 * MODEL_BASIC_USER is set the Authorization header carries basic auth instead
 * of the API key, which is what a credential-gated proxy expects.
 */

import type { Config } from "../config/config.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
};

export type ChatResult = {
  text: string;
  /** Normalized tool calls. Empty when the model produced prose only. */
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type ChatRequest = {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens?: number;
};

const ANTHROPIC_VERSION = "2023-06-01";

export class ModelClient {
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /** Authorization header value, honouring basic auth when configured. */
  private authHeader(): Record<string, string> {
    const { modelBasicUser, modelBasicPass, modelApiKey, modelStyle } = this.cfg;
    if (modelBasicUser) {
      const raw = `${modelBasicUser}:${modelBasicPass}`;
      const encoded = Buffer.from(raw, "utf8").toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    if (modelStyle === "anthropic") {
      return { "x-api-key": modelApiKey };
    }
    return { Authorization: `Bearer ${modelApiKey}` };
  }

  private url(path: string): string {
    const base = this.cfg.modelBaseUrl.replace(/\/+$/, "");
    if (!base) {
      throw new Error(
        "model: MODEL_BASE_URL is empty. Set it explicitly, even for hosted providers.",
      );
    }
    return `${base}${path}`;
  }

  /** Cost from the usage field, not from string length. */
  private price(inputTokens: number, outputTokens: number): number {
    const { priceInputPerM, priceOutputPerM } = this.cfg;
    return (
      (inputTokens / 1_000_000) * priceInputPerM +
      (outputTokens / 1_000_000) * priceOutputPerM
    );
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    return this.cfg.modelStyle === "anthropic"
      ? this.chatAnthropic(req)
      : this.chatOpenAI(req);
  }

  private async chatAnthropic(req: ChatRequest): Promise<ChatResult> {
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content,
    }));

    // tools is always sent, as an empty array when there are none. Omitting the
    // field entirely is ambiguous: some gateways treat a missing field as "use
    // whatever you like" and answer with tool calls the caller cannot resolve.
    const body = {
      model: this.cfg.modelId,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages,
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };

    const res = await fetch(this.url("/v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...this.authHeader(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    let text = "";
    const toolCalls: ChatResult["toolCalls"] = [];
    for (const block of data.content) {
      if (block.type === "text" && block.text) text += block.text;
      if (block.type === "tool_use" && block.id && block.name) {
        toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
      }
    }

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;

    return {
      text,
      toolCalls,
      stopReason: data.stop_reason ?? "end_turn",
      inputTokens,
      outputTokens,
      costUsd: this.price(inputTokens, outputTokens),
    };
  }

  private async chatOpenAI(req: ChatRequest): Promise<ChatResult> {
    const messages: Record<string, unknown>[] = [
      { role: "system", content: req.system },
    ];

    for (const m of req.messages) {
      if (typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content });
        continue;
      }
      for (const block of m.content) {
        if (block.type === "text") {
          messages.push({ role: m.role, content: block.text });
        } else if (block.type === "tool_use") {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: JSON.stringify(block.input) },
              },
            ],
          });
        } else {
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        }
      }
    }

    const body = {
      model: this.cfg.modelId,
      messages,
      // Always present, empty when there are no tools. See the Anthropic path
      // for why the field is never omitted.
      tools: req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    };

    const res = await fetch(this.url("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.authHeader(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      choices?: {
        message?: { content?: string | null; tool_calls?: unknown };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = data.choices?.[0];
    const toolCalls: ChatResult["toolCalls"] = [];
    const rawCalls = (choice?.message?.tool_calls ?? []) as {
      id: string;
      function: { name: string; arguments: string };
    }[];
    for (const call of rawCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        input = { _unparsed: call.function.arguments };
      }
      toolCalls.push({ id: call.id, name: call.function.name, input });
    }

    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;

    return {
      text: choice?.message?.content ?? "",
      toolCalls,
      stopReason: choice?.finish_reason ?? "stop",
      inputTokens,
      outputTokens,
      costUsd: this.price(inputTokens, outputTokens),
    };
  }
}