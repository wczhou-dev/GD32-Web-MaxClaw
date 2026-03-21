/**
 * PollingEngine.js - 轮询引擎
 * 
 * 类比嵌入式：
 * - 就像一个定时器中断服务程序（TIM_IRQHandler）
 * - 每隔一定周期（如1ms）对所有设备进行Modbus轮询
 * - 主动读取传感器数据，更新设备状态
 */

const DataParser = require('./DataParser');

class PollingEngine {
    /**
     * @param {DevicePool} devicePool - 设备连接池
     * @param {Object} options - 配置选项
     */
    constructor(devicePool, options = {}) {
        this.pool = devicePool;
        this.parser = new DataParser();
        
        // 配置
        this.config = {
            intervalMs: options.intervalMs || 1000,  // 轮询间隔（ms）
            maxRetries: options.maxRetries || 3        // 最大重试次数
        };
        
        // 状态
        this.isRunning = false;
        this.timerId = null;
        this.heartbeatCounter = 0;
        
        // 回调
        this.onData = null;      // 数据回调
        this.onStatusChange = null;  // 状态变化回调
        
        // 互斥锁（写入操作时暂停轮询）
        this.writeLock = false;
    }

    /**
     * 启动轮询
     * 类比：启动定时器，启用TIM中断
     */
    start() {
        if (this.isRunning) {
            console.log('[PollingEngine] Already running');
            return;
        }

        this.isRunning = true;
        console.log(`[PollingEngine] Started (interval: ${this.config.intervalMs}ms)`);
        
        // 立即执行一次
        this.pollAllDevices();
        
        // 启动定时器
        this.timerId = setInterval(() => {
            if (!this.writeLock) {
                this.pollAllDevices();
            }
        }, this.config.intervalMs);
    }

    /**
     * 停止轮询
     * 类比：关闭定时器，禁用TIM中断
     */
    stop() {
        if (this.timerId) {
            clearInterval(this.timerId);
            this.timerId = null;
        }
        this.isRunning = false;
        console.log('[PollingEngine] Stopped');
    }

    /**
     * 轮询所有设备
     * 类比：定时器中断触发，执行一次轮询任务
     */
    async pollAllDevices() {
        const devices = this.pool.getAllDevices();
        
        for (const device of devices) {
            if (!device.enabled) continue;
            
            try {
                await this.pollDevice(device.key);
            } catch (err) {
                console.error(`[PollingEngine] Poll ${device.key} failed: ${err.message}`);
            }
        }
    }

    /**
     * 轮询单个设备
     * @param {string} key - 设备标识
     */
    async pollDevice(key) {
        // 确保设备已连接
        const status = this.pool.getStatus(key);
        if (status && status.status !== 'CONNECTED') {
            // 尝试重连
            await this.pool.connect(key);
        }

        try {
            // 写入心跳值
            this.heartbeatCounter = (this.heartbeatCounter + 1) % 65536;
            await this.pool.writeRegister(key, 0x0000, this.heartbeatCounter);
            
            // 读取环境传感器数据
            const envData = await this.readBlock(key, 'BLOCK_ENV');
            
            // 读取硬件状态
            const hwData = await this.readBlock(key, 'BLOCK_HW');
            
            // 解析数据
            const sensorData = this.parser.parseSensorData({
                env: envData,
                hw: hwData
            });
            
            // 触发回调
            if (this.onData) {
                this.onData(key, sensorData);
            }
            
        } catch (err) {
            console.error(`[PollingEngine] Poll device ${key} error: ${err.message}`);
            throw err;
        }
    }

    /**
     * 读取数据块
     * @param {string} key - 设备标识
     * @param {string} blockName - 数据块名称
     */
    async readBlock(key, blockName) {
        const block = DataParser.BLOCKS[blockName];
        if (!block) {
            throw new Error(`Unknown block: ${blockName}`);
        }

        const start = block.start;
        const length = block.end - block.start + 1;
        
        try {
            const response = await this.pool.readHoldingRegisters(key, start, length);
            return response.data || [];
        } catch (err) {
            throw err;
        }
    }

