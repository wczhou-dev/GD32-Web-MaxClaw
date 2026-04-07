/**
 * @file main.js
 * @description 前端应用主入口文件（类比单片机工程中的 main.c）
 * 
 * 在 Vue 3 + Vite 的现代化前端开发中，这确实属于一套非常经典且标准的入口文件（main.js）配置模板。
 * 为了方便您理解（结合您的嵌入式背景），我们可以把 main.js 类比为单片机工程中的 main.c 初始化阶段：
 * --- 架构类比说明（面向嵌入式开发者） ---
 * 1. createApp(App)          => OS_Init() / Kernel_Init() : 初始化核心框架
 * 2. app.use(createPinia())  => RAM_Config() / Global_Var_Init() : 初始化全局状态存储区
 * 3. app.use(ElementPlus)    => LCD_Driver_Init() : 加载 UI 组件库驱动
 * 4. app.use(router)         => Task_Scheduler_Config() : 配置页面路由跳转逻辑
 * 5. app.mount('#app')       => OS_Start() / while(1) : 将程序正式挂载至 DOM 并启动循环渲染
 * -----------------------------------------
 */

import { createApp } from 'vue'                      // 导入 Vue 应用创建函数
import { createPinia } from 'pinia'                    // 导入 Pinia 状态管理库
import ElementPlus from 'element-plus'                // 导入 Element Plus 组件库
import 'element-plus/dist/index.css'                  // 导入 Element Plus 样式文件
import * as ElementPlusIconsVue from '@element-plus/icons-vue' // 导入所有图标组件
import App from './App.vue'                           // 导入根组件
import router from './router'                         // 导入路由配置

/*
Edited main.js

> [!IMPORTANT]
> ## 用户问题原文
> `const app = createApp(App)` 语法解析

这一行代码是 Vue 3 应用的“点火”开关。我们可以从 **JavaScript 基础语法** 和 **Vue 框架逻辑** 两个维度来拆解：

### 1. 语法拆解

| 代码片段 | 语法角色 | 说明 | 嵌入式 C 类比 |
| :--- | :--- | :--- | :--- |
| `const` | 关键字 | 声明一个**只读**变量（常量）。一旦赋值，`app` 就不能再指向别的对象。 | `struct AppInst * const app` |
| `app` | 变量名 | 这是一个“句柄”或“指针”，存放着整个应用的实例对象。 | `handle_t app_hdl` |
| `=` | 赋值运算符 | 将右侧函数的返回值保存到左侧变量中。 | `=` |
| `createApp` | 函数调用 | Vue 框架提供的**工厂函数**，根据传入的配置创建一个应用实例。 | `rt_thread_create(...)` |
| `(App)` | 函数参数 | 传入的是**根组件**（Root Component）。它定义了整个网页的最初始长相（HTML结构、逻辑）。 | 传入任务的 `entry_function` |

---

### 2. 深度解析：它到底做了什么？

#### A. 什么是 `App`？
`App` 是从 `./App.vue` 导入的一个对象。在 Vue 中，一个 `.vue` 文件编译后其实就是一个普通的 **JavaScript 对象**（包含模板、数据、函数）。它是整个界面的“总入口”。

#### B. `createApp` 的职责
在 Vue 2 中，我们直接 `new Vue()`。
在 **Vue 3** 中，改为了 `createApp`。这样做的好处是：**隔离性**。
- 每一个 `app` 实例都是独立的。
- 您可以在同一个页面里创建两个应用（比如一个侧边栏应用，一个主内容应用），它们互不干扰，不像全局变量那样会互相污染。

#### C. 返回值 `app` 是什么？
它不是一个简单的字符串或数字，它是一个**对象句柄**。它带有很多内置的“成员方法”，比如：
- `app.use()`: 加载驱动/插件（如 Pinia, Router）。
- `app.component()`: 注册全局外设（组件）。
- `app.mount()`: **最后一步**，告诉 Vue 把实例挂载到哪个硬件端口（HTML 节点）。

---

### 3. 程序员视角的一句话总结

> `const app = createApp(App)` 的意思就是：
> **“以 `App` 组件为蓝图数据，通过 Vue 的内核工厂，生成一个名为 `app` 的运行实例句柄。”**

这就好比在 RT-Thread 中：
```c
// 1. 定义任务蓝图 (App)
void app_entry(void* parameter) { ... }

// 2. 创建实例并拿回句柄 (app)
rt_thread_t app = rt_thread_create("app", app_entry, ...);

// 3. 这里的 app 句柄后续可以用来启动、停止该任务
```
 */

