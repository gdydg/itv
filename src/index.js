export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- 1. 播放路由重定向 ---
    if (path.startsWith('/play/')) {
      return await handlePlay(request, env, url);
    }

    // --- 2. 获取订阅 ---
    if (path === '/sub') {
      return await generateUserSubscription(request, env, url, 'm3u');
    }

    if (path === '/sub/tvbox') {
      return await generateUserSubscription(request, env, url, 'tvbox');
    }

    if (path === '/sub/txt') {
      return await generateUserSubscription(request, env, url, 'txt');
    }

    // --- 3. 后台管理 API ---
    if (path.startsWith('/admin/api/')) {
      if (!await checkAuth(request, env)) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic' } });
      return await handleAdminAPI(request, env, url);
    }

    // --- 4. 后台管理页面 ---
    if (path === '/admin') {
      if (!await checkAuth(request, env)) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic' } });
      return new Response(renderAdminPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    // --- 5. OAuth2 登录路由 ---
    if (path === '/api/auth/linuxdo') return handleLinuxDoAuth(request, env, url);
    if (path === '/api/auth/linuxdo/callback') return await handleLinuxDoCallback(request, env, url);
    
    if (path === '/api/auth/nodeloc') return handleNodeLocAuth(request, env, url);
    if (path === '/api/auth/nodeloc/callback') return await handleNodeLocCallback(request, env, url);

    // --- 6. 用户端 API (注册/登录/看板操作) ---
    if (path.startsWith('/api/user/')) {
      return await handleUserAPI(request, env, url);
    }

    // --- 7. 用户前端页面路由 ---
    if (path === '/login') {
      return new Response(renderLoginPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }
    
    if (path === '/') {
      const username = await getUserSession(request, env);
      if (!username) return Response.redirect(url.origin + '/login', 302);
      return new Response(renderUserDashboard(username), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    await updateM3USource(env);
  }
};

const DB_STORE_CACHE = new WeakMap();

function dbStore(env) {
  const cached = DB_STORE_CACHE.get(env);
  if (cached) return cached;

  if (!env.IPTV_DB) {
    throw new Error('Missing D1 binding: IPTV_DB');
  }

  const d1Store = createD1Store(env.IPTV_DB);
  DB_STORE_CACHE.set(env, d1Store);
  return d1Store;
}

function createD1Store(db) {
  let initialized = false;

  async function ensureInit() {
    if (initialized) return;

    await db
      .prepare('CREATE TABLE IF NOT EXISTS app_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, expiration INTEGER)')
      .run();
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_app_store_expiration ON app_store(expiration)')
      .run();

    initialized = true;
  }

  async function purgeExpired() {
    await ensureInit();
    await db.prepare('DELETE FROM app_store WHERE expiration IS NOT NULL AND expiration <= unixepoch()').run();
  }

  return {
    async get(key, type) {
      await purgeExpired();
      const row = await db.prepare('SELECT value FROM app_store WHERE key = ?').bind(key).first();
      if (!row) return null;
      if (type === 'json') {
        try {
          return JSON.parse(row.value);
        } catch (_) {
          return null;
        }
      }
      return row.value;
    },

    async put(key, value, options = {}) {
      await ensureInit();
      const now = Math.floor(Date.now() / 1000);
      let expiration = null;
      if (options.expirationTtl) {
        expiration = now + Number(options.expirationTtl);
      } else if (options.expiration) {
        expiration = Number(options.expiration);
      }

      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      await db
        .prepare(`
          INSERT INTO app_store(key, value, expiration)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            expiration = excluded.expiration
        `)
        .bind(key, stringValue, expiration)
        .run();
    },

    async delete(key) {
      await ensureInit();
      await db.prepare('DELETE FROM app_store WHERE key = ?').bind(key).run();
    },

    async list(options = {}) {
      await purgeExpired();
      const prefix = options.prefix || '';
      const rows = await db
        .prepare('SELECT key, expiration FROM app_store WHERE key LIKE ? ORDER BY key')
        .bind(prefix + '%')
        .all();

      return {
        keys: (rows.results || []).map((r) => ({
          name: r.key,
          expiration: r.expiration || undefined
        }))
      };
    }
  };
}

// ================= 会话与鉴权辅助函数 =================

async function getUserSession(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/session_id=([^;]+)/);
  if (!match) return null;
  const sessionId = match[1];
  return await dbStore(env).get('session:' + sessionId);
}

// ================= Linux DO OAuth2 逻辑 =================

function handleLinuxDoAuth(request, env, url) {
  if (!env.LINUXDO_CLIENT_ID) return new Response('未配置 LINUXDO_CLIENT_ID', { status: 500 });
  const redirectUri = url.origin + '/api/auth/linuxdo/callback';
  const state = crypto.randomUUID();
  const authUrl = 'https://connect.linux.do/oauth2/authorize' + 
    '?client_id=' + env.LINUXDO_CLIENT_ID + 
    '&response_type=code' + 
    '&redirect_uri=' + encodeURIComponent(redirectUri) + 
    '&state=' + state;
  return Response.redirect(authUrl, 302);
}

async function handleLinuxDoCallback(request, env, url) {
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
        code: code,
        redirect_uri: redirectUri
      })
    });
    if (!tokenRes.ok) throw new Error('Failed to fetch access token');
    const tokenData = await tokenRes.json();

    const userRes = await fetch('https://connect.linux.do/api/user', {
      headers: { 'Authorization': 'Bearer ' + tokenData.access_token }
    });
    if (!userRes.ok) throw new Error('Failed to fetch user info');
    const userData = await userRes.json();
    
    const username = 'linuxdo_' + userData.username;
    const sessionId = crypto.randomUUID();
    await dbStore(env).put('session:' + sessionId, username, { expirationTtl: 604800 });
    
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/', 'Set-Cookie': 'session_id=' + sessionId + '; Path=/; Max-Age=604800; HttpOnly' }
    });
  } catch (err) {
    return new Response('OAuth Error: ' + err.message, { status: 500 });
  }
}

