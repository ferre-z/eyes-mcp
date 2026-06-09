// =============================================================================
// Eyes-MCP — OpenAI-compatible LLM client tests
//
// The tests stub out the undici `request` so we never hit the network. We
// verify the request body shape and that the response is parsed correctly.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock undici BEFORE importing the module under test.
const mockRequest = vi.fn();
vi.mock("undici", () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

import {
  OpenAICompatibleClient,
  PROVIDERS,
  getProvider,
} from "../gemini.js";

interface MockResponse {
  statusCode: number;
  body: { text: () => Promise<string>; dump: () => Promise<void> };
}

function makeResponse(status: number, bodyObj: unknown): MockResponse {
  return {
    statusCode: status,
    body: {
      text: () => Promise.resolve(JSON.stringify(bodyObj)),
      dump: () => Promise.resolve(),
    },
  };
}

describe("OpenAICompatibleClient", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("PROVIDERS catalog has the two supported providers", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toContain("google-ai-studio");
    expect(ids).toContain("openrouter");
  });

  it("getProvider finds by id", () => {
    expect(getProvider("google-ai-studio")?.id).toBe("google-ai-studio");
    expect(getProvider("openrouter")?.id).toBe("openrouter");
    expect(getProvider("nope")).toBeUndefined();
  });

  it("Google AI Studio base URL is the OpenAI-compatible one (the right URL)", () => {
    const p = getProvider("google-ai-studio");
    expect(p?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  });

  it("sends an OpenAI-shape body and Bearer auth to the provider's base URL", async () => {
    mockRequest.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      }),
    );
    const provider = getProvider("google-ai-studio")!;
    const client = new OpenAICompatibleClient({ provider, apiKey: "sk-test-1234" });
    const r = await client.generate("hi");
    expect(r.text).toBe("hello");
    expect(r.tokensIn).toBe(4);
    expect(r.tokensOut).toBe(1);
    const [url, init] = mockRequest.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gemma-4-31b-it");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toBe("hi");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test-1234");
  });

  it("OpenRouter sends HTTP-Referer + X-Title extra headers", async () => {
    mockRequest.mockResolvedValueOnce(
      makeResponse(200, { choices: [{ message: { content: "x" } }] }),
    );
    const provider = getProvider("openrouter")!;
    const client = new OpenAICompatibleClient({ provider, apiKey: "or-key" });
    await client.generate("hi");
    const [, init] = mockRequest.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://github.com/ferre-z/eyes-mcp");
    expect(headers["X-Title"]).toBe("Eyes-MCP");
  });

  it("throws LlmHttpError on non-2xx with the raw body in the error", async () => {
    mockRequest.mockResolvedValueOnce(
      makeResponse(401, { error: { message: "bad key" } }),
    );
    const provider = getProvider("google-ai-studio")!;
    const client = new OpenAICompatibleClient({ provider, apiKey: "bad" });
    await expect(client.generate("hi")).rejects.toThrow(/LLM HTTP 401/);
  });

  it("attaches response_format=json_schema when a Zod schema is provided", async () => {
    mockRequest.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: '{"answer":"yes","score":1}' } }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    );
    const { z } = await import("zod");
    const schema = z.object({ answer: z.string(), score: z.number() });
    const provider = getProvider("google-ai-studio")!;
    const client = new OpenAICompatibleClient({ provider, apiKey: "k" });
    const r = await client.generate("hi", { responseSchema: schema });
    const [, init] = mockRequest.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema.properties.answer.type).toBe("string");
    expect(body.response_format.json_schema.schema.properties.score.type).toBe("number");
    expect(r.structured).toEqual({ answer: "yes", score: 1 });
  });

  it("strips markdown code fences from structured output", async () => {
    mockRequest.mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: '```json\n{"answer":"yes"}\n```' } }],
      }),
    );
    const { z } = await import("zod");
    const schema = z.object({ answer: z.string() });
    const provider = getProvider("google-ai-studio")!;
    const client = new OpenAICompatibleClient({ provider, apiKey: "k" });
    const r = await client.generate("hi", { responseSchema: schema });
    expect(r.structured).toEqual({ answer: "yes" });
  });
});
