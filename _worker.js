/**
 * 导航站后台内核（Cloudflare Pages 单文件 Worker）
 *
 * 作用：
 *   1) 首页服务端渲染：从 KV 读数据 → 套进 _template.html → 返回完整 HTML
 *      （这样做的好处：搜索引擎爬到的仍是完整内容，不影响收录）
 *   2) 后台 API：登录校验、读写站点数据、上传/读取图标
 *   3) 其余请求（CSS/JS/图片/admin.html）原样交给静态文件
 *
 * 安全设计：
 *   - 密码只从环境变量 ADMIN_PASSWORD 读取，不写在代码里
 *   - 登录成功后下发 HMAC 签名的 HttpOnly Cookie，服务端校验
 *   - 写操作额外校验 Origin，防跨站提交
 *
 * 容错设计：
 *   - 只要 KV 没绑定、或任何一步出错，就原样返回原来的静态 index.html
 *     也就是说：即使后台没配好，网站也照常显示，不会白屏
 */

const DATA_KEY = 'site:data';        // KV 里存站点数据的键
const ICON_PREFIX = 'icon:';         // KV 里存图标的键前缀
const COOKIE_NAME = 'nav_admin';     // 登录 Cookie 名
const SESSION_MS = 12 * 60 * 60 * 1000;  // 登录有效期 12 小时
const SEED_PATH = '/data/seed.json';     // 初始数据文件
const TEMPLATE_PATH = '/_template.html'; // 首页模板

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- 后台 API ----
    if (path.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ ok: false, error: '服务器内部错误：' + err.message }, 500);
      }
    }

    // ---- 首页：服务端渲染 ----
    if (path === '/' || path === '/index.html' || path === '/index.htm') {
      try {
        const rendered = await renderHome(request, env);
        if (rendered) return rendered;
      } catch (err) {
        // 出错就走静态兜底，下面会返回原 index.html。
        // 保留日志，方便在 Cloudflare 后台的日志里排查为什么没走动态渲染。
        console.error('[nav-ssr] 首页渲染失败，已回退静态页：', err && err.stack || err);
      }
    }

    // ---- 其他：静态资源 ----
    return serveAsset(request, env);
  },
};

/* ============================================================
 *  静态资源
 * ========================================================== */

function serveAsset(request, env) {
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('未找到该资源', { status: 404 });
}

/* ============================================================
 *  首页服务端渲染
 * ========================================================== */

async function renderHome(request, env) {
  const kv = env.NAV_KV;
  if (!kv) return null;                    // KV 没绑定 → 交给静态页

  let data = null;
  try {
    data = await kv.get(DATA_KEY, { type: 'json' });
  } catch (e) { /* 读失败当没数据 */ }

  // KV 里还没存过数据 → 用随包的 seed.json 作为初始内容
  if (!data || !Array.isArray(data.categories)) {
    try {
      const seedRes = await env.ASSETS.fetch(new URL(SEED_PATH, request.url).href);
      if (seedRes.ok) data = await seedRes.json();
    } catch (e) { /* 忽略 */ }
  }
  if (!data || !Array.isArray(data.categories)) return null;

  // 旧数据没有 sidebar 字段 → 从 seed.json 借用分组结构（只借用结构，内容仍以 KV 为准）
  if (!Array.isArray(data.sidebar)) {
    try {
      const seedRes = await env.ASSETS.fetch(new URL(SEED_PATH, request.url).href);
      if (seedRes.ok) {
        const seed = await seedRes.json();
        if (Array.isArray(seed.sidebar)) data.sidebar = seed.sidebar;
      }
    } catch (e) { /* 没有 sidebar 就走扁平渲染兜底 */ }
  }

  const tplRes = await env.ASSETS.fetch(new URL(TEMPLATE_PATH, request.url).href);
  if (!tplRes || !tplRes.ok) return null;
  let html = await tplRes.text();

  html = html.replace('<!--THEME_STYLE-->', themeStyle(data.theme));
  html = html.replace('<!--SIDEBAR_MENU-->', renderSidebar(data));
  html = html.replace('<!--SITE_CONTENT-->', renderContent(data));

  // 同步标题
  if (data.site && data.site.title) {
    html = html.replace(/<title>[\s\S]*?<\/title>/i, '<title>' + esc(data.site.title) + '</title>');
  }

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',   // 后台改完立刻生效，不做缓存
    },
  });
}

