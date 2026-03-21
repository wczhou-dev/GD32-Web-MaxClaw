# 92系列 Modbus-TCP 后端通信开发规范 (modbus-tcp-dev-spec.md)

## 1. 核心角色定义
- **中控 (Backend)**：充当 **Modbus TCP Master (Client)**。
- **环控器 (92-Series)**：充当 **Modbus TCP Slave (Server)**，默认端口：502。
- **技术栈**：Node.js + `modbus-serial` 库。

## 2. 通信链路管理 (Connection Management)
- **长连接策略**：中控与每一台环控器维持一个持久的 TCP 连接，严禁频繁建立/断开 Socket。
- **IP 路由映射**：后端需维护一个 `DevicePool` 对象，以 IP 为 key，管理对应的 `ModbusClient` 实例。
- **断线重连**：必须实现指数退避重连机制（Exponential Backoff），防止交换机抖动导致后端死循环。

## 3. 轮询引擎逻辑 (Polling Engine)
- **周期性任务**：默认轮询周期为 **1000ms**。
- **分段读取 (Block Read)**：
  - 严禁一个寄存器发一次请求。
  - 按以下分块一次性读取，降低网络开销：

| 块名        | 起始地址 | 结束地址 | 寄存器数 | 说明            |
| :---------- | :------- | :------- | :------- | :-------------- |
| BLOCK_SYS   | 0x0000   | 0x0018   | 25       | 心跳/控制/版本  |
| BLOCK_OTA   | 0x0100   | 0x0101   | 2        | OTA触发与版本   |
| BLOCK_OTA_S | 0x0150   | 0x0151   | 2        | OTA进度与状态   |
| BLOCK_ENV   | 0x1001   | 0x1048   | 72       | 全量传感器数据  |
| BLOCK_HW    | 0x4001   | 0x400B   | 11       | 继电器/DI/AO/AI |
| BLOCK_CFG   | 0x7001   | 0x7009   | 9        | 业务参数配置    |

- **原子性写入 (Atomic Write)**：
  - 写操作优先级高于读操作。
  - 执行写指令时必须暂停当前读任务，加互斥锁后执行写操作。
  - **写入确认机制**：写入完成后，必须立即回读同一地址验证寄存器值与写入值一致，确认无误后解锁恢复读取；若回读不一致，记录错误日志并重试最多3次。

## 4. 数据解析与精度换算 (Data Processing)

### 4.1 大端序转换 (Endianness)
- Modbus 默认大端序，使用 `buffer.readInt16BE()` 或 `readUInt16BE()` 解析。
- 32 位数据（如通风量 `0x0016`）必须连续读取 2 个寄存器拼接：
```javascript
  const val32 = (buf.readUInt16BE(0) << 16) | buf.readUInt16BE(2)
```

### 4.2 精度补偿 (Scaling)
| 数据类型     | 换算规则  | 示例          |
| :----------- | :-------- | :------------ |
| 温度         | val/10    | 282 → 28.2℃   |
| 湿度         | val/10    | 650 → 65.0%   |
| 风速         | val/10    | 12 → 1.2 m/s  |
| CO2 / 氨气   | 原值      | 850 → 850 ppm |
| 压差         | 原值      | 12 → 12 Pa    |
| 目标温度(读) | val/10    | 250 → 25.0℃   |
| 目标温度(写) | 前端值×10 | 25.0 → 写250  |

### 4.3 位掩码解析 (Bit Manipulation)
- 继电器状态 (`0x4001`)：32位整数解析为长度22的布尔数组，**0-based，index=0对应R1**：
```javascript
  const relays = Array.from({length: 22}, (_, i) => Boolean((val32 >> i) & 1))
```
- DI 输入状态 (`0x4007`)：uint16解析为长度10的布尔数组，**0-based，index=0对应DI1**：
```javascript
  const digitalInputs = Array.from({length: 10}, (_, i) => Boolean((val16 >> i) & 1))
```
- 继电器控制写入 (`0x5001`) **必须先读再写**，合并位图后写回：
```javascript
  // 读取当前值 → 修改指定位 → 写回，严禁直接覆盖
  let current = await readReg(0x5001)  // 读当前32位值
  if (value) current |= (1 << relayIndex)   // 置位
  else       current &= ~(1 << relayIndex)  // 清零
  await writeReg(0x5001, current)            // 写回
```

## 5. 异常处理与心跳 (Safety & Heartbeat)
- **心跳写入**：后端每周期向 `0x0000` 写入递增的 `uint16`（0-65535循环）。
- **超时判定**：连续3次读取超时（Timeout > 2000ms），标记设备为 `OFFLINE`，推送告警。
- **异常拦截**：收到 Modbus Exception Code（0x01、0x02等），记录错误日志，停止无效轮询。

## 6. OTA 专用传输规范
- **固件下载 URL**（固定格式，从 `.env` 读取中控IP）：
```
  http://<BACKEND_IP>:3000/download/SciGeneAI.rbl
```
- **触发顺序**（严格按序，不可颠倒）：
  1. 写入版本号：`0x0101 = version`
  2. 写入触发位：`0x0100 = 1`
- **进度平滑**：读取 `0x0150` 时，若数值跳变超过10%，前端做缓动处理。

