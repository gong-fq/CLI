// netlify/functions/bea-proxy.js  v5
// 关键修复：BEA 错误有时在 Results.Error 而非 BEAAPI.Error，两处均需检测

const https = require('https');
const BEA_API_BASE = 'https://apps.bea.gov/api/data';

function getApiKey() {
  const key = process.env.BEA_API_KEY;
  if (!key || key === 'GUEST_KEY' || key.trim() === '') return null;
  return key.trim();
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Referer':    'https://apps.bea.gov/',
        'User-Agent': 'Mozilla/5.0 (compatible; OpenCLI-BEA/1.0)',
        'Accept':     'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ parsed: JSON.parse(data), raw: data }); }
        catch (e) { resolve({ parsed: null, raw: data, parseError: e.message }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('请求超时（30s）')); });
  });
}

// 从 BEA 响应中提取错误（兼容 BEAAPI.Error 和 Results.Error 两种位置）
function extractBeaError(parsed) {
  if (!parsed) return null;
  // 位置 1: BEAAPI.Error
  if (parsed?.BEAAPI?.Error) return parsed.BEAAPI.Error;
  // 位置 2: BEAAPI.Results.Error（实测更常见）
  if (parsed?.BEAAPI?.Results?.Error) return parsed.BEAAPI.Results.Error;
  return null;
}

function errMsg(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.ErrorMessage || e.APIErrorMessage || e.errorcode || JSON.stringify(e);
}

function flattenData(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (typeof raw[0] === 'object' && !Array.isArray(raw[0])) return raw;
    if (Array.isArray(raw[0])) return raw.flat();
    return raw;
  }
  if (typeof raw === 'object') return [raw];
  return [];
}

function errResp(headers, code, msg, detail) {
  return { statusCode: code, headers, body: JSON.stringify({ error: msg, detail: detail || '' }) };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const apiKey = getApiKey();
  if (!apiKey) {
    return errResp(headers, 503, 'BEA_API_KEY 未配置',
      '请在 Netlify → Site settings → Environment variables 添加 BEA_API_KEY。申请：https://apps.bea.gov/api/signup/');
  }

  const q = event.queryStringParameters || {};

  // ── 调试端点 ──────────────────────────────────────────────────
  if (q.m === 'debug') {
    const table = q.table || 'T10101';
    const freq  = q.freq  || 'A';
    const year  = q.year  || 'X';
    const url   = `${BEA_API_BASE}?UserID=${encodeURIComponent(apiKey)}` +
      `&method=GetData&DataSetName=NIPA` +
      `&TableName=${encodeURIComponent(table)}` +
      `&Frequency=${encodeURIComponent(freq)}` +
      `&Year=${encodeURIComponent(year)}&ResultFormat=JSON`;
    try {
      const { parsed, raw } = await fetchUrl(url);
      const beaErr  = extractBeaError(parsed);
      const results = parsed?.BEAAPI?.Results;
      const beaData = results?.Data;
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          requestUrl:  url.replace(apiKey, 'KEY-HIDDEN'),
          beaError:    beaErr,
          resultsKeys: results ? Object.keys(results) : null,
          dataType:    typeof beaData,
          isArray:     Array.isArray(beaData),
          dataLength:  Array.isArray(beaData) ? beaData.length : null,
          firstItem:   Array.isArray(beaData) && beaData.length > 0 ? beaData[0] : null,
          rawSlice:    raw.slice(0, 1000),
        }, null, 2)
      };
    } catch (e) {
      return errResp(headers, 500, '调试失败：' + e.message, '');
    }
  }

  try {
    // ── 模式一：目录树 ────────────────────────────────────────────
    if (q.m === 'getTree') {
      const dataset   = q.dataset   || 'NIPA';
      const paramName = q.paramName || 'TableName';
      const url = `${BEA_API_BASE}?UserID=${encodeURIComponent(apiKey)}` +
        `&method=GetParameterValues` +
        `&DataSetName=${encodeURIComponent(dataset)}` +
        `&ParameterName=${encodeURIComponent(paramName)}&ResultFormat=JSON`;

      const { parsed } = await fetchUrl(url);
      const beaErr = extractBeaError(parsed);
      if (beaErr) return errResp(headers, 400, 'BEA 错误：' + errMsg(beaErr), JSON.stringify(beaErr));

      const raw    = parsed?.BEAAPI?.Results || {};
      const values = raw.ParamValue || raw.TableName || [];
      const nodes  = flattenData(values).map(v => ({
        id:       v.Key || v.TableName || v.Value || '',
        name:     v.Desc || v.Description || v.TableDescription || v.Key || '',
        isParent: false,
      })).filter(n => n.id);

      return { statusCode: 200, headers, body: JSON.stringify(nodes) };
    }

    // ── 模式二：数据集列表 ────────────────────────────────────────
    if (q.m === 'getDatasets') {
      const url = `${BEA_API_BASE}?UserID=${encodeURIComponent(apiKey)}` +
        `&method=GetDataSetList&ResultFormat=JSON`;
      const { parsed } = await fetchUrl(url);
      const beaErr = extractBeaError(parsed);
      if (beaErr) return errResp(headers, 400, 'BEA 错误：' + errMsg(beaErr), JSON.stringify(beaErr));

      const list  = flattenData(parsed?.BEAAPI?.Results?.Dataset);
      const nodes = list.map(d => ({
        id:   d.DatasetName || '',
        name: d.DatasetDescription || d.DatasetName || '',
        isParent: true,
      }));
      return { statusCode: 200, headers, body: JSON.stringify(nodes) };
    }

    // ── 模式三：查询数据 ──────────────────────────────────────────
    const dataset   = (q.dataset   || 'NIPA').trim();
    const tableName = (q.tableName || 'T10101').trim();
    const frequency = (q.frequency || 'A').trim().toUpperCase();
    let   year      = (q.year      || 'X').trim().toUpperCase();
    if (year === 'ALL') year = 'X';

    if (!tableName) return errResp(headers, 400, '缺少参数 tableName', '');
    if (!['A','Q','M'].includes(frequency))
      return errResp(headers, 400, `频率参数无效：${frequency}，应为 A/Q/M`, '');

    const url = `${BEA_API_BASE}?UserID=${encodeURIComponent(apiKey)}` +
      `&method=GetData` +
      `&DataSetName=${encodeURIComponent(dataset)}` +
      `&TableName=${encodeURIComponent(tableName)}` +
      `&Frequency=${encodeURIComponent(frequency)}` +
      `&Year=${encodeURIComponent(year)}` +
      `&ResultFormat=JSON`;

    const { parsed, raw: rawText } = await fetchUrl(url);

    // ★ 同时检查 BEAAPI.Error 和 Results.Error
    const beaErr = extractBeaError(parsed);
    if (beaErr) {
      return errResp(headers, 400,
        'BEA 错误：' + errMsg(beaErr),
        JSON.stringify(beaErr)
      );
    }

    const results  = parsed?.BEAAPI?.Results;
    const dataRows = flattenData(results?.Data);
    const notes    = results?.Notes || [];

    const debug = {
      dataset, tableName, frequency, year,
      resultsKeys: results ? Object.keys(results) : [],
      dataType:    typeof results?.Data,
      isArray:     Array.isArray(results?.Data),
      dataLength:  dataRows.length,
      firstRow:    dataRows[0] || null,
      rawSlice:    rawText.slice(0, 600),
    };

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ data: dataRows, meta: notes, debug }),
    };

  } catch (err) {
    return errResp(headers, 500, '代理函数异常：' + err.message, '');
  }
};