/** 生成侧边栏菜单 */
/** 侧边栏：按数据里的 sidebar 分组结构渲染（与原版手写结构一致）。
 *  数据格式（seed.json / KV 顶层字段 sidebar）：
 *    { type:'item',  cat:'分类id', icon:'far fa-star' }                 顶级项
 *    { type:'group', name:'组名',  icon:'fas fa-film',
 *      cats:['分类id' 或 {id:'分类id', label:'显示名'}, ...] }          可折叠分组
 *  兼容：cats 里也可以写分类名（旧格式），按名字兜底匹配。
 *  不在 sidebar 里出现的分类会自动追加为顶级项，保证后台新增的分类也能显示。 */
function renderSidebar(data) {
  const cats = data.categories || [];
  const byId = {}, byName = {};
  cats.forEach((c) => { byId[c.id] = c; byName[c.name] = c; });
  const resolve = (ref) => byId[ref] || byName[ref];
  const used = new Set();
  let items = '';

  const side = Array.isArray(data.sidebar) ? data.sidebar : [];
  for (const g of side) {
    if (g.type === 'group') {
      const kids = (g.cats || [])
        .map((x) => resolve(typeof x === 'string' ? x : x.id))
        .filter(Boolean);
      kids.forEach((c) => used.add(c.id));
      if (!kids.length) continue;
      const firstId = kids[0].id;
      const lis = kids.map((c) => {
        const raw = (g.cats || []).find((x) => (resolve(typeof x === 'string' ? x : x.id) || {}).id === c.id);
        const label = (raw && typeof raw === 'object' && raw.label) ? raw.label : c.name;
        return `<li><a href="#${esc(c.id)}" class="smooth"><span>${esc(label)}</span></a></li>`;
      }).join('\n');
      items += `                                <li class="sidebar-item">
                                    <a href="#${esc(firstId)}" class="smooth change-href" data-change="#${esc(firstId)}">
                                        <i class="${esc(g.icon || 'far fa-folder-open')} fa-lg icon-fw icon-lg mr-2"></i>
                                        <span>${esc(g.name)}</span>
                                        <i class="iconfont icon-arrow-r-m sidebar-more text-sm"></i>
                                    </a>
                                    <ul>
${lis}
                                    </ul>
                                </li>`;
    } else {
      const c = resolve(g.cat);
      if (!c) continue;
      used.add(c.id);
      items += `                                <li class="sidebar-item">
                                    <a href="#${esc(c.id)}" class="smooth">
                                        <i class="${esc(g.icon || 'far fa-star')} fa-lg icon-fw icon-lg mr-2"></i>
                                        <span>${esc(c.name)}</span>
                                    </a>
                                </li>`;
    }
  }

  // sidebar 里没覆盖到的分类（后台新加的）→ 追加为顶级项，不丢可见性
  const extra = cats.filter((c) => !used.has(c.id));
  if (extra.length) {
    items += '\n' + extra.map((c) => `                                <li class="sidebar-item">
                                    <a href="#${esc(c.id)}" class="smooth">
                                        <i class="far fa-star fa-lg icon-fw icon-lg mr-2"></i>
                                        <span>${esc(c.name)}</span>
                                    </a>
                                </li>`).join('\n');
  }
  return `                            <ul>\n${items}\n                            </ul>`;
}