// ================= NodeLoc OAuth2 逻辑 =================

function handleNodeLocAuth(request, env, url) {
  if (!env.NODELOC_CLIENT_ID) return new Response('未配置 NODELOC_CLIENT_ID', { status: 500 });
  const redirectUri = url.origin + '/api/auth/nodeloc/callback';
  const state = crypto.randomUUID();
  
  const authUrl = 'https://www.nodeloc.com/oauth-provider/authorize' + 
    '?client_id=' + env.NODELOC_CLIENT_ID + 
    '&response_type=code' + 
    '&redirect_uri=' + encodeURIComponent(redirectUri) + 
    '&state=' + state;
  return Response.redirect(authUrl, 302);
}

async function handleNodeLocCallback(request, env, url) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('Authorization Failed', { status: 400 });
  const redirectUri = url.origin + '/api/auth/nodeloc/callback';

  try {
    const tokenRes = await fetch('https://www.nodeloc.com/oauth-provider/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        client_id: env.NODELOC_CLIENT_ID,
        client_secret: env.NODELOC_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      })
    });
    if (!tokenRes.ok) throw new Error('Failed to fetch access token');
    const tokenData = await tokenRes.json();

    const userRes = await fetch('https://www.nodeloc.com/oauth-provider/userinfo', {
      headers: { 
        'Authorization': 'Bearer ' + tokenData.access_token,
        'Accept': 'application/json'
      }
    });
    if (!userRes.ok) throw new Error('Failed to fetch user info');
    const userData = await userRes.json();
    
    let rawUsername = userData.username || userData.preferred_username || userData.name || userData.sub || 'user_' + Math.random().toString(36).substr(2, 5);
    if (userData.data && userData.data.attributes) {
      rawUsername = userData.data.attributes.username;
    }
    
    const username = 'nodeloc_' + rawUsername;
    const sessionId = crypto.randomUUID();
    await dbStore(env).put('session:' + sessionId, username, { expirationTtl: 604800 });
    
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/', 'Set-Cookie': 'session_id=' + sessionId + '; Path=/; Max-Age=604800; HttpOnly' }
    });
  } catch (err) {
    return new Response('NodeLoc OAuth Error: ' + err.message, { status: 500 });
  }
}

// ================= 核心业务函数 =================

