/**
 * VectorEd Academy Knowledge Hub — Serverless API Proxy
 * Runs on Netlify Functions (same-origin with frontend).
 * Proxies requests to the Google Apps Script Web App execution endpoint,
 * properly handling HTTP 301, 302, 303, 307, and 308 redirects, payload
 * limits, and returning verified JSON to the browser.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Authoritative Apps Script Web App deployment endpoint
const APPS_SCRIPT_EXEC_URL = 'https://script.google.com/macros/s/AKfycbwwH1tbntk_njClNZ7uHoR1492derbjNXgkQKp6vnfBSsS8XA8mTCOkS_8mrGAKL5PI/exec';

// Maximum payload size: 6 MB (Netlify synchronous function limit)
const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const REQUEST_TIMEOUT_MS = 28000;

/**
 * Executes HTTP requests following HTTP redirects according to standard RFC specifications:
 * - 301 / 302 / 303: Method converts to GET, original POST body is dropped.
 *   (Crucial for Apps Script: Google's 302 redirects to a usercontent GET endpoint containing the execution JSON).
 * - 307 / 308: Method and original body are preserved.
 */
function requestWithRedirects(targetUrl, method, postData, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error('Redirect loop or too many redirects encountered while contacting backend.'));
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (err) {
      return reject(new Error('Invalid redirect location URL: ' + targetUrl));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const headers = {
      'User-Agent': 'VectorEd-KnowledgeHub-Proxy/1.0'
    };

    let outboundMethod = method.toUpperCase();
    let payloadToSend = null;

    if (outboundMethod === 'POST' && postData !== null && postData !== undefined) {
      headers['Content-Type'] = 'text/plain;charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(postData, 'utf8');
      payloadToSend = postData;
    }

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: outboundMethod,
      headers: headers,
      timeout: REQUEST_TIMEOUT_MS
    };

    const req = client.request(options, (res) => {
      const statusCode = res.statusCode;

      // Handle redirect responses
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, targetUrl).href;

        // Determine method conversion per RFC HTTP specs
        let nextMethod = outboundMethod;
        let nextPayload = payloadToSend;

        if (statusCode === 301 || statusCode === 302 || statusCode === 303) {
          // Google Apps Script responds to POST with 302 Found, redirecting to a GET URL serving the ContentService JSON
          nextMethod = 'GET';
          nextPayload = null;
        } else if (statusCode === 307 || statusCode === 308) {
          // Maintain original method and payload
          nextMethod = outboundMethod;
          nextPayload = payloadToSend;
        }

        return resolve(requestWithRedirects(nextUrl, nextMethod, nextPayload, redirectCount + 1));
      }

      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });

      res.on('end', () => {
        resolve({
          statusCode: statusCode,
          headers: res.headers,
          body: responseBody
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Backend connection timed out (' + (REQUEST_TIMEOUT_MS / 1000) + 's limit).'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (payloadToSend) {
      req.write(payloadToSend);
    }
    req.end();
  });
}

exports.handler = async (event, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };

  // Handle browser CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ''
    };
  }

  // Handle health-check ping
  if (event.httpMethod === 'GET') {
    try {
      const pingUrl = `${APPS_SCRIPT_EXEC_URL}?action=ping`;
      const pingRes = await requestWithRedirects(pingUrl, 'GET', null);

      let parsed;
      try {
        parsed = JSON.parse(pingRes.body);
      } catch (e) {
        parsed = { raw: pingRes.body ? pingRes.body.slice(0, 200) : '' };
      }

      const isBackendHealthy = pingRes.statusCode === 200 && parsed && parsed.success === true;

      return {
        statusCode: isBackendHealthy ? 200 : 502,
        headers: corsHeaders,
        body: JSON.stringify({
          success: isBackendHealthy,
          status: isBackendHealthy ? 'online' : 'unhealthy',
          proxy: 'Netlify Function',
          backend: parsed
        })
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Backend health check failed: ' + err.message
        })
      };
    }
  }

  // Enforce POST method for all API operations
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Method Not Allowed. Only POST requests are accepted.'
      })
    };
  }

  // Request body validation
  if (!event.body) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Bad Request: Missing request body.'
      })
    };
  }

  const bodyLength = Buffer.byteLength(event.body, 'utf8');
  if (bodyLength > MAX_PAYLOAD_BYTES) {
    return {
      statusCode: 413,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Payload Too Large: Maximum allowed upload size through proxy is 4.5 MB.'
      })
    };
  }

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(event.body);
  } catch (err) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Bad Request: Malformed JSON payload.'
      })
    };
  }

  if (!parsedPayload || typeof parsedPayload.action !== 'string' || !parsedPayload.action.trim()) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Bad Request: Missing or invalid "action" field.'
      })
    };
  }

  try {
    // Forward serialized payload as text/plain to avoid Google Apps Script preflight issues
    const backendRes = await requestWithRedirects(APPS_SCRIPT_EXEC_URL, 'POST', event.body);

    let jsonResponse;
    try {
      jsonResponse = JSON.parse(backendRes.body);
    } catch (jsonErr) {
      // Catch Google error HTML pages or unexpected non-JSON output
      const preview = (backendRes.body || '').replace(/<[^>]*>/g, '').trim().slice(0, 300);
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: 'Invalid response from Google Apps Script. Expected JSON.',
          details: preview || 'Empty response received from backend.'
        })
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(jsonResponse)
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: 'Gateway Communication Error: ' + err.message
      })
    };
  }
};
