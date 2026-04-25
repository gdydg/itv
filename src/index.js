export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/play/')) return handlePlay(request, env, url);
    if (path === '/sub') return generateUserSubscription(request, env, url, 'm3u');
    if (path === '/sub/txt') return generateUserSubscription(request, env, url, 'txt');
    if (path === '/sub/tvbox') return generateUserSubscription(request, env, url, 'tvbox');

    if (path === '/api/cron' || path === '/api/cron/sync') return handleExternalCronSync(request, env, url);

    if (path.startsWith('/admin/api/')) {
      if (!await checkAuth(request, env)) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic' } });
      }
      return handleAdminAPI(request, env, url);
    }

    if (path === '/admin') {
      if (!await checkAuth(request, env)) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic' } });
      }
      return html(renderAdminPage());
    }

    if (path === '/api/auth/linuxdo') return handleLinuxDoAuth(env, url);
    if (path === '/api/auth/linuxdo/callback') return handleLinuxDoCallback(env, url);
    if (path === '/api/auth/nodeloc') return handleNodeLocAuth(env, url);
    if (path === '/api/auth/nodeloc/callback') return handleNodeLocCallback(env, url);

    if (path.startsWith('/api/user/')) return handleUserAPI(request, env, url);

    if (path === '/login') return html(renderLoginPage());
    if (path === '/') {
      const username = await getUserSession(request, env);
      if (!username) return Response.redirect(url.origin + '/login', 302);
      return html(renderUserDashboard(username));
    }

    return new Response('Not Found', { status: 404 });
  }
};

const DB_STORE_CACHE = new WeakMap();

function dbStore(env) {
  const cached = DB_STORE_CACHE.get(env);
  if (cached) return cached;
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Missing Upstash Redis env: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  }
  const redisStore = createRedisStore({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN
  });
  DB_STORE_CACHE.set(env, redisStore);
  return redisStore;
}

function createRedisStore(redisConfig) {
  const META_PREFIX = '__meta:exp:';

  async function command(args) {
    const baseUrl = redisConfig.url.replace(/\/$/, '');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + redisConfig.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args)
    });
    if (!res.ok) throw new Error('Upstash command failed: ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error('Upstash command error: ' + data.error);
    return data.result;
  }

  async function scanKeys(pattern) {
    const keys = [];
    let cursor = '0';
    do {
      const result = await command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', 200]);
      cursor = String(result[0]);
      keys.push(...result[1]);
    } while (cursor !== '0');
    return keys;
  }

  return {
    async get(key, type) {
      const raw = await command(['GET', key]);
      if (raw === null || raw === undefined) return null;
      if (type === 'json') {
        try {
          return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (_) {
          return null;
        }
      }
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    },

    async put(key, value, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      let expiration;
      if (options.expirationTtl) expiration = now + Number(options.expirationTtl);
      else if (options.expiration) expiration = Number(options.expiration);

      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      if (expiration && expiration > now) {
        await command(['SET', key, stringValue, 'EXAT', expiration]);
        await command(['SET', META_PREFIX + key, String(expiration), 'EXAT', expiration]);
      } else {
        await command(['SET', key, stringValue]);
        await command(['DEL', META_PREFIX + key]);
      }
    },

    async delete(key) {
      await command(['DEL', key]);
      await command(['DEL', META_PREFIX + key]);
    },

    async delMany(keys = []) {
      if (!keys.length) return;
      await Promise.all(keys.map((k) => this.delete(k)));
    },

    async ttl(key) {
      const expiration = await command(['GET', META_PREFIX + key]);
      if (!expiration) return -1;
      const remain = Number(expiration) - Math.floor(Date.now() / 1000);
      return remain > 0 ? remain : -2;
    },

    async expire(key, seconds) {
      const now = Math.floor(Date.now() / 1000);
      const expiration = now + Number(seconds);
      await command(['EXPIREAT', key, expiration]);
      await command(['SET', META_PREFIX + key, String(expiration), 'EXAT', expiration]);
    },

    async list(options = {}) {
      const prefix = options.prefix || '';
      const keys = (await scanKeys(prefix + '*')).sort();
      return {
        keys: await Promise.all(keys.map(async (name) => {
          const expiration = await command(['GET', META_PREFIX + name]);
          return { name, expiration: expiration ? Number(expiration) : undefined };
        }))
      };
    }
  };
}