## 7. WebSocket 数据帧格式定义 (WS Frame Spec)

后端完成 Modbus 解析后通过 WebSocket 推送标准 JSON 数据帧。
前端必须严格按以下格式绑定，**严禁自行约定字段名**。

### 7.1 传感器数据帧 (sensor_data)
**推送时机**：每轮轮询完成后推送（约1000ms/次）。
```json
{
  "type": "sensor_data",
  "deviceIp": "10.137.11.101",
  "timestamp": 1718000000000,
  "data": {
    "temp":  [28.2, 27.5, 26.8, 27.1, 28.0, 27.3, 26.5, 27.9,
              28.1, 27.4, 26.9, 27.6, 28.3, 27.2, 26.7, 27.8],
    "humi":  [65.0, 63.2, 64.5, 62.8, 65.3, 63.7, 64.1, 62.5,
              65.6, 63.0, 64.8, 62.3, 65.1, 63.5, 64.3, 62.7],
    "co2":   [850, 900, 870, 920, 860, 910, 880, 930],
    "nh3":   [12, 15, 11, 14],
    "wind":  [1.2, 1.5, 1.3, 1.4, 1.1, 1.6, 1.2, 1.3,
              1.4, 1.5, 1.1, 1.2],
    "relays": [true, false, true, false, true, false, true, false,
               true, false, true, false, true, false, true, false,
               true, false, true, false, true, false],
    "digitalInputs": [true, false, true, false, true,
                      false, true, false, true, false],
    "outdoorTemp": 18.5,
    "outdoorHumi": 72.0,
    "pressure": [12, 15, 11, 14],
    "ao": [1450, 1380]
  }
}
```

**字段索引说明（严禁错位）**：

| 字段名             | 来源寄存器           | 长度 | 单位    | 索引规则                |
| :----------------- | :------------------- | :--- | :------ | :---------------------- |
| `temp[i]`          | 0x1001+i*2 (i=0..15) | 16   | ℃       | index 0 = 1#传感器      |
| `humi[i]`          | 0x1002+i*2 (i=0..15) | 16   | %       | index 0 = 1#传感器      |
| `co2[i]`           | 0x1021+i (i=0..7)    | 8    | ppm     | index 0 = 1#传感器      |
| `nh3[i]`           | 0x1029+i (i=0..3)    | 4    | ppm     | index 0 = 1#传感器      |
| `wind[i]`          | 0x102D+i (i=0..11)   | 12   | m/s     | index 0 = 1#传感器      |
| `relays[i]`        | 0x4001 bit[i]        | 22   | boolean | index 0 = R1 (0-based)  |
| `digitalInputs[i]` | 0x4007 bit[i]        | 10   | boolean | index 0 = DI1 (0-based) |
| `outdoorTemp`      | 0x1039               | 1    | ℃       | val/10                  |
| `outdoorHumi`      | 0x103A               | 1    | %       | val/10                  |
| `pressure[i]`      | 0x1042+i (i=0..3)    | 4    | Pa      | index 0 = 1#压差        |
| `ao[i]`            | 0x4003+i (i=0..1)    | 2    | rpm     | index 0 = AO1           |

### 7.2 设备状态帧 (device_status)
**推送时机**：连接状态变化时立即推送。
```json
{
  "type": "device_status",
  "deviceIp": "10.137.11.101",
  "timestamp": 1718000000000,
  "status": "ONLINE",
  "timeoutCount": 0
}
```

| `status` 值      | 含义                   |
| :--------------- | :--------------------- |
| `"ONLINE"`       | 连接正常               |
| `"RECONNECTING"` | 重连中（超时1-2次）    |
| `"OFFLINE"`      | 已离线（连续超时≥3次） |

### 7.3 OTA 进度帧 (ota_progress)
**推送时机**：OTA进行中每秒推送，完成或失败时推送最终状态。
```json
{
  "type": "ota_progress",
  "deviceIp": "10.137.11.101",
  "timestamp": 1718000000000,
  "progress": 68,
  "status": 1
}
```

| `status` 值  | 含义     | UI颜色 |
| :----------- | :------- | :----- |
| `0`          | 空闲     | 灰色   |
| `1`          | 下载中   | 蓝色   |
| `2`          | 校验中   | 橙色   |
| `3`          | 升级成功 | 绿色   |
| `255` (0xFF) | 升级失败 | 红色   |

### 7.4 前端下行控制帧 (前端 → 后端)
```json
{
  "type": "relay_control",
  "deviceIp": "10.137.11.101",
  "relayIndex": 0,
  "value": true
}
```
> `relayIndex` 为 **0-based**：R1=0，R2=1，...，R22=21。
> `value=true` 置位（ON），`value=false` 清零（OFF）。
> 后端收到后必须先读 `0x5001`，合并位图再写回。
```json
{
  "type": "ota_start",
  "deviceIp": "10.137.11.101",
  "version": 201
}
```

| `type` 值       | 对应 Modbus 写操作                          |
| :-------------- | :------------------------------------------ |
| `relay_control` | 读0x5001 → 修改bit[relayIndex] → 写回0x5001 |
| `ota_start`     | 先写0x0101=version，再写0x0100=1            |