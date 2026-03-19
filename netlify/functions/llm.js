// netlify/functions/llm.js
// DeepSeek Function Calling 代理，保护 API Key

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { message, history = [] } = JSON.parse(event.body || "{}");
  if (!message) return { statusCode: 400, body: "missing message" };

  const messages = [
    {
      role: "system",
      content: "你是一个统计分析助手，负责理解用户的统计分析需求并调用对应工具。用户可能用中文描述，你需要准确识别意图并选择合适的工具和参数。如果用户的问题与统计分析无关，请友好说明你只支持统计分析功能。"
    },
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

    // 有 function call
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

    // 普通文本回复
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
