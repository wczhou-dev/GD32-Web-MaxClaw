# GD32-Web-MaxClaw 项目调试日志 (debug_issues.md)

## 2026-03-23 调试记录

### 问题 1: 前端无法启动 (Vite 异常)
- **现象**: 执行 `npm run dev` 提示 `vite` 不是可运行程序，`npm install` 报错 `ERESOLVE`。
- **原因**: `package.json` 中 `vite` 版本被误设为 `^8.0.1`（当前最新稳定版为 6.x），导致与 Vue 插件冲突且无法安装。
- **解决**: 将 `package.json` 中的依赖包（Vite, Pinia, Vue-Router 等）全部修正回稳定兼容版本，并完成 `npm install`。

### 问题 2: 后端与环控器连接频繁超时 (TCP Connection Timed Out)
- **现象**: 后端能建立 TCP 连接，但 Modbus 读取/心跳始终超时，环控器侧提示 `reply sent` 但后端无响应。
- **原因 1 (IP 抓取错误)**: 电脑存在多个虚拟网卡（如 BaishanTun），程序默认抓取了 `192.0.2.233` 导致回包路径异常。
- **原因 2 (子网掩码错位)**: 电脑处于 `192.168.11.x (/23)` 网段，环控器处于 `192.168.10.x (/24)` 网段。环控器无法“认领”异网段回包，尝试通过不存在的网关转发导致数据丢失。
- **解决方案**:
    - **物理层面**: 修改电脑以太网卡 IP 为 `192.168.10.127`，掩码 `255.255.255.0`，与环控器保持严格同网段。
    - **逻辑层面**: 引入 `dotenv` 模块，改写 `server.js`。
    - **配置层面**: 增加 `.env` 文件，手动固定 `DEVICE_IP` 和 `LOCAL_IP`。

### 问题 3: Modbus 通信不稳定性
- **现象**: 网络波动导致偶尔丢包触发超时重连。
- **解决**: 修改 `DevicePool.js`，将 `modbus-serial` 的默认超时时间保持为 3s（原始值）。

### 问题 4: 环控器固件单线程阻塞导致的"幽灵连接"堆积（核心根因）
- **现象**: 环控器 `netstat` 持续出现 2~4 个 ESTABLISHED/LAST_ACK 连接。Ping 延迟暴涨至 1000~3000ms。
- **根因**: 环控器固件 (`modbus_tcp_server.c`) 采用单线程阻塞架构：
    - `modbus_tcp_listen(ctx, 1)` — backlog=1，只允许1个排队连接
    - 进入 `while(1) { modbus_receive() }` 阻塞循环处理当前客户端
    - `SO_RCVTIMEO = 10s` — 旧连接要等 10 秒才会超时释放
    - 当后端 `_resetConnection()` 强制关闭 Socket 后，环控器还要等 10 秒才能检测到连接断开
    - 如果后端在 10 秒内就重新发起 TCP 连接，新连接会被内核层 accept，但应用层还卡在旧循环里
    - 导致多个"幽灵连接"堆积，耗尽 LwIP 的 TCP PCB 和 PBUF 资源
- **解决**: 修改 `PollingEngine.js`，在设备断连后等待 **12 秒冷却期**再重连，确保环控器有充足时间释放旧连接。
- **固件代码路径**: `F:\1.AI\4.Project\Rtthread-encontrol\sj-encontrol\bsp\stm32\stm32f407-atk-explorer\applications\modbus_tcp_server.c`

---

## 💡 开发提示 (防遗忘机制)
- **更换场站时**: 若 IP 网段变化，只需修改 `backend/.env` 并重启 backend 即可。
- **残留进程清理**: Windows 环境下若发现端口占用，务必执行 `taskkill /F /IM node.exe`。
- **IP 强制锁定逻辑**: 位于 `backend/server.js` 的 `getLocalIP()` 函数中，优先读取环境变量。
