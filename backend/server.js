/**
 * server.js - GD32-Web-MaxClaw 主入口
 * 
 * 类比嵌入式：
 * - 就像 main() 函数，整个程序的起点
 * - 初始化各个外设（UART、GPIO、TIM等）
 * - 启动主循环
 */

const express = require('express');
const initLogger = require('./Logger'); // 引入日志模块
initLogger(); // 初始化日志拦截器，并执行双文件轮转逻辑

const cors = require('cors');
const path = require('path');
require('dotenv').config(); // 加载环境变量
const fs = require('fs');
const http = require('http');

// 导入各模块
const DevicePool = require('./DevicePool');
const PollingEngine = require('./PollingEngine');
const WebSocketManager = require('./WebSocketMgr');
const OTAHandler = require('./OTAHandler');
const createOtaRouter = require('./api/ota');
const TestManager = require('./ate/TestManager');
const SensorSimulator = require('./ate/SensorSimulator');
const testApiRouter = require('./api/test');
const sensorTestApiRouter = require('./api/sensor-test');

// ==================== 配置加载 ====================

/**
 * 加载配置文件
 * 类比：从Flash/EEPROM加载系统配置
 */
function loadConfig() {
    const configPath = path.join(__dirname, 'config', 'devices.json');

    // 默认配置
    let config = {
        devices: [{ name: '1号舍', ip: '192.168.110.125', port: 502, unitId: 1, enabled: true }],
        backend: { port: 3000, firmwarePath: 'F:/firmware' },
        polling: { intervalMs: 1000, timeoutMs: 2000, retryCount: 3 }
    };

    try {
        if (fs.existsSync(configPath)) {
            const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config = { ...config, ...fileConfig };
            console.log('[Config] Loaded:', config.devices?.length || 0, 'devices');
        }
    } catch (err) {
        console.error('[Config] Load error:', err.message);
    }

    // 应用环境变量覆盖 (如果存在)
    if (config.devices && config.devices[0] && process.env.DEVICE_IP) {
        console.log(`[Config] Overriding device IP with env: ${process.env.DEVICE_IP}`);
        config.devices[0].ip = process.env.DEVICE_IP;
    }

    if (process.env.PORT) {
        config.backend.port = parseInt(process.env.PORT);
    }
    if (process.env.FIRMWARE_PATH) {
        config.backend.firmwarePath = process.env.FIRMWARE_PATH;
    }

    // 返回最终配置
    return config;
}

// ==================== 获取本机IP ====================

/**
 * 获取本机局域网IP
 * 类比：获取网络接口地址
 */
