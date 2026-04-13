// netlify/functions/bea-relay.js
// 服务端中转：将请求转发到 bea-gong.netlify.app，绕过浏览器跨域限制

const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CLI-Gong-Relay/1.0)',
        'Accept': 'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const q = event.queryStringParameters || {};
  const tableName = q.tableName || 'T10101';
  const frequency = q.frequency || 'Q';
  const year      = q.year      || 'X';

  const targetUrl =
    `https://bea-gong.netlify.app/.netlify/functions/bea-proxy` +
    `?tableName=${encodeURIComponent(tableName)}` +
    `&frequency=${encodeURIComponent(frequency)}` +
    `&year=${encodeURIComponent(year)}`;

  try {
    const body = await fetchUrl(targetUrl);
    return { statusCode: 200, headers, body };
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: '中转请求失败：' + err.message })
    };
  }
};
