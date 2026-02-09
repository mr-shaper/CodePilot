/**
 * Antigravity Proxy Server
 *
 * Local HTTP proxy that translates between the Anthropic Messages API format
 * (used by Claude Code) and the Google Antigravity gateway format.
 *
 * Based on patterns from antigravity-claude-proxy by Badri Narayanan S (syntackle).
 *
 * Claude Code → POST /v1/messages (Anthropic format)
 *    → Proxy translates to Gemini Content API format
 *    → Wraps in Antigravity envelope
 *    → Sends to cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
 *    → Receives Gemini SSE response
 *    → Translates back to Anthropic SSE format
 *    → Returns to Claude Code
 */

import http from 'http';
import crypto from 'crypto';
import os from 'os';
import { refreshAccessToken } from './antigravity';

// ── Constants (aligned with antigravity-claude-proxy) ──

const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];

// For loadCodeAssist, prod first works better for fresh accounts
const LOAD_CODE_ASSIST_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
];

// Numeric enum values (matches Antigravity binary analysis)
const IDE_TYPE_ANTIGRAVITY = 6;
const PLUGIN_TYPE_GEMINI = 2;
const PLATFORM_MAP: Record<string, number> = {
  win32: 1,
  linux: 2,
  darwin: 3,
};

function getPlatformEnum(): number {
  return PLATFORM_MAP[process.platform] || 0;
}

function getPlatformUserAgent(): string {
  return `antigravity/1.16.5 ${process.platform}/${os.arch()}`;
}

const CLIENT_METADATA = {
  ideType: IDE_TYPE_ANTIGRAVITY,
  platform: getPlatformEnum(),
  pluginType: PLUGIN_TYPE_GEMINI,
};

const ANTIGRAVITY_HEADERS: Record<string, string> = {
  'User-Agent': getPlatformUserAgent(),
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata': JSON.stringify(CLIENT_METADATA),
};

// Antigravity system instruction (from CLIProxyAPI)
const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**`;

const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
const MIN_SIGNATURE_LENGTH = 50;

// ── Type definitions ──

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  thinking?: string;
  signature?: string;
  cache_control?: unknown;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string; cache_control?: unknown }>;
  max_tokens?: number;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  thinking?: { budget_tokens?: number };
  metadata?: unknown;
}

// ── Anthropic → Gemini conversion ──

function isThinkingModel(model: string): boolean {
  const lower = model.toLowerCase();
  if (lower.includes('thinking')) return true;
  // Gemini 3+ have implicit thinking
  const match = lower.match(/gemini-(\d+)/);
  if (match && parseInt(match[1], 10) >= 3) return true;
  return false;
}

function getModelFamily(model: string): 'claude' | 'gemini' | 'unknown' {
  const lower = model.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('gemini')) return 'gemini';
  return 'unknown';
}

/**
 * Strip cache_control from all message content blocks.
 * Claude Code CLI adds cache_control but Cloud Code API rejects it.
 */
function cleanCacheControl(messages: AnthropicMessage[]): AnthropicMessage[] {
  return messages.map(msg => {
    if (typeof msg.content === 'string') return msg;
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map(block => {
        if ('cache_control' in block) {
          const { cache_control, ...rest } = block;
          return rest;
        }
        return block;
      }),
    };
  });
}

function convertRole(role: string): string {
  return role === 'assistant' ? 'model' : 'user';
}

function convertContentToParts(
  content: string | AnthropicContentBlock[],
  isClaudeModel: boolean,
): unknown[] {
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ text: String(content) }];
  }

  const parts: unknown[] = [];

  for (const block of content) {
    if (!block) continue;

    switch (block.type) {
      case 'text':
        if (block.text && block.text.trim()) {
          parts.push({ text: block.text });
        }
        break;

      case 'image':
        if (block.source?.type === 'base64') {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
        } else if (block.source?.type === 'url') {
          parts.push({
            fileData: {
              mimeType: block.source.media_type || 'image/jpeg',
              fileUri: block.source.url,
            },
          });
        }
        break;

      case 'tool_use': {
        const functionCall: Record<string, unknown> = {
          name: block.name,
          args: block.input || {},
        };
        if (isClaudeModel && block.id) {
          functionCall.id = block.id;
        }
        const toolUsePart: Record<string, unknown> = { functionCall };
        // Restore cached signature if Claude Code stripped it
        if (block.id) {
          const cachedSig = getCachedSignature(block.id);
          if (cachedSig) {
            toolUsePart.thoughtSignature = cachedSig;
          }
        }
        parts.push(toolUsePart);
        break;
      }

      case 'tool_result': {
        let responseContent: unknown;
        if (typeof block.content === 'string') {
          responseContent = { result: block.content };
        } else if (Array.isArray(block.content)) {
          const texts = block.content
            .filter((c: AnthropicContentBlock) => c.type === 'text')
            .map((c: AnthropicContentBlock) => c.text || '')
            .join('\n');
          responseContent = { result: texts || '' };
        } else {
          responseContent = { result: '' };
        }

        const functionResponse: Record<string, unknown> = {
          name: block.tool_use_id || 'unknown',
          response: responseContent,
        };
        if (isClaudeModel && block.tool_use_id) {
          functionResponse.id = block.tool_use_id;
        }
        parts.push({ functionResponse });
        break;
      }

      case 'thinking':
        // Include thinking blocks with valid signatures
        if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
          parts.push({
            text: block.thinking,
            thought: true,
            thoughtSignature: block.signature,
          });
        }
        break;

      default:
        if (block.text) parts.push({ text: block.text });
        break;
    }
  }

  return parts;
}

/**
 * Clean JSON schema for Google API compatibility.
 * Removes unsupported fields that cause protobuf errors.
 */
function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const UNSUPPORTED_KEYS = [
    '$ref', '$schema', '$defs', 'additionalProperties',
    'default', 'examples', '$id', 'definitions',
  ];

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYS.includes(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned[key] = cleanSchema(value as Record<string, unknown>);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function convertTools(tools: AnthropicTool[]): Array<{ functionDeclarations: unknown[] }> {
  const declarations = tools.map((tool, idx) => {
    const name = String(tool.name || `tool-${idx}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const schema = tool.input_schema || { type: 'object' };
    return {
      name,
      description: tool.description || '',
      parameters: cleanSchema(schema),
    };
  });
  return [{ functionDeclarations: declarations }];
}