function getLocalIP() {
    // 优先使用手动指定的 IP，解决多网卡抓错 IP 的问题
    if (process.env.LOCAL_IP) {
        return process.env.LOCAL_IP;
    }

    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

// ==================== 主程序 ====================

let sensorSimulator = null; // 模块级引用，供优雅退出使用

async function main() {
    console.log('========================================');
    console.log('  GD32-Web-MaxClaw 后端服务');
    console.log('========================================');

    // 1. 加载配置
    const config = loadConfig();
    const localIP = getLocalIP();
    console.log(`[System] Local IP: ${localIP}`);

    // 2. 初始化DevicePool（设备连接池）
    console.log('\n[Step 1/6] Initializing DevicePool...');
    const devicePool = new DevicePool();

    // 添加设备
    for (const dev of config.devices) {
        if (dev.enabled) {
            devicePool.addDevice(dev);
        }
    }

    // 3. 初始化OTA处理器
    console.log('\n[Step 2/6] Initializing OTA Handler...');
    const otaHandler = new OTAHandler({
        firmwarePath: config.backend.firmwarePath || 'F:/firmware',
        backendIp: localIP,
        port: 18080
    });
    await otaHandler.startServer();

    // 4. 初始化PollingEngine（轮询引擎）
    console.log('\n[Step 3/6] Initializing PollingEngine...');
    const pollingEngine = new PollingEngine(devicePool, config.polling);

    // 初始化全局 HTTP Server (供 WebSocket 和 Express 共享)
    const app = express();
    const server = http.createServer(app);
    const httpPort = config.backend.port || 3000;

    // 5. 初始化WebSocket管理器
    console.log('\n[Step 4/6] Initializing WebSocket...');
    const wsManager = new WebSocketManager({ server: server });

    // 设置数据回调 - 轮询到数据后推送给前端
    pollingEngine.onData = (deviceKey, sensorData) => {
        const device = devicePool.getAllDevices().find(d => d.key === deviceKey);
        if (device) {
            wsManager.pushSensorData(device.ip, sensorData);
        }
    };

    // 设置状态变化回调
    pollingEngine.onStatusChange = (deviceKey, status) => {
        const device = devicePool.getAllDevices().find(d => d.key === deviceKey);
        if (device) {
            wsManager.pushDeviceStatus(device.ip, status);
        }
    };

    await wsManager.start();

    // 初始化 ATE 测试管理器
    console.log('\n[Step 4.5] Initializing TestManager...');
    const testManager = new TestManager({
        devicePool,
        pollingEngine,
        wsManager,
    });

    // 初始化传感器模拟器（支持 Mock 和真实串口模式）
    console.log('\n[Step 4.6] Initializing SensorSimulator...');
    const sensorSimMock = process.env.SENSOR_SIM_MOCK === 'true' || !process.env.SENSOR_SIM_PORT;
    sensorSimulator = new SensorSimulator({
      mock: sensorSimMock,
      port: process.env.SENSOR_SIM_PORT || 'COM3',
      baudRate: parseInt(process.env.SENSOR_SIM_BAUD) || 9600,
    });
    try {
      await sensorSimulator.start();
      console.log(`[SensorSimulator] 启动成功 (mode=${sensorSimMock ? 'mock' : 'serial'})`);
    } catch (err) {
      console.warn(`[SensorSimulator] 启动失败: ${err.message}，将以 Mock 模式运行`);
    }
    testManager.setSensorSimulator(sensorSimulator);

    // 将 testManager、wsManager 和 pollingEngine 注册到 Express app，供 API 路由使用
    app.set('testManager', testManager);
    app.set('wsManager', wsManager);
    app.set('pollingEngine', pollingEngine);

    // 注意：TestManager._emitSessionUpdate() 已经通过 wsManager.broadcast() 直接推送
    // 标准 WebSocket 消息（test_progress_update, test_finished_notification, test_error），
    // 不再额外监听事件以避免双重广播。

    // 设置客户端消息处理
    wsManager.onClientMessage = async (clientId, message) => {
        console.log(`[WS] Client message: ${message.type}`);

        switch (message.type) {
            case 'relay_control':
                try {
                    // 查找设备
                    const device = devicePool.getAllDevices().find(d => d.ip === message.deviceIp);
                    if (device) {
                        await pollingEngine.controlRelay(device.key, message.relayIndex, message.value);
                        wsManager.sendResponse(clientId, 'relay_control', true);
                    } else {
                        wsManager.sendResponse(clientId, 'relay_control', false, { error: 'Device not found' });
                    }
                } catch (err) {
                    wsManager.sendResponse(clientId, 'relay_control', false, { error: err.message });
                }
                break;

            case 'ota_start':
                try {
                    const device = devicePool.getAllDevices().find(d => d.ip === message.deviceIp);
                    if (device) {
                        await pollingEngine.triggerOTA(device.key, message.version);
                        wsManager.sendResponse(clientId, 'ota_start', true);
                    } else {
                        wsManager.sendResponse(clientId, 'ota_start', false, { error: 'Device not found' });
                    }
                } catch (err) {
                    wsManager.sendResponse(clientId, 'ota_start', false, { error: err.message });
                }
                break;

            case 'get_devices':
                // 返回设备列表
                wsManager.sendToClient(clientId, {
                    type: 'device_list',
                    devices: devicePool.getAllDevices()
                });
                break;

            // ============================================================
            // ATE 自动化测试消息处理
            // ============================================================

            case 'start_test_request':
                try {
                    const device = devicePool.getAllDevices().find(d => d.ip === message.deviceIp);
                    if (!device) {
                        wsManager.sendResponse(clientId, 'start_test_request', false, { error: '设备未找到' });
                        break;
                    }

                    // 异步启动测试（不阻塞 WebSocket）
                    testManager.startSession({
                        deviceKey: device.key,
                        deviceIp: message.deviceIp,
                        operatorInputId: message.operatorInputId,
                        deviceModel: message.deviceModel,
                        workOrder: message.workOrder,
                        selectedItemIds: message.selectedItemIds || [],
                    }).catch(err => {
                        console.error('[ATE] Start session error:', err.message);
                        wsManager.pushTestError({
                            deviceIp: message.deviceIp,
                            message: err.message,
                        });
                    });

                    wsManager.sendResponse(clientId, 'start_test_request', true);
                } catch (err) {
                    wsManager.sendResponse(clientId, 'start_test_request', false, { error: err.message });
                }
                break;

            case 'stop_test_request':
                try {
                    const device = devicePool.getAllDevices().find(d => d.ip === message.deviceIp);
                    if (device) {
                        await testManager.stopSession(device.key);
                        wsManager.sendResponse(clientId, 'stop_test_request', true);
                    } else {
                        wsManager.sendResponse(clientId, 'stop_test_request', false, { error: '设备未找到' });
                    }
                } catch (err) {
                    wsManager.sendResponse(clientId, 'stop_test_request', false, { error: err.message });
                }
                break;

            case 'reset_test_request':
                try {
                    const device = devicePool.getAllDevices().find(d => d.ip === message.deviceIp);
                    if (device) {
                        await testManager.resetSession(device.key);
                        wsManager.sendResponse(clientId, 'reset_test_request', true);
                    } else {
                        wsManager.sendResponse(clientId, 'reset_test_request', false, { error: '设备未找到' });
                    }
                } catch (err) {
                    wsManager.sendResponse(clientId, 'reset_test_request', false, { error: err.message });
                }
                break;

            case 'retry_failed_request':
                try {
                    const device = devicePool.getAllDevices().find(d => d.ip === message.deviceIp);
                    if (device) {
                        await testManager.retryFailed(device.key);
                        wsManager.sendResponse(clientId, 'retry_failed_request', true);
                    } else {
                        wsManager.sendResponse(clientId, 'retry_failed_request', false, { error: '设备未找到' });
                    }
                } catch (err) {
                    wsManager.sendResponse(clientId, 'retry_failed_request', false, { error: err.message });
                }
                break;

            case 'get_test_session':
                try {
                    const device = devicePool.getAllDevices().find(d => d.ip === message.deviceIp);
                    if (device) {
                        const session = testManager.getSession(device.key);
                        wsManager.sendResponse(clientId, 'get_test_session', true, { session });
                    } else {
                        wsManager.sendResponse(clientId, 'get_test_session', false, { error: '设备未找到' });
                    }
                } catch (err) {
                    wsManager.sendResponse(clientId, 'get_test_session', false, { error: err.message });
                }
                break;

            case 'manual_force_io_request':
                try {
                    const device = devicePool.getAllDevices().find(d => d.ip === message.deviceIp);
                    if (!device) {
                        wsManager.sendResponse(clientId, 'manual_force_io_request', false, { error: '设备未找到' });
                        break;
                    }
                    const result = await testManager.manualForceIo({
                        deviceKey: device.key,
                        deviceIp: message.deviceIp,
                        outputs: message.outputs || {},
                        timeoutMs: message.timeoutMs || 0,
                    });
                    wsManager.sendResponse(clientId, 'manual_force_io_request', result.success, result);
                } catch (err) {
                    wsManager.sendResponse(clientId, 'manual_force_io_request', false, { error: err.message });
                }
                break;
        }
    };

    // 6. 配置Express API服务
    console.log('\n[Step 5/6] Configuring Express API...');

    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // 挂载pollingEngine到app
    app.locals.pollingEngine = pollingEngine;
    app.locals.wsManager = wsManager;

    // 注册OTA路由
    app.use('/api/ota', createOtaRouter(otaHandler));

    // 注册ATE测试报告路由
    app.use('/api/test', testApiRouter);

    // 注册传感器自动测试路由
    app.use('/api/sensor-test', sensorTestApiRouter);

    // 设备列表API
    app.get('/api/devices', (req, res) => {
        res.json({ success: true, devices: devicePool.getAllDevices() });
    });

    // 设备状态API
    app.get('/api/devices/:ip/status', (req, res) => {
        const devices = devicePool.getAllDevices();
        const device = devices.find(d => d.ip === req.params.ip);
        if (device) {
            res.json({ success: true, status: devicePool.getStatus(device.key) });
        } else {
            res.status(404).json({ success: false, error: 'Device not found' });
        }
    });

    // 健康检查
    app.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            uptime: process.uptime(),
            devices: devicePool.getAllDevices().map(d => ({ ip: d.ip, status: d.status })),
            wsClients: wsManager.getStats().clientCount
        });
    });

    // 生产模式：托管前端构建产物
    const distPath = path.join(__dirname, '..', 'frontend', 'dist');
    if (fs.existsSync(distPath)) {
        console.log(`[Static] Serving frontend from: ${distPath}`);
        app.use(express.static(distPath));
        // SPA fallback：所有非 API 路由返回 index.html
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    // 启动基于共享端口的HTTP/WebSocket服务
    server.listen(httpPort, () => {
        console.log(`\n[Step 6/6] HTTP server: http://localhost:${httpPort}`);
        console.log('\n========================================');
        console.log('  ✅ GD32-Web-MaxClaw 后端启动成功！');
        console.log('========================================');
        console.log(`\n📍 访问地址:`);
        console.log(`   HTTP API: http://localhost:${httpPort}`);
        console.log(`   WebSocket: ws://localhost:${httpPort}`);
        console.log(`   OTA固件: http://${localIP}:18080/download/SciGeneAI.rbl`);
        console.log(`\n📡 等待环控器连接...`);
        console.log(`   IP: ${config.devices[0]?.ip || '192.168.110.125'}`);
        console.log('');
    });

    // 连接所有设备
    console.log('\n[Connect] Connecting to devices...');
    for (const device of devicePool.getAllDevices()) {
        if (device.enabled) {
            await devicePool.connect(device.key);
        }
    }

    // 启动轮询
    pollingEngine.start();

    // 启动心跳检测
    wsManager.startHeartbeat();
}

// 错误处理
process.on('uncaughtException', (err) => {
    console.error('[Error] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Error] Unhandled rejection at:', promise, 'reason:', reason);
});

// 优雅退出
process.on('SIGINT', async () => {
    console.log('\n[System] Shutting down...');
    try { await sensorSimulator.stop(); } catch (_) {}
    process.exit(0);
});

// 启动
main().catch(err => {
    console.error('[Error] Fatal error:', err);
    process.exit(1);
});
