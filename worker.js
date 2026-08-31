// Cloudflare Worker：股票資料跨網域代理
// 只允許代理白名單網域，避免被濫用當成任意代理。
// Yahoo Finance 的股價 API 需要先取得 cookie + crumb 通行證才能查詢，
// 這裡自動處理這段流程並短暫快取通行證，避免每次分析都重新申請。
// 部署方式見 README.md。

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'openapi.twse.com.tw',
  'mopsfin.twse.com.tw',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function isYahooChart(u){
  return (u.hostname === 'query1.finance.yahoo.com' || u.hostname === 'query2.finance.yahoo.com')
    && u.pathname.startsWith('/v8/finance/chart/');
}

function getSetCookies(res){
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie();
  }
  const sc = res.headers.get('set-cookie');
  return sc ? [sc] : [];
}

// 取得 Yahoo 的 cookie + crumb 通行證，短暫快取在 Cloudflare 的 Cache API 裡（約 20 分鐘），
// 避免每次查股票都要重新申請一次，拖慢速度。
async function getYahooCredentials(){
  const cache = caches.default;
  const cacheKey = new Request('https://internal-cache.local/yahoo-credentials');
  const cached = await cache.match(cacheKey);
  if (cached) {
    return await cached.json();
  }

  const cookieRes = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const cookies = getSetCookies(cookieRes).map(c => c.split(';')[0]).join('; ');

  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookies },
  });
  const crumb = (await crumbRes.text()).trim();

  const creds = { cookies, crumb };
  if (crumb && !crumb.includes('<')) {
    const cacheRes = new Response(JSON.stringify(creds), {
      headers: { 'Cache-Control': 'max-age=1200', 'Content-Type': 'application/json' },
    });
    await cache.put(cacheKey, cacheRes);
  }
  return creds;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');

    if (!target) {
      return new Response('缺少 url 參數，例如 /?url=https://query1.finance.yahoo.com/...', {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response('無效的 url 參數', {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return new Response('此網域不在白名單內：' + targetUrl.hostname, {
        status: 403,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    try {
      const fetchOptions = {
        headers: { 'User-Agent': UA, 'Accept': '*/*' },
        cf: { cacheTtl: 60, cacheEverything: true },
      };

      // 股價查詢需要 Yahoo 的 cookie + crumb 通行證才不會被 401 拒絕
      if (isYahooChart(targetUrl)) {
        const { cookies, crumb } = await getYahooCredentials();
        if (cookies) fetchOptions.headers['Cookie'] = cookies;
        if (crumb) targetUrl.searchParams.set('crumb', crumb);
      }

      let upstream = await fetch(targetUrl.toString(), fetchOptions);

      // 通行證可能剛好過期，401 的話清掉快取重試一次
      if (upstream.status === 401 && isYahooChart(targetUrl)) {
        await caches.default.delete(new Request('https://internal-cache.local/yahoo-credentials'));
        const { cookies, crumb } = await getYahooCredentials();
        if (cookies) fetchOptions.headers['Cookie'] = cookies;
        if (crumb) targetUrl.searchParams.set('crumb', crumb);
        upstream = await fetch(targetUrl.toString(), fetchOptions);
      }

      const body = await upstream.arrayBuffer();
      const contentType = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';

      return new Response(body, {
        status: upstream.status,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=60',
        },
      });
    } catch (e) {
      return new Response('代理請求失敗：' + e.message, {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  },
};
