/**
 * backend/ate/TestReportService.js
 * ATE 测试报告服务
 *
 * 职责：
 *   1. 测试结束立即落盘 JSON 原始报告
 *   2. 生成 HTML 可读报告（包含 timeline、参数快照、错误码说明）
 *   3. 提供报告查询和下载接口
 *   4. 断电或刷新后报告不丢失
 *
 * 开发依据：
 *   - P0 方案第 8 章：报告设计
 *   - P0 方案第 10 章：历史记录与质量追溯
 *   - shared/constants.js：TEST_STATUS_TEXT, SINGLE_RESULT_TEXT, ERROR_CODE_DETAIL
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本，JSON 和 HTML 报告生成
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  TEST_STATUS_TEXT,
  SINGLE_RESULT_TEXT,
  ERROR_CODE_DETAIL,
  CONFIG_DEFAULTS,
} = require('../../shared/constants');

/**
 * 测试报告服务
 */
class TestReportService {
  constructor() {
    /**
     * 报告存储目录
     */
    this._reportDir = path.resolve(CONFIG_DEFAULTS.REPORT_DIR);

    // 确保报告目录存在
    if (!fs.existsSync(this._reportDir)) {
      fs.mkdirSync(this._reportDir, { recursive: true });
    }
  }

  // ============================================================
  // 公共方法
  // ============================================================

  /**
   * 生成测试报告
   * @param {TestSession} session - 测试会话
   * @returns {Promise<object>} { id, jsonPath, htmlPath, downloadUrl }
   */
  async generateReport(session) {
    const reportId = session.sessionId;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // 生成 JSON 报告
    const jsonReport = this._generateJsonReport(session);
    const jsonFileName = `ATE-${reportId}-${timestamp}.json`;
    const jsonPath = path.join(this._reportDir, jsonFileName);
    fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');

    // 生成 HTML 报告
    const htmlReport = this._generateHtmlReport(jsonReport);
    const htmlFileName = `ATE-${reportId}-${timestamp}.html`;
    const htmlPath = path.join(this._reportDir, htmlFileName);
    fs.writeFileSync(htmlPath, htmlReport, 'utf8');

    console.log(`[TestReportService] Report generated: ${jsonFileName}`);

    return {
      id: reportId,
      jsonPath,
      htmlPath,
      jsonFileName,
      htmlFileName,
      downloadUrl: `/api/test/reports/${jsonFileName}`,
    };
  }