    /**
     * 读取OTA状态
     * @param {string} key - 设备标识
     */
    async readOTAStatus(key) {
        try {
            const response = await this.pool.readHoldingRegisters(key, 0x0150, 2);
            return {
                progress: response.data[0],
                status: response.data[1]
            };
        } catch (err) {
            console.error(`[PollingEngine] Read OTA status failed: ${err.message}`);
            return { progress: 0, status: 0 };
        }
    }

    /**
     * 控制继电器（带互斥锁）
     * 类比：GPIO输出操作，需要关闭定时器中断保证原子性
     * 
     * @param {string} key - 设备标识
     * @param {number} relayIndex - 继电器索引（0-based, 0=R1）
     * @param {boolean} value - true=ON, false=OFF
     */
    async controlRelay(key, relayIndex, value) {
        // 获取互斥锁（类比：关闭全局中断）
        this.writeLock = true;
        
        try {
            // 1. 读取当前继电器指令值
            const response = await this.pool.readHoldingRegisters(key, 0x5001, 2);
            let currentValue = (response.data[0] << 16) | response.data[1];
            
            // 2. 修改对应位
            currentValue = this.parser.generateRelayControl(currentValue, relayIndex, value);
            
            // 3. 写回
            const high = (currentValue >> 16) & 0xFFFF;
            const low = currentValue & 0xFFFF;
            await this.pool.writeRegisters(key, 0x5001, [high, low]);
            
            // 4. 验证（读回检查）
            const verifyResponse = await this.pool.readHoldingRegisters(key, 0x5001, 2);
            const verifyValue = (verifyResponse.data[0] << 16) | verifyResponse.data[1];
            
            if (verifyValue !== currentValue) {
                console.warn(`[PollingEngine] Relay verify failed: expected ${currentValue}, got ${verifyValue}`);
                // 重试一次
                await this.pool.writeRegisters(key, 0x5001, [high, low]);
            }
            
            console.log(`[PollingEngine] Relay ${relayIndex + 1} set to ${value ? 'ON' : 'OFF'}`);
            return true;
            
        } catch (err) {
            console.error(`[PollingEngine] Control relay failed: ${err.message}`);
            throw err;
        } finally {
            // 释放互斥锁（类比：恢复全局中断）
            this.writeLock = false;
        }
    }

    /**
     * 触发OTA升级
     * @param {string} key - 设备标识
     * @param {number} version - 目标版本号
     */
    async triggerOTA(key, version) {
        this.writeLock = true;
        
        try {
            // 必须先写版本号，再写触发位（顺序不可颠倒）
            await this.pool.writeRegister(key, 0x0101, version);
            console.log(`[PollingEngine] OTA version ${version} written`);
            
            await this.pool.writeRegister(key, 0x0100, 1);
            console.log(`[PollingEngine] OTA triggered`);
            
            return true;
        } catch (err) {
            console.error(`[PollingEngine] Trigger OTA failed: ${err.message}`);
            throw err;
        } finally {
            this.writeLock = false;
        }
    }

    /**
     * 读取配置参数
     * @param {string} key - 设备标识
     */
    async readConfig(key) {
        try {
            const response = await this.pool.readHoldingRegisters(key, 0x7001, 9);
            return {
                targetTemp: response.data[0] / 10,
                targetHumi: response.data[1] / 10,
                pigCount: response.data[2],
                buildingNo: response.data[3],
                unitNo: response.data[4],
                pigAge: response.data[5],
                pigWeight: response.data[6],
                healthStatus: response.data[7],
                buildingType: response.data[8]
            };
        } catch (err) {
            console.error(`[PollingEngine] Read config failed: ${err.message}`);
            throw err;
        }
    }
}

module.exports = PollingEngine;
