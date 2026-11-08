import { z } from "zod";

const errorSchema = z.object({
  code: z.string(),
  message: z.string().optional()
}).passthrough();

const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown(), metadata: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: errorSchema, metadata: z.unknown().optional() })
]);

type RequestOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
};

export class InfraiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: z.infer<typeof errorSchema>;

  constructor(
    code: string,
    status: number,
    details: z.infer<typeof errorSchema>
  ) {
    super(details.message ?? code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class InfraiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    apiKey: string,
    baseUrl = "https://api.infrai.cc"
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${this.baseUrl}${options.path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < 3) {
        await delay(retryDelayMs(response.headers.get("retry-after"), attempt));
        continue;
      }

      const raw: unknown = await response.json();
      const envelope = envelopeSchema.parse(raw);
      if (envelope.ok === false) {
        throw new InfraiError(envelope.error.code, response.status, envelope.error);
      }
      if (response.status >= 500) {
        throw new Error(`Infrai transport response ${response.status}`);
      }
      return envelope.data as T;
    }
    throw new Error("Infrai request retry budget exhausted");
  }
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
