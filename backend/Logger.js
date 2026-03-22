const fs = require('fs');
const path = require('path');

/**
 * 极简日志记录器 - 双文件循环覆盖模式
 * 1. 启动时：latest.log -> previous.log
 * 2. 运行中：追加 latest.log
 * 这样磁盘上永远只会有 2 份日志，且旧的会自动被覆盖，防止无限占用空间。
 */
function initLogger() {
    const logDir = path.join(__dirname, 'logs');
    const latestLog = path.join(logDir, 'latest.log');
    const previousLog = path.join(logDir, 'previous.log');

    try {
        // 1. 确保日志目录存在
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        // 2. 轮转逻辑 (实现双文件覆盖循环)
        if (fs.existsSync(latestLog)) {
            if (fs.existsSync(previousLog)) {
                fs.unlinkSync(previousLog);
            }
            fs.renameSync(latestLog, previousLog);
        }

        // 3. 拦截控制台输出
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;

        const logToFile = (type, args) => {
            const now = new Date();
            const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ` +
                              `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
            
            const content = args.map(arg => {
                if (arg instanceof Error) return arg.stack;
                if (typeof arg === 'object') return JSON.stringify(arg);
                return arg;
            }).join(' ');

            const line = `[${timestamp}] [${type}] ${content}\n`;
            
            try {
                fs.appendFileSync(latestLog, line, 'utf8');
            } catch (err) {
                // 写入失败不应中断主程序
            }
        };

        // 按需重写
        console.log = (...args) => {
            logToFile('INFO', args);
            originalLog.apply(console, args);
        };

        console.error = (...args) => {
            logToFile('ERROR', args);
            originalError.apply(console, args);
        };

        console.warn = (...args) => {
            logToFile('WARN', args);
            originalWarn.apply(console, args);
        };

        console.log('----------------------------------------------------');
        console.log('[System] Logger Initialized. Saving to backend/logs/latest.log');
        console.log('----------------------------------------------------');

    } catch (err) {
        console.error('[Error] Failed to initialize file logger:', err.message);
    }
}

module.exports = initLogger;
