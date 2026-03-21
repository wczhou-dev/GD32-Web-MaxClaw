/**
 * DevicePool.js - 设备连接池
 * 
 * 类比嵌入式：
 * - 就像管理多个UART串口句柄
 * - 每个设备对应一个TCP连接（类似一个串口设备）
 * - 提供连接的创建、销毁、重连等生命周期管理
 */

const ModbusRTU = require("modbus-serial");

class DevicePool {
    constructor() {
        /** @type {Map<string, {client: ModbusRTU, info: Object, status: string}>} */
        this.devices = new Map();
        this.eventHandlers = new Map();
    }

    /**
     * 注册设备
     * @param {Object} config - 设备配置
     * @param {string} config.ip - 设备IP地址
     * @param {number} config.port - Modbus端口，默认502
     * @param {number} config.unitId - 设备Unit ID，默认1
     */
    addDevice(config) {
        const key = `${config.ip}:${config.port}:${config.unitId}`;
        
        if (this.devices.has(key)) {
            console.log(`[DevicePool] Device ${key} already exists`);
            return;
        }

        const client = new ModbusRTU();
        client.setID(config.unitId || 1);
        client.setTimeout(config.timeoutMs || 2000);

        const deviceInfo = {
            ip: config.ip,
            port: config.port || 502,
            unitId: config.unitId || 1,
            name: config.name || config.ip,
            enabled: config.enabled !== false,
            timeoutCount: 0,
            lastSeen: null
        };

        this.devices.set(key, {
            client,
            info: deviceInfo,
            status: 'INIT'
        });

        console.log(`[DevicePool] Device added: ${config.name} (${key})`);
    }

    /**
     * 连接设备
     * 类比：UART_Open() 打开串口
     */
    async connect(key) {
        const device = this.devices.get(key);
        if (!device) {
            throw new Error(`Device ${key} not found`);
        }

        if (device.status === 'CONNECTED') {
            return true;
        }

        try {
            device.status = 'CONNECTING';
            this.emit('statusChange', key, 'CONNECTING');

            // 建立TCP连接（类比：串口打开成功）
            await device.client.connectTCP(device.info.ip, { 
                port: device.info.port 
            });

            device.status = 'CONNECTED';
            device.info.timeoutCount = 0;
            device.info.lastSeen = Date.now();
            
            console.log(`[DevicePool] Connected: ${device.info.name} (${key})`);
            this.emit('statusChange', key, 'ONLINE');
            
            return true;
        } catch (err) {
            device.status = 'DISCONNECTED';
            console.error(`[DevicePool] Connect failed: ${device.info.name} - ${err.message}`);
            this.emit('statusChange', key, 'OFFLINE');
            return false;
        }
    }

    /**
     * 断开连接
     * 类比：UART_Close() 关闭串口
     */
    async disconnect(key) {
        const device = this.devices.get(key);
        if (!device) return;

        try {
            device.client.close(() => {});
            device.status = 'DISCONNECTED';
            this.emit('statusChange', key, 'OFFLINE');
        } catch (err) {
            console.error(`[DevicePool] Disconnect error: ${err.message}`);
        }
    }

    /**
     * 读取保持寄存器
     * 类比：HAL_UART_Receive() 串口接收数据
     * 
     * @param {string} key - 设备标识
     * @param {number} address - 寄存器地址
     * @param {number} length - 读取长度
     */
    async readHoldingRegisters(key, address, length) {
        const device = this.devices.get(key);
        if (!device) {
            throw new Error(`Device ${key} not found`);
        }

        if (device.status !== 'CONNECTED') {
            throw new Error(`Device ${key} not connected`);
        }

        try {
            // 发起Modbus读请求（类比：发送读命令到串口）
            const response = await device.client.readHoldingRegisters(address, length);
            
            // 成功，更新状态
            device.info.timeoutCount = 0;
            device.info.lastSeen = Date.now();
            
            return response;
        } catch (err) {
            // 处理超时等错误
            device.info.timeoutCount++;
            
            if (device.info.timeoutCount >= 3) {
                device.status = 'OFFLINE';
                this.emit('statusChange', key, 'OFFLINE');
                console.error(`[DevicePool] Device ${key} OFFLINE (timeout ${device.info.timeoutCount})`);
            }
            
            throw err;
        }
    }

    /**
     * 写入单个寄存器
     * 类比：HAL_GPIO_WritePin() GPIO输出
     * 
     * @param {string} key - 设备标识
     * @param {number} address - 寄存器地址
     * @param {number} value - 写入值
     */
    async writeRegister(key, address, value) {
        const device = this.devices.get(key);
        if (!device) {
            throw new Error(`Device ${key} not found`);
        }

        if (device.status !== 'CONNECTED') {
            throw new Error(`Device ${key} not connected`);
        }

        try {
            await device.client.writeRegister(address, value);
            return true;
        } catch (err) {
            console.error(`[DevicePool] Write failed: ${err.message}`);
            throw err;
        }
    }

    /**
     * 写入多个寄存器
     * @param {string} key - 设备标识
     * @param {number} address - 起始地址
     * @param {number[]} values - 值数组
     */
    async writeRegisters(key, address, values) {
        const device = this.devices.get(key);
        if (!device) {
            throw new Error(`Device ${key} not found`);
        }

        if (device.status !== 'CONNECTED') {
            throw new Error(`Device ${key} not connected`);
        }

        try {
            await device.client.writeRegisters(address, values);
            return true;
        } catch (err) {
            console.error(`[DevicePool] WriteRegisters failed: ${err.message}`);
            throw err;
        }
    }

    /**
     * 获取设备状态
     */
    getStatus(key) {
        const device = this.devices.get(key);
        if (!device) return null;

        return {
            status: device.status,
            timeoutCount: device.info.timeoutCount,
            lastSeen: device.info.lastSeen
        };
    }

    /**
     * 获取所有设备信息
     */
    getAllDevices() {
        const result = [];
        for (const [key, device] of this.devices) {
            result.push({
                key,
                ...device.info,
                status: device.status,
                timeoutCount: device.info.timeoutCount,
                lastSeen: device.info.lastSeen
            });
        }
        return result;
    }

    /**
     * 获取在线设备数量
     */
    getOnlineCount() {
        let count = 0;
        for (const [, device] of this.devices) {
            if (device.status === 'CONNECTED') count++;
        }
        return count;
    }

    /**
     * 事件注册
     */
    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event).push(handler);
    }

    /**
     * 触发事件
     */
    emit(event, ...args) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.forEach(h => h(...args));
        }
    }
}

module.exports = DevicePool;
