const fs = require('fs');
const path = require('path');

const OAUTH_HOST = (process.env.OAUTH_HOST || 'https://auth.kimi.com').replace(/\/$/, '');
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const ENV_PATH = path.resolve(__dirname, '..', '.env');

let refreshPromise = null;

function loadEnvTokens() {
  const accessToken = process.env.PROXY_TARGET_TOKEN || null;
  const refreshToken = process.env.PROXY_REFRESH_TOKEN || null;
  const expiresAt = process.env.PROXY_TARGET_EXPIRES_AT
    ? parseFloat(process.env.PROXY_TARGET_EXPIRES_AT)
    : null;
  const expiresIn = process.env.PROXY_TARGET_EXPIRES_IN
    ? parseFloat(process.env.PROXY_TARGET_EXPIRES_IN)
    : null;

  if (!accessToken || !refreshToken) {
    return null;
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    expires_in: expiresIn,
  };
}

function isTokenExpired(token) {
  if (!token.expires_at) {
    // If we don't know when it expires, assume it needs refresh
    return true;
  }
  const expiresIn = token.expires_in || 3600;
  const threshold = Math.max(300, expiresIn * 0.5);
  const now = Date.now() / 1000;
  return now >= token.expires_at - threshold;
}

async function doRefresh(refreshToken, attempt = 0, maxRetries = 3) {
  const url = `${OAUTH_HOST}/api/oauth/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const status = response.status;
    let data = {};
    try {
      data = await response.json();
    } catch {
      // ignore JSON parse errors
    }

    if (status === 401 || status === 403) {
      throw new Error(data.error_description || 'Token refresh unauthorized.');
    }
    if (status >= 500 || status === 429) {
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        return doRefresh(refreshToken, attempt + 1, maxRetries);
      }
      throw new Error(data.error_description || `Token refresh failed (HTTP ${status}).`);
    }
    if (status !== 200) {
      throw new Error(data.error_description || `Token refresh failed (HTTP ${status}).`);
    }

    const expiresIn = parseFloat(data.expires_in);
    const expiresAt = Date.now() / 1000 + expiresIn;
    return {
      access_token: String(data.access_token),
      refresh_token: String(data.refresh_token),
      expires_at: expiresAt,
      expires_in: expiresIn,
    };
  } catch (err) {
    if (attempt < maxRetries - 1 && (err.message.includes('fetch failed') || err.code === 'ECONNREFUSED')) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      return doRefresh(refreshToken, attempt + 1, maxRetries);
    }
    throw err;
  }
}

function updateEnvFile(updates) {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  }

  const lines = content.split('\n');
  const keysToUpdate = Object.keys(updates);
  const updatedKeys = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const key of keysToUpdate) {
      if (line.startsWith(`${key}=`) || line.startsWith(`# ${key}=`) || line.startsWith(`#${key}=`) || line.match(new RegExp(`^${key}=`))) {
        lines[i] = `${key}=${updates[key]}`;
        updatedKeys.add(key);
      }
    }
  }

  for (const key of keysToUpdate) {
    if (!updatedKeys.has(key)) {
      lines.push(`${key}=${updates[key]}`);
    }
  }

  const newContent = lines.join('\n');
  fs.writeFileSync(ENV_PATH, newContent, 'utf-8');
}

async function ensureFreshToken() {
  const token = loadEnvTokens();
  if (!token) {
    throw new Error('PROXY_TARGET_TOKEN and PROXY_REFRESH_TOKEN must be configured in .env');
  }

  if (!isTokenExpired(token)) {
    return token.access_token;
  }

  if (refreshPromise) {
    await refreshPromise;
    const refreshed = loadEnvTokens();
    if (!refreshed) {
      throw new Error('Token refresh failed: tokens missing after refresh');
    }
    return refreshed.access_token;
  }

  refreshPromise = (async () => {
    try {
      const newToken = await doRefresh(token.refresh_token);
      updateEnvFile({
        PROXY_TARGET_TOKEN: newToken.access_token,
        PROXY_REFRESH_TOKEN: newToken.refresh_token,
        PROXY_TARGET_EXPIRES_AT: String(newToken.expires_at),
        PROXY_TARGET_EXPIRES_IN: String(newToken.expires_in),
      });
      process.env.PROXY_TARGET_TOKEN = newToken.access_token;
      process.env.PROXY_REFRESH_TOKEN = newToken.refresh_token;
      process.env.PROXY_TARGET_EXPIRES_AT = String(newToken.expires_at);
      process.env.PROXY_TARGET_EXPIRES_IN = String(newToken.expires_in);
      return newToken;
    } finally {
      refreshPromise = null;
    }
  })();

  const newToken = await refreshPromise;
  return newToken.access_token;
}

module.exports = {
  loadEnvTokens,
  isTokenExpired,
  doRefresh,
  updateEnvFile,
  ensureFreshToken,
};
