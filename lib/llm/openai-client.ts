import OpenAI from "openai";

export const openaiClient = new OpenAI();

export async function chatWithRetry(
  params: Parameters<typeof openaiClient.chat.completions.create>[0],
  maxRetries = 8
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  let attempt = 0;
  while (true) {
    try {
      return (await openaiClient.chat.completions.create(params)) as OpenAI.Chat.Completions.ChatCompletion;
    } catch (err) {
      const isRateLimit = err instanceof OpenAI.RateLimitError;
      const isServerError = err instanceof OpenAI.InternalServerError;

      if ((isRateLimit || isServerError) && attempt < maxRetries) {
        const retryAfterMs = parseRetryAfter(err) ?? Math.min(2000 * 2 ** attempt, 64000);
        await sleep(retryAfterMs + Math.random() * 500);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

function parseRetryAfter(err: unknown): number | null {
  try {
    if (err instanceof OpenAI.APIError) {
      const retryAfter = err.headers?.["retry-after"];
      if (retryAfter) {
        const seconds = parseFloat(String(retryAfter));
        if (!isNaN(seconds)) return Math.ceil(seconds * 1000) + 500;
      }
    }
    const message = (err as { message?: string }).message ?? "";
    const match = message.match(/try again in ([\d.]+)s/i);
    if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 500;
  } catch {
    // ignore
  }
  return null;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
