/**
 * api/ota.js - OTA上传接口
 * 提供固件上传的REST API
 */

const express = require('express');
const multer = require('multer');
const path = require('path');

/**
 * 创建OTA API路由
 * @param {OTAHandler} otaHandler - OTA处理器实例
 */
function createOtaRouter(otaHandler) {
    const router = express.Router();
    
    // 配置multer（内存存储）
    const upload = multer({ 
        storage: multer.memoryStorage(),
        limits: { fileSize: 50 * 1024 * 1024 },  // 限制50MB
        fileFilter: (req, file, cb) => {
            if (path.extname(file.originalname).toLowerCase() === '.rbl') {
                cb(null, true);
            } else {
                cb(new Error('Only .rbl files are allowed'));
            }
        }
    });

    /**
     * POST /api/ota/upload
     * 上传固件文件
     */
    router.post('/upload', upload.single('firmware'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: 'No file uploaded' });
            }

            console.log(`[OTA API] Uploading firmware: ${req.file.originalname} (${req.file.size} bytes)`);
            
            const result = await otaHandler.saveFirmware(req.file.buffer, req.file.originalname);
            
            if (result.success) {
                res.json({ success: true, filename: result.filename, size: result.size });
            } else {
                res.status(500).json({ success: false, error: result.error });
            }
        } catch (err) {
            console.error('[OTA API] Upload error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * POST /api/ota/start
     * 触发OTA升级
     * Body: { deviceIp, version }
     */
    router.post('/start', async (req, res) => {
        try {
            const { deviceIp, version } = req.body;
            
            if (!deviceIp || version === undefined) {
                return res.status(400).json({ success: false, error: 'Missing deviceIp or version' });
            }

            // 触发OTA（由PollingEngine处理）
            if (req.app.locals.pollingEngine) {
                await req.app.locals.pollingEngine.triggerOTA(deviceIp, parseInt(version));
                res.json({ success: true, message: 'OTA triggered', version: parseInt(version) });
            } else {
                res.status(500).json({ success: false, error: 'Polling engine not initialized' });
            }
        } catch (err) {
            console.error('[OTA API] Start error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * GET /api/ota/status
     * 获取OTA状态
     * Query: deviceIp
     */
    router.get('/status', async (req, res) => {
        try {
            const { deviceIp } = req.query;
            
            if (!deviceIp) {
                return res.status(400).json({ success: false, error: 'Missing deviceIp' });
            }

            if (req.app.locals.pollingEngine) {
                const status = await req.app.locals.pollingEngine.readOTAStatus(deviceIp);
                res.json({ success: true, ...status });
            } else {
                res.status(500).json({ success: false, error: 'Polling engine not initialized' });
            }
        } catch (err) {
            console.error('[OTA API] Status error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * GET /api/ota/info
     * 获取固件信息
     */
    router.get('/info', (req, res) => {
        const info = otaHandler.getFirmwareInfo();
        res.json({ success: true, firmware: info });
    });

    return router;
}

module.exports = createOtaRouter;
