// netlify/functions/llm.js
// DeepSeek Function Calling + 动态代码生成 代理

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
  },
  {
    type: "function",
    function: {
      name: "run_custom_plot",
      description: "当用户要求绘制工具集中没有的统计分布或图形时调用此工具，例如：卡方分布、t分布、F分布、对数正态分布、Beta分布、Gamma分布、指数分布、均匀分布等。生成纯JavaScript绘图代码在Canvas上执行。",
      parameters: {
        type: "object",
        properties: {
          title:       { type: "string", description: "图表标题，如'卡方分布 χ²(k=5)'" },
          info:        { type: "string", description: "图表下方参数信息，如'自由度 k = 5'" },
          plot_type:   { type: "string", enum: ["curve", "bars"], description: "curve=连续分布曲线, bars=离散分布条形图" },
          x_min:       { type: "number", description: "x轴最小值" },
          x_max:       { type: "number", description: "x轴最大值" },
          y_max:       { type: "number", description: "y轴最大值（概率密度上限）" },
          pdf_js:      { type: "string", description: "JavaScript函数体字符串，参数为x，返回该点的PDF/PMF值。只写函数体，不含function声明。例如：'const k=5; return Math.pow(x,k/2-1)*Math.exp(-x/2)/(Math.pow(2,k/2)*gamma(k/2));'" },
          description: { type: "string", description: "分布的简要统计说明，包含均值、方差等，2-3句话" }
        },
        required: ["title", "plot_type", "x_min", "x_max", "y_max", "pdf_js", "description"]
      }
    }
  }
];

// 关键词兜底映射（仅针对已有的7个固定工具）
const KEYWORD_MAP = [
  { keys: ['泊松', 'poisson'],                  tool: 'run_poisson',     argFn: extractPoissonArgs },
  { keys: ['二项', 'binomial'],                  tool: 'run_binomial',    argFn: extractBinomialArgs },
  { keys: ['正态', '高斯', 'normal gaussian'],   tool: 'run_normal',      argFn: extractNormalArgs },
  { keys: ['线性回归', '拟合直线', '最小二乘'],  tool: 'run_regression',  argFn: () => ({}) },
  { keys: ['逻辑回归', '逻辑分类', 'logistic'],  tool: 'run_logistic',    argFn: () => ({}) },
  { keys: ['判别', 'lda', 'fisher'],             tool: 'run_discriminant', argFn: () => ({}) },
  { keys: ['聚类', 'kmeans', 'k均值'],           tool: 'run_kmeans',      argFn: extractKmeansArgs },
];

function extractPoissonArgs(msg) {
  const m = msg.match(/λ\s*=\s*([\d.]+)/i) || msg.match(/lambda\s*=\s*([\d.]+)/i) || msg.match(/([\d.]+)/);
  return { lambda: m ? parseFloat(m[1]) : 3 };
}
function extractBinomialArgs(msg) {
  const n = msg.match(/n\s*=\s*(\d+)/i), p = msg.match(/p\s*=\s*([\d.]+)/i);
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
    if (keys.some(k => m.includes(k))) return { tool, args: argFn(message) };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const { message, history = [] } = JSON.parse(event.body || "{}");
  if (!message) return { statusCode: 400, body: "missing message" };

  const systemPrompt = `你是统计分析工具台的调度助手，规则如下：

【固定工具】以下请求必须调用对应工具，不得文字回答：
- 线性回归/拟合直线/最小二乘 → run_regression
- 逻辑回归/分类/sigmoid → run_logistic  
- 判别分析/LDA/Fisher → run_discriminant
- 聚类/K均值 → run_kmeans（提取K值）
- 正态分布/高斯分布 → run_normal（提取μ、σ）
- 泊松分布 → run_poisson（提取λ）
- 二项分布 → run_binomial（提取n、p）

【动态绘图工具】用户要求绘制以下分布时，调用 run_custom_plot，自己编写正确的PDF/PMF的JavaScript代码：
- 卡方分布χ²(k)：PDF = x^(k/2-1)*exp(-x/2) / (2^(k/2)*Γ(k/2))，x>0
- t分布t(ν)：PDF ∝ (1+x²/ν)^(-(ν+1)/2)
- F分布F(d1,d2)：PDF涉及Beta函数
- 对数正态分布：PDF = exp(-(ln(x)-μ)²/(2σ²)) / (x*σ*sqrt(2π))，x>0
- Beta分布Beta(α,β)：PDF = x^(α-1)*(1-x)^(β-1)/B(α,β)，0<x<1
- Gamma分布Gamma(α,β)：PDF = x^(α-1)*exp(-x/β) / (β^α*Γ(α))，x>0
- 指数分布Exp(λ)：PDF = λ*exp(-λx)，x>0
- 均匀分布U(a,b)：PDF = 1/(b-a)，a<x<b
- 以及用户要求的任何其他统计分布

pdf_js字段中可以使用以下辅助函数（已在前端实现）：
- gamma(n)：Gamma函数（支持半整数）
- lnGamma(n)：ln(Gamma(n))
- betaFn(a,b)：Beta函数

【其他】仅当消息完全与统计/数学无关时，才返回文字说明。`;

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
        max_tokens: 1024
      })
    });

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) return { statusCode: 500, body: JSON.stringify({ error: "DeepSeek 无响应" }) };

    // tool_call 路径
    if (choice.finish_reason === "tool_calls" && choice.message?.tool_calls?.length) {
      const call = choice.message.tool_calls[0];
      let toolArgs = {};
      try { toolArgs = JSON.parse(call.function.arguments || "{}"); } catch(_) {}
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "tool_call", tool: call.function.name, args: toolArgs })
      };
    }

    // 文本回复：关键词兜底（仅固定工具）
    const fallback = fallbackDetect(message);
    if (fallback) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "tool_call", tool: fallback.tool, args: fallback.args })
      };
    }

    // 普通文字回复
    const text = choice.message?.content || "（无回复）";
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", reply: text })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