async function handlePlay(request, env, url) {
  const token = url.searchParams.get('token');
  const channelId = url.pathname.replace('/play/', '').replace(/\/$/, '');
  
  if (!token) return new Response('Missing Token', { status: 401 });

  const tokenLimitStr = await dbStore(env).get('token:' + token);
  if (!tokenLimitStr) return new Response('Invalid Token or Expired', { status: 403 });
  
  const limit = parseInt(tokenLimitStr);
  const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  
  if (limit > 0) {
    let ips = await dbStore(env).get('ips:' + token, 'json') || [];
    if (!ips.includes(clientIP)) {
      if (ips.length >= limit) {
        return new Response('Security Triggered: IP limit exceeded. Please go to dashboard to reset IPs.', { status: 403 });
      }
      ips.push(clientIP);
      await dbStore(env).put('ips:' + token, JSON.stringify(ips));
    }
  }

  const channelsStr = await dbStore(env).get('data:channels');
  if (!channelsStr) return new Response('No Channels Data', { status: 500 });
  
  const channels = JSON.parse(channelsStr);
  const target = channels.find(c => c.id === channelId);
  
  if (!target) return new Response('Channel Not Found', { status: 404 });

  return new Response(null, {
    status: 302,
    headers: {
      'Location': target.url,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  });
}

async function updateM3USource(env) {
  const sourceUrlsStr = await dbStore(env).get('config:source_url');
  if (!sourceUrlsStr) return { success: false, msg: 'No source URL configured' };

  const urls = sourceUrlsStr.split(/[\n,]+/).map(u => u.trim()).filter(u => u);
  if (urls.length === 0) return { success: false, msg: 'No valid URLs found in config' };

  let allChannels = [];
  let errors = [];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const channels = parseM3U(text);
      allChannels = allChannels.concat(channels);
    } catch (err) {
      errors.push(`Failed to fetch ${url}: ${err.message}`);
    }
  }

  const uniqueChannels = [];
  const seenIds = new Set();
  for (const ch of allChannels) {
    if (!seenIds.has(ch.id)) {
      seenIds.add(ch.id);
      uniqueChannels.push(ch);
    }
  }

  if (uniqueChannels.length > 0) {
    await dbStore(env).put('data:channels', JSON.stringify(uniqueChannels));
    return { 
      success: true, 
      count: uniqueChannels.length, 
      msg: errors.length > 0 ? `部分成功, 抓取到 ${uniqueChannels.length} 个频道。错误: ${errors.join('; ')}` : `全部抓取成功, 共 ${uniqueChannels.length} 个频道`
    };
  }
  
  return { success: false, msg: '所有源均未找到有效频道。错误信息: ' + errors.join('; ') };
}

function generateFixedId(name, url) {
  const str = name + url;
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
        id: generateFixedId(info.name || '', line),
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

async function generateUserSubscription(request, env, url, format = 'm3u') {
  const token = url.searchParams.get('token');
  if (!token) return new Response('Missing Token', { status: 401 });

  const isValid = await dbStore(env).get('token:' + token);
  if (!isValid) return new Response('Invalid Token or Expired', { status: 403 });

  const channelsStr = await dbStore(env).get('data:channels');
  const channels = JSON.parse(channelsStr || '[]');
  const origin = url.origin;
  const txtSubscriptionUrl = origin + '/sub/txt?token=' + token;

  if (format === 'tvbox') {
    const tvbox = {
      lives: [
        {
          name: '自建专属 IPTV',
          type: 0,
          url: txtSubscriptionUrl,
          epg: ''
        }
      ]
    };
    return Response.json(tvbox);
  }

  if (format === 'txt') {
    const txt = channels.map(c => c.name + ',' + origin + '/play/' + c.id + '?token=' + token).join('\n');
    return new Response(txt, { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
  }

  let m3u = '#EXTM3U\n';
  channels.forEach(c => {
    m3u += '#EXTINF:-1 tvg-logo="' + c.logo + '" group-title="' + c.group + '",' + c.name + '\n';
    m3u += origin + '/play/' + c.id + '?token=' + token + '\n';
  });

  return new Response(m3u, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
}

// ================= 用户端 API (注册/看板) =================

async function handleUserAPI(request, env, url) {
  const route = url.pathname.replace('/api/user/', '');

  if (request.method === 'POST' && route === 'register') {
    const body = await request.json();
    if (!body.username || !body.password) return Response.json({ success: false, msg: '缺少账密' });
    const exists = await dbStore(env).get('user:' + body.username);
    if (exists) return Response.json({ success: false, msg: '用户名已存在' });
    
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
        'Set-Cookie': 'session_id=' + sessionId + '; Path=/; Max-Age=604800; HttpOnly'
      }
    });
  }

  const username = await getUserSession(request, env);
  if (!username) return Response.json({ success: false, msg: '未登录' }, { status: 401 });

  // === 新增获取系统通知接口 ===
  if (request.method === 'GET' && route === 'announcement') {
    const announcement = await dbStore(env).get('config:announcement') || '';
    return Response.json({ announcement });
  }

  if (request.method === 'POST' && route === 'bind') {
    const body = await request.json();
    const tokenExists = await dbStore(env).get('token:' + body.token);
    if (!tokenExists) return Response.json({ success: false, msg: '无效的或已过期的 Token' });

    const owner = await dbStore(env).get('owner:' + body.token);
    if (owner && owner !== username) return Response.json({ success: false, msg: '该 Token 已被其他用户绑定' });
    
    await dbStore(env).put('owner:' + body.token, username);
    
    let list = await dbStore(env).get('user_tokens:' + username, 'json') || [];
    if (!list.includes(body.token)) {
      list.push(body.token);
      await dbStore(env).put('user_tokens:' + username, JSON.stringify(list));
    }
    return Response.json({ success: true });
  }

  if (request.method === 'GET' && route === 'tokens') {
    let list = await dbStore(env).get('user_tokens:' + username, 'json') || [];
    let result = [];
    for (let t of list) {
      const limitStr = await dbStore(env).get('token:' + t);
      if (limitStr) {
        const ips = await dbStore(env).get('ips:' + t, 'json') || [];
        
        const keyList = await dbStore(env).list({ prefix: 'token:' + t });
        const keyInfo = keyList.keys.find(k => k.name === 'token:' + t);
        let expireText = '永久有效';
        if (keyInfo && keyInfo.expiration) {
          const d = new Date(keyInfo.expiration * 1000);
          expireText = d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        }

        result.push({ token: t, limit: parseInt(limitStr), used: ips.length, expireText: expireText });
      }
    }
    return Response.json(result);
  }

  if (request.method === 'POST' && route === 'reset_ip') {
    const body = await request.json();
    const owner = await dbStore(env).get('owner:' + body.token);
    if (owner !== username) return Response.json({ success: false, msg: '无权操作' });
    
    await dbStore(env).put('ips:' + body.token, '[]');
    return Response.json({ success: true });
  }

  if (request.method === 'POST' && route === 'logout') {
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(/session_id=([^;]+)/);
    if (match) await dbStore(env).delete('session:' + match[1]);
    
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
      }
    });
  }

  return new Response('Not Found', { status: 404 });
}

