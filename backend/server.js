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
const AteTcpClient = require('./ate/AteTcpClient');
const MshClient = require('./ate/MshClient');
const TestManager = require('./ate/TestManager');
const SensorSimulator = require('./ate/SensorSimulator');
const HilSessionManager = require('./ate/HilSessionManager');
const testApiRouter = require('./api/test');
const sensorTestApiRouter = require('./api/sensor-test');
const sensorSimulatorRouter = require('./api/sensor-simulator');

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

    // 初始化 ATE TCP 客户端 (JSON 协议，端口 9001)
    // 用于写入告警使能位等 JSON 属性配置
    const ateClient = new AteTcpClient({
      deviceIp: '192.168.110.125',
      port: parseInt(process.env.ATE_TCP_PORT) || 9001,
    });
    testManager.setAteClient(ateClient);
    console.log('[ATE] AteTcpClient 初始化完成 (端口 9001)');

    // 初始化 MSH 调试串口客户端 (用于历史缓冲读写)
    const mshClient = new MshClient({
      port: process.env.DEBUG_UART_PORT || 'COM4',
      baudRate: parseInt(process.env.DEBUG_UART_BAUD) || 115200,
    });
    testManager.setMshClient(mshClient);
    console.log('[MSH] MshClient 初始化完成 (端口 ' + (process.env.DEBUG_UART_PORT || 'COM4') + ')');

    // 注入轮询引擎引用 (测试时暂停轮询避免干扰)
    testManager.setPollingEngine(pollingEngine);

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
      // 加载默认场区配置（A型场区），使模拟器能响应环控器的 RS485 轮询
      const fieldType = process.env.SENSOR_FIELD_TYPE || 'A';
      sensorSimulator.loadFieldConfig(fieldType);
      console.log(`[SensorSimulator] 已加载场区配置: ${fieldType}`);

      // 初始化全部 16 路传感器的影子寄存器
      // 固件 sensor_map.c DONGYING/GUCHENG 版从站地址表 (匹配 rtconfig.h KEIL_VERSION_DONGYING):
      const fwSlaveAddrs = [0x01,0x02,0x03,0x07,0x08,0x09,0x50,0x1A,0x1B,0x1C,0x1D,0x1E,0x1F,0x51,0x33,0x34];
      fwSlaveAddrs.forEach((addr, i) => {
        // 注册 _sensorKeyMap（让 _findSensorKey 能找到）
        const key = 'temp_' + (i + 1);
        const humiKey = 'humi_' + (i + 1);
        // 固件寄存器顺序: reg0=湿度(HUM_INDEX), reg1=温度(TEM_INDEX)
        sensorSimulator._sensorKeyMap.set(key, {
            slaveAddr: addr,
            registerAddr: 0x0001,  // temp → register 1
            registerCount: 1,
            scale: 10,
          });
        sensorSimulator._sensorKeyMap.set(humiKey, {
            slaveAddr: addr,
            registerAddr: 0x0000,  // humi → register 0
            registerCount: 1,
            scale: 10,
          });
        // 初始化影子寄存器
        if (!sensorSimulator._shadowRegisters.has(addr)) {
          sensorSimulator._shadowRegisters.set(addr, new Map());
        }
        const regs = sensorSimulator._shadowRegisters.get(addr);
        // 固件 RS485 寄存器顺序: reg0=湿度, reg1=温度 (HUM_INDEX=0, TEM_INDEX=1)
        regs.set(0x0000, (40 + i * 2) * 10);   // 湿度: 40%, 42%, 44%, ...
        regs.set(0x0001, (20 + i) * 10);         // 温度: 20°C, 21°C, 22°C, ...
      });
      console.log('[SensorSimulator] 已初始化 16 路传感器影子寄存器 (slave: ' +
        fwSlaveAddrs.map(a => '0x' + a.toString(16)).join(',') + ')');

      // 初始化 CO2 传感器默认值（固件用 FC03 读 register 0x0002）
      const co2Defaults = [
        { key: 'co2_1', val: 400 }, { key: 'co2_2', val: 600 },
        { key: 'co2_3', val: 800 }, { key: 'co2_4', val: 1000 },
        { key: 'co2_5', val: 1200 }, { key: 'co2_6', val: 500 },
        { key: 'co2_7', val: 700 }, { key: 'co2_8', val: 900 },
      ];
      for (const c of co2Defaults) {
        sensorSimulator.setSensorValue(c.key, c.val);
      }
      console.log('[SensorSimulator] 已初始化 8 路 CO2 默认值');

      // 初始化压差传感器默认值（固件用 FC04 读 register 0x0000）
      const pressDefaults = [
        { key: 'press_1', val: 0 }, { key: 'press_2', val: 10 },
        { key: 'press_3', val: 25 }, { key: 'press_4', val: 50 },
      ];
      for (const p of pressDefaults) {
        sensorSimulator.setSensorValue(p.key, p.val);
      }
      console.log('[SensorSimulator] 已初始化 4 路压差默认值');
    } catch (err) {
      console.warn(`[SensorSimulator] 启动失败: ${err.message}，将以 Mock 模式运行`);
    }
    testManager.setSensorSimulator(sensorSimulator);

    // 将 testManager、wsManager 和 pollingEngine 注册到 Express app，供 API 路由使用
    app.set('testManager', testManager);
    app.set('wsManager', wsManager);
    app.set('pollingEngine', pollingEngine);
    app.set('sensorSimulator', sensorSimulator);

    // 初始化 HIL 会话管理器
    const hilSessionManager = new HilSessionManager({
      testManager,
      sensorSimulator,
      wsManager,
      devicePool,
    });
    app.set('hilSessionManager', hilSessionManager);
    console.log('[HilSession] 初始化完成');

    // 注意：TestManager._emitSessionUpdate() 已经通过 wsManager.broadcast() 直接推送
    // 标准 WebSocket 消息（test_progress_update, test_finished_notification, test_error），
    // 不再额外监听事件以避免双重广播。

    // 设置客户端消息处理
    wsManager.onClientMessage = async (clientId, message) => {
        console.log(`[WS] Client message: ${message.type}`);

        switch (message.type) {
            case 'set_log_save_config':
                try {
                    global.autoSaveMcuLogs = message.autoSave;
                    console.log(`[Config] 串口日志本地自动保存已切换为: ${global.autoSaveMcuLogs}`);
                    wsManager.sendResponse(clientId, 'set_log_save_config', true);
                } catch (err) {
                    wsManager.sendResponse(clientId, 'set_log_save_config', false, { error: err.message });
                }
                break;
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

    // 注册传感器模拟器控制路由
    app.use('/api/sensor-simulator', sensorSimulatorRouter);

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

    // 配置 GD32 传感器安装掩码（使固件开始 RS485 轮询）
    try {
        const device = devicePool.getAllDevices().find(d => d.enabled);
        if (device) {
            // 检查并写入场区类型 (若为 0 则写入默认值 B=2)
            const zoneResult = await devicePool.runExclusive(device.key, async () => {
                return await devicePool.readHoldingRegisters(device.key, 0x0019, 1);
            });
            const zoneVal = zoneResult?.data?.[0] ?? 0;
            if (zoneVal === 0) {
                const defaultZone = parseInt(process.env.DEFAULT_FIELD_ZONE || '2', 10);
                await devicePool.runExclusive(device.key, async () => {
                    await devicePool.writeRegister(device.key, 0x0019, defaultZone);
                });
                console.log(`[SensorConfig] 场区类型写入: ${defaultZone} (0x0019 原值为 0)`);
            } else {
                console.log(`[SensorConfig] 场区类型: ${zoneVal}`);
            }
            // 从环境变量或默认值读取传感器安装掩码
            const tempMask = parseInt(process.env.SENSOR_TEMP_MASK || '0xFFFF', 16);
            const humiMask = parseInt(process.env.SENSOR_HUMI_MASK || '0xFFFF', 16);
            // 逐个写入安装掩码，中间加延迟防止 TCP 超时
            await devicePool.writeRegister(device.key, 0x700A, tempMask);
            await new Promise(r => setTimeout(r, 500));
            await devicePool.writeRegister(device.key, 0x700B, humiMask);
            await new Promise(r => setTimeout(r, 500));
            await devicePool.writeRegister(device.key, 0x700C, 0x00FF);  // CO2 全部8路
            await new Promise(r => setTimeout(r, 500));
            await devicePool.writeRegister(device.key, 0x700E, 0x000F);  // 压差 全部4路
            console.log(`[SensorConfig] 传感器安装掩码: temp=0x${tempMask.toString(16).padStart(4,'0')} humi=0x${humiMask.toString(16).padStart(4,'0')} CO2=0xFF press=0x0F`);
        }
    } catch (err) {
        console.warn('[SensorConfig] 传感器配置写入失败:', err.message);
    }

    // 启动心跳检测
    wsManager.startHeartbeat();

    // [HIL 自动化开发] 启动 MCU 物理调试串口日志监听与广播转发
    // 同时将串口实例共享给 MshClient，避免两者争抢 COM4 端口
    const sharedPortRef = { port: null };
    initMcuSerialMonitor(wsManager, (port) => {
        sharedPortRef.port = port;
        mshClient.setExistingPort(port).then(() => {
            console.log('[MSH] 已复用 MCU 监视器的串口实例，无需单独打开 COM4');
        }).catch(err => {
            console.warn('[MSH] 复用串口实例失败:', err.message, '将在测试时尝试独立打开');
        });
    });
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


/**
 * [嵌入式与 Web 桥接类比]
 * initMcuSerialMonitor 相当于初始化一个独立的 DMA 串口接收通道加中断队列，
 * 当调试串口缓冲区有新数据时触发回调，一方面写入本地环形日志文件，另一方面通过全双工 WebSocket (WS) 推送至人机界面。
 *
 * @param {WebSocketManager} wsManager
 * @param {function} [onPortReady] - 可选回调，串口打开成功后调用，参数为 SerialPort 实例。
 *                                   用于将共享串口传递给 MshClient，避免端口冲突。
 */
function initMcuSerialMonitor(wsManager, onPortReady) {
    const configPath = path.join(__dirname, 'config', 'hil.config.json');
    if (!fs.existsSync(configPath)) {
        console.log('[Monitor] 提示：未检测到 config/hil.config.json 配置文件，跳过物理串口日志监听。');
        return;
    }

    let hilConfig;
    try {
        hilConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
        console.error('[Monitor] 解析 HIL 配置文件失败:', err.message);
        return;
    }

    const monitorConfig = hilConfig.monitor || {};
    const portPath = monitorConfig.debugSerialPort;
    const baudRate = monitorConfig.baudRate || 115200;
    const logFile = monitorConfig.logFile || 'logs/firmware_runtime.log';

    if (!portPath) {
        console.log('[Monitor] HIL 配置中未指定 debugSerialPort，跳过物理串口监听。');
        return;
    }

    const logFilePath = path.isAbsolute(logFile) ? logFile : path.join(__dirname, '..', logFile);
    
    // 确保日志文件夹存在
    try {
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    } catch (err) {
        console.error('[Monitor] 创建日志归档目录失败:', err.message);
    }

    // 以追加模式打开写入 file 流
    const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    const { SerialPort } = require('serialport');
    const { ReadlineParser } = require('@serialport/parser-readline');

    let port = null;
    let reconnectTimer = null;

    function connect() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        console.log('[Monitor] 串口监视器：正在尝试打开物理调试串口 ' + portPath + ' (波特率: ' + baudRate + ')...');
        
        port = new SerialPort({
            path: portPath,
            baudRate: baudRate,
            autoOpen: false
        });

        const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

        port.open((err) => {
            if (err) {
                let errMsg = '[Monitor] 打开串口 ' + portPath + ' 失败: ' + err.message;
                if (err.message.includes('Access denied')) {
                    errMsg += '。请确保关闭了电脑上其他正在使用该串口的调试终端或串口助手（如 SSCOM、Xshell 等），并等待 5 秒重连自愈。';
                } else {
                    errMsg += '。5秒后将尝试重新连接...';
                }
                console.error(errMsg);
                
                // 同时也向前端广播该报错信息，提示用户关闭串口助手
                wsManager.broadcast({
                    type: 'mcu_log',
                    data: errMsg
                });
                
                // 本地离线测试：如果串口未打开，每3秒模拟广播一次日志数据，方便前端调试 WebSocket 日志输出
                if (!global.mockSerialInterval) {
                    global.mockSerialInterval = setInterval(() => {
                        const timeStr = new Date().toLocaleTimeString();
                        wsManager.broadcast({
                            type: 'mcu_log',
                            data: '[Mock UART ' + timeStr + '] [Info] rtthread_main_thread init success, MSH shell active'
                        });
                    }, 3000);
                }

                reconnectTimer = setTimeout(connect, 5000);
                return;
            }

            // 成功连接后关闭 Mock 定时器
            if (global.mockSerialInterval) {
                clearInterval(global.mockSerialInterval);
                global.mockSerialInterval = null;
            }

            console.log('[Monitor] 成功连接至调试物理串口: ' + portPath + '，启动实时日志监听与广播。');

            // 通知外部模块（如 MshClient）串口已就绪，可共享使用
            if (typeof onPortReady === 'function') {
                try {
                    onPortReady(port);
                    console.log('[Monitor] 已将串口实例共享给 MshClient');
                } catch (e) {
                    console.error('[Monitor] 共享串口实例失败:', e.message);
                }
            }
        });

        parser.on('data', (line) => {
            const timestamp = new Date().toISOString();
            const formattedLine = '[' + timestamp + '] [MCU] ' + line;
            
            // 1. 本地持久化追加
            if (global.autoSaveMcuLogs !== false) {
                logStream.write(formattedLine + '\n');
            }
            
            // 2. 通过 WebSocket 实时广播给前端
            wsManager.broadcast({
                type: 'mcu_log',
                data: line
            });
        });

        port.on('error', (err) => {
            console.error('[Monitor] 串口 ' + portPath + ' 发生内部异常: ' + err.message);
        });

        port.on('close', () => {
            console.log('[Monitor] 串口 ' + portPath + ' 连接关闭或拔出。5秒后进入重连就绪队列...');
            reconnectTimer = setTimeout(connect, 5000);
        });
    }

    connect();

    // 注册进程退出时的优雅释放动作，防止句柄僵死占用 COM 端口
    process.on('SIGINT', () => {
        if (port && port.isOpen) {
            port.close();
        }
    });
}
