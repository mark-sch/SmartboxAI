const express = require('express');
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

function logRequest(req) {
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

  log('verbose', 'REQUEST  =>', JSON.stringify(logData, null, 2));
}

function logResponse(status, headers, body) {
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

  log('verbose', 'RESPONSE <=', JSON.stringify(logData, null, 2));
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

function logRoundtrip(method, path, usage, requestBytes, responseBytes, totalMs, ttftMs) {
  if (currentLogLevel < LOG_LEVELS.info) return;
  const requestKb = (requestBytes / 1024).toFixed(2);
  const responseKb = (responseBytes / 1024).toFixed(2);
  const tokenStr = formatTokens(usage);
  const speedStr = formatSpeed(usage, totalMs, ttftMs);
  log('info', `Roundtrip: ${method} ${path} | context: ${requestKb} kB | response: ${responseKb} kB | ${tokenStr} | ${speedStr}`);
}

// For streaming endpoints we need the raw body; for others we can parse JSON.
// We use express.raw for all routes and parse JSON on demand when needed.
app.use(express.raw({ type: '*/*', limit: '100mb' }));

app.use(authMiddleware);

app.all('*', async (req, res) => {
  logRequest(req);

  let targetToken;
  try {
    if (PROXY_REFRESH_TOKEN) {
      targetToken = await ensureFreshToken();
    } else {
      targetToken = PROXY_TARGET_TOKEN || PROXY_AUTH_TOKEN;
    }
  } catch (err) {
    log('error', 'Token refresh failed:', err.message);
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
  headers['User-Agent'] = 'KimiCLI/1.32.0';

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
        const metricsPayload = Buffer.from(JSON.stringify(metrics)).toString('base64');
        res.write(`data: {"choices":[{"delta":{"content":"\\uE000PROXY_METRICS:${metricsPayload}"},"finish_reason":null}]}\n\n`);
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
              logRoundtrip(req.method, req.path, streamUsage, requestBytes, responseBytes, endTime - startTime, firstByteTime - startTime);

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
          log('error', 'Streaming error:', err);
          if (!res.writableEnded) {
            const endTime = performance.now();
            const streamUsage = extractUsageFromSSE(streamBuffer);
            const metrics = buildProxyMetrics(streamUsage, endTime - startTime, firstByteTime - startTime);
            logRoundtrip(req.method, req.path, streamUsage, requestBytes, responseBytes, endTime - startTime, firstByteTime - startTime);

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
      logResponse(response.status, response.headers, bodyText);

      try {
        const data = JSON.parse(bodyText);
        if (req.path === '/models' && data.data && Array.isArray(data.data)) {
          for (const model of data.data) {
            if (!model.context_length && model.n_ctx_train) {
              model.context_length = model.n_ctx_train;
            }
          }
          bodyText = JSON.stringify(data);
        }
        const metricsPayload = Buffer.from(JSON.stringify(metrics)).toString('base64');
        if (data.choices && data.choices[0] && data.choices[0].message) {
          const originalContent = data.choices[0].message.content || '';
          data.choices[0].message.content = originalContent + `\uE000PROXY_METRICS:${metricsPayload}`;
          bodyText = JSON.stringify(data);
        }
      } catch (e) {
        // ignore injection errors
      }

      logRoundtrip(req.method, req.path, usage, requestBytes, responseBytes, endTime - startTime, firstByteTime - startTime);
      res.send(bodyText);
    }
  } catch (err) {
    log('error', 'Proxy error:', err);
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