// ================= 后台管理 API & 鉴权 =================

async function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  
  const [scheme, encoded] = authHeader.split(' ');
  if (scheme !== 'Basic') return false;
  
  const decoded = atob(encoded);
  const [user, pass] = decoded.split(':');
  
  const expectedUser = await dbStore(env).get('config:admin_user') || env.DEFAULT_ADMIN_USER || 'admin';
  const expectedPass = await dbStore(env).get('config:admin_pass') || env.DEFAULT_ADMIN_PASS || 'admin123';
  
  return user === expectedUser && pass === expectedPass;
}

async function handleAdminAPI(request, env, url) {
  const route = url.pathname.replace('/admin/api/', '');
  
  if (request.method === 'GET' && route === 'status') {
    const sourceUrl = await dbStore(env).get('config:source_url') || '';
    // 获取当前通知
    const announcement = await dbStore(env).get('config:announcement') || '';
    const channels = JSON.parse(await dbStore(env).get('data:channels') || '[]');
    return Response.json({ sourceUrl, announcement, channelCount: channels.length });
  }
  
  if (request.method === 'POST' && route === 'sync') {
    const result = await updateM3USource(env);
    return Response.json(result);
  }

  if (request.method === 'POST' && route === 'config') {
    const body = await request.json();
    await dbStore(env).put('config:source_url', body.sourceUrl);
    return Response.json({ success: true });
  }

  // === 新增保存通知接口 ===
  if (request.method === 'POST' && route === 'announcement') {
    const body = await request.json();
    await dbStore(env).put('config:announcement', body.announcement || '');
    return Response.json({ success: true });
  }

  if (request.method === 'GET' && route === 'tokens') {
    const list = await dbStore(env).list({ prefix: 'token:' });
    const tokens = await Promise.all(list.keys.map(async k => {
      const t = k.name.replace('token:', '');
      const limit = await dbStore(env).get(k.name);
      const ips = await dbStore(env).get('ips:' + t, 'json') || [];
      const owner = await dbStore(env).get('owner:' + t) || '未绑定';
      
      let expireText = '永久有效';
      if (k.expiration) {
        const d = new Date(k.expiration * 1000);
        expireText = d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      }

      return { token: t, limit: parseInt(limit), used: ips.length, ips: ips, expireText: expireText, owner: owner };
    }));
    return Response.json(tokens);
  }

  if (request.method === 'POST' && route === 'token') {
    const body = await request.json();
    const options = {};
    if (body.expireHours && Number(body.expireHours) > 0) {
       options.expirationTtl = Math.max(60, Number(body.expireHours) * 3600);
    }
    const limitVal = body.limit === '' ? '0' : body.limit.toString();
    await dbStore(env).put('token:' + body.token, limitVal, options);
    return Response.json({ success: true });
  }

  if (request.method === 'DELETE' && route === 'token') {
    const body = await request.json();
    await dbStore(env).delete('token:' + body.token);
    await dbStore(env).delete('ips:' + body.token);
    await dbStore(env).delete('owner:' + body.token);
    return Response.json({ success: true });
  }

  if (request.method === 'POST' && route === 'reset_ip') {
    const body = await request.json();
    await dbStore(env).put('ips:' + body.token, '[]');
    return Response.json({ success: true });
  }

  return new Response('Not Found', { status: 404 });
}

