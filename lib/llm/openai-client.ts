import OpenAI from "openai";

export const openaiClient = new OpenAI();

export async function chatWithRetry(
  params: Parameters<typeof openaiClient.chat.completions.create>[0],
  maxRetries = 6
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  let attempt = 0;
  while (true) {
    try {
      return await openaiClient.chat.completions.create(params) as OpenAI.Chat.Completions.ChatCompletion;
    } catch (err) {
      const status = (err as { status?: number }).status;
      const isRateLimit = status === 429;
      const isServerError = status !== undefined && status >= 500;

      if ((isRateLimit || isServerError) && attempt < maxRetries) {
        const retryAfterMs = parseRetryAfter(err) ?? Math.min(1000 * 2 ** attempt, 60000);
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
    const headers = (err as { headers?: Record<string, string> }).headers;
    const retryAfter = headers?.["retry-after"];
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      if (!isNaN(seconds)) return Math.ceil(seconds * 1000) + 200;
    }
    const message = (err as { message?: string }).message ?? "";
    const match = message.match(/try again in ([\d.]+)s/i);
    if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 200;
  } catch {
    // ignore
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