function buildAntigravityRequest(
  req: AnthropicRequest,
  projectId: string,
): { url: string; body: string; headers: Record<string, string> } {
  const model = req.model;
  const modelFamily = getModelFamily(model);
  const isClaudeModel = modelFamily === 'claude';
  const isThinking = isThinkingModel(model);

  // Clean cache_control from messages
  const messages = cleanCacheControl(req.messages);

  // Convert messages to Google format
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  for (const msg of messages) {
    const parts = convertContentToParts(msg.content, isClaudeModel);
    // Google API requires at least one part per content message
    if (parts.length === 0) {
      parts.push({ text: '.' });
    }
    contents.push({ role: convertRole(msg.role), parts });
  }

  // Build system instruction: Antigravity identity + user's system prompt
  const systemParts: Array<{ text: string }> = [
    { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
    { text: `Please ignore the following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
  ];

  // Append user's system prompt
  if (req.system) {
    if (typeof req.system === 'string') {
      systemParts.push({ text: req.system });
    } else if (Array.isArray(req.system)) {
      for (const block of req.system) {
        if (block.type === 'text' && block.text) {
          systemParts.push({ text: block.text });
        }
      }
    }
  }

  // Add thinking hint for Claude thinking models with tools
  if (isClaudeModel && isThinking && req.tools && req.tools.length > 0) {
    const lastPart = systemParts[systemParts.length - 1];
    lastPart.text += '\n\nInterleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
  }

  // Build generation config
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: req.max_tokens || 64000,
  };
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.top_p !== undefined) generationConfig.topP = req.top_p;
  if (req.top_k !== undefined) generationConfig.topK = req.top_k;
  if (req.stop_sequences?.length) generationConfig.stopSequences = req.stop_sequences;

  // Thinking config
  if (isThinking) {
    if (isClaudeModel) {
      const thinkingConfig: Record<string, unknown> = { include_thoughts: true };
      if (req.thinking?.budget_tokens) {
        thinkingConfig.thinking_budget = req.thinking.budget_tokens;
        // Ensure max_tokens > thinking_budget
        const maxTokens = (generationConfig.maxOutputTokens as number) || 64000;
        if (maxTokens <= req.thinking.budget_tokens) {
          generationConfig.maxOutputTokens = req.thinking.budget_tokens + 8192;
        }
      }
      generationConfig.thinkingConfig = thinkingConfig;
    } else {
      // Gemini thinking uses camelCase
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: req.thinking?.budget_tokens || 16000,
      };
    }
  }

  // Build inner request
  const innerRequest: Record<string, unknown> = {
    contents,
    generationConfig,
    systemInstruction: { role: 'user', parts: systemParts },
  };

  // Tools
  if (req.tools && req.tools.length > 0) {
    innerRequest.tools = convertTools(req.tools);
    if (isClaudeModel) {
      innerRequest.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
    }
  }

  // Wrap in Antigravity envelope
  const body = JSON.stringify({
    project: projectId,
    model,
    request: innerRequest,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: `agent-${crypto.randomUUID()}`,
  });

  const baseEndpoint = ANTIGRAVITY_ENDPOINTS[Math.floor(Math.random() * ANTIGRAVITY_ENDPOINTS.length)];
  const url = `${baseEndpoint}/v1internal:streamGenerateContent?alt=sse`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    ...ANTIGRAVITY_HEADERS,
  };

  if (isClaudeModel && isThinking) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
  }

  return { url, body, headers };
}

// ── Signature cache (for thinking models) ──
// Claude Code may strip thoughtSignature from tool_use blocks.
// We cache them here so we can restore them on subsequent turns.

const signatureCache = new Map<string, string>();        // toolId → thoughtSignature
const thinkingSignatureCache = new Map<string, string>(); // modelFamily → last thinking signature

function cacheSignature(toolId: string, signature: string): void {
  signatureCache.set(toolId, signature);
}

function getCachedSignature(toolId: string): string | undefined {
  return signatureCache.get(toolId);
}

function cacheThinkingSignature(signature: string, modelFamily: string): void {
  thinkingSignatureCache.set(modelFamily, signature);
}

// ── Gemini → Anthropic SSE conversion ──

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: unknown; id?: string };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

interface GeminiResponse {
  response?: {
    candidates?: GeminiCandidate[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; totalTokenCount?: number };
  };
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; totalTokenCount?: number };
}

function formatAnthropicSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

class AnthropicSSEWriter {
  private blockIndex = 0;
  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  start(): string {
    return formatAnthropicSSE('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${crypto.randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  textBlockStart(): string {
    const idx = this.blockIndex++;
    return formatAnthropicSSE('content_block_start', {
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'text', text: '' },
    });
  }

  textDelta(text: string): string {
    return formatAnthropicSSE('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex - 1,
      delta: { type: 'text_delta', text },
    });
  }

  thinkingBlockStart(): string {
    const idx = this.blockIndex++;
    return formatAnthropicSSE('content_block_start', {
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'thinking', thinking: '' },
    });
  }

  thinkingDelta(thinking: string): string {
    return formatAnthropicSSE('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex - 1,
      delta: { type: 'thinking_delta', thinking },
    });
  }

  signatureDelta(signature: string): string {
    return formatAnthropicSSE('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex - 1,
      delta: { type: 'signature_delta', signature },
    });
  }

  toolUseStart(name: string, id: string): string {
    const idx = this.blockIndex++;
    return formatAnthropicSSE('content_block_start', {
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'tool_use', id, name, input: {} },
    });
  }

  toolUseInput(jsonChunk: string): string {
    return formatAnthropicSSE('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex - 1,
      delta: { type: 'input_json_delta', partial_json: jsonChunk },
    });
  }

  blockStop(): string {
    return formatAnthropicSSE('content_block_stop', {
      type: 'content_block_stop',
      index: this.blockIndex - 1,
    });
  }

  end(stopReason: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }): string {
    let output = '';
    output += formatAnthropicSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: usage.outputTokens,
        input_tokens: usage.inputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: 0,
      },
    });
    output += formatAnthropicSSE('message_stop', { type: 'message_stop' });
    return output;
  }
}

interface StreamState {
  inTextBlock: boolean;
  inThinkingBlock: boolean;
  currentThinkingSignature: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  hasToolCalls: boolean;
  finished: boolean;
  model: string;
}

function closeThinkingBlock(writer: AnthropicSSEWriter, state: StreamState): string {
  let output = '';
  if (state.inThinkingBlock) {
    // Emit signature_delta before closing the thinking block
    if (state.currentThinkingSignature) {
      output += writer.signatureDelta(state.currentThinkingSignature);
    }
    output += writer.blockStop();
    state.inThinkingBlock = false;
    state.currentThinkingSignature = '';
  }
  return output;
}

function processGeminiChunk(
  raw: string,
  writer: AnthropicSSEWriter,
  state: StreamState,
): string {
  let output = '';
  let data: GeminiResponse;

  try {
    data = JSON.parse(raw);
  } catch {
    console.warn('[antigravity-proxy] Failed to parse SSE chunk:', raw.slice(0, 200));
    return '';
  }

  const inner = data.response || data;
  const candidates = inner.candidates;
  if (!candidates || candidates.length === 0) return '';

  const candidate = candidates[0];
  const parts = candidate.content?.parts;

  if (parts) {
    for (const part of parts) {
      // Thinking text
      if (part.thought && part.text !== undefined) {
        // Close text block if open
        if (state.inTextBlock) {
          output += writer.blockStop();
          state.inTextBlock = false;
        }
        if (!state.inThinkingBlock) {
          output += writer.thinkingBlockStart();
          state.inThinkingBlock = true;
        }
        output += writer.thinkingDelta(part.text);

        // Cache thinking signature if present
        if (part.thoughtSignature && part.thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
          state.currentThinkingSignature = part.thoughtSignature;
          const modelFamily = getModelFamily(state.model);
          cacheThinkingSignature(part.thoughtSignature, modelFamily);
        }
        continue;
      }

      // Regular text
      if (part.text !== undefined && !part.thought) {
        // Close thinking block if open (with signature)
        output += closeThinkingBlock(writer, state);
        if (!state.inTextBlock) {
          output += writer.textBlockStart();
          state.inTextBlock = true;
        }
        output += writer.textDelta(part.text);
      }

      // Function call
      if (part.functionCall) {
        // Close any open block
        if (state.inTextBlock) {
          output += writer.blockStop();
          state.inTextBlock = false;
        }
        output += closeThinkingBlock(writer, state);

        const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
        output += writer.toolUseStart(part.functionCall.name, toolId);
        output += writer.toolUseInput(JSON.stringify(part.functionCall.args || {}));
        output += writer.blockStop();
        state.hasToolCalls = true;

        // Cache tool signature for future turns (Claude Code may strip it)
        const functionCallSignature = part.thoughtSignature;
        if (functionCallSignature && functionCallSignature.length >= MIN_SIGNATURE_LENGTH) {
          cacheSignature(toolId, functionCallSignature);
        }
      }
    }
  }

  // Track usage (Antigravity's promptTokenCount is TOTAL including cached)
  const usage = inner.usageMetadata;
  if (usage) {
    const promptTokens = usage.promptTokenCount || 0;
    const cachedTokens = usage.cachedContentTokenCount || 0;
    // Anthropic format: input_tokens excludes cached
    state.usage.inputTokens = promptTokens - cachedTokens;
    state.usage.cacheReadTokens = cachedTokens;
    if (usage.candidatesTokenCount) {
      state.usage.outputTokens = usage.candidatesTokenCount;
    }
  }

  // Handle finish
  if (candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
    if (state.inTextBlock) {
      output += writer.blockStop();
      state.inTextBlock = false;
    }
    output += closeThinkingBlock(writer, state);

    let stopReason: string;
    if (candidate.finishReason === 'STOP') {
      // If there were tool calls, finishReason might still be STOP
      stopReason = state.hasToolCalls ? 'tool_use' : 'end_turn';
    } else if (candidate.finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    } else if (candidate.finishReason === 'TOOL_USE' || state.hasToolCalls) {
      stopReason = 'tool_use';
    } else {
      stopReason = 'end_turn';
    }

    output += writer.end(stopReason, state.usage);
    state.finished = true;
  }

  return output;
}

// ── Proxy server ──

let proxyServer: http.Server | null = null;
let proxyPort: number | null = null;

interface ProxyConfig {
  accessToken: string;
  refreshToken: string;
  projectId: string;
  tokenExpiry: number;
}

let proxyConfig: ProxyConfig | null = null;

async function ensureFreshToken(): Promise<string> {
  if (!proxyConfig) throw new Error('Proxy not configured');

  // Refresh if within 60s of expiry
  if (Date.now() < proxyConfig.tokenExpiry - 60000) {
    return proxyConfig.accessToken;
  }

  const result = await refreshAccessToken(proxyConfig.refreshToken);
  if (!result) throw new Error('Failed to refresh access token');

  proxyConfig.accessToken = result.accessToken;
  proxyConfig.tokenExpiry = Date.now() + result.expiresIn * 1000;
  return result.accessToken;
}

/**
 * Fetch the GCP project ID from the Antigravity backend.
 * Uses prod endpoint first (works better for fresh/unprovisioned accounts).
 */
export async function fetchAntigravityProjectId(accessToken: string): Promise<string> {
  for (const base of LOAD_CODE_ASSIST_ENDPOINTS) {
    try {
      const res = await fetch(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...ANTIGRAVITY_HEADERS,
        },
        body: JSON.stringify({ metadata: CLIENT_METADATA }),
      });
      if (!res.ok) continue;

      const data = await res.json() as {
        cloudaicompanionProject?: string | { id?: string };
        allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
      };

      // Extract project ID
      if (typeof data.cloudaicompanionProject === 'string') {
        return data.cloudaicompanionProject;
      }
      if (data.cloudaicompanionProject && typeof data.cloudaicompanionProject === 'object' && 'id' in data.cloudaicompanionProject) {
        return data.cloudaicompanionProject.id!;
      }

      // No project found - try onboarding
      console.log('[antigravity-proxy] No project in loadCodeAssist response, attempting onboardUser...');
      const tierId = getDefaultTierId(data.allowedTiers) || 'FREE';
      const onboardedProject = await onboardUser(accessToken, tierId);
      if (onboardedProject) {
        console.log(`[antigravity-proxy] Successfully onboarded, project: ${onboardedProject}`);
        return onboardedProject;
      }
    } catch (err) {
      console.warn(`[antigravity-proxy] Project discovery failed at ${base}:`, err);
    }
  }

  console.warn(`[antigravity-proxy] Using fallback project ID: ${DEFAULT_PROJECT_ID}`);
  return DEFAULT_PROJECT_ID;
}

function getDefaultTierId(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): string | undefined {
  if (!allowedTiers || allowedTiers.length === 0) return undefined;
  for (const tier of allowedTiers) {
    if (tier.isDefault) return tier.id;
  }
  return allowedTiers[0]?.id;
}

async function onboardUser(accessToken: string, tierId: string): Promise<string | null> {
  for (const base of ANTIGRAVITY_ENDPOINTS) {
    try {
      const res = await fetch(`${base}/v1internal:onboardUser`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...ANTIGRAVITY_HEADERS,
        },
        body: JSON.stringify({ tierId, metadata: CLIENT_METADATA }),
      });
      if (!res.ok) continue;

      const data = await res.json() as {
        done?: boolean;
        response?: { cloudaicompanionProject?: { id?: string } };
      };

      if (data.done && data.response?.cloudaicompanionProject?.id) {
        return data.response.cloudaicompanionProject.id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Start the Antigravity proxy server.
 * Returns the local URL that Claude Code should use as ANTHROPIC_BASE_URL.
 */
export async function startAntigravityProxy(
  refreshToken: string,
  accessToken: string,
  projectId: string,
  expiresIn: number,
): Promise<string> {
  // Stop existing proxy if any
  if (proxyServer) {
    try { proxyServer.close(); } catch { /* ignore */ }
    proxyServer = null;
  }

  proxyConfig = {
    accessToken,
    refreshToken,
    projectId,
    tokenExpiry: Date.now() + expiresIn * 1000,
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        });
        res.end();
        return;
      }

      // Health check / heartbeat (GET or POST to root)
      if (req.url === '/' || req.url === '') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      // Model listing endpoint (Claude Code may call this)
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }

      // Only handle POST /v1/messages
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
        console.warn(`[antigravity-proxy] Unhandled ${req.method} ${req.url}`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      try {
        // Read request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const bodyStr = Buffer.concat(chunks).toString('utf-8');
        const anthropicReq: AnthropicRequest = JSON.parse(bodyStr);

        // Get fresh access token
        const token = await ensureFreshToken();

        // Build Antigravity request
        const { url, body, headers } = buildAntigravityRequest(anthropicReq, proxyConfig!.projectId);
        headers['Authorization'] = `Bearer ${token}`;

        console.log(`[antigravity-proxy] → ${anthropicReq.model}, messages=${anthropicReq.messages.length}, tools=${anthropicReq.tools?.length || 0}, stream=${anthropicReq.stream !== false}`);

        // Send to Antigravity
        const agResponse = await fetch(url, {
          method: 'POST',
          headers,
          body,
        });

        if (!agResponse.ok) {
          const errText = await agResponse.text();
          console.error(`[antigravity-proxy] Gateway error ${agResponse.status}: ${errText.slice(0, 500)}`);
          res.writeHead(agResponse.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: `Antigravity gateway error: ${errText.slice(0, 200)}` },
          }));
          return;
        }

        // Always use streaming (Claude Code SDK uses streaming)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const writer = new AnthropicSSEWriter(anthropicReq.model);
        const state: StreamState = {
          inTextBlock: false,
          inThinkingBlock: false,
          currentThinkingSignature: '',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
          hasToolCalls: false,
          finished: false,
          model: anthropicReq.model,
        };

        // Emit message_start
        res.write(writer.start());

        // Process SSE stream from Antigravity
        const reader = agResponse.body?.getReader();
        if (!reader) {
          res.write(writer.end('end_turn', state.usage));
          res.end();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              // SSE spec: handle both "data:payload" and "data: payload"
              if (!line.startsWith('data:')) continue;
              const jsonStr = line.slice(5).trim();
              if (!jsonStr || jsonStr === '[DONE]') continue;

              const sseOutput = processGeminiChunk(jsonStr, writer, state);
              if (sseOutput) {
                res.write(sseOutput);
              }
            }
          }

          // Process remaining buffer
          if (buffer.startsWith('data:')) {
            const jsonStr = buffer.slice(5).trim();
            if (jsonStr && jsonStr !== '[DONE]') {
              const sseOutput = processGeminiChunk(jsonStr, writer, state);
              if (sseOutput) res.write(sseOutput);
            }
          }

          // Ensure clean close
          if (state.inTextBlock) {
            res.write(writer.blockStop());
          }
          if (state.inThinkingBlock) {
            res.write(closeThinkingBlock(writer, state));
          }
          if (!state.finished) {
            const stopReason = state.hasToolCalls ? 'tool_use' : 'end_turn';
            res.write(writer.end(stopReason, state.usage));
          }

          console.log(`[antigravity-proxy] ← done, tokens: in=${state.usage.inputTokens} out=${state.usage.outputTokens} cached=${state.usage.cacheReadTokens}`);
          res.end();
        } catch (streamErr) {
          console.error('[antigravity-proxy] Stream error:', streamErr);
          if (!state.finished) {
            res.write(writer.end('end_turn', state.usage));
          }
          res.end();
        }
      } catch (err) {
        console.error('[antigravity-proxy] Request error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: err instanceof Error ? err.message : 'Internal proxy error' },
        }));
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        proxyPort = addr.port;
        proxyServer = server;
        const baseUrl = `http://127.0.0.1:${proxyPort}`;
        console.log(`[antigravity-proxy] Proxy server started on ${baseUrl}`);
        resolve(baseUrl);
      } else {
        reject(new Error('Failed to get proxy server address'));
      }
    });

    server.on('error', (err) => {
      reject(new Error(`Proxy server failed: ${err.message}`));
    });
  });
}

export function stopAntigravityProxy(): void {
  if (proxyServer) {
    try { proxyServer.close(); } catch { /* ignore */ }
    proxyServer = null;
    proxyPort = null;
    proxyConfig = null;
  }
}