// ================= 前端页面渲染 =================

function renderLoginPage() {
  return '<!DOCTYPE html>\n' +
  '<html lang="zh-CN">\n' +
  '<head>\n' +
  '  <meta charset="UTF-8">\n' +
  '  <title>系统登录/注册</title>\n' +
  '  <style>\n' +
  '    body { font-family: system-ui; background: #f4f4f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }\n' +
  '    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 300px; text-align: center; }\n' +
  '    input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }\n' +
  '    button { color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; width: 100%; margin-top: 10px; font-weight: bold; }\n' +
  '    .btn-login { background: #3b82f6; }\n' +
  '    .btn-reg { background: #10b981; }\n' +
  '    .oauth-btn { margin-top: 15px; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: normal; }\n' +
  '    .btn-linuxdo { background: #232323; }\n' +
  '    .btn-nodeloc { background: #007bff; }\n' +
  '    .divider { margin: 20px 0; color: #999; font-size: 14px; display: flex; align-items: center; }\n' +
  '    .divider::before, .divider::after { content: ""; flex: 1; border-bottom: 1px solid #eee; }\n' +
  '    .divider::before { margin-right: 10px; } .divider::after { margin-left: 10px; }\n' +
  '  </style>\n' +
  '</head>\n' +
  '<body>\n' +
  '  <div class="card">\n' +
  '    <h2>IPTV 订阅系统</h2>\n' +
  '    <input type="text" id="user" placeholder="用户名">\n' +
  '    <input type="password" id="pass" placeholder="密码">\n' +
  '    <button class="btn-login" onclick="doAction(\'login\')">登录</button>\n' +
  '    <button class="btn-reg" onclick="doAction(\'register\')">注册新账号</button>\n' +
  '    <div class="divider">或者</div>\n' +
  '    <button class="oauth-btn btn-linuxdo" onclick="window.location.href=\'/api/auth/linuxdo\'">\n' +
  '      <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-2-5.5l7-4.5-7-4.5v9z"/></svg>\n' +
  '      使用 Linux DO 登录\n' +
  '    </button>\n' +
  '    <button class="oauth-btn btn-nodeloc" onclick="window.location.href=\'/api/auth/nodeloc\'">\n' +
  '      <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm8 11h-2v3H8v-3H6v5h12v-5zm0-9H6v5h2V6h8v3h2V4z"/></svg>\n' +
  '      使用 NodeLoc 登录\n' +
  '    </button>\n' +
  '  </div>\n' +
  '  <script>\n' +
  '    async function doAction(action) {\n' +
  '      const u = document.getElementById(\'user\').value;\n' +
  '      const p = document.getElementById(\'pass\').value;\n' +
  '      if(!u || !p) return alert(\'请输入账密\');\n' +
  '      const res = await fetch(\'/api/user/\' + action, {\n' +
  '        method: \'POST\', body: JSON.stringify({username: u, password: p})\n' +
  '      });\n' +
  '      const data = await res.json();\n' +
  '      if(data.success) {\n' +
  '        if(action === \'register\') alert(\'注册成功，请登录！\');\n' +
  '        else window.location.href = \'/\';\n' +
  '      } else {\n' +
  '        alert(data.msg);\n' +
  '      }\n' +
  '    }\n' +
  '  </script>\n' +
  '</body>\n' +
  '</html>';
}

