# ATE 自动化测试系统部署指南

## 1. 系统要求

### 1.1 硬件要求
- **测试主机**：Windows 10/11 电脑，4GB+ 内存
- **网络**：与环控器同一局域网（默认 192.168.10.x）
- **浏览器**：Chrome 90+ / Edge 90+ / Firefox 88+

### 1.2 软件要求
- **Node.js**：v18.x 或 v20.x（LTS 版本）
- **npm**：v9.x 或更高

## 2. 安装步骤

### 2.1 安装 Node.js

#### 方式一：在线安装
1. 访问 https://nodejs.org/
2. 下载 LTS 版本（推荐 v20.x）
3. 双击安装包，按默认选项安装

#### 方式二：离线安装（车间无外网）
1. 在有网电脑下载 Node.js 安装包：
   - Windows 64-bit: https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi
2. 拷贝安装包到测试主机
3. 双击安装

### 2.2 部署项目

#### 方式一：从 Git 克隆（需要网络）
```bash
git clone https://github.com/wczhou-dev/GD32-Web-MaxClaw.git
cd GD32-Web-MaxClaw
```

#### 方式二：拷贝项目文件（离线）
1. 将整个 `GD32-Web-MaxClaw` 文件夹拷贝到测试主机
2. 确保目录结构完整：
   ```
   GD32-Web-MaxClaw/
   ├── backend/
   │   ├── node_modules/    ← 需要预装依赖
   │   ├── config/
   │   ├── ate/
   │   ├── api/
   │   └── server.js
   ├── frontend/
   │   ├── node_modules/    ← 需要预装依赖
   │   ├── src/
   │   └── package.json
   ├── shared/
   └── docs/
   ```

### 2.3 安装依赖

#### 方式一：在线安装
```bash
# 安装后端依赖
cd backend
npm install

# 安装前端依赖
cd ../frontend
npm install
```

#### 方式二：离线安装（拷贝 node_modules）
如果测试主机无外网，需要在有网电脑预先安装依赖并拷贝：
```bash
# 在有网电脑执行
cd backend && npm install
cd ../frontend && npm install

# 拷贝 node_modules 文件夹到测试主机对应位置
```

### 2.4 构建前端
```bash
cd frontend
npm run build
```

构建完成后，`frontend/dist/` 目录包含静态文件。

## 3. 配置

### 3.1 环境变量
创建或编辑 `backend/.env` 文件：
```env
# 设备 IP 地址（环控器 ATE 服务 IP）
DEVICE_IP=192.168.10.233

# 本机 IP（多网卡时手动指定）
LOCAL_IP=192.168.10.100

# ATE TCP 端口（固件端口）
ATE_TCP_PORT=9001

# Modbus TCP 端口
MODBUS_PORT=502

# 后端服务端口
PORT=3001

# 报告存储目录
REPORT_DIR=backend/reports

# ACK 超时时间（毫秒）
ATE_ACK_TIMEOUT_MS=2000

# 重连冷却时间（毫秒）
ATE_RECONNECT_COOLDOWN_MS=12000
```

### 3.2 设备配置
编辑 `backend/config/devices.json`：
```json
{
  "devices": [
    {
      "name": "1号舍",
      "ip": "192.168.10.233",
      "port": 502,
      "unitId": 1,
      "enabled": true
    }
  ],
  "backend": {
    "port": 3001,
    "firmwarePath": "F:/firmware"
  },
  "polling": {
    "intervalMs": 2000,
    "timeoutMs": 3000,
    "retryCount": 3
  }
}
```

## 4. 启动服务

### 4.1 启动后端
```bash
cd backend
npm run start
# 或开发模式（自动重启）
npm run dev
```

### 4.2 访问系统
打开浏览器访问：
```
http://localhost:3001
```

### 4.3 Windows 一键启动脚本
创建 `start-ate.bat` 文件：
```batch
@echo off
echo ========================================
echo   GD32 ATE 自动化测试系统启动中...
echo ========================================

REM 启动后端服务
cd /d %~dp0backend
start "ATE Backend" node server.js

REM 等待服务启动
timeout /t 3 /nobreak > nul

REM 打开浏览器
start http://localhost:3001

echo.
echo 系统已启动！浏览器将自动打开。
echo 按任意键退出此窗口...
pause > nul
```

双击 `start-ate.bat` 即可启动系统。

## 5. 离线部署包制作

### 5.1 在有网电脑准备
```bash
# 1. 克隆项目
git clone https://github.com/wczhou-dev/GD32-Web-MaxClaw.git
cd GD32-Web-MaxClaw

# 2. 安装依赖
cd backend && npm install && cd ..
cd frontend && npm install && npm run build && cd ..

# 3. 打包（排除 .git 和 docs）
# 使用 7-Zip 或 WinRAR 打包
```

### 5.2 部署包内容
```
GD32-ATE-Deploy/
├── backend/
│   ├── node_modules/      ← 已安装依赖
│   ├── config/
│   ├── ate/
│   ├── api/
│   ├── reports/           ← 空目录，存放报告
│   ├── logs/              ← 空目录，存放日志
│   ├── .env               ← 配置文件
│   └── server.js
├── frontend/
│   ├── dist/              ← 已构建产物
│   └── node_modules/      ← 已安装依赖（开发时需要）
├── shared/
├── start-ate.bat          ← 一键启动脚本
└── README.md
```

## 6. 常见问题

### 6.1 端口被占用
```bash
# 查看占用端口的进程
netstat -ano | findstr :3001

# 终止进程
taskkill /PID <进程ID> /F
```

### 6.2 设备连接失败
1. 检查环控器是否上电
2. 检查网线连接
3. 检查 IP 配置是否正确
4. 检查防火墙是否放行端口 502 和 9001

### 6.3 报告目录权限
确保 `backend/reports/` 和 `backend/logs/` 目录可写。

## 7. 技术支持

如有问题，请联系：
- 项目地址：https://github.com/wczhou-dev/GD32-Web-MaxClaw
