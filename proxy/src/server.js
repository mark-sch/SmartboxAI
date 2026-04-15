const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { ensureFreshToken } = require('./oauth');

const app = express();

function getProxyTargetUrl() {
  return (process.env.PROXY_TARGET_URL || '').replace(/\/$/, '');
}
const PROXY_AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || '';
const PROXY_TARGET_TOKEN = process.env.PROXY_TARGET_TOKEN || '';
const PROXY_REFRESH_TOKEN = process.env.PROXY_REFRESH_TOKEN || '';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3000', 10);
const PROXY_LOG_LEVEL = (process.env.PROXY_LOG_LEVEL || 'info').toLowerCase();

const PROXY_DEVICE_IDS = (process.env.PROXY_DEVICE_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
let deviceIdIndex = 0;

function getNextDeviceId() {
  if (PROXY_DEVICE_IDS.length === 0) return null;
  const id = PROXY_DEVICE_IDS[deviceIdIndex];
  deviceIdIndex = (deviceIdIndex + 1) % PROXY_DEVICE_IDS.length;
  return id;
}

const LOG_LEVELS = { error: 0, info: 1, verbose: 2 };
const currentLogLevel = LOG_LEVELS[PROXY_LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, ...args) {
  if (LOG_LEVELS[level] <= currentLogLevel) {
    const prefix = `[${level.toUpperCase()}]`;
    console.log(prefix, ...args);
  }
}

if (!getProxyTargetUrl()) {
  log('error', 'PROXY_TARGET_URL is not set');
  process.exit(1);
}

if (!PROXY_AUTH_TOKEN) {
  log('error', 'PROXY_AUTH_TOKEN is not set');
  process.exit(1);
}

function sendError(res, status, message, type) {
  const body = {
    error: {
      message,
      type: type || 'authentication_error',
      param: null,
      code: null,
    },
  };
  res.status(status).json(body);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== PROXY_AUTH_TOKEN) {
    log('error', 'Auth failed:', req.method, req.path);
    sendError(res, 401, 'Invalid or missing proxy authentication token.', 'authentication_error');
    return;
  }
  next();
}

// ============================================================================
// Session logging helpers
// ============================================================================

function getSessionDir(sessionId) {
  return path.join(__dirname, '..', 'sessions', sessionId);
}