function renderUserDashboard(username) {
  return '<!DOCTYPE html>\n' +
  '<html lang="zh-CN">\n' +
  '<head>\n' +
  '  <meta charset="UTF-8">\n' +
  '  <title>用户控制台</title>\n' +
  '  <style>\n' +
  '    body { font-family: system-ui; background: #f9fafb; margin: 0; padding: 20px; }\n' +
  '    .container { max-width: 800px; margin: auto; }\n' +
  '    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }\n' +
  '    .notice-card { background: #eff6ff; border-left: 4px solid #3b82f6; color: #1e3a8a; }\n' +
  '    .notice-card h3 { margin-top: 0; font-size: 16px; margin-bottom: 8px; display: flex; align-items: center; gap: 5px; }\n' +
  '    input { padding: 8px; border: 1px solid #ddd; border-radius: 4px; }\n' +
  '    button { background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }\n' +
  '    button.warning { background: #f59e0b; }\n' +
  '    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }\n' +
  '    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }\n' +
  '    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }\n' +
  '    .header h1 { margin: 0; }\n' +
  '  </style>\n' +
  '</head>\n' +
  '<body>\n' +
  '  <div class="container">\n' +
  '    <div class="header">\n' +
  '      <h1>欢迎回来, ' + username + '</h1>\n' +
  '      <button class="warning" onclick="logout()">退出登录</button>\n' +
  '    </div>\n' +
  '    \n' +
  '    <!-- 通知横幅容器 -->\n' +
  '    <div id="noticeBox" class="card notice-card" style="display: none;">\n' +
  '      <h3>🔔 系统通知</h3>\n' +
  '      <div id="noticeContent" style="line-height: 1.5;"></div>\n' +
  '    </div>\n' +
  '\n' +
  '    <div class="card">\n' +
  '      <h2>绑定新 Token</h2>\n' +
  '      <p>请输入管理员分发给您的 Token 激活码进行绑定：</p>\n' +
  '      <input type="text" id="bindToken" placeholder="输入 Token">\n' +
  '      <button onclick="bind()">立即绑定</button>\n' +
  '    </div>\n' +
  '    <div class="card">\n' +
  '      <h2>我的订阅列表</h2>\n' +
  '      <table>\n' +
  '        <thead><tr>\n' +
  '          <th>Token</th>\n' +
  '          <th>状态/限制</th>\n' +
  '          <th>过期时间</th>\n' +
  '          <th>订阅接口</th>\n' +
  '          <th>操作</th>\n' +
  '        </tr></thead>\n' +
  '        <tbody id="list"></tbody>\n' +
  '      </table>\n' +
  '    </div>\n' +
  '  </div>\n' +
  '  <script>\n' +
  '    async function loadNotice() {\n' +
  '      try {\n' +
  '        const res = await fetch(\'/api/user/announcement\');\n' +
  '        const data = await res.json();\n' +
  '        if (data.announcement && data.announcement.trim() !== \'\') {\n' +
  '          document.getElementById(\'noticeContent\').innerHTML = data.announcement.replace(/\\n/g, \'<br>\');\n' +
  '          document.getElementById(\'noticeBox\').style.display = \'block\';\n' +
  '        }\n' +
  '      } catch(e) {}\n' +
  '    }\n' +
  '    async function loadData() {\n' +
  '      const res = await fetch(\'/api/user/tokens\');\n' +
  '      const data = await res.json();\n' +
  '      const tbody = document.getElementById(\'list\');\n' +
  '      let html = \'\';\n' +
  '      for(let i=0; i<data.length; i++) {\n' +
  '        let t = data[i];\n' +
  '        let limitTxt = t.limit === 0 ? \'无限 IP\' : (t.used + \' / \' + t.limit + \' IP\');\n' +
  '        let m3uLink = window.location.origin + \'/sub?token=\' + t.token;\n' +
  '        let tvboxLink = window.location.origin + \'/sub/tvbox?token=\' + t.token;\n' +
  '        let txtLink = window.location.origin + \'/sub/txt?token=\' + t.token;\n' +
  '        html += \'<tr>\' +\n' +
  '          \'<td>\' + t.token + \'</td>\' +\n' +
  '          \'<td>\' + limitTxt + \'</td>\' +\n' +
  '          \'<td>\' + t.expireText + \'</td>\' +\n' +
  '          \'<td style="display:flex; gap:6px; flex-wrap:wrap;"><button onclick="copy(\\\'\' + m3uLink + \'\\\')">M3U</button><button onclick="copy(\\\'\' + tvboxLink + \'\\\')">TVBox</button><button onclick="copy(\\\'\' + txtLink + \'\\\')">TXT</button></td>\' +\n' +
  '          \'<td><button class="warning" onclick="resetIp(\\\'\' + t.token + \'\\\')">解除封锁</button></td>\' +\n' +
  '        \'</tr>\';\n' +
  '      }\n' +
  '      tbody.innerHTML = html;\n' +
  '    }\n' +
  '    async function bind() {\n' +
  '      const t = document.getElementById(\'bindToken\').value;\n' +
  '      if(!t) return;\n' +
  '      const res = await fetch(\'/api/user/bind\', { method: \'POST\', body: JSON.stringify({token: t}) });\n' +
  '      const data = await res.json();\n' +
  '      if(data.success) { alert(\'绑定成功\'); document.getElementById(\'bindToken\').value=\'\'; loadData(); }\n' +
  '      else alert(data.msg);\n' +
  '    }\n' +
  '    async function resetIp(token) {\n' +
  '      await fetch(\'/api/user/reset_ip\', { method: \'POST\', body: JSON.stringify({token: token}) });\n' +
  '      alert(\'已重置该 Token 的 IP 记录\');\n' +
  '      loadData();\n' +
  '    }\n' +
  '    async function logout() {\n' +
  '      await fetch(\'/api/user/logout\', { method: \'POST\' });\n' +
  '      window.location.href = \'/login\';\n' +
  '    }\n' +
  '    function copy(text) {\n' +
  '      navigator.clipboard.writeText(text).then(() => alert(\'已复制！\'));\n' +
  '    }\n' +
  '    loadNotice();\n' +
  '    loadData();\n' +
  '  </script>\n' +
  '</body>\n' +
  '</html>';
}

