/**
 * backend/ate/SensorReportService.js
 * P1 传感器测试报告服务
 *
 * 职责：
 *   1. 生成 JSON/HTML 格式的传感器测试报告
 *   2. 记录场景输入、模拟器状态、断言结果、交易日志、清理结果
 *   3. 失败时可定位到具体场景、断言和错误码
 *
 * 开发依据：
 *   - 传感器自动测试任务开发列表P1.md §八 (HIST-P1-012, SYS-P1-005)
 *
 * 更新历史：
 *   v1.0  2026-06-16  初始版本
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ERROR_CODE_DETAIL } = require('../../shared/constants');

class SensorReportService {
  constructor(options = {}) {
    this._reportDir = options.reportDir || path.join(__dirname, '..', 'reports', 'sensor');
    this._ensureDir(this._reportDir);
  }

  /**
   * 生成单个场景测试报告
   * @param {object} result - SensorTestExecutor.execute() 的返回值
   * @returns {Promise<{jsonPath: string, htmlPath: string}>}
   */
  async generateScenarioReport(result) {
    const report = result.report;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `sensor-${report.scenarioId}-${timestamp}`;

    const jsonPath = path.join(this._reportDir, `${fileName}.json`);
    const htmlPath = path.join(this._reportDir, `${fileName}.html`);

    // 补充错误码详情
    if (report.assertions) {
      for (const a of report.assertions) {
        if (a.code && ERROR_CODE_DETAIL[a.code]) {
          const detail = ERROR_CODE_DETAIL[a.code];
          a.errorName = detail.name;
          a.errorCause = detail.cause;
          a.errorSuggestion = detail.suggestion;
        }
      }
    }

    // JSON 报告
    const jsonReport = {
      reportVersion: '2.0',
      reportType: 'sensor-test',
      generatedAt: new Date().toISOString(),
      ...report,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf-8');

    // HTML 报告
    const html = this._buildScenarioHtml(jsonReport);
    fs.writeFileSync(htmlPath, html, 'utf-8');

    console.log(`[SensorReportService] 报告已生成: ${fileName}`);
    return { jsonPath, htmlPath, fileName };
  }

  /**
   * 生成批量测试报告
   * @param {object} batchResult - TestManager.runSensorBatch() 的返回值
   * @returns {Promise<{jsonPath: string, htmlPath: string}>}
   */
  async generateBatchReport(batchResult) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `sensor-batch-${timestamp}`;

    const jsonPath = path.join(this._reportDir, `${fileName}.json`);
    const htmlPath = path.join(this._reportDir, `${fileName}.html`);

    const jsonReport = {
      reportVersion: '2.1',
      reportType: 'sensor-batch',
      generatedAt: new Date().toISOString(),
      // BE-SENSOR-010: 补充设备信息、场区类型和固件版本
      deviceInfo: batchResult.deviceInfo || {},
      fieldType: batchResult.fieldType || 'A',
      summary: {
        total: batchResult.total,
        passed: batchResult.passed,
        failed: batchResult.failed,
        skipped: batchResult.skipped || 0,
        passRate: batchResult.total > 0
          ? `${((batchResult.passed / batchResult.total) * 100).toFixed(1)}%`
          : '0%',
      },
      scenarios: batchResult.results.map(r => ({
        scenarioId: r.report?.scenarioId || r.scenarioId,
        scenarioName: r.report?.scenarioName || '未知',
        conclusion: r.pass ? '通过' : (r.report?.conclusion || '失败'),
        skipReason: r.skipReason || null,
        duration: r.report?.duration || 0,
        assertionCount: r.results?.length || 0,
        failureCount: r.results?.filter(a => !a.pass).length || 0,
        assertions: r.results || [],
        // BE-SENSOR-010: 补充输入模拟值、交易日志和清理结果
        inputs: r.report?.simulatorState?.shadowRegisters || null,
        transactionLog: r.report?.transactionLog || [],
        cleanupResult: r.report?.cleanupResult || null,
      })),
    };

    fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf-8');

    const html = this._buildBatchHtml(jsonReport);
    fs.writeFileSync(htmlPath, html, 'utf-8');

    console.log(`[SensorReportService] 批量报告已生成: ${fileName}`);
    return { jsonPath, htmlPath, fileName };
  }

  /**
   * 获取报告列表
   * @returns {object[]}
   */
  getReportList() {
    try {
      const files = fs.readdirSync(this._reportDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();

      return files.map(f => {
        const fullPath = path.join(this._reportDir, f);
        const stat = fs.statSync(fullPath);
        let summary = null;
        try {
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          summary = {
            type: data.reportType,
            conclusion: data.conclusion || data.summary?.passRate,
            scenarioId: data.scenarioId,
            fieldType: data.fieldType || null,
            total: data.summary?.total || null,
            passed: data.summary?.passed || null,
            failed: data.summary?.failed || null,
            passRate: data.summary?.passRate || null,
            deviceIp: data.deviceInfo?.ip || null,
          };
        } catch (e) {}
        return {
          fileName: f,
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
          summary,
        };
      });
    } catch (e) {
      return [];
    }
  }

  /**
   * 获取单个报告
   * @param {string} fileName
   * @returns {object|null}
   */
  getReport(fileName) {
    try {
      const fullPath = path.join(this._reportDir, fileName);
      return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  /**
   * 获取报告文件绝对路径，供 API 下载 JSON/HTML 使用。
   * @param {string} fileName
   * @returns {string|null}
   */
  getReportPath(fileName) {
    const fullPath = path.join(this._reportDir, fileName);
    if (!fs.existsSync(fullPath)) return null;
    return fullPath;
  }

  // ============================================================
  // HTML 报告生成
  // ============================================================

  _buildScenarioHtml(report) {
    const passColor = '#52c41a';
    const failColor = '#ff4d4f';
    const conclusionColor = report.conclusion === '通过' ? passColor : failColor;

    const assertionRows = (report.assertions || []).map((a, i) => `
      <tr>
        <td>${i + 1}</td>
        <td style="color: ${a.pass ? passColor : failColor}; font-weight: bold;">${a.pass ? '通过' : '失败'}</td>
        <td>${a.message || '-'}</td>
        <td>${a.expected != null ? JSON.stringify(a.expected) : '-'}</td>
        <td>${a.actual != null ? JSON.stringify(a.actual) : '-'}</td>
        <td>${a.tolerance != null ? a.tolerance : '-'}</td>
        <td>${a.code || '-'}</td>
      </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>传感器测试报告 - ${report.scenarioId}</title>
  <style>
    body { font-family: 'Microsoft YaHei', sans-serif; margin: 20px; background: #f5f5f5; }
    .header { background: linear-gradient(135deg, #1890ff, #096dd9); color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .header h1 { margin: 0; font-size: 24px; }
    .header p { margin: 5px 0 0; opacity: 0.8; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .card h2 { margin: 0 0 16px; font-size: 18px; color: #333; border-bottom: 2px solid #1890ff; padding-bottom: 8px; }
    .conclusion { font-size: 28px; font-weight: bold; color: ${conclusionColor}; text-align: center; padding: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    th { background: #fafafa; font-weight: 600; color: #666; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .meta-item { background: #f9f9f9; padding: 12px; border-radius: 6px; }
    .meta-label { font-size: 12px; color: #999; margin-bottom: 4px; }
    .meta-value { font-size: 16px; font-weight: 600; color: #333; }
  </style>
</head>
<body>
  <div class="header">
    <h1>传感器自动测试报告</h1>
    <p>${report.scenarioName || report.scenarioId} | ${report.reportType}</p>
  </div>

  <div class="card">
    <div class="conclusion">${report.conclusion}</div>
  </div>

  <div class="card">
    <h2>基本信息</h2>
    <div class="meta">
      <div class="meta-item"><div class="meta-label">场景 ID</div><div class="meta-value">${report.scenarioId}</div></div>
      <div class="meta-item"><div class="meta-label">场景名称</div><div class="meta-value">${report.scenarioName || '-'}</div></div>
      <div class="meta-item"><div class="meta-label">场区类型</div><div class="meta-value">${report.fieldType || '-'}</div></div>
      <div class="meta-item"><div class="meta-label">执行时间</div><div class="meta-value">${report.duration || 0}ms</div></div>
      <div class="meta-item"><div class="meta-label">开始时间</div><div class="meta-value">${report.startTime ? new Date(report.startTime).toLocaleString() : '-'}</div></div>
      <div class="meta-item"><div class="meta-label">结束时间</div><div class="meta-value">${report.endTime ? new Date(report.endTime).toLocaleString() : '-'}</div></div>
    </div>
  </div>

  <div class="card">
    <h2>断言结果 (${(report.assertions || []).filter(a => a.pass).length}/${(report.assertions || []).length} 通过)</h2>
    <table>
      <tr><th>#</th><th>结果</th><th>描述</th><th>期望值</th><th>实际值</th><th>容差</th><th>错误码</th></tr>
      ${assertionRows}
    </table>
  </div>

  ${report.error ? `<div class="card"><h2>错误信息</h2><pre style="color: #ff4d4f; background: #fff2f0; padding: 12px; border-radius: 4px;">${report.error}</pre></div>` : ''}

  <div class="card" style="color: #999; font-size: 12px; text-align: center;">
    报告生成时间: ${report.generatedAt || new Date().toISOString()} | MaxClaw ATE 传感器自动测试系统
  </div>
</body>
</html>`;
  }

  _buildBatchHtml(report) {
    const passColor = '#52c41a';
    const failColor = '#ff4d4f';

    const scenarioRows = (report.scenarios || []).map((s, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${s.scenarioId}</td>
        <td>${s.scenarioName}</td>
        <td style="color: ${s.conclusion === '通过' ? passColor : (s.conclusion === '跳过' ? '#faad14' : failColor)}; font-weight: bold;">${s.conclusion}${s.skipReason ? ` (${s.skipReason})` : ''}</td>
        <td>${s.duration}ms</td>
        <td>${s.assertionCount}</td>
        <td style="color: ${s.failureCount > 0 ? failColor : passColor}">${s.failureCount}</td>
      </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>传感器批量测试报告</title>
  <style>
    body { font-family: 'Microsoft YaHei', sans-serif; margin: 20px; background: #f5f5f5; }
    .header { background: linear-gradient(135deg, #1890ff, #096dd9); color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .header h1 { margin: 0; font-size: 24px; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .card h2 { margin: 0 0 16px; font-size: 18px; color: #333; border-bottom: 2px solid #1890ff; padding-bottom: 8px; }
    .summary { display: flex; justify-content: center; gap: 40px; padding: 20px; }
    .summary-item { text-align: center; }
    .summary-number { font-size: 36px; font-weight: bold; }
    .summary-label { font-size: 14px; color: #999; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    th { background: #fafafa; font-weight: 600; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <h1>传感器批量测试报告</h1>
  </div>

  <div class="card">
    <div class="summary">
      <div class="summary-item"><div class="summary-number" style="color: #333;">${report.summary.total}</div><div class="summary-label">总场景数</div></div>
      <div class="summary-item"><div class="summary-number" style="color: ${passColor};">${report.summary.passed}</div><div class="summary-label">通过</div></div>
      <div class="summary-item"><div class="summary-number" style="color: ${failColor};">${report.summary.failed}</div><div class="summary-label">失败</div></div>
      <div class="summary-item"><div class="summary-number" style="color: #1890ff;">${report.summary.passRate}</div><div class="summary-label">通过率</div></div>
    </div>
  </div>

  <div class="card">
    <h2>场景明细</h2>
    <table>
      <tr><th>#</th><th>场景 ID</th><th>场景名称</th><th>结论</th><th>耗时</th><th>断言数</th><th>失败数</th></tr>
      ${scenarioRows}
    </table>
  </div>

  <div class="card" style="color: #999; font-size: 12px; text-align: center;">
    报告生成时间: ${report.generatedAt} | MaxClaw ATE 传感器自动测试系统
  </div>
</body>
</html>`;
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

module.exports = SensorReportService;
