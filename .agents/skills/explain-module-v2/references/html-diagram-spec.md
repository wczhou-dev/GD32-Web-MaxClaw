# HTML 时序图完整规范

> 本文件由 SKILL.md Step 2 引用，包含 CSS 色彩规范、HTML 结构模板、箭头绘制方法。

---

## 1. CSS 色彩规范

```css
/* ===== 参与者栏头背景 ===== */
前端列:        background:#0f4c75; color:white;   /* 深蓝 */
核心引擎列:    background:#1a1a2e; color:white;   /* 深紫蓝 */
依赖模块列:    background:#3b1f6b; color:white;   /* 深紫 */
硬件/外部列:   background:#16404d; color:white;   /* 深青 */

/* ===== 步骤注释框 (inline style) ===== */
初始化/正常流程:  background:#e0e7ff; border:1.5px solid #6366f1;  /* 靛蓝 */
心跳/写操作:      background:#dcfce7; border:1.5px solid #86efac;  /* 绿色 */
数据采集/读操作:  background:#dbeafe; border:1.5px solid #93c5fd;  /* 蓝色 */
数据解析/处理:    background:#fef3c7; border:1.5px solid #f59e0b;  /* 黄色 */
WebSocket/推送:   background:#cffafe; border:1.5px solid #67e8f9;  /* 青色 */
互斥控制/加锁:    background:#fee2e2; border:1.5px solid #fca5a5;  /* 红色 */
OTA/升级操作:     background:#ffedd5; border:1.5px solid #fdba74;  /* 橙色 */

/* ===== 箭头与线条 ===== */
正向实线箭头:  border-top:2px solid #2563eb;   /* 蓝色 — 发出指令 */
返回虚线箭头:  border-top:2px dashed #94a3b8;  /* 灰色 — 收到返回值 */
控制指令箭头:  border-top:2px solid #dc2626;   /* 红色 — 高优先级控制 */
生命线竖线:    border-left:2px dashed #cbd5e1; /* 贯穿所有步骤行 */
```

---

## 2. 页面必须包含的五个元素

### A. 页面标题（黄色横幅）
```html
<div style="text-align:center;background:#fef08a;border:2px solid #ca8a04;
  border-radius:8px;padding:12px 24px;font-size:20px;font-weight:bold;
  margin-bottom:30px;letter-spacing:2px;">
  【 {模块名}.js 】 函数调用关系时序图
</div>
```

### B. 参与者栏头（深色背景，`<table>` 布局）
根据模块实际情况识别所有参与者，常见角色：
- 🖥️ 前端浏览器 (Vue + Pinia)
- ⚙️ 核心模块（当前 JS 文件）
- 📦 依赖模块（被调用的其他文件）
- 🔌 外部资源（硬件/API/数据库）

### C. 步骤行（带序号圆圈）
- 黑色圆形序号徽章 ①②③...（inline style）
- 不同颜色注释框说明步骤语义
- 横向箭头指示调用方向（含箭头三角形）
- 步骤说明格式：`序号 函数名() — 中文说明`

### D. 区块分隔标题行（colspan 满行）
```
主循环/定时任务：  background:#fffbeb; border-top:3px solid #fcd34d;  /* 黄色 */
互斥控制/独立指令：background:#f5f3ff; border-top:3px solid #a78bfa;  /* 紫色 */
初始化启动：       background:#f0fdf4; border-top:3px solid #86efac;  /* 绿色 */
```

### E. 图例（页面底部 flex 行）
- 🔵 蓝色实线 = 向外发命令
- ⚪ 灰虚线 = 收到返回值
- 🔴 红色实线 = 高优先级控制指令

---

