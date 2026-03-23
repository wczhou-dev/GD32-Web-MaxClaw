---
description: 启动"金牌导师"四步拆解模式，解析指定的 JS/Vue/HTML 模块并生成可视化 HTML 时序图。
---

# 🚀 工作流：explain-module (模块深度剖析)

## 任务目标
当用户输入 `/explain-module [模块名]`、"帮我分析"、"画图"、"函数关系" 等关键词时，
启动本工作流，按以下所有步骤**完整执行，禁止省略任何一步**。

---

## ✅ 执行步骤

### Step 1：读取目标文件
使用工具读取用户指定的源文件，梳理所有函数、变量、调用关系，在脑中建立全局视图后，再开始输出。

---

### Step 2：生成 HTML 可视化时序图

### Step 2：建立专属分析目录与生成 HTML 时序图

1. **新建分析专用文件夹**：在 `docs/analysis/` 目录下，按照当前分析的模块名新建子文件夹。
   - 示例：当前分析 `PollingEngine.js`，则创建目录 `docs/analysis/PollingEngine/`。
2. **生成 HTML 文件**：在该子文件夹内生成 `{模块名}_diagram.html` 文件。**生成前必须完整核对以下规范表，不可跳过**：

#### ⚡ 规范速查对照表

| 规范项 | 说明 |
| :--- | :--- |
| **存放路径** | `docs/analysis/{模块名}/{模块名}_diagram.html` |
| **布局方式** | HTML `<table>` 而非 CSS Grid（兼容性更好，防布局跑偏）|
| **参与者栏** | 深色标题栏，含 emoji 角色图标和英文副标题，各列背景色不同 |
| **步骤序号** | ①②③ 黑色圆圈编号，每行必须有中文说明，格式：`序号 函数名() — 说明` |
| **颜色系统** | 6 种颜色区分语义（绿=心跳/写，蓝=采集/读，黄=解析，青=WebSocket，红=控制，橙=OTA）|
| **区块分隔** | 主循环=黄色系横幅，互斥锁=紫色系横幅，初始化=绿色系横幅 |
| **生命线** | `border-left: 2px dashed #cbd5e1` 贯穿每个参与者列 |
| **箭头方向** | 实蓝=发出指令，虚灰=返回数据，实红=高优先级控制 |
| **参考模板** | 已有的 `PollingEngine` 样本可供复刻布局。|

#### 2.1 页面必须包含的五个元素

**A. 页面标题（黄色横幅）**
```html
<div style="text-align:center;background:#fef08a;border:2px solid #ca8a04;
  border-radius:8px;padding:12px 24px;font-size:20px;font-weight:bold;
  margin-bottom:30px;letter-spacing:2px;">
  【 模块名.js 】 函数调用关系时序图
</div>
```

**B. 参与者栏头（深色背景，`<table>` 布局）**
- 根据模块实际情况识别所有参与者，常见角色：
  - 🖥️ 前端浏览器 (Vue + Pinia)
  - ⚙️ 核心模块 (当前 JS 文件)
  - 📦 依赖模块 (被调用的其他文件)
  - 🔌 外部资源 (硬件/API/数据库)

**C. 步骤行（带序号圆圈）**
- 黑色圆形序号徽章 ①②③...（内联样式）
- 不同颜色注释框说明该步骤的语义
- 横向箭头指示调用方向（含箭头三角形）

**D. 区块分隔标题行（colspan 满行）**
- 主循环/定时任务：`background:#fffbeb; border-top:3px solid #fcd34d;` 黄色
- 互斥控制/独立指令：`background:#f5f3ff; border-top:3px solid #a78bfa;` 紫色
- 初始化启动：`background:#f0fdf4; border-top:3px solid #86efac;` 绿色

**E. 图例（页面底部 flex 行）**
- 蓝色实线 = 向外发命令
- 灰虚线 = 收到返回值
- 红色实线 = 高优先级控制指令

#### 2.2 CSS 色彩规范（必须严格执行）

```css
/* ===== 参与者栏头背景 ===== */
前端列:        background:#0f4c75; color:white;  /* 深蓝 */
核心引擎列:    background:#1a1a2e; color:white;  /* 深紫蓝 */
依赖模块列:    background:#3b1f6b; color:white;  /* 深紫 */
硬件/外部列:   background:#16404d; color:white;  /* 深青 */

/* ===== 步骤注释框 (inline style) ===== */
初始化/正常流程:  background:#e0e7ff; border:1.5px solid #6366f1;  /* 靛蓝 */
心跳/写操作:      background:#dcfce7; border:1.5px solid #86efac;  /* 绿色 */
数据采集/读操作:  background:#dbeafe; border:1.5px solid #93c5fd;  /* 蓝色 */
数据解析/处理:    background:#fef3c7; border:1.5px solid #f59e0b;  /* 黄色 */
WebSocket/推送:   background:#cffafe; border:1.5px solid #67e8f9;  /* 青色 */
互斥控制/加锁:    background:#fee2e2; border:1.5px solid #fca5a5;  /* 红色 */
OTA/升级操作:     background:#ffedd5; border:1.5px solid #fdba74;  /* 橙色 */

/* ===== 箭头与线 ===== */
正向实线箭头: border-top:2px solid #2563eb;   /* 蓝色 */
返回虚线箭头: border-top:2px dashed #94a3b8;  /* 灰色 */
控制指令箭头: border-top:2px solid #dc2626;   /* 红色 */
生命线竖线:   border-left:2px dashed #cbd5e1; /* 贯穿所有步骤行 */
```

