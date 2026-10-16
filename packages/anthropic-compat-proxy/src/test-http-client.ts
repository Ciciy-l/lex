import { request } from 'node:http';

/** A real HTTP request owned by one test, never a pooled socket from a retired proxy. */
export function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(`${url}/v1/responses`, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'thread-id': 'thread-a',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('error', reject);
      res.once('aborted', () => reject(new Error('test HTTP response aborted')));
      res.once('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}