## 3. 表格布局结构规范

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{模块名} 函数调用时序图</title>
  <style>
    body { font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; 
           background:#f8fafc; padding:30px; }
    table { width:100%; border-collapse:collapse; min-width:700px; }
    th { padding:14px 10px; text-align:center; }
    td { padding:8px 6px; vertical-align:middle; }
    .step-badge {
      display:inline-flex; align-items:center; justify-content:center;
      width:26px; height:26px; border-radius:50%;
      background:#1e293b; color:white; font-weight:bold; font-size:13px;
    }
    .note-box {
      border-radius:6px; padding:6px 10px; font-size:13px;
      font-weight:500; display:inline-block; max-width:95%;
    }
    /* 箭头容器 */
    .arrow-right {
      display:flex; align-items:center;
      border-top:2px solid #2563eb; position:relative;
    }
    .arrow-right::after {
      content:''; position:absolute; right:-1px;
      border:6px solid transparent; border-left:8px solid #2563eb;
    }
    .arrow-return {
      display:flex; align-items:center;
      border-top:2px dashed #94a3b8; position:relative;
    }
    /* 生命线 */
    .lifeline { border-left:2px dashed #cbd5e1; min-height:50px; }
  </style>
</head>
<body>

<!-- 标题横幅 -->
<div style="text-align:center;background:#fef08a;border:2px solid #ca8a04;
  border-radius:8px;padding:12px 24px;font-size:20px;font-weight:bold;
  margin-bottom:30px;letter-spacing:2px;">
  【 {模块名}.js 】 函数调用关系时序图
</div>

<table>
  <colgroup>
    <col style="width:60px">   <!-- 步骤编号列（固定宽） -->
    <col style="width:25%">    <!-- 参与者1 -->
    <col style="width:35%">    <!-- 核心模块（最宽，主要逻辑在此） -->
    <col style="width:25%">    <!-- 参与者3 -->
  </colgroup>
  <thead>
    <tr>
      <th style="background:#374151;color:white;border-radius:6px 0 0 0;">步骤</th>
      <th style="background:#0f4c75;color:white;">
        🖥️ 前端浏览器<br><small style="opacity:.7">Vue + Pinia</small>
      </th>
      <th style="background:#1a1a2e;color:white;">
        ⚙️ {模块名}<br><small style="opacity:.7">Core Engine</small>
      </th>
      <th style="background:#16404d;color:white;border-radius:0 6px 0 0;">
        🔌 外部资源<br><small style="opacity:.7">Hardware / API</small>
      </th>
    </tr>
  </thead>
  <tbody>

    <!-- 区块分隔行示例（初始化） -->
    <tr>
      <td colspan="4" style="background:#f0fdf4;border-top:3px solid #86efac;
        padding:8px 16px;font-weight:bold;color:#166534;font-size:14px;">
        🟢 初始化阶段
      </td>
    </tr>

    <!-- 步骤行示例 -->
    <tr>
      <td style="text-align:center;">
        <span class="step-badge">①</span>
      </td>
      <td class="lifeline" style="text-align:center;">
        <!-- 注释框示例（靛蓝=初始化） -->
        <div class="note-box" style="background:#e0e7ff;border:1.5px solid #6366f1;">
          init() — 初始化引擎
        </div>
      </td>
      <td class="lifeline" style="text-align:center;">
        <!-- 箭头示例（从左→右） -->
        <div class="arrow-right" style="margin:10px 0;"></div>
      </td>
      <td class="lifeline"></td>
    </tr>

    <!-- 区块分隔行示例（主循环） -->
    <tr>
      <td colspan="4" style="background:#fffbeb;border-top:3px solid #fcd34d;
        padding:8px 16px;font-weight:bold;color:#92400e;font-size:14px;">
        🔄 主循环 — setInterval 定时驱动
      </td>
    </tr>

    <!-- 更多步骤行按此格式继续... -->

  </tbody>
</table>

<!-- 图例 -->
<div style="margin-top:30px;display:flex;gap:30px;align-items:center;
  padding:12px 20px;background:#f1f5f9;border-radius:8px;font-size:13px;">
  <span><span style="display:inline-block;width:30px;border-top:2px solid #2563eb;vertical-align:middle;"></span> 发出指令</span>
  <span><span style="display:inline-block;width:30px;border-top:2px dashed #94a3b8;vertical-align:middle;"></span> 收到返回值</span>
  <span><span style="display:inline-block;width:30px;border-top:2px solid #dc2626;vertical-align:middle;"></span> 高优先级控制</span>
</div>

</body>
</html>
```

---

## 4. 常见参与者颜色分配示例

| 参与者类型 | 表头背景色 | emoji |
|:--|:--|:--|
| 前端 Vue/Pinia | `#0f4c75` | 🖥️ |
| 核心 JS 模块 | `#1a1a2e` | ⚙️ |
| Store/数据层 | `#3b1f6b` | 📦 |
| WebSocket | `#164e63` | 🔌 |
| 硬件设备 | `#16404d` | 🏭 |
| HTTP API | `#1c3a2a` | 🌐 |