#### 2.3 表格布局结构规范

```html
<table style="width:100%;border-collapse:collapse;min-width:700px;">
  <colgroup>
    <col style="width:70px">  <!-- 步骤编号列（固定宽） -->
    <col style="width:25%">   <!-- 参与者1 -->
    <col style="width:35%">   <!-- 核心模块（最宽，承载主要逻辑注释框与箭头） -->
    <col style="width:25%">   <!-- 参与者3 -->
  </colgroup>
  <thead>
    <tr>
      <th><!-- 步骤列 --></th>
      <th><!-- 参与者1深色标题 --></th>
      <th><!-- 核心模块深色标题 --></th>
      <th><!-- 参与者3深色标题 --></th>
    </tr>
  </thead>
  <tbody>
    <!-- 区块分隔行：colspan="4" -->
    <!-- 步骤行：每步一个 <tr>，对应列中放注释框和箭头 -->
  </tbody>
</table>
```

---

### Step 3：四步金牌导师拆解

在对话中，**必须按以下顺序完整输出四步内容，每步不可省略**。

#### 🧱 第一步：业务黑盒（把它当成产品说明书）
禁止涉及具体代码，只用最通俗的语言回答以下 4 个问题：
1. **核心职责**：一句话说清它是一个负责什么的模块。
2. **输入**：它需要接收什么参数？（如设备 IP、轮询间隔）
3. **输出**：处理完后数据被送到哪里去了？
4. **使用场景举例**：以本项目 GD32 环控 Web 系统为背景，举一个具体的使用例子。

#### 🦴 第二步：静态骨架（画出代码结构）
剥离所有内部实现逻辑，只展示骨架：
- **核心状态/变量**：列出最关键的几个变量，每个一句话解释用途。
- **核心方法**：列出所有主要函数，每个一句话说明作用。
- 输出格式：可使用 Mermaid 图、树形文本或 Markdown 列表。

#### ⚙️ 第三步：动态运转（梳理生命周期与数据流）
解释这个模块是怎么"活起来"的，重点回答：
1. **启动与循环机制**：第一次执行的触发点是什么？`setInterval`? `onMounted`? 外部调用?
2. **异常与边界处理**：
   - 如果网络断开、硬件无响应，它会怎么做？
   - 有没有可能导致内存泄漏？它是如何防御的？

#### 🎯 第四步：执行主线（顺风局 → 逆风局 → 语法点拨）
1. **Happy Path（主线任务）**：
   - 挑出一段"一切顺利"的核心代码片段（只展示这一段）。
   - 在代码里逐行写中文步骤注释（`// 步骤1: ...`）。
2. **Edge Cases（防御性编程）**：
   - 指出哪里做了防错处理（如 `try-catch`、`clearInterval`、`writeLock`）。
   - 用一句话说明这样写的原因。
3. **关键语法点拨**：
   - 对代码中初学者容易懵的 JS 语法，单独拎出来用一两句话解释。
   - 必须类比 C 语言，格式如下：
   > 💡 `async/await` 在 JS 里，就像 C 的信号量等待 `xSemaphoreTake(sem, portMAX_DELAY)`，程序会原地挂起，直到拿到"令牌"才继续往下跑。
   - 常见需要点拨的语法：`Promise`、`async/await`、`=>` 箭头函数、解构赋值、`?.` 可选链、`||` 逻辑默认值。

---

### Step 4：生成 Markdown 解析文档与双路交付

1. **生成 Markdown 文档**：将 Step 3 生成的"四步拆解"内容（业务黑盒、静态骨架、动态运转、执行主线），写入到同一个子文件夹中，命名为 `{模块名}.md`。
   - 示例路径：`docs/analysis/PollingEngine/PollingEngine.md`。

2. **双路交付（对话内 + 文件）**：
   - **对话内**：完整输出"四步拆解"的文字内容。
   - **文件**：告知用户分析文件夹已建好，提供两个文件的本地可点击链接：
```
📄 已归档至分析目录：
1. 静态流转图：docs/analysis/{模块名}/{模块名}_diagram.html
2. 深度剖析文档：docs/analysis/{模块名}/{模块名}.md
💡 提示：在 VS Code 即可直接预览 Markdown 格式的文档和 HTML 图表。
```

---

## ⚠️ 注意事项（违反即为错误）
- 语气保持：**资深、耐心、循序渐进**，像坐在用户旁边结对编程的导师。
- **严禁**直接逐行翻译代码注释。
- **严禁**跳过任何一步或以"简短版"敷衍。
- 嵌入式 C 类比是**必选项**，不是可选项。
- HTML 文件是**必须生成**的，不可用 Mermaid 或图片截图来替代。
- HTML 中**必须使用中文说明**，禁止纯英文注释框。
