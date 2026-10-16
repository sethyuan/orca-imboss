import { SettingKeys } from "@shared/constants/settings";
import { previewImageMime } from "@shared/image-attachments";
import type { ProviderApiType } from "@shared/types";
import { readFile, stat } from "fs/promises";
import { listProviders, revealProviderKey } from "./agent/providers";
import { getSetting } from "./db/settings";

/**
 * App-owned vision bridge.
 *
 * A coding-agent model is not necessarily able to see: imboss hands attachments
 * to the agent as a list of absolute paths, and a text-only model can do nothing
 * with a picture. This module is the other way in — it sends one image to a
 * *separately configured* vision model and returns that model's description as
 * text, which the agent can then reason about. The model is picked in
 * Settings › General, and the `imb_look_at_image` built-in tool is the agent's
 * door to it.
 *
 * Like `image-gen.ts` this is a call the app makes itself (the Pi SDK has no
 * vision API). It reuses the configuration the app already owns: the same
 * credential store, the same base URL / api type, and the process-wide HTTP
 * proxy (`http-proxy.ts`) that every main-process `fetch` inherits. All four
 * api types the app supports have an image shape, so any configured provider
 * can serve as the vision model:
 * - OpenAI-compatible `POST {base}/chat/completions` (OpenAI, OpenRouter, most
 *   gateways) with an `image_url` data URL;
 * - OpenAI `POST {base}/responses` with an `input_image`;
 * - Anthropic `POST {base}/messages` with a base64 image block;
 * - Google `POST {base}/models/{model}:generateContent` with `inlineData`.
 *
 * Credentials never leave this process: the key is read per request and is only
 * ever put in an `Authorization` / `x-api-key` / `x-goog-api-key` header.
 */

/** A configured vision model: `"<provider>/<modelId>"`. */
export interface VisionModelRef {
  provider: string;
  model: string;
}

/** Vision calls are slow; a hung provider must not pin the agent forever. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Cap on the provider's error body echoed back to the caller. */
const MAX_ERROR_DETAIL = 300;

/**
 * Cap on the picture handed to the vision model. The file is inlined as-is (no
 * re-encode), so an oversized one is refused with a clear message instead of
 * being rejected by the provider.
 */
export const MAX_VISION_IMAGE_BYTES = 20 * 1024 * 1024;

/** Instruction used when the caller asks nothing specific. */
const DEFAULT_VISION_PROMPT =
  "Describe this image in detail: what it shows, and any text it contains (transcribe text verbatim).";

/**
 * Endpoints for curated (built-in) providers.
 *
 * The app does not know a built-in provider's base URL — that lives in the Pi
 * SDK's bundled catalog — so this map carries the few the vision client can
 * reach. Custom providers need no entry: their base URL and api type are stored
 * in `models.json` and are used as-is, which is how an OpenAI-compatible gateway
 * is supported without code changes.
 */
const BUILTIN_VISION_ENDPOINTS: Record<
  string,
  { baseUrl: string; apiType: ProviderApiType }
> = {
  openai: { baseUrl: "https://api.openai.com/v1", apiType: "openai-responses" },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    apiType: "anthropic-messages",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiType: "google-generative-ai",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiType: "openai-completions",
  },
  xai: { baseUrl: "https://api.x.ai/v1", apiType: "openai-completions" },
};

/** `"provider/modelId"` for a stored setting value, or `null` when unusable. */
export function parseVisionModelRef(
  value: string | null | undefined,
): VisionModelRef | null {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return null;
  const at = trimmed.indexOf("/");
  if (at <= 0 || at === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, at), model: trimmed.slice(at + 1) };
}

