exports.handler = async (event) => {
const body = JSON.parse(event.body);
const msg = body.message;

let reply = "";

// 🧠 简单“AI决策”（后面可换DeepSeek）
reply = `已调用统计CLI：\n斜率 = ${result.slope.toFixed(2)}\n截距 = ${result.intercept.toFixed(2)}`;
// 👉 模拟 CLI 调用
const result = linearRegression({
x: [1, 2, 3, 4],
y: [2, 4, 5, 8]
});

```
reply = `已调用统计CLI：
```

斜率 = ${result.slope.toFixed(2)}
截距 = ${result.intercept.toFixed(2)}`;
} else {
reply = "我目前支持：线性回归（试试说：拟合一条直线）";
}

return {
statusCode: 200,
body: JSON.stringify({ reply })
};
};

// ⚙️ 模拟 CLI 工具
function linearRegression(data) {
const x = data.x;
const y = data.y;

const n = x.length;
const xMean = x.reduce((a,b)=>a+b)/n;
const yMean = y.reduce((a,b)=>a+b)/n;

let num = 0, den = 0;
for (let i = 0; i < n; i++) {
num += (x[i]-xMean)*(y[i]-yMean);
den += (x[i]-xMean)**2;
}

const slope = num / den;
const intercept = yMean - slope * xMean;

return { slope, intercept };
}
