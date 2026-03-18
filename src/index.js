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
      return await generateUserM3U(request, env, url);
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

    // --- 5. 用户主页 ---
    if (path === '/') {
      return new Response(renderUserPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    return new Response('Not Found', { status: 404 });
  },

  // --- 定时任务：抓取更新 ---
  async scheduled(event, env, ctx) {
    await updateM3USource(env);
  }
};

// ================= 核心业务函数 =================

async function handlePlay(request, env, url) {
  const token = url.searchParams.get('token');
  const channelId = url.pathname.replace('/play/', '').replace(/\/$/, '');
  
  if (!token) return new Response('Missing Token', { status: 401 });

  const tokenLimitStr = await env.IPTV_KV.get('token:' + token);
  if (!tokenLimitStr) return new Response('Invalid Token or Token Expired', { status: 403 });
  
  const limit = parseInt(tokenLimitStr);
  const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  
  let ips = await env.IPTV_KV.get('ips:' + token, 'json') || [];
  if (!ips.includes(clientIP)) {
    if (ips.length >= limit) {
      // 【核心功能 1】发现溢出 IP 访问，直接删除该 Token 和相关记录
      await env.IPTV_KV.delete('token:' + token);
      await env.IPTV_KV.delete('ips:' + token);
      return new Response('Security Triggered: IP limit exceeded. This Token has been permanently disabled.', { status: 403 });
    }
    ips.push(clientIP);
    await env.IPTV_KV.put('ips:' + token, JSON.stringify(ips));
  }

  const channelsStr = await env.IPTV_KV.get('data:channels');
  if (!channelsStr) return new Response('No Channels Data', { status: 500 });
  
  const channels = JSON.parse(channelsStr);
  const target = channels.find(c => c.id === channelId);
  
  if (!target) return new Response('Channel Not Found: ' + channelId, { status: 404 });

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
  const sourceUrl = await env.IPTV_KV.get('config:source_url');
  if (!sourceUrl) return { success: false, msg: 'No source URL configured' };

  try {
    const res = await fetch(sourceUrl);
    const text = await res.text();
    const channels = parseM3U(text);
    
    if (channels.length > 0) {
      await env.IPTV_KV.put('data:channels', JSON.stringify(channels));
      return { success: true, count: channels.length };
    }
    return { success: false, msg: 'No valid channels found in source' };
  } catch (err) {
    return { success: false, msg: err.message };
  }
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

async function generateUserM3U(request, env, url) {
  const token = url.searchParams.get('token');
  if (!token) return new Response('Missing Token', { status: 401 });

  const isValid = await env.IPTV_KV.get('token:' + token);
  if (!isValid) return new Response('Invalid Token or Expired', { status: 403 });

  const channelsStr = await env.IPTV_KV.get('data:channels');
  const channels = JSON.parse(channelsStr || '[]');
  const origin = url.origin;
  
  let m3u = '#EXTM3U\n';
  channels.forEach(c => {
    m3u += '#EXTINF:-1 tvg-logo="' + c.logo + '" group-title="' + c.group + '",' + c.name + '\n';
    m3u += origin + '/play/' + c.id + '?token=' + token + '\n';
  });

  return new Response(m3u, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
}

// ================= 后台管理 API & 鉴权 =================

async function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  
  const [scheme, encoded] = authHeader.split(' ');
  if (scheme !== 'Basic') return false;
  
  const decoded = atob(encoded);
  const [user, pass] = decoded.split(':');
  
  const expectedUser = await env.IPTV_KV.get('config:admin_user') || env.DEFAULT_ADMIN_USER || 'admin';
  const expectedPass = await env.IPTV_KV.get('config:admin_pass') || env.DEFAULT_ADMIN_PASS || 'admin123';
  
  return user === expectedUser && pass === expectedPass;
}

async function handleAdminAPI(request, env, url) {
  const route = url.pathname.replace('/admin/api/', '');
  
  if (request.method === 'GET' && route === 'status') {
    const sourceUrl = await env.IPTV_KV.get('config:source_url') || '';
    const channels = JSON.parse(await env.IPTV_KV.get('data:channels') || '[]');
    return Response.json({ sourceUrl, channelCount: channels.length });
  }
  
  if (request.method === 'POST' && route === 'sync') {
    const result = await updateM3USource(env);
    return Response.json(result);
  }

  if (request.method === 'POST' && route === 'config') {
    const body = await request.json();
    await env.IPTV_KV.put('config:source_url', body.sourceUrl);
    return Response.json({ success: true });
  }

  if (request.method === 'GET' && route === 'tokens') {
    const list = await env.IPTV_KV.list({ prefix: 'token:' });
    const tokens = await Promise.all(list.keys.map(async k => {
      const t = k.name.replace('token:', '');
      const limit = await env.IPTV_KV.get(k.name);
      const ips = await env.IPTV_KV.get('ips:' + t, 'json') || [];
      
      let expireText = '永久有效';
      if (k.expiration) {
        // KV 返回的 expiration 是秒级时间戳，转为东八区时间展示
        const d = new Date(k.expiration * 1000);
        expireText = d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      }

      return { token: t, limit: parseInt(limit), used: ips.length, ips: ips, expireText: expireText };
    }));
    return Response.json(tokens);
  }

  if (request.method === 'POST' && route === 'token') {
    const body = await request.json();
    const options = {};
    
    // 【核心功能 2】利用 KV 原生的 expirationTtl 设置存活时间
    if (body.expireHours && Number(body.expireHours) > 0) {
       // expirationTtl 必须以秒为单位，且最小值为 60 秒
       options.expirationTtl = Math.max(60, Number(body.expireHours) * 3600);
    }

    await env.IPTV_KV.put('token:' + body.token, body.limit.toString(), options);
    return Response.json({ success: true });
  }

  if (request.method === 'DELETE' && route === 'token') {
    const body = await request.json();
    await env.IPTV_KV.delete('token:' + body.token);
    await env.IPTV_KV.delete('ips:' + body.token);
    return Response.json({ success: true });
  }

  return new Response('Not Found', { status: 404 });
}

// ================= 前端页面渲染 (HTML/CSS/JS) =================

function renderUserPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IPTV 订阅获取</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f4f4f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 100%; max-width: 400px; text-align: center; }
    input { width: 90%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
    button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; width: 100%; }
    button:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h2>获取你的专属订阅</h2>
    <p>请输入管理员分配给你的 Token</p>
    <input type="text" id="token" placeholder="输入 Token">
    <button onclick="getSub()">生成并复制链接</button>
  </div>
  <script>
    function getSub() {
      const token = document.getElementById('token').value.trim();
      if(!token) return alert('请输入 Token');
      const url = window.location.origin + '/sub?token=' + token;
      navigator.clipboard.writeText(url).then(function() {
        alert('订阅链接已复制到剪贴板！');
      });
    }
  </script>
