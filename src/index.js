const ADMIN_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IPTV 代理管理后台</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f3f4f6; color: #333; }
    .card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); margin-bottom: 24px; }
    h1 { text-align: center; color: #111827; margin-bottom: 30px; }
    h3 { margin-top: 0; color: #374151; font-size: 1.2rem; margin-bottom: 16px; }
    input, textarea { width: 100%; box-sizing: border-box; margin-bottom: 16px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; }
    input:focus, textarea:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.3); }
    button { background: #3b82f6; color: white; border: none; cursor: pointer; font-weight: bold; padding: 12px; border-radius: 8px; font-size: 1rem; width: 100%; transition: background 0.2s; margin-bottom: 8px; }
    button:hover { background: #2563eb; }
    .btn-green { background: #10b981; }
    .btn-green:hover { background: #059669; }
    #result { background: #1f2937; color: #10b981; padding: 16px; border-radius: 8px; white-space: pre-wrap; word-break: break-all; font-family: monospace; min-height: 50px; max-height: 400px; overflow-y: auto;}
    .highlight-link { color: #fbbf24; font-weight: bold; }
  </style>
</head>
<body>
  <h1>📺 IPTV 代理管理后台</h1>
  
  <div class="card">
    <h3>🔑 1. 管理员认证</h3>
    <input type="password" id="adminSecret" placeholder="在此输入你的 ADMIN_SECRET 密码">
  </div>

  <div class="card">
    <h3>🔗 2. 导入直播源 (二选一)</h3>
    <label style="display:block; margin-bottom:8px; color:#4b5563; font-weight:bold;">方式 A: 通过订阅链接一键拉取</label>
    <input type="text" id="subUrl" placeholder="输入外部 M3U 订阅链接 (例如: http://example.com/iptv.m3u)">
    <button class="btn-green" onclick="importSubscription()">从订阅链接自动拉取</button>
    <hr style="border: 0; border-top: 1px dashed #d1d5db; margin: 20px 0;">
    <label style="display:block; margin-bottom:8px; color:#4b5563; font-weight:bold;">方式 B: 手动粘贴 M3U 文本</label>
    <textarea id="m3uContent" rows="4" placeholder="#EXTM3U\n#EXTINF:-1,CCTV1\nhttp://example.com/cctv1.m3u8\n..."></textarea>
    <button onclick="importM3U()">解析并导入文本</button>
  </div>

  <div class="card">
    <h3>🎫 3. 生成专属订阅链接</h3>
    <label style="display:block; margin-bottom:8px; color:#4b5563;">该 Token 允许使用的独立 IP 数量：</label>
    <input type="number" id="maxIps" value="1" min="1">
    <button onclick="generateToken()">生成我的 M3U 订阅链接</button>
  </div>

  <div class="card">
    <h3>📝 操作结果</h3>
    <div id="result">等待操作...</div>
  </div>

  <script>
    function log(msg) {
      document.getElementById('result').innerHTML = typeof msg === 'object' ? JSON.stringify(msg, null, 2).replace(/(https?:\\/\\/[^\\s"]+)/g, '<a href="$1" target="_blank" class="highlight-link">$1</a>') : msg;
    }

    async function importSubscription() {
      const secret = document.getElementById('adminSecret').value;
      const url = document.getElementById('subUrl').value;
      if (!secret) return alert('请输入管理员密码！');
      if (!url) return alert('请输入订阅链接！');
      
      log('🔄 正在前往目标链接拉取数据，请稍候...');
      try {
        const res = await fetch('/admin/subscribe', {
          method: 'POST',
          headers: { 'Authorization': secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        log(data);
      } catch(err) { log('❌ 拉取失败: ' + err.message); }
    }

    async function importM3U() {
      const secret = document.getElementById('adminSecret').value;
      const content = document.getElementById('m3uContent').value;
      if (!secret) return alert('请输入管理员密码！');
      if (!content) return alert('请输入 M3U 文本内容！');
      
      log('🔄 正在解析并导入，请稍候...');
      try {
        const res = await fetch('/admin/m3u', {
          method: 'POST',
          headers: { 'Authorization': secret },
          body: content
        });
        const data = await res.json();
        log(data);
      } catch(err) { log('❌ 请求失败: ' + err.message); }
    }

    async function generateToken() {
      const secret = document.getElementById('adminSecret').value;
      const maxIps = parseInt(document.getElementById('maxIps').value) || 1;
      if (!secret) return alert('请输入管理员密码！');
      
      log('🔄 正在生成 Token 并打包订阅链接...');
      try {
        const res = await fetch('/admin/token', {
          method: 'POST',
          headers: { 'Authorization': secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxIps })
        });
        
        if (res.status === 401) return log('❌ 密码错误 (Unauthorized)');
        const data = await res.json();
        
        const currentUrl = window.location.origin;
        // 自动拼接出完整的 M3U 订阅链接
        data.your_m3u_subscription = \`\${currentUrl}/subscribe?token=\${data.token}\`;
        
        log(data);
      } catch(err) { log('❌ 请求失败: ' + err.message); }
    }
  </script>
</body>
</html>
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 0. 返回 Web 管理后台
    if (path === '/' || path === '/admin') {
      return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    // 1. 订阅链接导入接口
    if (path === '/admin/subscribe' && method === 'POST') {
      if (!checkAdmin(request, env)) return new Response(JSON.stringify({error: 'Unauthorized'}), { status: 401 });
      try {
        const body = await request.json();
        const subRes = await fetch(body.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!subRes.ok) throw new Error(`Status ${subRes.status}`);
        const channels = parseM3U(await subRes.text());
        let count = 0;
        for (const channel of channels) {
          await env.IPTV_KV.put(`stream:${channel.id}`, channel.url);
          count++;
        }
        return Response.json({ message: `成功导入 ${count} 个频道！` });
      } catch (error) { return new Response(JSON.stringify({error: error.message}), { status: 500 }); }
    }

    // 2. 文本导入 M3U 接口
    if (path === '/admin/m3u' && method === 'POST') {
      if (!checkAdmin(request, env)) return new Response(JSON.stringify({error: 'Unauthorized'}), { status: 401 });
      const channels = parseM3U(await request.text());
      let count = 0;
      for (const channel of channels) {
        await env.IPTV_KV.put(`stream:${channel.id}`, channel.url);
        count++;
      }
      return Response.json({ message: `成功导入 ${count} 个频道` });
    }

    // 3. 生成 Token 接口
    if (path === '/admin/token' && method === 'POST') {
      if (!checkAdmin(request, env)) return new Response(JSON.stringify({error: 'Unauthorized'}), { status: 401 });
      const body = await request.json();
      const tokenString = body.token || generateRandomString(12);
      await env.IPTV_KV.put(`token:${tokenString}`, JSON.stringify({ maxIps: body.maxIps || 1, ips: [] }));
      return Response.json({ message: 'Token 生成成功', token: tokenString });
    }

    // 4. 获取 M3U 订阅链接 接口 (核心新功能 ✨)
    if (path === '/subscribe' && method === 'GET') {
      const tokenString = url.searchParams.get('token');
      if (!tokenString) return new Response('Missing Token', { status: 403 });

      // 验证 Token 是否有效
      const tokenRaw = await env.IPTV_KV.get(`token:${tokenString}`);
      if (!tokenRaw) return new Response('Invalid Token', { status: 403 });

      // 遍历 KV 数据库中所有以 "stream:" 开头的键
      const listed = await env.IPTV_KV.list({ prefix: 'stream:' });
      const currentOrigin = url.origin;

      let m3uContent = '#EXTM3U\n';
      
      for (const key of listed.keys) {
        // 从键名中提取频道 ID (例如 "stream:CCTV_1" 提取出 "CCTV_1")
        const id = key.name.replace('stream:', '');
        // 把下划线替换回空格，还原频道名称
        const name = decodeURIComponent(id).replace(/_/g, ' ');
        
        m3uContent += `#EXTINF:-1,${name}\n`;
        // 生成代理播放地址
        m3uContent += `${currentOrigin}/play/${id}?token=${tokenString}\n`;
      }

      // 告诉浏览器/播放器这是一个 M3U 文件
      return new Response(m3uContent, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Disposition': 'attachment; filename="proxy_playlist.m3u"',
          // 允许跨域请求
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 5. 播放/重定向 接口
    if (path.startsWith('/play/') && method === 'GET') {
      const channelId = decodeURIComponent(path.split('/')[2]);
      const tokenString = url.searchParams.get('token');
      if (!tokenString) return new Response('Missing Token', { status: 403 });

      const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
      const tokenRaw = await env.IPTV_KV.get(`token:${tokenString}`);
      if (!tokenRaw) return new Response('Invalid Token', { status: 403 });
      
      const tokenData = JSON.parse(tokenRaw);
      
      if (!tokenData.ips.includes(clientIp)) {
        if (tokenData.ips.length >= tokenData.maxIps) {
          return new Response('IP limit reached', { status: 403 });
        } else {
          tokenData.ips.push(clientIp);
          ctx.waitUntil(env.IPTV_KV.put(`token:${tokenString}`, JSON.stringify(tokenData)));
        }
      }

      const streamUrl = await env.IPTV_KV.get(`stream:${channelId}`);
      if (!streamUrl) return new Response('Stream not found', { status: 404 });

      return Response.redirect(streamUrl, 302);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// --- 辅助函数 ---
function checkAdmin(request, env) { return request.headers.get('Authorization') === env.ADMIN_SECRET; }
function parseM3U(content) {
  const lines = content.split('\n');
  const channels = [];
  let currentName = '';
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('#EXTINF')) {
      const parts = line.split(',');
      currentName = parts.length > 1 ? parts[1].trim() : 'Unknown';
    } else if (line && !line.startsWith('#')) {
      const id = encodeURIComponent(currentName.replace(/\s+/g, '_'));
      channels.push({ id, name: currentName, url: line });
    }
  }
  return channels;
}
function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}
