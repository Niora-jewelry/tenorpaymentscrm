/**
 * A stand-in for Twilio's servers, for the browser suites only. Loaded into a local
 * server with NODE_OPTIONS=--require, it answers requests to twilio.com from inside
 * that process, so the real SDK runs and nothing reaches Twilio. Nothing in the app
 * imports it, and without the --require it does nothing.
 *
 * Every request is appended to FAKE_TWILIO_LOG as one JSON line. A number ending
 * 0199 is refused the way Twilio refuses one.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- loaded with node --require, so it has to be CommonJS */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

const LOG = process.env.FAKE_TWILIO_LOG;
let serial = 0;
const sid = (prefix) => `${prefix}fake${String(++serial).padStart(28, '0')}`;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    const host = req.headers['x-fake-host'];
    const path = (req.url ?? '').split('?')[0];
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), method: req.method, host, path, form }) + '\n');

    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === null ? '' : JSON.stringify(body));
    };
    if (Object.values(form).some((v) => String(v).endsWith('0199'))) {
      return send(400, { code: 21211, message: 'Fake Twilio refused this number', status: 400 });
    }
    if (req.method === 'DELETE') return send(204, null);
    if (path.endsWith('/Messages.json')) return send(201, { sid: sid('SM'), status: 'queued', to: form.To, from: form.From, body: form.Body });
    if (/\/Webhooks$/.test(path)) return send(201, { sid: sid('WH') });
    if (/\/Participants$/.test(path)) return send(201, { sid: sid('MB') });
    if (/\/Messages$/.test(path)) return send(201, { sid: sid('IM'), author: form.Author, body: form.Body });
    if (/\/Conversations$/.test(path)) return send(201, { sid: sid('CH'), friendly_name: form.FriendlyName, state: 'active' });
    if (/\/Conversations\/[^/]+$/.test(path)) return send(200, { sid: path.split('/').pop(), state: form.State });
    return send(404, { code: 20404, message: `Fake Twilio has no ${path}`, status: 404 });
  });
});
server.listen(0, '127.0.0.1');
server.unref();

const realRequest = https.request;
https.request = function request(...args) {
  const target = typeof args[0] === 'string' || args[0] instanceof URL ? new URL(args[0]) : args[0];
  const hostname = target.hostname ?? target.host ?? '';
  if (!String(hostname).endsWith('twilio.com')) return realRequest.apply(this, args);
  const options = args.find((a) => a && typeof a === 'object' && !(a instanceof URL)) ?? {};
  const callback = args.find((a) => typeof a === 'function');
  const path = target.path ?? `${target.pathname ?? '/'}${target.search ?? ''}`;
  return http.request(
    {
      method: options.method ?? 'GET',
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      headers: { ...(options.headers ?? {}), 'x-fake-host': String(hostname) },
    },
    callback,
  );
};