function renderAdminPage() {
  return '<!DOCTYPE html>\n' +
  '<html lang="zh-CN">\n' +
  '<head>\n' +
  '  <meta charset="UTF-8">\n' +
  '  <title>管理后台</title>\n' +
  '  <style>\n' +
  '    body { font-family: system-ui; background: #f9fafb; margin: 0; padding: 20px; }\n' +
  '    .container { max-width: 900px; margin: auto; }\n' +
  '    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }\n' +
  '    input, textarea { padding: 8px; border: 1px solid #ddd; border-radius: 4px; }\n' +
  '    button { background: #10b981; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }\n' +
  '    button.danger { background: #ef4444; }\n' +
  '    button.warning { background: #f59e0b; }\n' +
  '    button.blue { background: #3b82f6; }\n' +
  '    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }\n' +
  '    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }\n' +
  '  </style>\n' +
  '</head>\n' +
  '<body>\n' +
  '  <div class="container">\n' +
  '    <h1>管理后台</h1>\n' +
  '    \n' +
  '    <div class="card">\n' +
  '      <h2>1. 系统通知管理</h2>\n' +
  '      <p style="color:#666; font-size:12px;">在此处发布的通知将显示在所有用户的控制台顶部（支持插入基础的 HTML 标签，如 &lt;a href="..."&gt; 链接）。</p>\n' +
  '      <textarea id="adminAnnouncement" placeholder="输入要发布的通知内容... 留空则不显示通知" rows="3" style="width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 10px;"></textarea><br>\n' +
  '      <button class="blue" onclick="saveAnnouncement()">发布 / 更新通知</button>\n' +
  '      <button class="danger" onclick="clearAnnouncement()" style="margin-left: 10px;">清空通知</button>\n' +
  '    </div>\n' +
  '\n' +
  '    <div class="card">\n' +
  '      <h2>2. 原始直播源</h2>\n' +
  '      <p>有效去重频道数 <span id="chCount">0</span></p>\n' +
  '      <textarea id="sourceUrl" placeholder="输入 M3U 订阅链接，支持多个源，请每行输入一个链接" rows="4" style="width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 10px;"></textarea><br>\n' +
  '      <button onclick="saveConfig()">保存源配置</button>\n' +
  '      <button class="blue" onclick="syncM3U()" style="margin-left: 10px;">立即抓取/更新</button>\n' +
  '    </div>\n' +
  '\n' +
  '    <div class="card">\n' +
  '      <h2>3. Token 管理 (激活码)</h2>\n' +
  '      <p style="color:#666; font-size:12px;">给用户分发下方的 Token。IP限制填 0 代表无限IP。</p>\n' +
  '      <div style="display:flex; gap: 10px; margin-bottom: 10px;">\n' +
  '        <input type="text" id="newToken" placeholder="生成新 Token" style="flex: 2;">\n' +
  '        <input type="number" id="newLimit" placeholder="IP限制(0为无限)" value="3" style="flex: 1;">\n' +
  '        <input type="number" id="expireHours" placeholder="有效期(小时)" style="flex: 1.5;">\n' +
  '        <button onclick="addToken()" style="flex: 1;">生成</button>\n' +
  '      </div>\n' +
  '      <table>\n' +
  '        <thead><tr>\n' +
  '          <th>Token</th><th>归属用户</th><th>IP 状态</th><th>过期时间</th><th>操作</th>\n' +
  '        </tr></thead>\n' +
  '        <tbody id="tokenList"></tbody>\n' +
  '      </table>\n' +
  '    </div>\n' +
  '  </div>\n' +
  '  <script>\n' +
  '    async function loadData() {\n' +
  '      const statusRes = await fetch(\'/admin/api/status\');\n' +
  '      const status = await statusRes.json();\n' +
  '      document.getElementById(\'sourceUrl\').value = status.sourceUrl;\n' +
  '      document.getElementById(\'adminAnnouncement\').value = status.announcement || \'\';\n' +
  '      document.getElementById(\'chCount\').innerText = status.channelCount;\n' +
  '      \n' +
  '      const tokensRes = await fetch(\'/admin/api/tokens\');\n' +
  '      const tokens = await tokensRes.json();\n' +
  '      const tbody = document.getElementById(\'tokenList\');\n' +
  '      let html = \'\';\n' +
  '      for(let i=0; i<tokens.length; i++) {\n' +
  '        let t = tokens[i];\n' +
  '        let limitTxt = t.limit === 0 ? \'无限\' : (t.used + \'/\' + t.limit);\n' +
  '        html += \'<tr>\' +\n' +
  '          \'<td>\' + t.token + \'</td>\' +\n' +
  '          \'<td>\' + t.owner + \'</td>\' +\n' +
  '          \'<td><span title="\' + t.ips.join(\', \') + \'">\' + limitTxt + \'</span></td>\' +\n' +
  '          \'<td>\' + t.expireText + \'</td>\' +\n' +
  '          \'<td>\' +\n' +
  '            \'<button class="warning" onclick="resetIp(\\\'\' + t.token + \'\\\')" style="margin-right:5px;">清IP</button>\' +\n' +
  '            \'<button class="danger" onclick="delToken(\\\'\' + t.token + \'\\\')">删</button>\' +\n' +
  '          \'</td>\' +\n' +
  '        \'</tr>\';\n' +
  '      }\n' +
  '      tbody.innerHTML = html;\n' +
  '    }\n' +
  '    async function saveAnnouncement() {\n' +
  '      const text = document.getElementById(\'adminAnnouncement\').value;\n' +
  '      await fetch(\'/admin/api/announcement\', { method: \'POST\', body: JSON.stringify({ announcement: text }) });\n' +
  '      alert(\'通知更新成功！\');\n' +
  '    }\n' +
  '    async function clearAnnouncement() {\n' +
  '      document.getElementById(\'adminAnnouncement\').value = \'\';\n' +
  '      await saveAnnouncement();\n' +
  '    }\n' +
  '    async function saveConfig() {\n' +
  '      const url = document.getElementById(\'sourceUrl\').value;\n' +
  '      await fetch(\'/admin/api/config\', { method: \'POST\', body: JSON.stringify({ sourceUrl: url }) });\n' +
  '      alert(\'源配置保存成功\');\n' +
  '    }\n' +
  '    async function syncM3U() {\n' +
  '      const res = await fetch(\'/admin/api/sync\', { method: \'POST\' });\n' +
  '      const data = await res.json();\n' +
  '      if(data.success) { alert(data.msg); } else { alert(\'失败: \' + data.msg); }\n' +
  '      loadData();\n' +
  '    }\n' +
  '    async function addToken() {\n' +
  '      const token = document.getElementById(\'newToken\').value;\n' +
  '      const limit = document.getElementById(\'newLimit\').value;\n' +
  '      const expireHours = document.getElementById(\'expireHours\').value;\n' +
  '      if(!token) return alert(\'请输入 Token\');\n' +
  '      await fetch(\'/admin/api/token\', { method: \'POST\', body: JSON.stringify({ token: token, limit: limit, expireHours: expireHours }) });\n' +
  '      document.getElementById(\'newToken\').value = \'\';\n' +
  '      loadData();\n' +
  '    }\n' +
  '    async function delToken(token) {\n' +
  '      if(!confirm(\'确定删除吗？\')) return;\n' +
  '      await fetch(\'/admin/api/token\', { method: \'DELETE\', body: JSON.stringify({ token: token }) });\n' +
  '      loadData();\n' +
  '    }\n' +
  '    async function resetIp(token) {\n' +
  '      await fetch(\'/admin/api/reset_ip\', { method: \'POST\', body: JSON.stringify({ token: token }) });\n' +
  '      loadData();\n' +
  '    }\n' +
  '    loadData();\n' +
  '  </script>\n' +
  '</body>\n' +
  '</html>';
}