const app = createApp(App)                            // 创建应用实例

/*
这段代码是 Vue 3 项目中非常常见的**图标批量全局注册**逻辑。对于习惯 C 语言这类过程式语言的开发者来说，这里的“解构赋值”和“对象迭代”可能看起来比较玄学。
以下是对这段代码的深度语法拆解：
---
### 1. 核心流程拆解
这段代码的功能可以类比为：**读取一个“驱动包”，并将包里的所有驱动程序循环注册到操作系统的内核中。**
#### **第一步：`Object.entries(ElementPlusIconsVue)`**
* **语法点：** 静态方法调用。
* **作用：** `ElementPlusIconsVue` 是一个对象（类似 C 语言的结构体或字典），里面存了成百上千个图标组件。
* **执行结果：** 它把对象转换成一个**二维数组**。
    * *转换前：* `{ Edit: Component, Share: Component }`
    * *转换后：* `[ ["Edit", Component], ["Share", Component] ]`

#### **第二步：`for (const [key, component] of ...)`**
这里包含了两个关键语法：
1.  **`for...of` 循环**：这是现代 JavaScript 遍历数组的标准方式（类似于 Python 的 `for item in list`）。
2.  **数组解构赋值 `[key, component]`**：这是这段代码最优雅的地方。在每次循环时，它直接把二维数组里的子数组拆开：
    * 第一个元素（图标名字符串）赋值给变量 `key`。
    * 第二个元素（组件对象）赋值给变量 `component`。
#### **第三步：`app.component(key, component)`**
* **语法点：** 方法调用。
* **作用：** 这是 Vue 的 API，用于全局注册组件。
* **效果：** 注册完成后，你可以在整个项目的任何 HTML 模板中直接使用 `<Edit />` 或 `<Share />` 标签，而不需要在每个页面重复 `import`。
---
### 2. 技术细节对比表
为了方便理解，我们可以将其与传统的 C 语言逻辑进行类比：
| JS 语法成分 | 描述 | C 语言类比 |
| :--- | :--- | :--- |
| **`Object`** | 内置全局对象 | 系统头文件/标准库 |
| **`entries()`** | 将对象转为键值对数组 | 遍历结构体成员并存入数组 |
| **`const`** | 声明只读变量 | `const` 关键字 |
| **`[key, component]`** | **解构赋值** | 手动提取数组下标：`k = arr[0]; c = arr[1];` |
| **`app.component()`** | 全局函数注册 | 填充函数指针查找表 (Look-up Table) |
---
### 3. 为什么不一个一个注册？
如果不用这段循环，你的代码可能会变成这样：
```javascript
import { Edit, Share, Check, Delete ... } from '@element-plus/icons-vue'

app.component('Edit', Edit)
app.component('Share', Share)
app.component('Check', Check)
// ... 此处省略 200 行
```
**这段 3 行的代码利用了 JavaScript 的对象处理能力，直接干掉了几百行的重复劳动。**
---
### 4. 语法要点总结
* **`Object.entries`**：是处理“键值对”数据的利器。
* **解构赋值**：极大地提高了代码的可读性，避免了 `item[0]`、`item[1]` 这种含义不明的代码。
* **`for...of`**：比传统的 `for(i=0; i<n; i++)` 更安全，不会出现越界问题，且语义更明确。

这种写法在前端工程化中非常普遍，主要用于**自动化配置**和**批量组件注入**。
*/

// 遍历并全局注册所有 Element Plus 图标组件，以便在任何地方直接使用
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())                                // 启用 Pinia 存储系统（用于 deviceStore）
app.use(ElementPlus)                                  // 启用 Element Plus UI 框架
app.use(router)                                       // 启用路由系统（管理页面跳转）
app.mount('#app')                                     // 将应用挂载到 index.html 中的 #app 节点