/** 生成内容区：分类标题 + 该分类下的网站卡片 */
function renderContent(data) {
  return (data.categories || []).map((c) => {
    const cards = (c.items || []).map(cardHtml).join('\n');
    return `<div class="d-flex flex-fill">
    <h4 class="text-gray text-lg mb-4">
        <i class="site-tag iconfont icon-tag icon-lg mr-1" id="${esc(c.id)}"></i>
        ${esc(c.name)}
    </h4>
    <div class="flex-fill"></div>
</div>
<div class="row">
${cards}
</div>`;
  }).join('\n\n');
}

/** 单个网站卡片（结构与原来手写的完全一致，保证样式不变） */
function cardHtml(it) {
  const icon = it.icon || 'assets/images/logos/default.webp';
  const desc = it.desc || '';
  return `    <div class="url-card col-6 col-sm-6 col-md-4 col-xl-5a col-xxl-6a">
        <div class="url-body default">
            <a href="${esc(it.url)}" target="_blank" data-id="" data-url="${esc(it.url)}"
                class="card no-c mb-4" data-toggle="tooltip" data-placement="bottom" data-original-title="${esc(desc)}">
                <div class="card-body">
                    <div class="url-content d-flex align-items-center">
                        <div class="url-img mr-2 d-flex align-items-center justify-content-center">
                            <img class="lazy" src="${esc(icon)}" data-src="${esc(icon)}"
                                onerror="javascript:this.src='assets/images/logos/default.webp'" alt="${esc(it.title)}">
                        </div>
                        <div class="url-info flex-fill">
                            <div class="text-sm overflowClip_1">
                                <strong>${esc(it.title)}</strong>
                            </div>
                            <p class="overflowClip_1 m-0 text-muted text-xs">${esc(desc)}</p>
                        </div>
                    </div>
                </div>
            </a>
            <a href="${esc(it.url)}" class="togo text-center text-muted is-views" data-toggle="tooltip"
                data-placement="right" title="直达" rel="nofollow">
                <i class="iconfont icon-goto"></i>
            </a>
        </div>
    </div>`;
}

/** 主题配色：注入一段 <style> 覆盖关键颜色 */
function themeStyle(theme) {
  if (!theme) return '';
  const t = {
    primary: theme.primary || '#f1404b',
    bg: theme.bg || '#f6f7f9',
    card: theme.card || '#ffffff',
    text: theme.text || '#1f2328',
    muted: theme.muted || '#656d76',
  };
  return `<style id="nav-theme">
:root{--nav-primary:${cssSafe(t.primary)};--nav-bg:${cssSafe(t.bg)};--nav-card:${cssSafe(t.card)};--nav-text:${cssSafe(t.text)};--nav-muted:${cssSafe(t.muted)};}
body{background-color:var(--nav-bg)!important;color:var(--nav-text)!important;}
.url-body .card, .friendlink, .sidebar-nav{background-color:var(--nav-card)!important;}
.text-muted, .text-gray{color:var(--nav-muted)!important;}
a:hover, a:focus{color:var(--nav-primary)!important;}
.btn-primary, .bg-primary{background-color:var(--nav-primary)!important;border-color:var(--nav-primary)!important;}
.search-input:focus, .s-search input:focus{border-color:var(--nav-primary)!important;}
</style>`;
}

