// netlify/functions/llm.js
// DeepSeek Function Calling + 动态代码生成 代理

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_regression",
      description: "线性回归（OLS最小二乘），拟合直线，计算斜率、截距、R²。若用户消息中含有数值数组（来自数据管道），必须将其提取并传入 x 和 y 参数。",
      parameters: {
        type: "object",
        properties: {
          x: {
            type: "array",
            items: { type: "number" },
            description: "自变量数组。若消息含数值序列，提取为 [1,2,3,...n] 序号；否则省略。"
          },
          y: {
            type: "array",
            items: { type: "number" },
            description: "因变量数组。若消息含数值序列，提取全部数值；否则省略。"
          }
        },
        required: []
      }
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
      description: "当用户要求绘制工具集中没有的统计分布或图形时调用此工具，例如：卡方分布、t分布、F分布、对数正态分布、Beta分布、Gamma分布、指数分布、均匀分布等。支持单曲线(pdf_js)和多曲线(curves数组)模式。y_max可省略，前端会自动计算。",
      parameters: {
        type: "object",
        properties: {
          title:       { type: "string", description: "图表标题，如'卡方分布 χ²'" },
          info:        { type: "string", description: "图表下方参数信息" },
          plot_type:   { type: "string", enum: ["curve", "bars"], description: "curve=连续分布, bars=离散分布" },
          x_min:       { type: "number", description: "x轴起始值（连续分布建议从0.001而非0开始，避免奇点）" },
          x_max:       { type: "number", description: "x轴结束值" },
          y_max:       { type: "number", description: "y轴上限，可省略由前端自动计算（推荐省略）" },
          pdf_js:      { type: "string", description: "单曲线模式：JS函数体，参数x，返回PDF值。可用gamma(n)/lnGamma(n)/betaFn(a,b)。只写函数体不含声明。" },
          curves:      { type: "array",  description: "多曲线模式：数组，每项{label:string, pdf_js:string, color?:string}。用于在同一图中展示多个参数的分布。与pdf_js二选一，优先用curves。", items: { type: "object" } },
          description: { type: "string", description: "分布的简要统计说明，2-3句话" }
        },
        required: ["title", "plot_type", "x_min", "x_max"]
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

【数据管道 — 极重要】当用户消息中包含"数值：..."这一行时，表示来自数据管道的真实统计数据。
调用 run_regression 时必须：
1. 将"数值："后面的所有数字提取为 y 数组
2. 将 x 设为 [1, 2, 3, ..., n]（与 y 等长的序号）
3. 绝对不能省略 x 和 y 参数，否则前端会用错误的演示数据

例：消息含"数值：100, 200, 350"，则传入 x=[1,2,3], y=[100,200,350]

【动态绘图工具】用户要求绘制工具集之外的分布时，调用 run_custom_plot。
必须使用 curves 数组（每个参数一条曲线），不要使用单一 pdf_js。
x_min/x_max/y_max 可根据分布特点设置，y_max 可省略由前端自动计算。

以下是各分布的标准 pdf_js 写法（直接复制使用，k/nu/d1/d2/mu/sigma/alpha/beta/lambda 替换为具体数值）：

卡方分布 χ²(k)，x>0，x_min=0.001：
  "if(x<=0) return 0; var k=5; return Math.exp((k/2-1)*Math.log(x) - x/2 - (k/2)*Math.log(2) - lnGamma(k/2));"

t分布 t(ν)，x∈(-∞,+∞)：
  "var nu=5; return Math.exp(lnGamma((nu+1)/2) - lnGamma(nu/2)) / (Math.sqrt(nu*Math.PI)) * Math.pow(1+x*x/nu, -(nu+1)/2);"

F分布 F(d1,d2)，x>0，x_min=0.001：
  "if(x<=0) return 0; var d1=5,d2=10; var lp=lnGamma((d1+d2)/2)-lnGamma(d1/2)-lnGamma(d2/2)+(d1/2)*Math.log(d1/d2)+(d1/2-1)*Math.log(x)-((d1+d2)/2)*Math.log(1+d1*x/d2); return Math.exp(lp);"

对数正态 LN(μ,σ)，x>0，x_min=0.001：
  "if(x<=0) return 0; var mu=0,sigma=0.5; return Math.exp(-Math.pow(Math.log(x)-mu,2)/(2*sigma*sigma)) / (x*sigma*Math.sqrt(2*Math.PI));"

Beta分布 Beta(α,β)，0<x<1，x_min=0.001，x_max=0.999：
  "if(x<=0||x>=1) return 0; var a=2,b=5; return Math.exp((a-1)*Math.log(x)+(b-1)*Math.log(1-x)-lnGamma(a)-lnGamma(b)+lnGamma(a+b));"

Gamma分布 Gamma(α,β)，x>0，x_min=0.001：
  "if(x<=0) return 0; var a=2,b=2; return Math.exp((a-1)*Math.log(x) - x/b - a*Math.log(b) - lnGamma(a));"

指数分布 Exp(λ)，x>0：
  "if(x<0) return 0; var lam=1; return lam*Math.exp(-lam*x);"

均匀分布 U(a,b)：
  "var a=0,b=1; return (x>=a&&x<=b)?1/(b-a):0;"

【重要规则】
1. 多参数对比时，必须用 curves 数组，每条曲线对应一个参数值，有独立的 label 和 pdf_js
2. pdf_js 只写函数体（不含 function 声明），参数名必须是 x，可调用 gamma/lnGamma/betaFn
3. 所有对 x 的限制（x>0 等）必须在 pdf_js 内部用 if 判断，不能依赖 x_min
4. 使用 lnGamma 而非直接用 gamma 做乘除，避免数值溢出

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
