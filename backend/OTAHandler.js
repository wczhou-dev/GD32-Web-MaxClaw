/**
 * OTAHandler.js - OTA升级处理器
 * 
 * 类比嵌入式：
 * - 就像IAP（In-Application Programming）升级模块
 * - 处理固件上传、存储、下载
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

class OTAHandler {
    constructor(options = {}) {
        this.firmwarePath = options.firmwarePath || 'F:/firmware';
        this.backendIp = options.backendIp || '127.0.0.1';
        this.port = options.port || 18080;
        this.server = null;
        this.currentFirmware = null;
        this.ensureFirmwareDir();
    }

    ensureFirmwareDir() {
        try {
            if (!fs.existsSync(this.firmwarePath)) {
                fs.mkdirSync(this.firmwarePath, { recursive: true });
                console.log(`[OTA] Created: ${this.firmwarePath}`);
            }
        } catch (err) {
            console.error(`[OTA] Dir error:`, err.message);
        }
    }

    startServer() {
        return new Promise((resolve, reject) => {
            try {
                this.server = http.createServer((req, res) => this.handleRequest(req, res));
                this.server.on('error', reject);
                this.server.listen(this.port, '0.0.0.0', () => {
                    console.log(`[OTA] HTTP server: http://${this.backendIp}:${this.port}`);
                    resolve();
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    handleRequest(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
        
        const url = new URL(req.url, `http://${req.headers.host}`);
        
        if (url.pathname === '/download/SciGeneAI.rbl') {
            this.serveFirmware(req, res);
        } else if (url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', firmware: this.currentFirmware }));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }

    serveFirmware(req, res) {
        const file = path.join(this.firmwarePath, 'SciGeneAI.rbl');
        if (!fs.existsSync(file)) {
            res.writeHead(404);
            res.end('Firmware not found');
            return;
        }
        const stats = fs.statSync(file);
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': stats.size,
            'Content-Disposition': 'attachment; filename="SciGeneAI.rbl"'
        });
        fs.createReadStream(file).pipe(res);
    }

    async saveFirmware(buffer, filename) {
        try {
            const targetPath = path.join(this.firmwarePath, 'SciGeneAI.rbl');
            fs.writeFileSync(targetPath, buffer);
            const stats = fs.statSync(targetPath);
            this.currentFirmware = { filename: 'SciGeneAI.rbl', size: stats.size, uploadTime: Date.now() };
            console.log(`[OTA] Saved: ${stats.size} bytes`);
            return { success: true, filename: 'SciGeneAI.rbl', size: stats.size };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    getFirmwareInfo() {
        const file = path.join(this.firmwarePath, 'SciGeneAI.rbl');
        if (!fs.existsSync(file)) return null;
        const stats = fs.statSync(file);
        return { filename: 'SciGeneAI.rbl', size: stats.size, downloadUrl: `http://${this.backendIp}:${this.port}/download/SciGeneAI.rbl` };
    }

    stopServer() {
        if (this.server) { this.server.close(); this.server = null; }
    }
}

module.exports = OTAHandler;
