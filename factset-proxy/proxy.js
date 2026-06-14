const express = require('express');
const app = express();

const SECRET = process.env.PROXY_SECRET;
const FACTSET_KEY = process.env.FACTSET_KEY; // base64(username:apikey)

if (!SECRET || !FACTSET_KEY) {
  console.error('PROXY_SECRET and FACTSET_KEY env vars are required');
  process.exit(1);
}

app.use(express.json());

app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.all('/factset/*', async (req, res) => {
  if (req.headers['x-proxy-secret'] !== SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const path = req.path.replace('/factset', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = `https://api.factset.com${path}${qs}`;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Basic ${FACTSET_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });

    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'upstream_error', detail: err.message });
  }
});

app.listen(3001, () => console.log('factset-proxy listening on :3001'));