function html(content) {
  return new Response(content, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function getOrigin(request, fallbackUrl) {
  const host = request.headers.get('host');
  if (host) return `https://${host}`;
  return fallbackUrl.origin;
}

function decodeCookieSession(cookieHeader) {
  const match = (cookieHeader || '').match(/session_id=([^;]+)/);
  return match ? match[1] : null;
}

function safeJsonParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

async function getUserSession(request, env) {
  const sessionId = decodeCookieSession(request.headers.get('Cookie') || '');
  if (!sessionId) return null;
  return dbStore(env).get('session:' + sessionId);
}

async function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  const [scheme, encoded] = authHeader.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;

  const decoded = atob(encoded);
  const [user, pass] = decoded.split(':');
  const expectedUser = await dbStore(env).get('config:admin_user') || env.DEFAULT_ADMIN_USER || 'admin';
  const expectedPass = await dbStore(env).get('config:admin_pass') || env.DEFAULT_ADMIN_PASS || 'admin123';
  return user === expectedUser && pass === expectedPass;
}

async function getAuthorizedChannels(env, token) {
  const channels = safeJsonParse(await dbStore(env).get('data:channels'), []);
  const groupsStr = (await dbStore(env).get('token_groups:' + token)) || '*';
  if (groupsStr === '*') return channels;
  const allowedGroups = groupsStr.split(',').map((g) => g.trim()).filter(Boolean);
  return channels.filter((c) => allowedGroups.includes(c.sourceGroup || '默认'));
}

async function handleExternalCronSync(request, env, url) {
  const key = url.searchParams.get('key') || request.headers.get('x-cron-key') || '';
  const expectedKey = env.CRON_SECRET || 'my-secret-cron-key';
  if (key !== expectedKey) return Response.json({ success: false, msg: 'Invalid Cron Key' }, { status: 401 });

  const result = await updateM3USource(env);
  return Response.json(result, { status: result.success ? 200 : 500 });
}

function handleLinuxDoAuth(env, url) {
  if (!env.LINUXDO_CLIENT_ID) return new Response('未配置 LINUXDO_CLIENT_ID', { status: 500 });
  const redirectUri = url.origin + '/api/auth/linuxdo/callback';
  const authUrl = 'https://connect.linux.do/oauth2/authorize' +
    '?client_id=' + env.LINUXDO_CLIENT_ID +
    '&response_type=code' +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&state=' + crypto.randomUUID();
  return Response.redirect(authUrl, 302);
}

async function handleLinuxDoCallback(env, url) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('Authorization Failed', { status: 400 });
  const redirectUri = url.origin + '/api/auth/linuxdo/callback';

  try {
    const tokenRes = await fetch('https://connect.linux.do/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.LINUXDO_CLIENT_ID,
        client_secret: env.LINUXDO_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });
    if (!tokenRes.ok) throw new Error('Failed to fetch access token');
    const tokenData = await tokenRes.json();

    const userRes = await fetch('https://connect.linux.do/api/user', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    if (!userRes.ok) throw new Error('Failed to fetch user info');
    const userData = await userRes.json();

    const sessionId = crypto.randomUUID();
    await dbStore(env).put('session:' + sessionId, 'linuxdo_' + userData.username, { expirationTtl: 604800 });
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Set-Cookie': `session_id=${sessionId}; Path=/; Max-Age=604800; HttpOnly` }
    });
  } catch (err) {
    return new Response('OAuth Error: ' + err.message, { status: 500 });
  }
}

function handleNodeLocAuth(env, url) {
  if (!env.NODELOC_CLIENT_ID) return new Response('未配置 NODELOC_CLIENT_ID', { status: 500 });
  const redirectUri = url.origin + '/api/auth/nodeloc/callback';
  const authUrl = 'https://www.nodeloc.com/oauth-provider/authorize' +
    '?client_id=' + env.NODELOC_CLIENT_ID +
    '&response_type=code' +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&state=' + crypto.randomUUID();
  return Response.redirect(authUrl, 302);
}

async function handleNodeLocCallback(env, url) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('Authorization Failed', { status: 400 });
  const redirectUri = url.origin + '/api/auth/nodeloc/callback';

  try {
    const tokenRes = await fetch('https://www.nodeloc.com/oauth-provider/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: env.NODELOC_CLIENT_ID,
        client_secret: env.NODELOC_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });
    if (!tokenRes.ok) throw new Error('Failed to fetch access token');
    const tokenData = await tokenRes.json();

    const userRes = await fetch('https://www.nodeloc.com/oauth-provider/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token, Accept: 'application/json' }
    });
    if (!userRes.ok) throw new Error('Failed to fetch user info');
    const userData = await userRes.json();

    let rawUsername = userData.username || userData.preferred_username || userData.name || userData.sub || ('user_' + Math.random().toString(36).slice(2, 7));
    if (userData.data?.attributes?.username) rawUsername = userData.data.attributes.username;

    const sessionId = crypto.randomUUID();
    await dbStore(env).put('session:' + sessionId, 'nodeloc_' + rawUsername, { expirationTtl: 604800 });
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Set-Cookie': `session_id=${sessionId}; Path=/; Max-Age=604800; HttpOnly` }
    });
  } catch (err) {
    return new Response('NodeLoc OAuth Error: ' + err.message, { status: 500 });
  }
}