/** Inverse of `parseVisionModelRef`. */
export function visionModelRef(ref: VisionModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/** The configured vision model, or `null` when none has been picked yet. */
export function getVisionModelRef(): VisionModelRef | null {
  return parseVisionModelRef(getSetting(SettingKeys.VisionModel));
}

/**
 * Ask the vision model what one picture shows. `question` is what the caller
 * wants to know about it (defaults to a general description, including any text
 * in the image).
 */
export async function describeImage(
  ref: VisionModelRef,
  path: string,
  question?: string,
): Promise<string> {
  const image = await loadImage(path);
  const endpoint = await resolveEndpoint(ref.provider);
  const prompt = visionPrompt(question);
  switch (endpoint.apiType) {
    case "anthropic-messages":
      return requestAnthropic(endpoint, ref.model, image, prompt);
    case "google-generative-ai":
      return requestGoogle(endpoint, ref.model, image, prompt);
    case "openai-completions":
      return requestOpenAiChat(endpoint, ref.model, image, prompt);
    case "openai-responses":
      return requestOpenAiResponses(endpoint, ref.model, image, prompt);
    default:
      throw new Error(
        `Provider "${ref.provider}" (${endpoint.apiType}) has no vision API.`,
      );
  }
}

/** One picture, ready to inline. */
interface LoadedImage {
  mime: string;
  base64: string;
}

/** Read a picture off disk, refusing anything the model could not accept. */
async function loadImage(path: string): Promise<LoadedImage> {
  const mime = previewImageMime("", path);
  if (mime === null) {
    throw new Error(`Not a supported image file: ${path}`);
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`Image file not found: ${path}`);
  }
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  if (info.size > MAX_VISION_IMAGE_BYTES) {
    throw new Error(
      `Image is too large to look at (${formatBytes(info.size)}, limit ${formatBytes(MAX_VISION_IMAGE_BYTES)}).`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`Could not read the image file: ${path}`);
  }
  return { mime, base64: bytes.toString("base64") };
}

/** The instruction sent along with the picture. */
function visionPrompt(question: string | undefined): string {
  const asked = (question ?? "").trim();
  if (asked.length === 0) return DEFAULT_VISION_PROMPT;
  return `${asked}\n\n(Answer from the image. Also transcribe any text it contains.)`;
}

interface ResolvedEndpoint {
  baseUrl: string;
  apiType: ProviderApiType;
  apiKey: string;
}

/** Resolve a provider's endpoint + credential, or explain why it cannot. */
async function resolveEndpoint(provider: string): Promise<ResolvedEndpoint> {
  const apiKey = await revealProviderKey(provider);
  if (apiKey === null || apiKey.length === 0) {
    throw new Error(`No API key is configured for provider "${provider}".`);
  }
  const info = (await listProviders()).find((entry) => entry.id === provider);
  if (info?.kind === "custom") {
    if (!info.baseUrl || !info.apiType) {
      throw new Error(
        `Provider "${provider}" has no base URL / API type configured.`,
      );
    }
    return { baseUrl: info.baseUrl, apiType: info.apiType, apiKey };
  }
  const builtin = BUILTIN_VISION_ENDPOINTS[provider];
  if (!builtin) {
    throw new Error(
      `Provider "${provider}" is not supported for image description yet.`,
    );
  }
  return { ...builtin, apiKey };
}

/** Auth headers for a provider's api type. */
function authHeaders(endpoint: ResolvedEndpoint): Record<string, string> {
  switch (endpoint.apiType) {
    case "google-generative-ai":
      return { "x-goog-api-key": endpoint.apiKey };
    case "anthropic-messages":
      return {
        "x-api-key": endpoint.apiKey,
        "anthropic-version": "2023-06-01",
      };
    default:
      return { authorization: `Bearer ${endpoint.apiKey}` };
  }
}

/** `data:` URL for the OpenAI-shaped payloads. */
function dataUrlOf(image: LoadedImage): string {
  return `data:${image.mime};base64,${image.base64}`;
}

/** OpenAI-compatible `POST {base}/chat/completions`. */
async function requestOpenAiChat(
  endpoint: ResolvedEndpoint,
  model: string,
  image: LoadedImage,
  prompt: string,
): Promise<string> {
  const url = `${trimBase(endpoint.baseUrl)}/chat/completions`;
  const body = await fetchJson(url, {
    method: "POST",
    headers: { ...authHeaders(endpoint), "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrlOf(image) } },
          ],
        },
      ],
    }),
  });
  return openAiChatText(body);
}

