type LLMConfig = {
  apiKey: string | undefined;
  model: string;
  baseUrl: string;
};

type LLMMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type LLMResponse = {
  id: string;
  choices: Array<{
    index: number;
    message: LLMMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

const DEFAULT_NIM_BASE = "https://integrate.api.nvidia.com/v1";
const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434/v1";

/**
 * Strip thinking/reasoning blocks from Nemotron output.
 * Nemotron-3-Super wraps its chain-of-thought in ... tags.
 * This removes those blocks and returns only the final answer.
 */
function stripThinking(text: string): string {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (cleaned.length === 0) {
    const match = text.match(/<\/think>\s*([\s\S]*)/i);
    if (match) cleaned = match[1]!.trim();
  }
  return cleaned;
}

export class LLMClient {
  private primary: LLMConfig;
  private fallback: LLMConfig | null;
  private lastPrimaryError: number = 0;
  private fallbackUntil: number = 0;
  private static readonly FALLBACK_COOLDOWN_MS = 60_000;

  constructor(
    nimApiKey: string | undefined,
    nimModel: string,
    ollamaModel: string | undefined,
    ollamaBaseUrl?: string,
    nimBaseUrl?: string,
  ) {
    this.primary = {
      apiKey: nimApiKey,
      model: nimModel,
      baseUrl: nimBaseUrl ?? DEFAULT_NIM_BASE,
    };
    this.fallback = ollamaModel
      ? {
          apiKey: "ollama",
          model: ollamaModel,
          baseUrl: ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE,
        }
      : null;
  }

  private get activeConfig(): LLMConfig {
    if (this.fallback && Date.now() < this.fallbackUntil) {
      return this.fallback;
    }
    return this.primary;
  }

  private async callApi(
    config: LLMConfig,
    messages: LLMMessage[],
    opts?: { temperature?: number; max_tokens?: number },
  ): Promise<string> {
    const body = {
      model: config.model,
      messages,
      temperature: opts?.temperature ?? 0.3,
      max_tokens: opts?.max_tokens ?? 2048,
      stream: false,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as LLMResponse;
    return data.choices[0]?.message?.content ?? "";
  }

  async chat(
    messages: LLMMessage[],
    opts?: { temperature?: number; max_tokens?: number },
  ): Promise<string> {
    const config = this.activeConfig;

    try {
      return await this.callApi(config, messages, opts);
    } catch (err) {
      if (this.fallback && config === this.primary) {
        this.fallbackUntil = Date.now() + LLMClient.FALLBACK_COOLDOWN_MS;
        this.lastPrimaryError = Date.now();
        try {
          return await this.callApi(this.fallback, messages, opts);
        } catch {
          // Both failed
        }
      }
      throw err;
    }
  }

  async refineQuery(rawQuery: string): Promise<string> {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content:
          "You are a search query refiner for dark web onion search engines. " +
          "Rewrite the user's query into an optimized search string. " +
          "Keep it concise (under 50 chars). Remove filler words. " +
          "Preserve key terms and entities. Output ONLY the refined query, nothing else. " +
          "Do NOT output reasoning or thinking process.",
      },
      { role: "user", content: rawQuery },
    ];
    const raw = await this.chat(messages, { temperature: 0.1, max_tokens: 256 });
    return stripThinking(raw).trim();
  }

  async summarizeResults(
    query: string,
    results: Array<{ title: string; url: string; snippet: string }>,
  ): Promise<string> {
    const resultText = results
      .slice(0, 10)
      .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`)
      .join("\n\n");

    const messages: LLMMessage[] = [
      {
        role: "system",
        content:
          "You are a search results synthesizer. Given a search query and results from " +
          "dark web onion search engines, produce a concise summary with inline citations [1], [2]. " +
          "Highlight entities (BTC addresses, PGP keys, onion links) if present. " +
          "Be factual. Do not speculate beyond the provided results. " +
          "Maximum 300 words.\n\n" +
          "IMPORTANT: Output ONLY the final summary text. Do NOT output your reasoning, " +
          "thinking process, chain-of-thought, or any meta-commentary. " +
          "Do NOT use <think> tags or any thinking markers. " +
          "Start directly with the summary content.",
      },
      {
        role: "user",
        content: `Query: ${query}\n\nResults:\n${resultText}`,
      },
    ];
    const raw = await this.chat(messages, { temperature: 0.2, max_tokens: 4096 });
    return stripThinking(raw);
  }

  async classifyResult(
    title: string,
    snippet: string,
  ): Promise<{ category: string; risk: "low" | "medium" | "high" }> {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content:
          'Classify the following search result snippet. Output JSON only: {"category": "...", "risk": "low|medium|high"}. ' +
          "Categories: marketplace, forum, wiki, blog, service, directory, scam, empty, captcha, other. " +
          "Risk: low = informational, medium = suspicious/unverified, high = known scam or illegal.",
      },
      {
        role: "user",
        content: `Title: ${title}\nSnippet: ${snippet}`,
      },
    ];
    const raw = await this.chat(messages, { temperature: 0.1, max_tokens: 512 });
    const cleaned = stripThinking(raw).replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return { category: "other", risk: "low" };
    }
  }

  get status(): { primary: string; fallback: string | null; usingFallback: boolean } {
    const usingFallback = Date.now() < this.fallbackUntil;
    return {
      primary: this.primary.model,
      fallback: this.fallback?.model ?? null,
      usingFallback,
    };
  }
}
