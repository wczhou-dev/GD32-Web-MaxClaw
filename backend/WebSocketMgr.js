/**
 * WebSocketMgr.js - WebSocket管理器
 * 
 * 类比嵌入式：
 * - 就像USART的TX/RX中断或DMA通道
 * - 负责前端和后端之间的数据通信
 * - 前端 <-> WebSocket <-> 后端 <-> Modbus
 */

const WebSocket = require('ws');

class WebSocketManager {
    /**
     * @param {Object} options - 配置选项
     */
    constructor(options = {}) {
        this.port = options.port || 3000;
        this.clients = new Map();  // 存储连接的客户端
        this.wss = null;
        
        // 回调
        this.onClientMessage = null;  // 客户端消息回调
    }

    /**
     * 启动WebSocket服务
     * 类比：USART初始化，设置波特率等
     */
    start() {
        return new Promise((resolve, reject) => {
            try {
                this.wss = new WebSocket.Server({ port: this.port });
                
                this.wss.on('connection', (ws, req) => {
                    this.handleConnection(ws, req);
                });

                this.wss.on('error', (err) => {
                    console.error('[WS] Server error:', err.message);
                    reject(err);
                });

                console.log(`[WS] Server started on port ${this.port}`);
                resolve();
            } catch (err) {
                console.error('[WS] Start failed:', err.message);
                reject(err);
            }
        });
    }

    /**
     * 处理新的客户端连接
     * @param {WebSocket} ws - WebSocket连接
     * @param {Object} req - HTTP请求
     */
    handleConnection(ws, req) {
        const clientId = this.generateClientId();
        const clientInfo = {
            id: clientId,
            ws: ws,
            ip: req.socket.remoteAddress,
            connectTime: Date.now(),
            lastMessage: Date.now()
        };
        
        this.clients.set(clientId, clientInfo);
        console.log(`[WS] Client connected: ${clientId} (${clientInfo.ip})`);

        // 发送欢迎消息
        this.sendToClient(clientId, {
            type: 'connected',
            clientId: clientId,
            timestamp: Date.now()
        });

        // 监听消息
        ws.on('message', (data) => {
            this.handleMessage(clientId, data);
        });

        // 监听关闭
        ws.on('close', () => {
            console.log(`[WS] Client disconnected: ${clientId}`);
            this.clients.delete(clientId);
        });

        // 监听错误
        ws.on('error', (err) => {
            console.error(`[WS] Client ${clientId} error:`, err.message);
        });

        // 设置心跳检测
        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
    }

    /**
     * 处理客户端消息
     * @param {string} clientId - 客户端ID
     * @param {Buffer} data - 消息数据
     */
    handleMessage(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client) return;

        client.lastMessage = Date.now();

        try {
            const message = JSON.parse(data.toString());
            console.log(`[WS] Message from ${clientId}:`, message.type);

            // 触发回调
            if (this.onClientMessage) {
                this.onClientMessage(clientId, message);
            }
        } catch (err) {
            console.error(`[WS] Parse message failed:`, err.message);
        }
    }

    /**
     * 广播数据到所有客户端
     * 类比：DMA发送数据到所有从机
     * 
     * @param {Object} data - 要广播的数据
     */
    broadcast(data) {
        const message = JSON.stringify(data);
        
        for (const [clientId, client] of this.clients) {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
            }
        }
    }

    /**
     * 发送数据到指定客户端
     * @param {string} clientId - 客户端ID
     * @param {Object} data - 数据
     */
    sendToClient(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client) return false;

        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
            return true;
        }
        return false;
    }

    /**
     * 推送传感器数据
     * @param {string} deviceIp - 设备IP
     * @param {Object} sensorData - 传感器数据
     */
    pushSensorData(deviceIp, sensorData) {
        this.broadcast({
            type: 'sensor_data',
            deviceIp: deviceIp,
            timestamp: Date.now(),
            data: sensorData
        });
    }

    /**
     * 推送设备状态
     * @param {string} deviceIp - 设备IP
     * @param {string} status - ONLINE/OFFLINE/RECONNECTING
     * @param {number} timeoutCount - 超时次数
     */
    pushDeviceStatus(deviceIp, status, timeoutCount = 0) {
        this.broadcast({
            type: 'device_status',
            deviceIp: deviceIp,
            timestamp: Date.now(),
            status: status,
            timeoutCount: timeoutCount
        });
    }

    /**
     * 推送OTA进度
     * @param {string} deviceIp - 设备IP
     * @param {number} progress - 进度 0-100
     * @param {number} status - OTA状态码
     */
    pushOTAProgress(deviceIp, progress, status) {
        this.broadcast({
            type: 'ota_progress',
            deviceIp: deviceIp,
            timestamp: Date.now(),
            progress: progress,
            status: status
        });
    }

    /**
     * 发送响应给客户端
     * @param {string} clientId - 客户端ID
     * @param {string} requestType - 请求类型
     * @param {boolean} success - 是否成功
     * @param {Object} data - 响应数据
     */
    sendResponse(clientId, requestType, success, data = {}) {
        this.sendToClient(clientId, {
            type: `${requestType}_response`,
            success: success,
            timestamp: Date.now(),
            ...data
        });
    }

    /**
     * 生成客户端ID
     */
    generateClientId() {
        return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * 获取连接统计
     */
    getStats() {
        return {
            clientCount: this.clients.size,
            clients: Array.from(this.clients.values()).map(c => ({
                id: c.id,
                ip: c.ip,
                connectTime: c.connectTime,
                lastMessage: c.lastMessage
            }))
        };
    }

    /**
     * 停止服务
     */
    stop() {
        if (this.wss) {
            this.wss.close();
            this.wss = null;
            console.log('[WS] Server stopped');
        }
    }

    /**
     * 启动心跳检测
     */
    startHeartbeat(intervalMs = 30000) {
        setInterval(() => {
            if (!this.wss) return;

            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    return ws.terminate();
                }

                ws.isAlive = false;
                ws.pong();
            });
        }, intervalMs);
    }
}

module.exports = WebSocketManager;
