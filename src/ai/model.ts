import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_MODEL = 'gemma4:e2b-it-qat';

/** The LanguageModel used for every AI SDK call in the app — see
 *  README.md "AI protocol" / "Local AI models (Ollama)". Points at
 *  Ollama's OpenAI-compatible endpoint via @ai-sdk/openai with a custom
 *  baseURL, rather than a self-hosted-specific provider package — see the
 *  chat history for why (this is the one place that choice matters; the
 *  rest of the app never imports @ai-sdk/openai directly).
 *
 *  OLLAMA_BASE_URL must include the /v1 path segment — createOpenAI
 *  appends endpoint paths (/chat/completions, ...) directly onto it, the
 *  same way it does for the real OpenAI API. Defaults to the local dev
 *  Ollama container (127.0.0.1:11434); prod (docker-compose.yml) reaches
 *  Ollama at http://ollama:11434/v1 over the Compose network instead and
 *  must set this explicitly.
 *
 *  apiKey is a placeholder, never a real secret — Ollama has no
 *  authentication of its own (see docker-compose.yml's loopback-only
 *  port binding), but @ai-sdk/openai throws at call time if no key is
 *  supplied at all, real or not. */
export function getModel(): LanguageModel {
  const baseURL = process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
  const modelId = process.env.AI_MODEL ?? DEFAULT_MODEL;

  const provider = createOpenAI({ baseURL, apiKey: 'ollama' });
  // Explicitly .chat(), not calling the provider directly — the latter
  // defaults to OpenAI's newer Responses API (/v1/responses), which
  // Ollama's OpenAI-compat layer doesn't handle reliably for anything
  // beyond a trivial schema (confirmed by testing: a nested/discriminated
  // schema through that path fails server-side with "failed to parse
  // grammar"). /v1/chat/completions is the endpoint actually verified
  // against Ollama's own docs and real testing earlier in this project.
  return provider.chat(modelId);
}
