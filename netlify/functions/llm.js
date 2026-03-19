// netlify/functions/llm.js
// DeepSeek Function Calling 代理

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_regression",
      description: "线性回归（OLS最小二乘），拟合直线，计算斜率、截距、R²",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "run_logistic",
      description: "逻辑回归二分类，梯度下降训练，输出决策边界和准确率",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "run_discriminant",
      description: "Fisher线性判别分析（LDA），计算判别方向和判别边界",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "run_kmeans",
      description: "K-均值聚类（Lloyd迭代），按用户指定K值聚类，K默认为3",
      parameters: {
        type: "object",
        properties: {
          k: { type: "integer", description: "聚类数量K，默认3，范围1-5", default: 3 }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_normal",
      description: "正态分布概率计算，绘制概率密度曲线",
      parameters: {
        type: "object",
        properties: {
          mu:  { type: "number", description: "均值μ，默认0" },
          sig: { type: "number", description: "标准差σ，默认1，必须大于0" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_poisson",
      description: "泊松分布概率计算，绘制PMF条形图",
      parameters: {
        type: "object",
        properties: {
          lambda: { type: "number", description: "泊松参数λ（均值），默认3，必须大于0" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_binomial",
      description: "二项分布概率计算，绘制PMF条形图",
      parameters: {
        type: "object",
        properties: {
          n: { type: "integer", description: "试验次数n，默认10" },
          p: { type: "number",  description: "成功概率p，默认0.5，范围(0,1)" }
        },
        required: []
      }
    }
  }
];

// 前端关键词 → 工具名的后备映射（当 DeepSeek 返回文本时兜底）
const KEYWORD_MAP = [
  { keys: ['泊松', 'poisson'],             tool: 'run_poisson',     argFn: extractPoissonArgs },
  { keys: ['二项', 'binomial'],             tool: 'run_binomial',    argFn: extractBinomialArgs },
  { keys: ['正态', '高斯', 'normal'],       tool: 'run_normal',      argFn: extractNormalArgs },
  { keys: ['回归', '直线', '拟合', '最小二乘'], tool: 'run_regression',  argFn: () => ({}) },
  { keys: ['逻辑', '分类', 'logistic'],     tool: 'run_logistic',    argFn: () => ({}) },
  { keys: ['判别', 'lda', 'fisher'],        tool: 'run_discriminant', argFn: () => ({}) },
  { keys: ['聚类', 'kmeans', 'k均值', 'k=', 'k＝'], tool: 'run_kmeans', argFn: extractKmeansArgs },
];

function extractPoissonArgs(msg) {
  const m = msg.match(/λ\s*=\s*([\d.]+)/i) || msg.match(/lambda\s*=\s*([\d.]+)/i) || msg.match(/([\d.]+)/);
  return { lambda: m ? parseFloat(m[1]) : 3 };
}
function extractBinomialArgs(msg) {
  const n = msg.match(/n\s*=\s*(\d+)/i);
  const p = msg.match(/p\s*=\s*([\d.]+)/i);
  return { n: n ? parseInt(n[1]) : 10, p: p ? parseFloat(p[1]) : 0.5 };
}
function extractNormalArgs(msg) {
  const mu  = msg.match(/μ\s*=\s*([\d.\-]+)/i) || msg.match(/均值\s*=?\s*([\d.\-]+)/);
  const sig = msg.match(/σ\s*=\s*([\d.]+)/i)   || msg.match(/标准差\s*=?\s*([\d.]+)/);
  return { mu: mu ? parseFloat(mu[1]) : 0, sig: sig ? parseFloat(sig[1]) : 1 };
}
function extractKmeansArgs(msg) {
  const k = msg.match(/k\s*[=＝]\s*(\d)/i);
  return { k: k ? parseInt(k[1]) : 3 };
}

function fallbackDetect(message) {
  const m = message.toLowerCase();
  for (const { keys, tool, argFn } of KEYWORD_MAP) {
    if (keys.some(k => m.includes(k))) {
      return { tool, args: argFn(message) };
    }
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { message, history = [] } = JSON.parse(event.body || "{}");
  if (!message) return { statusCode: 400, body: "missing message" };

  const systemPrompt = `你是一个统计分析工具台的调度助手。规则：
1. 只要用户消息涉及以下内容，必须立即调用对应工具，不得用文字回答：
   - 线性回归、拟合直线、最小二乘 → run_regression
   - 逻辑回归、分类、sigmoid → run_logistic
   - 判别分析、LDA、Fisher → run_discriminant
   - 聚类、K均值 → run_kmeans（提取K值）
   - 正态分布、高斯分布 → run_normal（提取μ和σ）
   - 泊松分布 → run_poisson（提取λ）
   - 二项分布 → run_binomial（提取n和p）
   - "展示"、"绘制"、"画"、"条形图"等词出现时，结合上下文判断分布/模型并调用工具
2. 用户追问上一个统计结果时（如"展示这个分布的图"），根据对话历史推断参数，直接调用工具。
3. 仅当消息完全与统计无关时才用文字回复。`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: message }
  ];

  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 512
      })
    });

    const data = await res.json();
    const choice = data.choices?.[0];

    if (!choice) {
      return { statusCode: 500, body: JSON.stringify({ error: "DeepSeek 无响应" }) };
    }

    // ── tool_call 路径 ────────────────────────────────
    if (choice.finish_reason === "tool_calls" && choice.message?.tool_calls?.length) {
      const call = choice.message.tool_calls[0];
      const toolName = call.function.name;
      let toolArgs = {};
      try { toolArgs = JSON.parse(call.function.arguments || "{}"); } catch(_) {}
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "tool_call", tool: toolName, args: toolArgs })
      };
    }

    // ── 文本回复路径：做关键词兜底检测 ───────────────
    const fallback = fallbackDetect(message);
    if (fallback) {
      // DeepSeek 没有 function call，但消息含统计关键词 → 强制走工具
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "tool_call", tool: fallback.tool, args: fallback.args })
      };
    }

    // 真正的非统计问题，返回文本
    const text = choice.message?.content || "（无回复）";
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", reply: text })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
