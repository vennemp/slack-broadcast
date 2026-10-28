import { createServer } from 'node:http';
import { verifySlackRequest, verifyTaskRequest } from './cloud-security.js';

const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

export function createCloudServer({ signingSecret, handleSlack, handleTask, verifier, serviceUrl, serviceAccount, logger = console }) {
  return createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health') return send(response, 200, { ok: true });
    if (request.method !== 'POST' || !['/slack/events', '/tasks/deliver'].includes(path)) return send(response, 404, { error: 'not_found' });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) return send(response, 413, { error: 'payload_too_large' });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (path === '/slack/events') {
        if (!verifySlackRequest({ secret: signingSecret, body, timestamp: request.headers['x-slack-request-timestamp'], signature: request.headers['x-slack-signature'] })) return send(response, 401, { error: 'invalid_signature' });
        let payload;
        if (request.headers['content-type']?.split(';')[0].trim() === 'application/json') payload = JSON.parse(body.toString('utf8'));
        else {
          const form = new URLSearchParams(body.toString('utf8'));
          payload = form.has('payload') ? JSON.parse(form.get('payload')) : Object.fromEntries(form);
        }
        return send(response, 200, await handleSlack(payload));
      }
      if (!await verifyTaskRequest({ authorization: request.headers.authorization, verifier, audience: serviceUrl, serviceAccount })) return send(response, 401, { error: 'invalid_identity' });
      const payload = JSON.parse(body.toString('utf8'));
      if (!/^[0-9a-f-]{36}$/.test(payload.id || '')) return send(response, 400, { error: 'invalid_job' });
      const result = await handleTask(payload.id);
      if (result.state === 'busy') return send(response, 503, { error: 'lease_active' });
      if (result.state === 'missing') return send(response, 404, { error: 'job_missing' });
      return send(response, 200, { ok: true });
    } catch (error) {
      logger.error(`Request failed: ${error.code || error.name || 'unknown_error'}`);
      return send(response, 500, { error: 'request_failed' });
    }
  });
}
