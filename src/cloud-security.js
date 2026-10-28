import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySlackRequest({ secret, body, timestamp, signature, now = Date.now() }) {
  if (!/^\d+$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  if (!/^v0=[0-9a-f]{64}$/.test(signature || '')) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function verifyTaskRequest({ authorization, verifier, audience, serviceAccount }) {
  if (!authorization?.startsWith('Bearer ')) return false;
  try {
    const ticket = await verifier.verifyIdToken({ idToken: authorization.slice(7), audience });
    const claims = ticket.getPayload();
    return claims?.email === serviceAccount && claims.email_verified === true;
  } catch {
    return false;
  }
}