async function handlePlay(request, env, url) {
  const token = url.searchParams.get('token');
  const channelId = url.pathname.replace('/play/', '').replace(/\/$/, '');
  if (!token) return new Response('Missing Token', { status: 401 });

  const limitStr = await dbStore(env).get('token:' + token);
  if (limitStr === null) return new Response('Invalid Token or Expired', { status: 403 });

  const limit = parseInt(limitStr || '0', 10);
  const clientIP = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || '127.0.0.1';

  if (limit > 0) {
    let ips = safeJsonParse(await dbStore(env).get('ips:' + token), []);
    if (!Array.isArray(ips)) ips = [];
    if (!ips.includes(clientIP)) {
      if (ips.length >= limit) {
        return new Response('Security Triggered: IP limit exceeded. Please go to dashboard to reset IPs.', { status: 403 });
      }
      ips.push(clientIP);
      await dbStore(env).put('ips:' + token, ips);
    }
  }

  const channels = await getAuthorizedChannels(env, token);
  const target = channels.find((c) => c.id === channelId);
  if (!target) return new Response('Channel Not Found or Unauthorized', { status: 404 });

  return new Response(null, {
    status: 302,
    headers: {
      Location: target.url,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0'
    }
  });
}

async function generateUserSubscription(request, env, url, format = 'm3u') {
  const token = url.searchParams.get('token');
  if (!token) return new Response('Missing Token', { status: 401 });

  const isValid = await dbStore(env).get('token:' + token);
  if (isValid === null) return new Response('Invalid Token or Expired', { status: 403 });

  const channels = await getAuthorizedChannels(env, token);
  let hiddenGroups = safeJsonParse(await dbStore(env).get('token_hidden_groups:' + token), []);
  if (!Array.isArray(hiddenGroups)) hiddenGroups = [];

  const origin = getOrigin(request, url);

  if (format === 'tvbox') {
    return Response.json({
      lives: [{ name: '自建专属 IPTV', type: 0, url: `${origin}/sub/txt?token=${token}`, epg: '' }]
    });
  }

  if (format === 'txt') {
    const grouped = {};
    channels.forEach((c) => {
      if (hiddenGroups.includes(c.group)) return;
      const group = c.group || '未分类';
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(c);
    });

    let txt = '';
    for (const group in grouped) {
      txt += `${group},#genre#\n`;
      grouped[group].forEach((c) => {
        txt += `${c.name},${origin}/play/${c.id}?token=${token}\n`;
      });
    }
    return new Response(txt, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  let m3u = '#EXTM3U\n';
  channels.forEach((c) => {
    if (hiddenGroups.includes(c.group)) return;
    m3u += `#EXTINF:-1 tvg-logo="${c.logo || ''}" group-title="${c.group || '未分类'}",${c.name}\n`;
    m3u += `${origin}/play/${c.id}?token=${token}\n`;
  });

  return new Response(m3u, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
}

async function handleUserAPI(request, env, url) {
  const route = url.pathname.replace('/api/user/', '');

  if (request.method === 'POST' && route === 'register') {
    const body = await request.json();
    if (!body.username || !body.password) return Response.json({ success: false, msg: '缺少账密' });
    if (await dbStore(env).get('user:' + body.username)) return Response.json({ success: false, msg: '用户名已存在' });
    await dbStore(env).put('user:' + body.username, body.password);
    return Response.json({ success: true });
  }

  if (request.method === 'POST' && route === 'login') {
    const body = await request.json();
    const storedPass = await dbStore(env).get('user:' + body.username);
    if (!storedPass || storedPass !== body.password) return Response.json({ success: false, msg: '账号或密码错误' });
    const sessionId = crypto.randomUUID();
    await dbStore(env).put('session:' + sessionId, body.username, { expirationTtl: 604800 });
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `session_id=${sessionId}; Path=/; Max-Age=604800; HttpOnly`
      }
    });
  }

  if (request.method === 'GET' && route === 'announcement') {
    return Response.json({ announcement: (await dbStore(env).get('config:announcement')) || '' });
  }

  const username = await getUserSession(request, env);
  if (!username) return Response.json({ success: false, msg: '未登录' }, { status: 401 });

  if (request.method === 'GET' && route === 'tokens') {
    let list = safeJsonParse(await dbStore(env).get('user_tokens:' + username), []);
    if (!Array.isArray(list)) list = [];

    const result = [];
    for (const t of list) {
      const limitStr = await dbStore(env).get('token:' + t);
      if (limitStr !== null) {
        const ips = safeJsonParse(await dbStore(env).get('ips:' + t), []);
        const ttlSeconds = await dbStore(env).ttl('token:' + t);
        const notice = await dbStore(env).get('token_notice:' + t) || '';

        let expireText = '永久有效';
        if (ttlSeconds > 0) {
          expireText = new Date(Date.now() + ttlSeconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        }
        result.push({ token: t, limit: parseInt(limitStr, 10), used: Array.isArray(ips) ? ips.length : 0, expireText, notice });
      }
    }
    return Response.json(result);
  }

  if (request.method === 'POST' && route === 'bind') {
    const body = await request.json();
    const token = body.token;
    const tokenExists = await dbStore(env).get('token:' + token);
    if (tokenExists === null) return Response.json({ success: false, msg: '无效的或已过期的 Token' });

    const owner = await dbStore(env).get('owner:' + token);
    if (owner && owner !== username) return Response.json({ success: false, msg: '该 Token 已被其他用户绑定' });

    if (!owner) {
      await dbStore(env).put('owner:' + token, username);
      const durationHours = await dbStore(env).get('token_duration:' + token);
      if (durationHours) {
        const seconds = Math.max(60, Number(durationHours) * 3600);
        await dbStore(env).expire('token:' + token, seconds);
        await dbStore(env).delete('token_duration:' + token);
      }
    }

    let list = safeJsonParse(await dbStore(env).get('user_tokens:' + username), []);
    if (!Array.isArray(list)) list = [];
    if (!list.includes(token)) {
      list.push(token);
      await dbStore(env).put('user_tokens:' + username, list);
    }

    return Response.json({ success: true, notice: (await dbStore(env).get('token_notice:' + token)) || '' });
  }

  if (request.method === 'POST' && route === 'reset_ip') {
    const body = await request.json();
    if ((await dbStore(env).get('owner:' + body.token)) !== username) return Response.json({ success: false, msg: '无权操作' });
    await dbStore(env).put('ips:' + body.token, []);
    return Response.json({ success: true });
  }

  if (request.method === 'GET' && route === 'token_groups') {
    try {
      const token = url.searchParams.get('token');
      if ((await dbStore(env).get('owner:' + token)) !== username) return Response.json({ success: false, msg: '无权操作' });

      const channels = await getAuthorizedChannels(env, token);
      const groups = [...new Set(channels.map((c) => c.group || '未分类'))];
      let hiddenGroups = safeJsonParse(await dbStore(env).get('token_hidden_groups:' + token), []);
      if (!Array.isArray(hiddenGroups)) hiddenGroups = [];
      return Response.json({ success: true, groups, hiddenGroups });
    } catch (err) {
      return Response.json({ success: false, msg: '后端解析遇到错误，请查看控制台日志' }, { status: 500 });
    }
  }

  if (request.method === 'POST' && route === 'token_groups') {
    const body = await request.json();
    if ((await dbStore(env).get('owner:' + body.token)) !== username) return Response.json({ success: false, msg: '无权操作' });
    await dbStore(env).put('token_hidden_groups:' + body.token, JSON.stringify(body.hiddenGroups || []));
    return Response.json({ success: true });
  }

  if (request.method === 'POST' && route === 'logout') {
    const sessionId = decodeCookieSession(request.headers.get('Cookie') || '');
    if (sessionId) await dbStore(env).delete('session:' + sessionId);
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
      }
    });
  }

  return new Response('Not Found', { status: 404 });
}