function ensureSessionDir(sessionId) {
  const dir = getSessionDir(sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function extractSessionId(body) {
  if (!body || body.length === 0) return null;
  try {
    const data = JSON.parse(body.toString('utf-8'));
    if (data && typeof data.prompt_cache_key === 'string' && data.prompt_cache_key.trim()) {
      return data.prompt_cache_key.trim();
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function initStateJson(sessionId) {
  const dir = getSessionDir(sessionId);
  const statePath = path.join(dir, 'state.json');
  if (fs.existsSync(statePath)) return;
  const state = {
    version: 1,
    approval: { yolo: false, auto_approve_actions: [] },
    additional_dirs: [],
    custom_title: null,
    title_generated: false,
    title_generate_attempts: 0,
    plan_mode: false,
    plan_session_id: null,
    plan_slug: null,
    wire_mtime: null,
    archived: false,
    archived_at: null,
    auto_archive_exempt: false,
    todos: [],
    agent_file: null,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

function countContextMessages(sessionId) {
  const contextPath = path.join(getSessionDir(sessionId), 'context.jsonl');
  if (!fs.existsSync(contextPath)) return 0;
  let count = 0;
  const data = fs.readFileSync(contextPath, 'utf-8');
  for (const line of data.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.role === 'string' && !obj.role.startsWith('_')) {
        count++;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return count;
}

function appendContextMessages(sessionId, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const contextPath = path.join(getSessionDir(sessionId), 'context.jsonl');
  const existingCount = countContextMessages(sessionId);
  const newMessages = messages.slice(existingCount);
  if (newMessages.length === 0) return;
  const lines = newMessages.map((m) => JSON.stringify(m) + '\n');
  fs.appendFileSync(contextPath, lines.join(''), 'utf-8');
}

function appendContextEntry(sessionId, entry) {
  const contextPath = path.join(getSessionDir(sessionId), 'context.jsonl');
  fs.appendFileSync(contextPath, JSON.stringify(entry) + '\n', 'utf-8');
}

function appendContextUsage(sessionId, usage) {
  if (!usage || typeof usage.total_tokens !== 'number') return;
  const contextPath = path.join(getSessionDir(sessionId), 'context.jsonl');
  const line = JSON.stringify({ role: '_usage', token_count: usage.total_tokens }) + '\n';
  fs.appendFileSync(contextPath, line, 'utf-8');
}

function appendWireLog(sessionId, type, payload) {
  const wirePath = path.join(getSessionDir(sessionId), 'wire.jsonl');
  const needsHeader = !fs.existsSync(wirePath) || fs.statSync(wirePath).size === 0;
  const lines = [];
  if (needsHeader) {
    lines.push(JSON.stringify({ type: 'metadata', protocol_version: 'proxy-1.1' }) + '\n');
  }
  const record = {
    timestamp: Date.now() / 1000,
    message: { type, payload },
  };
  lines.push(JSON.stringify(record) + '\n');
  fs.appendFileSync(wirePath, lines.join(''), 'utf-8');
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function shorten(text, width, placeholder = '…') {
  text = text.split(/\s+/).join(' ');
  if (text.length <= width) return text;
  let cut = width - placeholder.length;
  if (cut <= 0) return text.slice(0, width);
  const space = text.lastIndexOf(' ', cut);
  if (space > 0) cut = space;
  return text.slice(0, cut).trimEnd() + placeholder;
}

function updateCustomTitle(sessionId, messages) {
  if (!Array.isArray(messages)) return;
  const userMsg = messages.find((m) => m && m.role === 'user');
  if (!userMsg) return;
  const text = extractTextFromContent(userMsg.content).trim();
  if (!text) return;
  const title = shorten(text, 50);
  const statePath = path.join(getSessionDir(sessionId), 'state.json');
  if (!fs.existsSync(statePath)) return;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (state.custom_title === null) {
      state.custom_title = title;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
    }
  } catch {
    // ignore state update errors
  }
}

// ============================================================================
// End session logging helpers
// ============================================================================

function logRequest(req, sessionId) {
  if (currentLogLevel < LOG_LEVELS.verbose) return;

  const logData = {
    method: req.method,
    path: req.path,
    headers: { ...req.headers },
  };
  delete logData.headers.authorization;

  if (req.body && req.body.length > 0) {
    const bodyStr = req.body.toString('utf-8');
    try {
      logData.body = JSON.parse(bodyStr);
    } catch {
      logData.body = bodyStr;
    }
  }

  const prefix = sessionId ? `[${sessionId}]` : '';
  log('verbose', prefix, 'REQUEST  =>', JSON.stringify(logData, null, 2));
}

function logResponse(status, headers, body, sessionId) {
  if (currentLogLevel < LOG_LEVELS.verbose) return;

  const logData = { status };
  const contentType = headers.get('content-type') || '';
  if (body) {
    if (contentType.includes('application/json')) {
      try {
        logData.body = JSON.parse(body);
      } catch {
        logData.body = body;
      }
    } else {
      logData.body = body;
    }
  }

  const prefix = sessionId ? `[${sessionId}]` : '';
  log('verbose', prefix, 'RESPONSE <=', JSON.stringify(logData, null, 2));
}

function extractUsage(body) {
  if (!body) return null;
  try {
    const data = JSON.parse(body);
    const usage = data.usage;
    if (!usage) return null;
    const cachedTokens = usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? null;
    return {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      cached_tokens: cachedTokens,
    };
  } catch {
    return null;
  }
}

function extractUsageFromSSE(buffer) {
  if (!buffer) return null;
  const lines = buffer.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === '[DONE]') continue;
      try {
        const data = JSON.parse(jsonStr);
        if (data.usage) {
          const cachedTokens = data.usage.cached_tokens ?? data.usage.prompt_tokens_details?.cached_tokens ?? null;
          return {
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
            total_tokens: data.usage.total_tokens,
            cached_tokens: cachedTokens,
          };
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  return null;
}

function formatTokens(usage) {
  if (!usage) return 'tokens: n/a';
  const context = usage.prompt_tokens ?? '?';
  const output = usage.completion_tokens ?? '?';
  const total = usage.total_tokens ?? '?';
  const cached = usage.cached_tokens ?? '?';
  const realInput = (typeof usage.prompt_tokens === 'number' && typeof usage.cached_tokens === 'number')
    ? usage.prompt_tokens - usage.cached_tokens
    : '?';
  return `tokens: context=${context} (cached=${cached} input=${realInput}) output=${output} total=${total}`;
}

function buildProxyMetrics(usage, totalMs, ttftMs) {
  // NOTE: totalMs measures the raw HTTP roundtrip from fetch() call until the
  // last response byte is consumed. It therefore differs slightly (typically
  // ~50-100 ms) from Kimi CLI's internal "LLM step" timer, which wraps the
  // entire kosong call including request preparation. Exact parity is not
  // feasible at the proxy layer without disproportionate instrumentation.
  const totalSeconds = totalMs / 1000;
  const ttftSeconds = Math.max(ttftMs / 1000, 0.001);
  const generationTime = Math.max(totalSeconds - ttftSeconds, 0.001);

  const metrics = {
    total_time: Number(totalSeconds.toFixed(2)),
    ttft: Number(ttftSeconds.toFixed(2)),
  };

  if (usage && typeof usage.prompt_tokens === 'number') {
    const inputTokens = usage.prompt_tokens - (usage.cached_tokens ?? 0);
    metrics.input_tok_s = Number((inputTokens / ttftSeconds).toFixed(2));
  }

  if (usage && typeof usage.completion_tokens === 'number' && usage.completion_tokens > 0) {
    metrics.output_tok_s = Number((usage.completion_tokens / generationTime).toFixed(2));
  }

  return metrics;
}

function extractAssistantMessageFromSSE(buffer) {
  if (!buffer) return null;
  const lines = buffer.split('\n');
  let textContent = '';
  let reasoningContent = '';
  let hasDelta = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === '[DONE]') continue;
      try {
        const data = JSON.parse(jsonStr);
        if (data.choices && data.choices[0] && data.choices[0].delta) {
          hasDelta = true;
          const delta = data.choices[0].delta;
          if (typeof delta.content === 'string') {
            textContent += delta.content;
          }
          if (typeof delta.reasoning_content === 'string') {
            reasoningContent += delta.reasoning_content;
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  if (!hasDelta) return null;
  if (reasoningContent) {
    return {
      role: 'assistant',
      content: [
        { type: 'think', think: reasoningContent, encrypted: null },
        { type: 'text', text: textContent },
      ],
    };
  }
  return { role: 'assistant', content: textContent };
}

function formatSpeed(usage, totalMs, ttftMs) {
  const totalSeconds = totalMs / 1000;
  const ttftSeconds = Math.max(ttftMs / 1000, 0.001);
  const generationTime = Math.max(totalSeconds - ttftSeconds, 0.001);

  const hasInput = usage && typeof usage.prompt_tokens === 'number';
  const hasOutput = usage && typeof usage.completion_tokens === 'number' && usage.completion_tokens > 0;

  if (hasInput && hasOutput) {
    const inputTokens = usage.prompt_tokens - (usage.cached_tokens ?? 0);
    const inputTokS = inputTokens / ttftSeconds;
    const outputTokS = usage.completion_tokens / generationTime;
    return `speed: in=${inputTokS.toFixed(2)} out=${outputTokS.toFixed(2)} tok/s (total: ${totalSeconds.toFixed(2)}s, ttft: ${ttftSeconds.toFixed(2)}s)`;
  }

  if (hasInput) {
    const inputTokens = usage.prompt_tokens - (usage.cached_tokens ?? 0);
    const inputTokS = inputTokens / ttftSeconds;
    return `speed: in=${inputTokS.toFixed(2)} tok/s (total: ${totalSeconds.toFixed(2)}s, ttft: ${ttftSeconds.toFixed(2)}s)`;
  }

  if (hasOutput) {
    const outputTokS = usage.completion_tokens / generationTime;
    return `speed: out=${outputTokS.toFixed(2)} tok/s (total: ${totalSeconds.toFixed(2)}s, ttft: ${ttftSeconds.toFixed(2)}s)`;
  }

  return `speed: total: ${totalSeconds.toFixed(2)}s (ttft: ${ttftSeconds.toFixed(2)}s)`;
}

function logRoundtrip(method, path, usage, requestBytes, responseBytes, totalMs, ttftMs, sessionId) {
  if (currentLogLevel < LOG_LEVELS.info) return;
  const requestKb = (requestBytes / 1024).toFixed(2);
  const responseKb = (responseBytes / 1024).toFixed(2);
  const tokenStr = formatTokens(usage);
  const speedStr = formatSpeed(usage, totalMs, ttftMs);
  const prefix = sessionId ? `[${sessionId}] ` : '';
  log('info', `${prefix}Roundtrip: ${method} ${path} | context: ${requestKb} kB | response: ${responseKb} kB | ${tokenStr} | ${speedStr}`);
}

// For streaming endpoints we need the raw body; for others we can parse JSON.
// We use express.raw for all routes and parse JSON on demand when needed.
app.use(express.raw({ type: '*/*', limit: '100mb' }));

app.use(authMiddleware);

app.all('*', async (req, res) => {
  const sessionId = extractSessionId(req.body);
  const deviceIdOverride = getNextDeviceId();
  logRequest(req, sessionId);

  if (sessionId) {
    ensureSessionDir(sessionId);
    initStateJson(sessionId);
    try {
      const bodyData = JSON.parse(req.body.toString('utf-8'));
      if (Array.isArray(bodyData.messages)) {
        appendContextMessages(sessionId, bodyData.messages);
        updateCustomTitle(sessionId, bodyData.messages);
      }
    } catch {
      // ignore
    }
    const sanitizedHeaders = { ...req.headers };
    delete sanitizedHeaders.authorization;
    if (deviceIdOverride) {
      if (req.headers['x-msh-device-id']) {
        sanitizedHeaders['x-proxy-original-device-id'] = req.headers['x-msh-device-id'];
      }
      sanitizedHeaders['x-msh-device-id'] = deviceIdOverride;
    }
    if (process.env.PROXY_USER_AGENT) {
      if (req.headers['user-agent']) {
        sanitizedHeaders['x-proxy-original-user-agent'] = req.headers['user-agent'];
      }
      sanitizedHeaders['user-agent'] = process.env.PROXY_USER_AGENT;
    }
    let bodyData = null;
    try {
      bodyData = JSON.parse(req.body.toString('utf-8'));
    } catch {
      bodyData = req.body.toString('utf-8');
    }
    try {
      const wireBody = JSON.parse(req.body.toString('utf-8'));
      if (Array.isArray(wireBody.messages)) {
        const lastUserMsg = wireBody.messages.slice().reverse().find((m) => m && m.role === 'user');
        if (lastUserMsg) {
          const userText = extractTextFromContent(lastUserMsg.content);
          appendWireLog(sessionId, 'TurnBegin', { user_input: [{ type: 'text', text: userText }] });
        }
      }
    } catch {
      // ignore wire init errors
    }
    appendWireLog(sessionId, 'StepBegin', { n: 1 });
  }

  let targetToken;
  try {
    if (PROXY_REFRESH_TOKEN) {
      targetToken = await ensureFreshToken();
    } else {
      targetToken = PROXY_TARGET_TOKEN || PROXY_AUTH_TOKEN;
    }
  } catch (err) {
    log('error', sessionId ? `[${sessionId}]` : '', 'Token refresh failed:', err.message);
    sendError(res, 401, `Token refresh failed: ${err.message}`, 'authentication_error');
    return;
  }

  const targetUrl = `${getProxyTargetUrl()}${req.path}`;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === 'host') {
      continue;
    }
    if (key.toLowerCase() === 'authorization') {
      headers[key] = `Bearer ${targetToken}`;
      continue;
    }
    if (key.toLowerCase() === 'user-agent') {
      continue;
    }
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  if (deviceIdOverride) {
    headers['x-msh-device-id'] = deviceIdOverride;
  }
  if (process.env.PROXY_USER_AGENT) {
    headers['User-Agent'] = process.env.PROXY_USER_AGENT;
  } else if (req.headers['user-agent']) {
    headers['User-Agent'] = req.headers['user-agent'];
  }

  const fetchOptions = {
    method: req.method,
    headers,
    // Node fetch accepts Buffer/Uint8Array as body
    body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
  };

  const requestBytes = Buffer.isBuffer(req.body) ? req.body.length : 0;

  try {
    const startTime = performance.now();
    const response = await fetch(targetUrl, fetchOptions);
    const firstByteTime = performance.now();

    // Forward status
    res.status(response.status);

    // Forward headers (filter out hop-by-hop and content-transforming headers)
    const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'];
    for (const [key, value] of response.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (hopByHop.includes(lowerKey)) {
        continue;
      }
      // Remove content-encoding and content-length because Node.js fetch
      // automatically decompresses the body, but we must not tell the client
      // that it is still compressed.
      if (lowerKey === 'content-encoding' || lowerKey === 'content-length') {
        continue;
      }
      res.setHeader(key, value);
    }

    const isStream = response.headers.get('content-type')?.includes('text/event-stream');

    if (isStream) {
      const reader = response.body.getReader();
      let responseBytes = 0;
      let streamBuffer = '';
      let sseBuffer = '';
      let doneHeld = false;
      const decoder = new TextDecoder();

      function parseSSE(buffer) {
        const events = [];
        let remainder = buffer;
        while (true) {
          const blankLineIndex = remainder.search(/\r?\n\r?\n/);
          if (blankLineIndex === -1) break;
          const eventText = remainder.slice(0, blankLineIndex);
          remainder = remainder.slice(blankLineIndex + 2);
          let data = null;
          for (const line of eventText.split(/\r?\n/)) {
            if (line.startsWith('data:')) {
              data = line.slice(5).trim();
            }
          }
          if (data !== null) {
            events.push({ data });
          }
        }
        return { events, remainder };
      }

      function flushMetricsAndDone(metrics) {
        const messageId = (() => {
          try {
            const firstDataLine = streamBuffer.split('\n').find((l) => l.trim().startsWith('data:') && l.trim().slice(5).trim() !== '[DONE]');
            if (firstDataLine) {
              const firstData = JSON.parse(firstDataLine.trim().slice(5).trim());
              return firstData.id || '';
            }
          } catch {
            // ignore
          }
          return '';
        })();
        res.write(`data: {"id":"${messageId}","object":"chat.completion.chunk","created":${Math.floor(Date.now() / 1000)},"model":"","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"proxy_metrics":${JSON.stringify(metrics)}}\n\n`);
        res.write(`event: proxy_metrics\ndata: ${JSON.stringify(metrics)}\n\n`);
        res.write('data: [DONE]\n\n');
      }

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              const endTime = performance.now();
              const streamUsage = extractUsageFromSSE(streamBuffer);
              const metrics = buildProxyMetrics(streamUsage, endTime - startTime, firstByteTime - startTime);
              logRoundtrip(req.method, req.path, streamUsage, requestBytes, responseBytes, endTime - startTime, firstByteTime - startTime, sessionId);

              if (sessionId) {
                const assistantMessage = extractAssistantMessageFromSSE(streamBuffer);
                if (assistantMessage !== null) {
                  appendContextEntry(sessionId, assistantMessage);
                  if (Array.isArray(assistantMessage.content)) {
                    for (const part of assistantMessage.content) {
                      appendWireLog(sessionId, 'ContentPart', part);
                    }
                  } else if (typeof assistantMessage.content === 'string') {
                    appendWireLog(sessionId, 'ContentPart', { type: 'text', text: assistantMessage.content });
                  }
                }
                const messageId = (() => {
                  try {
                    const firstDataLine = streamBuffer.split('\n').find((l) => l.trim().startsWith('data:') && l.trim().slice(5).trim() !== '[DONE]');
                    if (firstDataLine) {
                      const firstData = JSON.parse(firstDataLine.trim().slice(5).trim());
                      return firstData.id || null;
                    }
                  } catch {
                    // ignore
                  }
                  return null;
                })();
                appendWireLog(sessionId, 'StatusUpdate', {
                  context_tokens: streamUsage?.prompt_tokens ?? null,
                  token_usage: streamUsage
                    ? {
                        input_other: streamUsage.prompt_tokens - (streamUsage.cached_tokens ?? 0),
                        output: streamUsage.completion_tokens,
                        input_cache_read: streamUsage.cached_tokens ?? 0,
                        input_cache_creation: 0,
                      }
                    : null,
                  message_id: messageId,
                });
                appendWireLog(sessionId, 'TurnEnd', {});
                appendContextUsage(sessionId, streamUsage);
              }

              // Flush any remaining partial events
              if (sseBuffer.trim()) {
                const { events, remainder } = parseSSE(sseBuffer);
                for (const ev of events) {
                  if (ev.data === '[DONE]') {
                    doneHeld = true;
                  } else {
                    res.write(`data: ${ev.data}\n\n`);
                  }
                }
                if (remainder.trim()) {
                  res.write(remainder);
                }
              }

              if (doneHeld) {
                flushMetricsAndDone(metrics);
              }
              res.end();
              return;
            }
            const chunk = Buffer.from(value);
            responseBytes += chunk.length;
            const chunkStr = chunk.toString('utf-8');
            streamBuffer += chunkStr;
            sseBuffer += chunkStr;

            const { events, remainder } = parseSSE(sseBuffer);
            sseBuffer = remainder;

            for (const ev of events) {
              if (ev.data === '[DONE]') {
                doneHeld = true;
              } else {
                res.write(`data: ${ev.data}\n\n`);
              }
            }
            // Flush for SSE streaming
            if (res.flush && typeof res.flush === 'function') {
              res.flush();
            }
          }
        } catch (err) {
          log('error', sessionId ? `[${sessionId}]` : '', 'Streaming error:', err);
          if (!res.writableEnded) {
            const endTime = performance.now();
            const streamUsage = extractUsageFromSSE(streamBuffer);
            const metrics = buildProxyMetrics(streamUsage, endTime - startTime, firstByteTime - startTime);
            logRoundtrip(req.method, req.path, streamUsage, requestBytes, responseBytes, endTime - startTime, firstByteTime - startTime, sessionId);

            if (sessionId) {
              const assistantMessage = extractAssistantMessageFromSSE(streamBuffer);
              if (assistantMessage !== null) {
                appendContextEntry(sessionId, assistantMessage);
                if (Array.isArray(assistantMessage.content)) {
                  for (const part of assistantMessage.content) {
                    appendWireLog(sessionId, 'ContentPart', part);
                  }
                } else if (typeof assistantMessage.content === 'string') {
                  appendWireLog(sessionId, 'ContentPart', { type: 'text', text: assistantMessage.content });
                }
              }
              const messageId = (() => {
                try {
                  const firstDataLine = streamBuffer.split('\n').find((l) => l.trim().startsWith('data:') && l.trim().slice(5).trim() !== '[DONE]');
                  if (firstDataLine) {
                    const firstData = JSON.parse(firstDataLine.trim().slice(5).trim());
                    return firstData.id || null;
                  }
                } catch {
                  // ignore
                }
                return null;
              })();
              appendWireLog(sessionId, 'StatusUpdate', {
                context_tokens: streamUsage?.prompt_tokens ?? null,
                token_usage: streamUsage
                  ? {
                      input_other: streamUsage.prompt_tokens - (streamUsage.cached_tokens ?? 0),
                      output: streamUsage.completion_tokens,
                      input_cache_read: streamUsage.cached_tokens ?? 0,
                      input_cache_creation: 0,
                    }
                  : null,
                message_id: messageId,
              });
              appendWireLog(sessionId, 'TurnEnd', {});
              appendContextUsage(sessionId, streamUsage);
            }

            if (sseBuffer.trim()) {
              const { events, remainder } = parseSSE(sseBuffer);
              for (const ev of events) {
                if (ev.data === '[DONE]') {
                  doneHeld = true;
                } else {
                  res.write(`data: ${ev.data}\n\n`);
                }
              }
              if (remainder.trim()) {
                res.write(remainder);
              }
            }

            if (doneHeld) {
              flushMetricsAndDone(metrics);
            }
            res.end();
          }
        }
      };
      pump();
    } else {
      let bodyText = await response.text();
      const endTime = performance.now();
      const responseBytes = Buffer.byteLength(bodyText, 'utf-8');
      const usage = extractUsage(bodyText);
      const metrics = buildProxyMetrics(usage, endTime - startTime, firstByteTime - startTime);
      res.setHeader('X-Proxy-Metrics', JSON.stringify(metrics));
      logResponse(response.status, response.headers, bodyText, sessionId);

      try {
        const data = JSON.parse(bodyText);
        if (sessionId && data.choices && data.choices[0] && data.choices[0].message) {
          const msg = data.choices[0].message;
          const assistantMessage = msg.reasoning_content
            ? {
                role: 'assistant',
                content: [
                  { type: 'think', think: msg.reasoning_content, encrypted: null },
                  { type: 'text', text: msg.content || '' },
                ],
              }
            : { role: 'assistant', content: msg.content || '' };
          appendContextEntry(sessionId, assistantMessage);
        }
        if (req.path === '/models' && data.data && Array.isArray(data.data)) {
          for (const model of data.data) {
            if (!model.context_length && model.n_ctx_train) {
              model.context_length = model.n_ctx_train;
            }
          }
          bodyText = JSON.stringify(data);
        }
        data.proxy_metrics = metrics;
        bodyText = JSON.stringify(data);
      } catch (e) {
        // ignore injection errors
      }

      if (sessionId) {
        try {
          const data = JSON.parse(bodyText);
          const msg = data.choices && data.choices[0] && data.choices[0].message;
          if (msg) {
            if (msg.reasoning_content) {
              appendWireLog(sessionId, 'ContentPart', { type: 'think', think: msg.reasoning_content, encrypted: null });
              appendWireLog(sessionId, 'ContentPart', { type: 'text', text: msg.content || '' });
            } else {
              appendWireLog(sessionId, 'ContentPart', { type: 'text', text: msg.content || '' });
            }
          }
          appendWireLog(sessionId, 'StatusUpdate', {
            context_tokens: usage?.prompt_tokens ?? null,
            token_usage: usage
              ? {
                  input_other: usage.prompt_tokens - (usage.cached_tokens ?? 0),
                  output: usage.completion_tokens,
                  input_cache_read: usage.cached_tokens ?? 0,
                  input_cache_creation: 0,
                }
              : null,
            message_id: data.id || null,
          });
          appendWireLog(sessionId, 'TurnEnd', {});
        } catch {
          // ignore wire log errors
        }
        appendContextUsage(sessionId, usage);
      }

      logRoundtrip(req.method, req.path, usage, requestBytes, responseBytes, endTime - startTime, firstByteTime - startTime, sessionId);
      res.send(bodyText);
    }
  } catch (err) {
    log('error', sessionId ? `[${sessionId}]` : '', 'Proxy error:', err);
    sendError(res, 502, `Proxy target error: ${err.message}`, 'proxy_error');
  }
});

module.exports = { app };

if (require.main === module) {
  app.listen(PROXY_PORT, () => {
    log('info', `Smartbox LLM Proxy listening on port ${PROXY_PORT}`);
    log('info', `Forwarding to: ${getProxyTargetUrl()}`);
    log('info', `Log level: ${PROXY_LOG_LEVEL}`);
    if (PROXY_REFRESH_TOKEN) {
      log('info', 'Token refresh mode: enabled');
    } else {
      log('info', 'Token refresh mode: disabled (using static PROXY_TARGET_TOKEN)');
    }
  });
}