/** OpenAI `POST {base}/responses`. */
async function requestOpenAiResponses(
  endpoint: ResolvedEndpoint,
  model: string,
  image: LoadedImage,
  prompt: string,
): Promise<string> {
  const url = `${trimBase(endpoint.baseUrl)}/responses`;
  const body = await fetchJson(url, {
    method: "POST",
    headers: { ...authHeaders(endpoint), "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrlOf(image) },
          ],
        },
      ],
    }),
  });
  return openAiResponsesText(body);
}

/** Anthropic `POST {base}/messages`. */
async function requestAnthropic(
  endpoint: ResolvedEndpoint,
  model: string,
  image: LoadedImage,
  prompt: string,
): Promise<string> {
  const url = `${trimBase(endpoint.baseUrl)}/messages`;
  const body = await fetchJson(url, {
    method: "POST",
    headers: { ...authHeaders(endpoint), "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mime,
                data: image.base64,
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  return anthropicText(body);
}

/** Google `POST {base}/models/{model}:generateContent`. */
async function requestGoogle(
  endpoint: ResolvedEndpoint,
  model: string,
  image: LoadedImage,
  prompt: string,
): Promise<string> {
  const url = `${trimBase(endpoint.baseUrl)}/models/${encodeURIComponent(model)}:generateContent`;
  const body = await fetchJson(url, {
    method: "POST",
    headers: { ...authHeaders(endpoint), "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: image.mime, data: image.base64 } },
          ],
        },
      ],
    }),
  });
  return googleText(body);
}

/** Text of an OpenAI chat completion (`choices[0].message.content`). */
function openAiChatText(body: Record<string, unknown>): string {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const content = (
    choices[0] as { message?: { content?: unknown } } | undefined
  )?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }
  // Some gateways return the parts array instead of a joined string.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part as { text?: unknown }).text)
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  throw new Error("The vision model returned no description.");
}

/** Text of an OpenAI Responses result (`output[].content[].text`). */
function openAiResponsesText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string" && body.output_text.trim().length) {
    return body.output_text.trim();
  }
  const output = Array.isArray(body.output) ? body.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) chunks.push(text);
    }
  }
  const joined = chunks.join("\n").trim();
  if (joined.length > 0) return joined;
  throw new Error("The vision model returned no description.");
}

/** Text blocks of an Anthropic messages result. */
function anthropicText(body: Record<string, unknown>): string {
  const content = Array.isArray(body.content) ? body.content : [];
  const chunks = content
    .filter((part) => (part as { type?: unknown }).type === "text")
    .map((part) => (part as { text?: unknown }).text)
    .filter((part): part is string => typeof part === "string");
  const joined = chunks.join("\n").trim();
  if (joined.length > 0) return joined;
  throw new Error("The vision model returned no description.");
}

/** Text parts of a Google `generateContent` result. */
function googleText(body: Record<string, unknown>): string {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const parts =
    (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content
      ?.parts ?? [];
  const chunks: string[] = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) chunks.push(text);
  }
  const joined = chunks.join("\n").trim();
  if (joined.length > 0) return joined;
  throw new Error("The vision model returned no description.");
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await request(url, init);
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("The vision model returned a non-JSON response.");
  }
}

/** One HTTP call with the shared timeout and error mapping. */
async function request(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new Error(
      err instanceof Error && err.name === "AbortError"
        ? "Looking at the image timed out."
        : "Could not reach the vision model.",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `The vision model failed (HTTP ${res.status})${errorDetail(detail)}`,
    );
  }
  return res;
}

/** Short, single-line echo of a provider's error body. */
function errorDetail(body: string): string {
  const cleaned = body.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_DETAIL);
  return cleaned.length > 0 ? `: ${cleaned}` : "";
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Human-readable byte size for the error messages. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