</body>
</html>`;
}

function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>M3U Proxy 管理后台</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f9fafb; margin: 0; padding: 20px; }
    .container { max-width: 900px; margin: auto; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
    h2 { margin-top: 0; }
    input { padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
    button { background: #10b981; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
    button.danger { background: #ef4444; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    .warning-text { color: #ef4444; font-size: 12px; margin-top: 5px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>管理后台</h1>
    
    <div class="card">
      <h2>1. 原始直播源设置</h2>
      <p>当前状态：频道数 <span id="chCount">0</span></p>
      <input type="text" id="sourceUrl" placeholder="输入 M3U 订阅链接" style="width: 70%;">
      <button onclick="saveConfig()">保存</button>
      <button onclick="syncM3U()" style="background:#3b82f6;">立即抓取更新</button>
    </div>

    <div class="card">
      <h2>2. Token 管理</h2>
      <p class="warning-text">注：如果请求的 IP 数量超过限制，Token 将被自动且永久地删除作废。</p>
      
      <div style="display:flex; gap: 10px; margin-bottom: 10px;">
        <input type="text" id="newToken" placeholder="自定义 Token" style="flex: 2;">
        <input type="number" id="newLimit" placeholder="最大允许IP数" value="3" style="flex: 1;">
        <input type="number" id="expireHours" placeholder="有效期(小时)，留空为永久" style="flex: 1.5;">
        <button onclick="addToken()" style="flex: 1;">生成 Token</button>
      </div>
      
      <table>
        <thead><tr>
          <th>Token</th>
          <th>IP 限制</th>
          <th>已用 IP</th>
          <th>过期时间</th>
          <th>操作</th>
        </tr></thead>
        <tbody id="tokenList"></tbody>
      </table>
    </div>
  </div>

  <script>
    async function loadData() {
      const statusRes = await fetch('/admin/api/status');
      const status = await statusRes.json();
      document.getElementById('sourceUrl').value = status.sourceUrl;
      document.getElementById('chCount').innerText = status.channelCount;

      const tokensRes = await fetch('/admin/api/tokens');
      const tokens = await tokensRes.json();
      const tbody = document.getElementById('tokenList');
      
      let html = '';
      for(let i = 0; i < tokens.length; i++) {
        let t = tokens[i];
        let ipsStr = t.ips.join(', ');
        html += '<tr>' +
          '<td>' + t.token + '</td>' +
          '<td>' + t.limit + '</td>' +
          '<td><span title="' + ipsStr + '">' + t.used + '</span></td>' +
          '<td>' + t.expireText + '</td>' +
          '<td><button class="danger" onclick="delToken(\\'' + t.token + '\\')">删除</button></td>' +
        '</tr>';
      }
      tbody.innerHTML = html;
    }

    async function saveConfig() {
      const url = document.getElementById('sourceUrl').value;
      await fetch('/admin/api/config', { method: 'POST', body: JSON.stringify({ sourceUrl: url }) });
      alert('保存成功');
    }

    async function syncM3U() {
      const res = await fetch('/admin/api/sync', { method: 'POST' });
      const data = await res.json();
      if(data.success) {
        alert('抓取成功，共更新 ' + data.count + ' 个频道');
      } else {
        alert('抓取失败: ' + data.msg);
      }
      loadData();
    }

    async function addToken() {
      const token = document.getElementById('newToken').value;
      const limit = document.getElementById('newLimit').value;
      const expireHours = document.getElementById('expireHours').value;
      
      if(!token) return alert('请输入 Token');
      
      const payload = { 
        token: token, 
        limit: limit,
        expireHours: expireHours
      };

      await fetch('/admin/api/token', { method: 'POST', body: JSON.stringify(payload) });
      
      // 清空输入框
      document.getElementById('newToken').value = '';
      document.getElementById('expireHours').value = '';
      loadData();
    }

    async function delToken(token) {
      if(!confirm('确定删除吗？')) return;
      await fetch('/admin/api/token', { method: 'DELETE', body: JSON.stringify({ token: token }) });
      loadData();
    }

    loadData();
  </script>
</body>
</html>`;
}
