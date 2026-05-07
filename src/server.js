import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import worker from './index.js';

function parseRedisUrl(redisUrl, options = {}) {
  const url = new URL(redisUrl);
  const forceTls = options.forceTls === true;
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1) || 0) : 0,
    tls: forceTls || url.protocol === 'rediss:'
  };
}

function createRedisClient(redisUrl, options = {}) {
  const conf = parseRedisUrl(redisUrl, options);
  let socket;
  let buffer = Buffer.alloc(0);
  const queue = [];
  let fallbackToPlainTried = false;

  function encodeCommand(args) {
    let out = `*${args.length}\r\n`;
    for (const arg of args) {
      const value = String(arg);
      out += `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
    }
    return Buffer.from(out);
  }

  function readLine(start) {
    const idx = buffer.indexOf('\r\n', start);
    if (idx === -1) return null;
    return { line: buffer.subarray(start, idx).toString(), next: idx + 2 };
  }

  function parseAt(pos = 0) {
    if (buffer.length <= pos) return null;
    const type = String.fromCharCode(buffer[pos]);
    if (type === '+' || type === '-' || type === ':') {
      const line = readLine(pos + 1);
      if (!line) return null;
      if (type === ':') return { value: Number(line.line), next: line.next };
      if (type === '-') throw new Error(line.line);
      return { value: line.line, next: line.next };
    }
    if (type === '$') {
      const line = readLine(pos + 1);
      if (!line) return null;
      const len = Number(line.line);
      if (len === -1) return { value: null, next: line.next };
      const end = line.next + len;
      if (buffer.length < end + 2) return null;
      return { value: buffer.subarray(line.next, end).toString(), next: end + 2 };
    }
    if (type === '*') {
      const line = readLine(pos + 1);
      if (!line) return null;
      const count = Number(line.line);
      if (count === -1) return { value: null, next: line.next };
      const values = [];
      let next = line.next;
      for (let i = 0; i < count; i++) {
        const parsed = parseAt(next);
        if (!parsed) return null;
        values.push(parsed.value);
        next = parsed.next;
      }
      return { value: values, next };
    }
    throw new Error('Unknown Redis RESP type: ' + type);
  }

  function drain() {
    while (queue.length) {
      let parsed;
      try {
        parsed = parseAt(0);
      } catch (err) {
        queue.shift().reject(err);
        continue;
      }
      if (!parsed) return;
      buffer = buffer.subarray(parsed.next);
      queue.shift().resolve(parsed.value);
    }
  }

  async function connect() {
    if (socket && !socket.destroyed) return;
    const openSocket = (useTls) => (useTls
      ? tls.connect({ host: conf.host, port: conf.port, servername: conf.host })
      : net.createConnection({ host: conf.host, port: conf.port }));

    socket = openSocket(conf.tls);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      drain();
    });
    socket.on('error', (err) => {
      while (queue.length) queue.shift().reject(err);
    });
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
    } catch (err) {
      if (conf.tls && options.forceTls === true && !fallbackToPlainTried) {
        fallbackToPlainTried = true;
        try { socket.destroy(); } catch (_) {}
        conf.tls = false;
        return connect();
      }
      throw err;
    }
    const sendRaw = (args) => new Promise((resolve, reject) => {
      queue.push({ resolve, reject });
      socket.write(encodeCommand(args));
    });
    if (conf.password) {
      if (conf.username) await sendRaw(['AUTH', conf.username, conf.password]);
      else await sendRaw(['AUTH', conf.password]);
    }
    if (conf.db) await sendRaw(['SELECT', conf.db]);
  }

  async function command(args) {
    await connect();
    return new Promise((resolve, reject) => {
      queue.push({ resolve, reject });
      socket.write(encodeCommand(args));
    });
  }

  return { command };
}

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
  const dbType = (process.env.DB_TYPE || 'upstash').toLowerCase();
  const env = {
    DB_TYPE: dbType,
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
  if (dbType === 'redis' && process.env.REDIS_URL) {
    env.REDIS_CLIENT = createRedisClient(process.env.REDIS_URL, {
      forceTls: String(process.env.REDIS_TLS || '').toLowerCase() === 'true'
    });
  }
  return env;
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