/* ============================================================
 *  后台 API
 * ========================================================== */

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // ---- 登录 ----
  if (path === '/api/login' && method === 'POST') {
    const pwd = env.ADMIN_PASSWORD;
    if (!pwd) {
      return json({ ok: false, error: '后台还没设置密码。请到 Cloudflare Pages → 项目 → 设置 → 环境变量，添加 ADMIN_PASSWORD。' }, 503);
    }
    let body = {};
    try { body = await request.json(); } catch (e) { /* 空 body */ }
    if (!checkPassword(String(body.password || ''), String(pwd))) {
      return json({ ok: false, error: '密码不对' }, 401);
    }
    const token = await makeToken(String(pwd));
        return json({ ok: true }, 200, {
      'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
    });
  }

  // ---- 退出 ----
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, {
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    });
  }

  // ---- 检查登录状态 ----
  if (path === '/api/session' && method === 'GET') {
    const ok = await isAuthed(request, env);
    return json({ ok: true, authed: ok, configured: !!env.ADMIN_PASSWORD, kv: !!env.NAV_KV });
  }

  // ---- 读取站点数据（需登录）----
  if (path === '/api/data' && method === 'GET') {
    const auth = await requireAuth(request, env);
    if (auth) return auth;
    let data = null;
    try { data = await env.NAV_KV.get(DATA_KEY, { type: 'json' }); } catch (e) { /* 无 */ }
    return json({ ok: true, data });
  }

  // ---- 保存站点数据（需登录）----
  if (path === '/api/data' && method === 'POST') {
    const auth = await requireAuth(request, env);
    if (auth) return auth;
    let body;
    try { body = await request.json(); } catch (e) {
      return json({ ok: false, error: '数据格式不对' }, 400);
    }
    const data = body && body.data ? body.data : body;
    if (!data || !Array.isArray(data.categories)) {
      return json({ ok: false, error: '缺少 categories 分类数据' }, 400);
    }
    // 规范一下：每个分类必须有 id / name / items
    data.categories = data.categories.map((c, i) => ({
      id: String(c.id || ('cat' + (i + 1))),
      name: String(c.name || ('分类' + (i + 1))),
      icon: String(c.icon || 'far fa-star'),
      items: Array.isArray(c.items) ? c.items.map((it) => ({
        title: String(it.title || ''),
        url: String(it.url || ''),
        desc: String(it.desc || ''),
        icon: String(it.icon || ''),
      })).filter((it) => it.title && it.url) : [],
    }));

    // 规范 sidebar（大分类）：引用一律降为「分类 id 字符串」，
    // 兼容旧数据的 {id,label} 对象写法，并清掉指向已删分类的悬空引用。
    const catIds = new Set(data.categories.map((c) => c.id));
    const nameToId = {};
    data.categories.forEach((c) => { nameToId[c.name] = c.id; });
    // 引用可能是 id，也可能是分类名（旧数据混着写），统一换算成 id
    const oneId = (x) => {
      const v = (x && typeof x === 'object') ? (x.id || '') : (x || '');
      const s = v ? String(v) : '';
      if (!s) return '';
      return catIds.has(s) ? s : (nameToId[s] || '');
    };
    if (Array.isArray(data.sidebar)) {
      data.sidebar = data.sidebar
        .filter((g) => g && (g.type === 'group' || g.type === 'item'))
        .map((g) => {
          if (g.type === 'item') {
            return { type: 'item', cat: oneId(g.cat), icon: String(g.icon || 'far fa-star') };
          }
          const cats = [];
          (Array.isArray(g.cats) ? g.cats : []).forEach((x) => {
            const id = oneId(x);
            if (id && catIds.has(id) && !cats.includes(id)) cats.push(id);
          });
          return {
            type: 'group',
            name: String(g.name || '分组'),
            icon: String(g.icon || 'far fa-folder-open'),
            cats,
          };
        })
        .filter((g) => (g.type === 'item' ? catIds.has(g.cat) : true));
    }

    await env.NAV_KV.put(DATA_KEY, JSON.stringify(data));
    return json({ ok: true });
  }

  // ---- 上传图标（需登录）----
  if (path === '/api/icon' && method === 'POST') {
    const auth = await requireAuth(request, env);
    if (auth) return auth;
    let body;
    try { body = await request.json(); } catch (e) {
      return json({ ok: false, error: '数据格式不对' }, 400);
    }
    const raw = String(body.data || '');
    const comma = raw.indexOf(',');
    const b64 = comma >= 0 ? raw.slice(comma + 1) : raw;
    if (!b64) return json({ ok: false, error: '图片内容为空' }, 400);
    if (b64.length > 700 * 1024) {
      return json({ ok: false, error: '图片太大了（base64 超过 700KB），请换一张小一点的' }, 400);
    }
    const type = String(body.type || 'image/png');
    const id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await env.NAV_KV.put(ICON_PREFIX + id, JSON.stringify({ type, b64 }));
    return json({ ok: true, url: '/api/icon/' + id });
  }

  // ---- 读取图标（公开，供首页显示）----
  const m = path.match(/^\/api\/icon\/([A-Za-z0-9_-]+)$/);
  if (m && method === 'GET') {
    const rec = await env.NAV_KV.get(ICON_PREFIX + m[1]);
    if (!rec) return new Response('图标不存在', { status: 404 });
    let obj;
    try { obj = JSON.parse(rec); } catch (e) {
      return new Response('图标数据损坏', { status: 500 });
    }
    let bin;
    try { bin = atob(obj.b64); } catch (e) {
      return new Response('图标数据损坏', { status: 500 });
    }
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Response(arr, {
      headers: {
        'content-type': obj.type || 'image/png',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  return json({ ok: false, error: '接口不存在' }, 404);
}

/* ============================================================
 *  登录鉴权
 * ========================================================== */

async function requireAuth(request, env) {
  if (!env.NAV_KV) {
    return json({ ok: false, error: '后台还没绑定 KV 存储。请到 Cloudflare Pages → 项目 → 设置 → Functions → KV 命名空间绑定，变量名填 NAV_KV。' }, 503);
  }
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '后台还没设置密码。请在 Pages 环境变量里添加 ADMIN_PASSWORD。' }, 503);
  }
  if (!sameOrigin(request)) {
    return json({ ok: false, error: '跨站请求已被拒绝' }, 403);
  }
  if (!(await isAuthed(request, env))) {
    return json({ ok: false, error: '登录已过期，请重新登录', needLogin: true }, 401);
  }
  return null;
}

