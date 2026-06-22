#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将 frontend_analysis.md 转换为 PDF（支持中文）
基于 chinese-pdf-generator Skill 模板
"""

import os
import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Preformatted,
    Table, TableStyle, PageBreak, HRFlowable
)
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


# ==================== 字体注册 ====================
def register_chinese_fonts():
    """注册中文字体"""
    font_paths = [
        ('SimHei', 'C:/Windows/Fonts/simhei.ttf'),
        ('SimSun', 'C:/Windows/Fonts/simsun.ttc'),
        ('MicrosoftYaHei', 'C:/Windows/Fonts/msyh.ttc'),
    ]
    registered = []
    for name, path in font_paths:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont(name, path))
                registered.append(name)
            except Exception as e:
                print(f"  注册 {name} 失败: {e}")
    return registered


# ==================== 样式定义 ====================
def create_styles(font_name):
    """创建统一的 PDF 样式"""
    styles = getSampleStyleSheet()

    # 文档标题
    title = ParagraphStyle(
        'DocTitle', parent=styles['Title'],
        fontName=font_name, fontSize=22, alignment=TA_CENTER,
        spaceAfter=20, textColor=colors.HexColor('#E94560')
    )
    # 副标题信息
    subtitle = ParagraphStyle(
        'SubTitle', parent=styles['Normal'],
        fontName=font_name, fontSize=10, alignment=TA_CENTER,
        spaceAfter=30, textColor=colors.HexColor('#888888')
    )
    # 一级标题
    h1 = ParagraphStyle(
        'H1', parent=styles['Heading1'],
        fontName=font_name, fontSize=18, spaceBefore=24, spaceAfter=12,
        textColor=colors.HexColor('#E94560'),
        borderWidth=0, borderPadding=0,
    )
    # 二级标题
    h2 = ParagraphStyle(
        'H2', parent=styles['Heading2'],
        fontName=font_name, fontSize=14, spaceBefore=18, spaceAfter=8,
        textColor=colors.HexColor('#4ecdc4')
    )
    # 三级标题
    h3 = ParagraphStyle(
        'H3', parent=styles['Heading3'],
        fontName=font_name, fontSize=12, spaceBefore=14, spaceAfter=6,
        textColor=colors.HexColor('#ff6b6b')
    )
    # 正文
    body = ParagraphStyle(
        'Body', parent=styles['Normal'],
        fontName=font_name, fontSize=10, spaceAfter=6,
        leading=16, textColor=colors.HexColor('#333333')
    )
    # 代码块
    code = ParagraphStyle(
        'CodeBlock', parent=styles['Code'],
        fontName=font_name, fontSize=8,
        backColor=colors.HexColor('#f0f4f8'),
        leftIndent=12, rightIndent=12,
        spaceBefore=6, spaceAfter=8,
        leading=12, borderWidth=1,
        borderColor=colors.HexColor('#d0d7de'),
        borderPadding=8,
    )
    # 列表项
    bullet = ParagraphStyle(
        'Bullet', parent=body,
        fontName=font_name, fontSize=10,
        leftIndent=20, spaceAfter=4, leading=15,
        bulletIndent=8
    )

    return {
        'title': title, 'subtitle': subtitle,
        'h1': h1, 'h2': h2, 'h3': h3,
        'body': body, 'code': code, 'bullet': bullet
    }


# ==================== Markdown 解析 ====================
def parse_markdown_to_story(md_path, styles):
    """将 Markdown 文件解析为 reportlab story 元素列表"""
    with open(md_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    story = []
    in_code_block = False
    code_buffer = []
    in_table = False
    table_rows = []
    first_section = True

    i = 0
    while i < len(lines):
        line = lines[i].rstrip('\n').rstrip('\r')

        # ---------- 代码块处理 ----------
        if line.startswith('```'):
            if in_code_block:
                # 代码块结束
                code_text = '\n'.join(code_buffer)
                # 替换特殊 Unicode 字符为 ASCII
                code_text = code_text.replace('│', '|').replace('▼', 'v')
                code_text = code_text.replace('──→', '-->').replace('→', '->')
                code_text = code_text.replace('←', '<-')
                # 转义 XML 特殊字符
                code_text = code_text.replace('&', '&amp;')
                code_text = code_text.replace('<', '&lt;').replace('>', '&gt;')
                if code_text.strip():
                    story.append(Preformatted(code_text, styles['code']))
                code_buffer = []
                in_code_block = False
            else:
                in_code_block = True
            i += 1
            continue

        if in_code_block:
            code_buffer.append(line)
            i += 1
            continue

        # ---------- 表格处理 ----------
        if '|' in line and line.strip().startswith('|'):
            cells = [c.strip() for c in line.strip().split('|')[1:-1]]
            # 跳过分隔行 (|---|---|)
            if cells and all(set(c) <= set('-: ') for c in cells):
                i += 1
                continue
            if not in_table:
                in_table = True
                table_rows = []
            table_rows.append(cells)
            i += 1
            continue
        elif in_table:
            # 表格结束，渲染
            if table_rows:
                story.append(Spacer(1, 6))
                story.append(build_table(table_rows, styles))
                story.append(Spacer(1, 8))
            table_rows = []
            in_table = False
            # 不要 continue，继续处理当前行

        # ---------- 空行 ----------
        if not line.strip():
            i += 1
            continue

        # ---------- 水平线 ----------
        if line.strip() in ('---', '***', '___'):
            story.append(Spacer(1, 6))
            story.append(HRFlowable(
                width="100%", thickness=1,
                color=colors.HexColor('#d0d7de'),
                spaceBefore=4, spaceAfter=8
            ))
            i += 1
            continue

        # ---------- 标题 ----------
        if line.startswith('# '):
            text = clean_md(line[2:])
            if first_section:
                story.append(Paragraph(text, styles['title']))
                first_section = False
            else:
                story.append(Spacer(1, 12))
                story.append(Paragraph(text, styles['h1']))
            i += 1
            continue

        if line.startswith('## '):
            text = clean_md(line[3:])
            story.append(Paragraph(text, styles['h2']))
            i += 1
            continue

        if line.startswith('### '):
            text = clean_md(line[4:])
            story.append(Paragraph(text, styles['h3']))
            i += 1
            continue

        # ---------- 引用块 ----------
        if line.startswith('> '):
            text = clean_md(line[2:])
            quote_style = ParagraphStyle(
                'Quote', parent=styles['body'],
                leftIndent=20, borderWidth=0,
                textColor=colors.HexColor('#666666'),
                fontName=styles['body'].fontName
            )
            story.append(Paragraph(f"  {text}", quote_style))
            i += 1
            continue

        # ---------- 列表项 ----------
        if line.startswith('- ') or line.startswith('* '):
            text = clean_md(line[2:])
            story.append(Paragraph(f"<bullet>&bull;</bullet> {text}", styles['bullet']))
            i += 1
            continue

        if re.match(r'^\d+\.\s', line):
            text = clean_md(re.sub(r'^\d+\.\s', '', line))
            num = re.match(r'^(\d+)\.', line).group(1)
            story.append(Paragraph(f"<bullet>{num}.</bullet> {text}", styles['bullet']))
            i += 1
            continue

        # ---------- 正文 ----------
        text = clean_md(line)
        if text.strip():
            story.append(Paragraph(text, styles['body']))

        i += 1

    # 处理文件末尾未关闭的表格
    if in_table and table_rows:
        story.append(build_table(table_rows, styles))

    return story


def clean_md(text):
    """清理 Markdown 格式标记，转为 reportlab 可用的文本"""
    # 转义 XML 特殊字符
    text = text.replace('&', '&amp;')
    text = text.replace('<', '&lt;').replace('>', '&gt;')
    # 加粗 **text** -> <b>text</b>
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    # 行内代码 `code` -> <font color="#E94560">code</font>
    text = re.sub(r'`(.+?)`', r'<font color="#E94560">\1</font>', text)
    # 去掉图片标记
    text = re.sub(r'!\[.*?\]\(.*?\)', '', text)
    # 去掉链接标记，保留文字
    text = re.sub(r'\[(.+?)\]\(.*?\)', r'\1', text)
    return text


def build_table(rows, styles):
    """构建 PDF 表格"""
    if not rows:
        return Spacer(1, 1)

    font_name = styles['body'].fontName
    # 将每个单元格转为 Paragraph 以支持中文
    data = []
    for row in rows:
        data.append([
            Paragraph(clean_md(cell), ParagraphStyle(
                'Cell', fontName=font_name, fontSize=8,
                leading=12, textColor=colors.HexColor('#333333')
            ))
            for cell in row
        ])

    col_count = max(len(r) for r in data)
    col_width = (A4[0] - 4 * cm) / col_count

    t = Table(data, colWidths=[col_width] * col_count)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e8edf3')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.HexColor('#1a1a2e')),
        ('FONTNAME', (0, 0), (-1, -1), font_name),
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#d0d7de')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1),
         [colors.white, colors.HexColor('#f8f9fa')]),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
    ]))
    return t


# ==================== 主程序 ====================
def main():
    print("=" * 50)
    print("  Markdown → PDF 转换器（中文版）")
    print("=" * 50)

    # 1. 注册字体
    print("\n[1/3] 注册中文字体...")
    fonts = register_chinese_fonts()
    if not fonts:
        print("  错误：未找到中文字体！")
        return
    font = fonts[0]
    print(f"  使用字体：{font}")

    # 2. 解析 Markdown
    md_path = os.path.join(os.path.dirname(__file__), 'frontend_analysis.md')
    pdf_path = os.path.join(os.path.dirname(__file__), 'frontend_analysis_v2.pdf')
    print(f"\n[2/3] 解析 Markdown：{os.path.basename(md_path)}")

    styles = create_styles(font)
    story = parse_markdown_to_story(md_path, styles)

    # 3. 生成 PDF
    print(f"\n[3/3] 生成 PDF：{os.path.basename(pdf_path)}")
    doc = SimpleDocTemplate(
        pdf_path, pagesize=A4,
        rightMargin=2 * cm, leftMargin=2 * cm,
        topMargin=2 * cm, bottomMargin=2 * cm,
        title='GD32 环控系统 — 前端架构分析',
        author='GD32-Web-MaxClaw'
    )
    doc.build(story)

    size_kb = os.path.getsize(pdf_path) / 1024
    print(f"\n  PDF 生成成功！大小：{size_kb:.1f} KB")
    print(f"  路径：{pdf_path}")


if __name__ == '__main__':
    main()
