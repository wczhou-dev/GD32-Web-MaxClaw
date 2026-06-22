# 后端架构分析 — 模块管线索引

## 数据流管线

```text
前端 WebSocket / HTTP 请求
        │
        ▼
    server.js（调度 + HTTP/WS 桥接）
        │
        ├──▶ DevicePool（Modbus TCP 连接管理 + 寄存器读写）
        │            │
        │            ▼
        ├──▶ PollingEngine（定时采集 + 心跳 + 继电器控制 + OTA触发）
        │            │
        │            ▼
        └──▶ DataParser（寄存器原始值 → JSON 解析 + 位掩码构建）
```

**请求方向**：server.js 接收前端指令 → 调度 PollingEngine 执行采集/控制 → 通过 DevicePool 与硬件通信 → DataParser 将原始寄存器值转换为结构化 JSON → 经 WebSocket 推送回前端。

## 模块概要

| 模块 | 职责 | 上游 | 下游 | 详细文档 |
|------|------|------|------|----------|
| server.js | 后端总装配台与调度入口；拉起设备池、轮询引擎、OTA、Express、WebSocket，桥接前端请求到各子模块 | 前端 HTTP/WS 请求、`devices.json` 配置、环境变量 | DevicePool、PollingEngine、OTAHandler、WebSocketManager | [server.md](服务端/server.md) |
| DevicePool | 多台 GD32 的 Modbus TCP 连接管家；统一管理设备注册、建连、断线重连、寄存器读写、状态查询与事件广播 | server.js（设备配置注入）、PollingEngine（读写调用） | GD32 硬件（Modbus TCP Socket） | [设备池.md](设备池/设备池.md) |
| PollingEngine | 心脏起搏器；以 setInterval 驱动周期巡检（心跳 5s / 数据采集 30s），支持继电器控制指令（带 writeLock 互斥）和 OTA 触发 | DevicePool（连接句柄）、DataParser（解析能力） | DataParser（原始块 → JSON）、前端（onData 回调推 WebSocket） | [轮询引擎.md](轮询引擎/轮询引擎.md) |
| DataParser | 翻译官；按寄存器地址字典将 16 位原始值转换为温度/湿度/CO2/氨气/继电器状态等物理量，支持位域掩码构建控制字 | PollingEngine（原始寄存器块 blocks） | PollingEngine / server.js（格式化 JSON 结果） | [数据解析器.md](数据解析/数据解析器.md) |

## 关键协议

> 寄存器地址表和精度换算规则详见 [Modbus-TCP通信开发规范](../../协议规范/Modbus-TCP后端通信开发规范.md) 和 [ModbusTCP寄存器映射表](../../协议规范/ModbusTCP寄存器映射表.md)。

## 快速导航

- **设备配置**：`backend/config/devices.json`
- **后端入口**：`backend/server.js`
- **连接池**：`backend/DevicePool.js`
- **轮询引擎**：`backend/PollingEngine.js`
- **数据解析器**：`backend/DataParser.js`