async function handleAdminAPI(request, env, url) {
  const route = url.pathname.replace('/admin/api/', '');

  if (request.method === 'GET' && route === 'status') {
    const sourceUrl = await dbStore(env).get('config:source_url') || '';
    const announcement = await dbStore(env).get('config:announcement') || '';
    const channels = safeJsonParse(await dbStore(env).get('data:channels'), []);
    return Response.json({ sourceUrl, announcement, channelCount: channels.length });
  }

  if (request.method === 'POST' && route === 'sync') {
    return Response.json(await updateM3USource(env));
  }

  if (request.method === 'POST' && route === 'config') {
    const body = await request.json();
    await dbStore(env).put('config:source_url', body.sourceUrl || '');
    return Response.json({ success: true });
  }

  if (request.method === 'POST' && route === 'announcement') {
    const body = await request.json();
    await dbStore(env).put('config:announcement', body.announcement || '');
    return Response.json({ success: true });
  }

  if (request.method === 'GET' && route === 'tokens') {
    const list = await dbStore(env).list({ prefix: 'token:' });
    const tokens = await Promise.all(list.keys.map(async (k) => {
      const t = k.name.replace('token:', '');
      const limit = await dbStore(env).get(k.name);
      const ips = safeJsonParse(await dbStore(env).get('ips:' + t), []);
      const owner = await dbStore(env).get('owner:' + t) || '未绑定';
      const groups = await dbStore(env).get('token_groups:' + t) || '*';
      const notice = await dbStore(env).get('token_notice:' + t) || '';

      let expireText = '永久有效';
      if (k.expiration) {
        expireText = new Date(k.expiration * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      } else {
        const durationHours = await dbStore(env).get('token_duration:' + t);
        if (durationHours && owner === '未绑定') expireText = `绑定后 ${durationHours} 小时失效`;
      }

      return {
        token: t,
        limit: parseInt(limit || '0', 10),
        used: Array.isArray(ips) ? ips.length : 0,
        ips: Array.isArray(ips) ? ips : [],
        expireText,
        owner,
        groups,
        notice
      };
    }));
    return Response.json(tokens);
  }

  if (request.method === 'POST' && route === 'token') {
    const body = await request.json();
    const limitVal = body.limit === '' ? '0' : String(body.limit);
    await dbStore(env).put('token:' + body.token, limitVal);
    await dbStore(env).put('token_groups:' + body.token, body.groups || '*');
    await dbStore(env).put('token_notice:' + body.token, body.notice || '');

    if (body.expireHours && Number(body.expireHours) > 0) {
      await dbStore(env).put('token_duration:' + body.token, String(body.expireHours));
    } else {
      await dbStore(env).delete('token_duration:' + body.token);
    }
    return Response.json({ success: true });
  }

  if (request.method === 'DELETE' && route === 'token') {
    const body = await request.json();
    await dbStore(env).delMany([
      'token:' + body.token,
      'ips:' + body.token,
      'owner:' + body.token,
      'token_duration:' + body.token,
      'token_groups:' + body.token,
      'token_notice:' + body.token,
      'token_hidden_groups:' + body.token
    ]);
    return Response.json({ success: true });
  }

  if (request.method === 'POST' && route === 'reset_ip') {
    const body = await request.json();
    await dbStore(env).put('ips:' + body.token, []);
    return Response.json({ success: true });
  }

  return new Response('Not Found', { status: 404 });
}

function generateFixedId(group, name, url) {
  let stableUrl = url;
  const safeName = name || '未命名';
  const safeGroup = group || '默认';

  try {
    const u = new URL(url);
    const dynamicParams = ['txSecret', 'txTime', 't', 'token', 'sign', 'auth_key', 'expire', 'md5', 'wsSecret', 'wsTime', 'session', 'sid', 'uuid', 'v'];
    dynamicParams.forEach((p) => u.searchParams.delete(p));
    stableUrl = u.toString();
  } catch (_) {
    stableUrl = url.split('?')[0];
  }

  const str = `${safeGroup}_${safeName}_${stableUrl}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  }
  return 'ch_' + Math.abs(hash).toString(36);
}

function parseM3U(content) {
  const lines = content.split('\n');
  const channels = [];
  let info = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      const nameMatch = line.match(/,(.+)$/);
      const logoMatch = line.match(/tvg-logo="([^"]+)"/);
      const groupMatch = line.match(/group-title="([^"]+)"/);
      info = {
        name: nameMatch ? nameMatch[1].trim() : 'Channel ' + i,
        logo: logoMatch ? logoMatch[1] : '',
        group: groupMatch ? groupMatch[1] : 'Default'
      };
    } else if (line.startsWith('http')) {
      channels.push({
        id: generateFixedId(info.group, info.name, line),
        url: line,
        name: info.name,
        logo: info.logo,
        group: info.group
      });
      info = {};
    }
  }
  return channels;
}

async function updateM3USource(env) {
  const sourceUrlsStr = await dbStore(env).get('config:source_url');
  if (!sourceUrlsStr) return { success: false, msg: 'No source URL configured' };

  const lines = sourceUrlsStr.split(/[\n,]+/).map((u) => u.trim()).filter(Boolean);
  if (!lines.length) return { success: false, msg: 'No valid URLs found in config' };

  let allChannels = [];
  const errors = [];

  for (const line of lines) {
    let sourceGroup = '默认';
    let sourceUrl = line;

    if (line.includes('|')) {
      const idx = line.indexOf('|');
      sourceGroup = line.slice(0, idx).trim();
      sourceUrl = line.slice(idx + 1).trim();
    }

    try {
      const res = await fetch(sourceUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const channels = parseM3U(text);
      channels.forEach((c) => {
        c.sourceGroup = sourceGroup;
      });
      allChannels = allChannels.concat(channels);
    } catch (err) {
      errors.push(`Failed to fetch ${sourceUrl}: ${err.message}`);
    }
  }

  const seenIds = new Set();
  const uniqueChannels = allChannels.filter((ch) => {
    if (seenIds.has(ch.id)) return false;
    seenIds.add(ch.id);
    return true;
  });

  if (uniqueChannels.length > 0) {
    await dbStore(env).put('data:channels', uniqueChannels);
    return {
      success: true,
      count: uniqueChannels.length,
      msg: errors.length ? `部分成功, 抓取 ${uniqueChannels.length} 频道。错误: ${errors.join('; ')}` : `全部抓取成功, 共 ${uniqueChannels.length} 个频道`
    };
  }

  return { success: false, msg: '所有源均未找到有效频道。错误信息: ' + errors.join('; ') };
}

function renderLoginPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>系统登录/注册</title>
  <style>body{font-family:system-ui;background:#f4f4f5;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.1);width:300px;text-align:center}input{width:100%;padding:10px;margin:10px 0;border:1px solid #ddd;border-radius:4px;box-sizing:border-box}button{color:#fff;border:none;padding:10px;border-radius:4px;cursor:pointer;width:100%;margin-top:10px;font-weight:700}.btn-login{background:#3b82f6}.btn-reg{background:#10b981}.oauth-btn{margin-top:15px;display:flex;align-items:center;justify-content:center;gap:8px;font-weight:400}.btn-linuxdo{background:#232323}.btn-nodeloc{background:#007bff}.divider{margin:20px 0;color:#999;font-size:14px;display:flex;align-items:center}.divider::before,.divider::after{content:"";flex:1;border-bottom:1px solid #eee}.divider::before{margin-right:10px}.divider::after{margin-left:10px}</style>
  </head><body><div class="card"><h2>订阅系统</h2><input type="text" id="user" placeholder="用户名"><input type="password" id="pass" placeholder="密码"><button class="btn-login" onclick="doAction('login')">登录</button><button class="btn-reg" onclick="doAction('register')">注册新账号</button><div class="divider">或者</div><button class="oauth-btn btn-linuxdo" onclick="window.location.href='/api/auth/linuxdo'">使用 Linux DO 登录</button><button class="oauth-btn btn-nodeloc" onclick="window.location.href='/api/auth/nodeloc'">使用 NodeLoc 登录</button></div>
  <script>async function doAction(action){const u=document.getElementById('user').value;const p=document.getElementById('pass').value;if(!u||!p)return alert('请输入账密');const res=await fetch('/api/user/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const data=await res.json();if(data.success){if(action==='register')alert('注册成功，请登录！');else window.location.href='/'}else alert(data.msg)}</script></body></html>`;
}

function renderUserDashboard(username) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>用户控制台</title>
  <style>body{font-family:system-ui;background:#f9fafb;margin:0;padding:20px}.container{max-width:1000px;margin:auto}.card{background:#fff;padding:20px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);margin-bottom:20px}.notice-card{background:#eff6ff;border-left:4px solid #3b82f6;color:#1e3a8a}input{padding:8px;border:1px solid #ddd;border-radius:4px}button{background:#3b82f6;color:#fff;border:none;padding:8px 12px;border-radius:4px;cursor:pointer;font-size:12px;margin-bottom:4px}.warning{background:#f59e0b}.btn-manage{background:#6366f1}table{width:100%;border-collapse:collapse;margin-top:15px;font-size:14px}th,td{padding:10px;text-align:left;border-bottom:1px solid #ddd}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.copy-group{display:flex;flex-wrap:wrap;gap:5px}.btn-m3u{background:#10b981}.btn-txt{background:#8b5cf6}.btn-tvb{background:#ec4899}.notice-text{font-size:12px;color:#854d0e;background:#fef08a;padding:4px 8px;border-radius:4px;display:inline-block;margin-top:4px}</style>
  </head><body><div class="container"><div class="header"><h1>欢迎回来, ${username}</h1><button class="warning" onclick="logout()" style="font-size:14px;">退出登录</button></div>
  <div id="noticeBox" class="card notice-card" style="display:none;"><h3>🔔 系统通知</h3><div id="noticeContent"></div></div>
  <div class="card"><h2>绑定新 Token</h2><div style="display:flex;gap:10px;"><input type="text" id="bindToken" placeholder="输入 Token" style="flex:1;"><button onclick="bind()" style="font-size:14px;">立即绑定</button></div></div>
  <div class="card" style="overflow-x:auto;"><h2>我的订阅列表</h2><table><thead><tr><th>Token</th><th>状态/限制</th><th>过期时间</th><th>管理员注意事项</th><th>复制订阅链接</th><th>操作</th></tr></thead><tbody id="list"></tbody></table></div>
  <div id="groupModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);align-items:center;justify-content:center;z-index:1000"><div style="background:#fff;padding:20px;border-radius:8px;width:400px;max-width:90%;max-height:80vh;display:flex;flex-direction:column"><h3 style="margin-top:0">隐藏分组管理</h3><div id="groupList" style="flex:1;overflow-y:auto;margin-bottom:15px;border:1px solid #ddd;padding:10px;border-radius:4px;display:flex;flex-direction:column;gap:8px;">加载中...</div><div style="display:flex;justify-content:flex-end;gap:10px;"><button onclick="closeGroupModal()" style="background:#6b7280;font-size:14px;">取消</button><button onclick="saveGroups()" style="font-size:14px;">保存设置</button></div></div></div>
  </div><script>
  let currentManageToken='';
  async function loadNotice(){const r=await fetch('/api/user/announcement');const d=await r.json();if(d.announcement&&d.announcement.trim()!==''){document.getElementById('noticeContent').innerHTML=d.announcement.replace(/\\n/g,'<br>');document.getElementById('noticeBox').style.display='block';}}
  async function loadData(){const res=await fetch('/api/user/tokens');const data=await res.json();const tbody=document.getElementById('list');let html='';data.forEach(t=>{const limitTxt=t.limit===0?'无限 IP':(t.used+' / '+t.limit+' IP');const sub=window.location.origin+'/sub?token='+t.token;const txt=window.location.origin+'/sub/txt?token='+t.token;const tvb=window.location.origin+'/sub/tvbox?token='+t.token;const notice=t.notice?'<span class="notice-text">'+t.notice+'</span>':'-';html+='<tr><td>'+t.token+'</td><td>'+limitTxt+'</td><td>'+t.expireText+'</td><td>'+notice+'</td><td><div class="copy-group"><button class="btn-m3u" onclick="copy(\\''+sub+'\\')">复制 M3U</button><button class="btn-txt" onclick="copy(\\''+txt+'\\')">复制 TXT</button><button class="btn-tvb" onclick="copy(\\''+tvb+'\\')">复制 TVBox</button></div></td><td><button class="btn-manage" onclick="openGroupModal(\\''+t.token+'\\')">隐藏分组</button><button class="warning" onclick="resetIp(\\''+t.token+'\\')">解除封锁</button></td></tr>';});tbody.innerHTML=html;}
  async function bind(){const token=document.getElementById('bindToken').value;if(!token)return;const res=await fetch('/api/user/bind',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});const data=await res.json();if(data.success){alert('绑定成功！'+(data.notice?'\\n\\n管理员注意事项：\\n'+data.notice:''));document.getElementById('bindToken').value='';loadData();}else alert(data.msg)}
  async function resetIp(token){await fetch('/api/user/reset_ip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});alert('已重置该 Token 的 IP 记录');loadData();}
  async function logout(){await fetch('/api/user/logout',{method:'POST'});window.location.href='/login';}
  function copy(text){navigator.clipboard.writeText(text).then(()=>alert('已复制链接！\\n\\n'+text));}
  async function openGroupModal(token){currentManageToken=token;document.getElementById('groupModal').style.display='flex';document.getElementById('groupList').innerHTML='加载中...';const res=await fetch('/api/user/token_groups?token='+token);const data=await res.json();if(!data.success){document.getElementById('groupList').innerHTML='<div style="color:red">'+data.msg+'</div>';return;}let html='';if(!data.groups.length){html='<div style="color:#666;text-align:center;">暂无可用分组</div>';}else{data.groups.forEach(g=>{const hidden=data.hiddenGroups.includes(g);html+='<label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" class="group-checkbox" value="'+g+'" '+(hidden?'checked':'')+'>'+g+'</label>';});}document.getElementById('groupList').innerHTML=html;}
  function closeGroupModal(){document.getElementById('groupModal').style.display='none';currentManageToken='';}
  async function saveGroups(){if(!currentManageToken)return;const checks=document.querySelectorAll('.group-checkbox');const hiddenGroups=[];checks.forEach(cb=>{if(cb.checked)hiddenGroups.push(cb.value);});const res=await fetch('/api/user/token_groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:currentManageToken,hiddenGroups})});const data=await res.json();if(data.success){alert('保存成功！');closeGroupModal();}else alert(data.msg);}
  loadNotice();loadData();
  </script></body></html>`;
}

function renderAdminPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>管理后台</title>
  <style>body{font-family:system-ui;background:#f9fafb;margin:0;padding:20px}.container{max-width:1000px;margin:auto}.card{background:#fff;padding:20px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);margin-bottom:20px}input,textarea{padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box}button{background:#10b981;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer}.danger{background:#ef4444}.warning{background:#f59e0b}.blue{background:#3b82f6}table{width:100%;border-collapse:collapse;margin-top:15px;font-size:14px}th,td{padding:10px;text-align:left;border-bottom:1px solid #ddd}.badge{background:#e0e7ff;color:#3730a3;padding:2px 6px;border-radius:4px;font-size:12px}</style>
  </head><body><div class="container"><h1>管理后台</h1>
  <div class="card"><h2>1. 系统通知管理</h2><textarea id="adminAnnouncement" rows="3" style="width:100%;margin-bottom:10px;"></textarea><br><button class="blue" onclick="saveAnnouncement()">发布 / 更新通知</button><button class="danger" onclick="clearAnnouncement()" style="margin-left:10px;">清空通知</button></div>
  <div class="card"><h2>2. 原始直播源配置</h2><p>有效去重频道数 <span id="chCount" style="font-weight:bold;color:#10b981;">0</span></p><textarea id="sourceUrl" rows="4" style="width:100%;margin-bottom:10px;"></textarea><br><button onclick="saveConfig()">保存源配置</button><button class="blue" onclick="syncM3U()" style="margin-left:10px;">立即抓取/更新</button></div>
  <div class="card" style="overflow-x:auto;"><h2>3. Token 管理</h2><div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;"><input id="newToken" placeholder="生成新 Token" style="flex:1;min-width:150px;"><input type="number" id="newLimit" placeholder="IP限制(0为无限)" value="3" style="width:120px;"><input type="number" id="expireHours" placeholder="有效期(小时)" style="width:120px;"><input id="tokenGroups" placeholder="授权分组" style="flex:1;min-width:150px;" value="*"><input id="tokenNotice" placeholder="注意事项/留言" style="flex:1.5;min-width:200px;"><button onclick="addToken()" style="width:80px;">生成</button></div>
  <table><thead><tr><th>Token</th><th>归属用户</th><th>IP 状态</th><th>授权分组</th><th>注意事项</th><th>过期时间</th><th>操作</th></tr></thead><tbody id="tokenList"></tbody></table></div>
  </div><script>
  async function loadData(){const status=await (await fetch('/admin/api/status')).json();document.getElementById('sourceUrl').value=status.sourceUrl;document.getElementById('adminAnnouncement').value=status.announcement||'';document.getElementById('chCount').innerText=status.channelCount;const tokens=await (await fetch('/admin/api/tokens')).json();let html='';tokens.forEach(t=>{const limitTxt=t.limit===0?'无限':(t.used+'/'+t.limit);const groups=t.groups==='*'?'<span class="badge" style="background:#dcfce7;color:#166534;">全部源</span>':'<span class="badge">'+t.groups+'</span>';const notice=t.notice||'-';html+='<tr><td>'+t.token+'</td><td>'+t.owner+'</td><td><span title="'+t.ips.join(', ')+'">'+limitTxt+'</span></td><td>'+groups+'</td><td>'+notice+'</td><td>'+t.expireText+'</td><td><button class="warning" onclick="resetIp(\\''+t.token+'\\')" style="margin-right:5px;padding:4px 8px;font-size:12px;">清IP</button><button class="danger" onclick="delToken(\\''+t.token+'\\')" style="padding:4px 8px;font-size:12px;">删</button></td></tr>';});document.getElementById('tokenList').innerHTML=html;}
  async function saveAnnouncement(){const announcement=document.getElementById('adminAnnouncement').value;await fetch('/admin/api/announcement',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({announcement})});alert('通知更新成功！');}
  async function clearAnnouncement(){document.getElementById('adminAnnouncement').value='';await saveAnnouncement();}
  async function saveConfig(){const sourceUrl=document.getElementById('sourceUrl').value;await fetch('/admin/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceUrl})});alert('源配置保存成功');}
  async function syncM3U(){const res=await fetch('/admin/api/sync',{method:'POST'});const data=await res.json();alert(data.success?data.msg:('失败: '+data.msg));loadData();}
  async function addToken(){const token=document.getElementById('newToken').value;if(!token)return alert('请输入 Token');const limit=document.getElementById('newLimit').value;const expireHours=document.getElementById('expireHours').value;const groups=document.getElementById('tokenGroups').value||'*';const notice=document.getElementById('tokenNotice').value||'';await fetch('/admin/api/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,limit,expireHours,groups,notice})});document.getElementById('newToken').value='';document.getElementById('tokenNotice').value='';loadData();}
  async function delToken(token){if(!confirm('确定删除吗？'))return;await fetch('/admin/api/token',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});loadData();}
  async function resetIp(token){await fetch('/admin/api/reset_ip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});loadData();}
  loadData();
  </script></body></html>`;
}