async function isAuthed(request, env) {
  const secret = env.ADMIN_PASSWORD;
  if (!secret) return false;
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return false;
  return await verifyToken(token, String(secret));
}

/** 简单的同源校验，防跨站提交 */
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;   // 没有 Origin 头（如 curl）时放行
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (e) {
    return false;
  }
}

function getCookie(request, name) {
  const h = request.headers.get('cookie') || '';
  const parts = h.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    if (p.slice(0, idx).trim() === name) return decodeURIComponent(p.slice(idx + 1).trim());
  }
  return '';
}

/** 密码比对（逐字符比较，避免短路泄露长度信息） */
function checkPassword(input, expected) {
  let diff = input.length ^ expected.length;
  for (let i = 0; i < Math.max(input.length, expected.length); i++) {
    diff |= (input.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/* ============================================================
 *  HMAC 签名令牌
 * ========================================================== */

async function makeToken(secret) {
  const payload = b64url(JSON.stringify({ exp: Date.now() + SESSION_MS }));
  const sig = await hmacSign(payload, secret);
  return payload + '.' + sig;
}

async function verifyToken(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const ok = await hmacVerify(payload, sig, secret);
  if (!ok) return false;
  try {
    const obj = JSON.parse(b64urlDecode(payload));
    return typeof obj.exp === 'number' && Date.now() < obj.exp;
  } catch (e) {
    return false;
  }
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function hmacSign(payload, secret) {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return b64urlFromBuffer(sig);
}

async function hmacVerify(payload, sig, secret) {
  const key = await importKey(secret);
  const buf = b64urlToBuffer(sig);
  if (!buf) return false;
  try {
    return await crypto.subtle.verify('HMAC', key, buf, new TextEncoder().encode(payload));
  } catch (e) {
    return false;
  }
}

/* ---- base64url 工具 ---- */

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(arr);
}

function b64urlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuffer(s) {
  try {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  } catch (e) {
    return null;
  }
}

/* ============================================================
 *  小工具
 * ========================================================== */

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** HTML 转义，防止内容里的尖括号破坏页面 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** CSS 值清洗，只允许安全字符，防止注入 */
function cssSafe(v) {
  const s = String(v == null ? '' : v);
  return /^[a-zA-Z0-9#().,\s%-]{1,40}$/.test(s) ? s : '#f1404b';
}
