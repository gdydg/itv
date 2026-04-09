import http from 'node:http';
import { Readable } from 'node:stream';
import worker from './index.js';

function toHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, v));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

function buildUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || '127.0.0.1';
  return `${proto}://${host}${req.url || '/'}`;
}

function getBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  return Readable.toWeb(req);
}

function getEnv() {
  return {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    DEFAULT_ADMIN_USER: process.env.DEFAULT_ADMIN_USER,
    DEFAULT_ADMIN_PASS: process.env.DEFAULT_ADMIN_PASS,
    LINUXDO_CLIENT_ID: process.env.LINUXDO_CLIENT_ID,
    LINUXDO_CLIENT_SECRET: process.env.LINUXDO_CLIENT_SECRET,
    NODELOC_CLIENT_ID: process.env.NODELOC_CLIENT_ID,
    NODELOC_CLIENT_SECRET: process.env.NODELOC_CLIENT_SECRET,
    CRON_SECRET: process.env.CRON_SECRET
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const request = new Request(buildUrl(req), {
      method: req.method,
      headers: toHeaders(req.headers),
      body: getBody(req),
      duplex: 'half'
    });

    const response = await worker.fetch(request, getEnv(), { waitUntil() {} });

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    if (!response.body) {
      res.end();
      return;
    }

    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Internal Server Error');
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${port}`);
});
