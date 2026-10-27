import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createAnthropicCompatProxy } from './server.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';

it('attributes native HTTP requests once across proxies while preserving explicit route headers and deletes', async () => {
  const captures: Array<{ headers: Record<string, string | string[] | undefined>; rawHeaders: string[]; body: string }> = [];
  const upstream = createServer(async (req, res) => {
    let body=''; for await (const chunk of req) body += chunk;
    captures.push({ headers: req.headers, rawHeaders: req.rawHeaders, body });
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n');
  });
  const port = await listenOnAvailableLoopbackPort(upstream);
  let route: { headerOverride?: Record<string, string>; headerDelete?: string[] } = {};
  const inner = await createAnthropicCompatProxy({ upstream: 'http://127.0.0.1:' + port, transformRequest: [], routingTransform: () => route });
  const outer = await createAnthropicCompatProxy({ upstream: inner.url, transformRequest: [] });
  const payload = JSON.stringify({ model: 'fixture', input: [{ role: 'user', content: 'same body' }] });
  const send = () => new Promise<void>((resolve, reject) => {
    const req = request(outer.url + '/responses', { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'User-Agent': 'native/7 (fixture)', originator: 'codex_cli_rs', authorization: 'Bearer fixture', 'chatgpt-account-id': 'synthetic-account' } }, res => {
      res.resume(); res.on('end', resolve); res.on('error', reject);
    }); req.on('error', reject); req.end(payload);
  });
  try {
    await send();
    expect(captures[0].headers).toMatchObject({ 'user-agent': 'native/7 (fixture) Lex', 'x-title': 'Lex', originator: 'codex_cli_rs', authorization: 'Bearer fixture' });
    route = { headerOverride: { 'User-Agent': 'explicit-client/2', 'X-TITLE': 'Selected app' }, headerDelete: ['Originator', 'ChatGPT-Account-Id'] };
    await send();
    expect(captures[1].headers['user-agent']).toBe('explicit-client/2');
    expect(captures[1].headers['x-title']).toBe('Selected app');
    expect(captures[1].headers.originator).toBeUndefined();
    expect(captures[1].headers['chatgpt-account-id']).toBeUndefined();
    route = { headerDelete: ['X-Title', 'User-Agent'] }; await send();
    expect(captures[2].headers['x-title']).toBeUndefined(); expect(captures[2].headers['user-agent']).toBeUndefined();
    for (const capture of captures) {
      expect(JSON.parse(capture.body)).toEqual(JSON.parse(payload));
      expect(capture.headers.authorization).toBe('Bearer fixture');
      for (const name of ['user-agent','x-title']) expect(capture.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()===name).length).toBeLessThanOrEqual(1);
    }
    expect(captures).toHaveLength(3);
    // Non-sensitive capture: no credentials or raw request content in output.
    process.stdout.write(JSON.stringify({ modelHeaderCaptures: captures.map(c=>({ userAgent:c.headers['user-agent'],title:c.headers['x-title'],originator:c.headers.originator,bodySha256:createHash('sha256').update(c.body).digest('hex') })) })+'\n');
  } finally { await outer.dispose(); await inner.dispose(); upstream.closeAllConnections(); await new Promise<void>(r=>upstream.close(()=>r())); }
});
