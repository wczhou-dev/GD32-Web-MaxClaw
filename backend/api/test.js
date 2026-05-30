/**
 * backend/api/test.js
 * ATE 测试报告 API
 *
 * 职责：
 *   1. 提供历史报告列表查询
 *   2. 提供 JSON/HTML 报告下载
 *   3. 提供 ATE 配置保存和读取
 *
 * 开发依据：
 *   - 任务表阶段 7.3
 *   - shared/constants.js：API_PATH
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本
 */

'use strict';

const express = require('express');
const router = express.Router();
const TestReportService = require('../ate/TestReportService');

/**
 * 创建报告服务实例
 */
const reportService = new TestReportService();

/**
 * GET /api/test/reports
 * 获取历史报告列表
 */
router.get('/reports', async (req, res) => {
  try {
    const { sn, date, conclusion } = req.query;
    const reports = await reportService.getReportList({ sn, date, conclusion });
    res.json({ success: true, reports });
  } catch (err) {
    console.error('[API] Get reports error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/test/reports/:filename
 * 下载报告文件（JSON 或 HTML）
 */
router.get('/reports/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const report = await reportService.getReport(filename);

    if (!report) {
      return res.status(404).json({ success: false, error: '报告不存在' });
    }

    // 根据文件扩展名设置 Content-Type
    if (filename.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const htmlReport = reportService._generateHtmlReport(report);
      res.send(htmlReport);
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json(report);
    }
  } catch (err) {
    console.error('[API] Get report error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/test/reports/:filename.json
 * 下载 JSON 报告
 */
router.get('/reports/:filename.json', async (req, res) => {
  try {
    const { filename } = req.params;
    const jsonFilename = filename.endsWith('.json') ? filename : `${filename}.json`;
    const report = await reportService.getReport(jsonFilename);

    if (!report) {
      return res.status(404).json({ success: false, error: '报告不存在' });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json(report);
  } catch (err) {
    console.error('[API] Get JSON report error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/test/reports/:filename.html
 * 下载 HTML 报告
 */
router.get('/reports/:filename.html', async (req, res) => {
  try {
    const { filename } = req.params;
    const htmlFilename = filename.endsWith('.html') ? filename : `${filename}.html`;
    const report = await reportService.getReport(htmlFilename);

    if (!report) {
      return res.status(404).json({ success: false, error: '报告不存在' });
    }

    const htmlReport = reportService._generateHtmlReport(report);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlReport);
  } catch (err) {
    console.error('[API] Get HTML report error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/test/config
 * 保存 ATE 配置
 */
router.post('/config', async (req, res) => {
  try {
    const config = req.body;
    // TODO: 保存配置到文件
    console.log('[API] Save ATE config:', config);
    res.json({ success: true, message: '配置保存成功' });
  } catch (err) {
    console.error('[API] Save config error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/test/config
 * 获取 ATE 配置
 */
router.get('/config', async (req, res) => {
  try {
    // TODO: 从文件读取配置
    const config = {
      ateTcpPort: 9001,
      modbusPort: 502,
      reportDir: 'backend/reports',
      ackTimeoutMs: 2000,
      reconnectCooldownMs: 12000,
    };
    res.json({ success: true, config });
  } catch (err) {
    console.error('[API] Get config error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