  /**
   * 获取历史报告列表
   * @param {object} filters - 筛选条件
   * @param {string} [filters.sn] - 设备 SN
   * @param {string} [filters.date] - 日期筛选
   * @param {string} [filters.conclusion] - 结论筛选 (pass/fail)
   * @returns {Promise<Array<object>>}
   */
  async getReportList(filters = {}) {
    const files = fs.readdirSync(this._reportDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    const reports = [];

    for (const file of files) {
      try {
        const filePath = path.join(this._reportDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const report = JSON.parse(content);

        // 应用筛选
        if (filters.conclusion && report.conclusion !== filters.conclusion) {
          continue;
        }
        if (filters.sn && report.deviceSn !== filters.sn) {
          continue;
        }
        if (filters.date && !report.endTime.startsWith(filters.date)) {
          continue;
        }

        reports.push({
          id: report.sessionId,
          fileName: file,
          deviceSn: report.deviceSn,
          workOrder: report.workOrder,
          operator: report.operator,
          conclusion: report.conclusion,
          startTime: report.startTime,
          endTime: report.endTime,
          summary: report.summary,
          downloadUrl: `/api/test/reports/${file}`,
        });
      } catch (err) {
        console.warn(`[TestReportService] Skip invalid report file: ${file}`);
      }
    }

    return reports;
  }

  /**
   * 获取报告内容
   * @param {string} fileName - 报告文件名
   * @returns {Promise<object|null>}
   */
  async getReport(fileName) {
    const filePath = path.join(this._reportDir, fileName);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      return null;
    }
  }

  // ============================================================
  // 内部方法：JSON 报告生成
  // ============================================================

  /**
   * 生成 JSON 格式报告
   * @param {TestSession} session
   * @returns {object}
   * @private
   */
  _generateJsonReport(session) {
    // 构建 timeline 数组
    const timeline = [];
    for (const [itemId, item] of session.timeline) {
      const errorDetail = item.errorCode ? ERROR_CODE_DETAIL[item.errorCode] : null;
      timeline.push({
        itemId,
        state: SINGLE_RESULT_TEXT[item.state] || '未知',
        stateCode: item.state,
        startTime: item.startTime ? new Date(item.startTime).toISOString() : null,
        endTime: item.endTime ? new Date(item.endTime).toISOString() : null,
        duration: item.startTime && item.endTime ? item.endTime - item.startTime : null,
        errorCode: item.errorCode || null,
        errorName: errorDetail ? errorDetail.name : null,
        errorCause: errorDetail ? errorDetail.cause : null,
        errorSuggestion: errorDetail ? errorDetail.suggestion : null,
        errorHardware: errorDetail ? errorDetail.hardware : null,
        diagnostics: item.diagnostics || null,
      });
    }

    return {
      // 报告元数据
      reportVersion: '1.0',
      generatedAt: new Date().toISOString(),

      // 设备信息
      sessionId: session.sessionId,
      deviceIp: session.deviceIp,
      deviceKey: session.deviceKey,
      deviceModel: session.deviceModel,
      deviceSn: session.deviceSn || '',
      firmwareVersion: session.firmwareVersion || '',
      protocolVersion: session.protocolVersion || '',

      // 测试信息
      operator: session.operatorInputId,
      workOrder: session.workOrder,
      startTime: session.startTime ? new Date(session.startTime).toISOString() : null,
      endTime: session.endTime ? new Date(session.endTime).toISOString() : null,
      duration: session.startTime && session.endTime ? session.endTime - session.startTime : null,

      // 测试结果
      conclusion: TEST_STATUS_TEXT[session.overallStatus] || '未知',
      conclusionCode: session.overallStatus,
      progress: session.progress,
      summary: { ...session.summary },

      // 测试项时间线
      timeline,

      // 参数快照
      parameters: {
        selectedItemIds: session.selectedItemIds,
        testMask: session.selectedItemIds.reduce((mask, id) => {
          const item = require('./TestCatalog').prototype.getItemById.call(
            { _basicItems: [], _businessItems: [] },
            id
          );
          return mask | (item ? item.mask : 0);
        }, 0),
      },

      // 原始寄存器快照
      registersSnapshot: session.registersSnapshot || {},

      // 错误信息
      error: session.error || null,
    };
  }

  // ============================================================
  // 内部方法：HTML 报告生成
  // ============================================================

  /**
   * 生成 HTML 格式报告（单页，可离线打开和打印）
   * @param {object} jsonReport
   * @returns {string}
   * @private
   */
  _generateHtmlReport(jsonReport) {
    const { sessionId, deviceIp, deviceModel, operator, workOrder,
            startTime, endTime, duration, conclusion, summary, timeline,
            error } = jsonReport;

    const conclusionColor = conclusion === '通过' ? '#52c41a' :
                           conclusion === '失败' ? '#ff4d4f' :
                           conclusion === '已停止' ? '#faad14' : '#d9d9d9';

    const durationStr = duration ? `${(duration / 1000).toFixed(1)}s` : '-';

    // 生成 timeline HTML
    let timelineHtml = '';
    for (const item of timeline) {
      const stateColor = item.state === '通过' ? '#52c41a' :
                        item.state === '失败' ? '#ff4d4f' :
                        item.state === '超时' ? '#faad14' : '#d9d9d9';

      let errorHtml = '';
      if (item.errorCode) {
        errorHtml = `
          <div class="error-detail">
            <p><strong>错误码：</strong>0x${item.errorCode.toString(16).toUpperCase().padStart(4, '0')}</p>
            <p><strong>错误名称：</strong>${item.errorName || '-'}</p>
            <p><strong>可能原因：</strong>${item.errorCause || '-'}</p>
            <p><strong>排障建议：</strong>${item.errorSuggestion || '-'}</p>
            <p><strong>涉及硬件：</strong>${item.errorHardware || '-'}</p>
          </div>
        `;
      }

      timelineHtml += `
        <tr>
          <td>${item.itemId}</td>
          <td style="color: ${stateColor}; font-weight: bold;">${item.state}</td>
          <td>${item.duration ? `${(item.duration / 1000).toFixed(1)}s` : '-'}</td>
          <td>${item.errorCode ? `0x${item.errorCode.toString(16).toUpperCase().padStart(4, '0')}` : '-'}</td>
          <td>${errorHtml || '-'}</td>
        </tr>
      `;
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ATE 测试报告 - ${sessionId}</title>
  <style>
    body { font-family: 'Microsoft YaHei', sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1000px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #333; border-bottom: 2px solid #1890ff; padding-bottom: 10px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; }
    .info-item { padding: 10px; background: #fafafa; border-radius: 4px; }
    .info-item label { color: #666; font-size: 12px; }
    .info-item value { display: block; font-size: 16px; font-weight: bold; color: #333; margin-top: 5px; }
    .conclusion { text-align: center; padding: 20px; margin: 20px 0; border-radius: 8px; font-size: 24px; font-weight: bold; }
    .summary { display: flex; justify-content: space-around; margin: 20px 0; }
    .summary-item { text-align: center; padding: 15px; background: #fafafa; border-radius: 8px; min-width: 80px; }
    .summary-item .count { font-size: 24px; font-weight: bold; }
    .summary-item .label { color: #666; font-size: 12px; margin-top: 5px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #e8e8e8; padding: 10px; text-align: left; }
    th { background: #fafafa; font-weight: bold; }
    .error-detail { background: #fff2f0; padding: 10px; border-radius: 4px; border-left: 3px solid #ff4d4f; }
    .error-detail p { margin: 5px 0; font-size: 13px; }
    @media print { body { background: white; } .container { box-shadow: none; } }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔧 ATE 自动化测试报告</h1>

    <div class="info-grid">
      <div class="info-item">
        <label>会话 ID</label>
        <value>${sessionId}</value>
      </div>
      <div class="info-item">
        <label>设备 IP</label>
        <value>${deviceIp}</value>
      </div>
      <div class="info-item">
        <label>设备型号</label>
        <value>${deviceModel}</value>
      </div>
      <div class="info-item">
        <label>操作员工号</label>
        <value>${operator || '-'}</value>
      </div>
      <div class="info-item">
        <label>工单号</label>
        <value>${workOrder || '-'}</value>
      </div>
      <div class="info-item">
        <label>测试时长</label>
        <value>${durationStr}</value>
      </div>
    </div>

    <div class="conclusion" style="background: ${conclusionColor}20; color: ${conclusionColor}; border: 2px solid ${conclusionColor};">
      ${conclusion}
    </div>

    <div class="summary">
      <div class="summary-item">
        <div class="count">${summary.total}</div>
        <div class="label">总测试项</div>
      </div>
      <div class="summary-item">
        <div class="count" style="color: #52c41a;">${summary.passed}</div>
        <div class="label">通过</div>
      </div>
      <div class="summary-item">
        <div class="count" style="color: #ff4d4f;">${summary.failed}</div>
        <div class="label">失败</div>
      </div>
      <div class="summary-item">
        <div class="count" style="color: #faad14;">${summary.skipped}</div>
        <div class="label">跳过</div>
      </div>
    </div>

    <h2>测试项详情</h2>
    <table>
      <thead>
        <tr>
          <th>项 ID</th>
          <th>状态</th>
          <th>耗时</th>
          <th>错误码</th>
          <th>错误详情</th>
        </tr>
      </thead>
      <tbody>
        ${timelineHtml}
      </tbody>
    </table>

    ${error ? `
    <h2>错误信息</h2>
    <div class="error-detail">
      <p>${error}</p>
    </div>
    ` : ''}

    <footer style="margin-top: 30px; padding-top: 10px; border-top: 1px solid #e8e8e8; color: #999; font-size: 12px;">
      <p>报告生成时间：${new Date().toLocaleString('zh-CN')}</p>
      <p>MaxClaw ATE 自动化测试系统</p>
    </footer>
  </div>
</body>
</html>`;
  }
}

module.exports = TestReportService;
