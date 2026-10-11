#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CAJ 转 PDF 转换脚本
使用 caj2pdf 开源工具进行转换
依赖：PyPDF2, imagesize, mutool (mupdf)
"""

import sys
import os
import json
import subprocess
import shutil


# 确保 stdout/stderr 使用 UTF-8 编码
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')


def check_mutool(mutool_path=None):
    """检查 mutool 是否可用"""
    if mutool_path and os.path.isfile(mutool_path):
        return True, mutool_path
    which_result = shutil.which('mutool')
    return which_result is not None, which_result or ''


def check_caj2pdf():
    """检查 caj2pdf 是否已安装"""
    try:
        result = subprocess.run(
            [sys.executable, '-c', 'import caj2pdf; print("ok")'],
            capture_output=True, text=True, timeout=10
        )
        return result.returncode == 0 and 'ok' in result.stdout
    except Exception:
        return False


def convert_caj2pdf(input_path, output_path, mutool_path=None):
    """将 CAJ 文件转换为 PDF"""
    if not os.path.exists(input_path):
        return {'status': 'error', 'message': f'输入文件不存在: {input_path}'}

    # 检查文件扩展名
    ext = os.path.splitext(input_path)[1].lower()
    if ext not in ('.caj', '.nh'):
        return {'status': 'error', 'message': f'不支持的文件格式: {ext}，仅支持 .caj 和 .nh'}

    # 方法1：尝试使用 caj2pdf 命令行工具
    caj2pdf_cmd = shutil.which('caj2pdf')
    if caj2pdf_cmd:
        try:
            result = subprocess.run(
                [caj2pdf_cmd, 'convert', input_path, '-o', output_path],
                capture_output=True, text=True, timeout=300
            )
            if result.returncode == 0 and os.path.exists(output_path):
                size = os.path.getsize(output_path)
                return {
                    'status': 'success',
                    'output': output_path,
                    'message': f'转换成功，文件大小: {size / 1024 / 1024:.1f} MB'
                }
            else:
                return {
                    'status': 'error',
                    'message': f'caj2pdf 转换失败: {result.stderr or result.stdout}'
                }
        except subprocess.TimeoutExpired:
            return {'status': 'error', 'message': '转换超时（超过 5 分钟）'}
        except Exception as e:
            return {'status': 'error', 'message': f'caj2pdf 执行错误: {str(e)}'}

    # 方法2：尝试通过 Python 模块调用
    try:
        # 尝试导入 caj2pdf 相关模块
        from cajparser import CAJParser
        parser = CAJParser(input_path)

        # 检查是否需要 mutool（优先使用传入的路径）
        mutool_ok, resolved_mutool = check_mutool(mutool_path)
        if not mutool_ok:
            return {
                'status': 'error',
                'message': 'CAJ 转换需要 mutool 工具。请在应用设置中点击"一键安装"安装 CAJ 转换组件。'
            }

        # 将 mutool 路径加入 PATH，供 caj2pdf 内部调用
        if resolved_mutool:
            mutool_dir = os.path.dirname(resolved_mutool)
            if mutool_dir and mutool_dir not in os.environ.get('PATH', ''):
                os.environ['PATH'] = mutool_dir + os.pathsep + os.environ.get('PATH', '')

        # 执行转换
        parser.convert(output_path)

        if os.path.exists(output_path):
            size = os.path.getsize(output_path)
            return {
                'status': 'success',
                'output': output_path,
                'message': f'转换成功，文件大小: {size / 1024 / 1024:.1f} MB'
            }
        else:
            return {'status': 'error', 'message': '转换完成但输出文件不存在'}
    except ImportError:
        return {
            'status': 'error',
            'message': 'CAJ 转换工具未安装。请执行以下命令安装：\n'
                      'pip install git+https://github.com/caj2pdf/caj2pdf.git\n'
                      'pip install PyPDF2 imagesize\n'
                      '并安装 mupdf 工具（提供 mutool 命令）'
        }
    except Exception as e:
        error_msg = str(e)
        if 'Unknown file type' in error_msg:
            return {
                'status': 'error',
                'message': '不支持的 CAJ 文件类型。该文件可能是新版格式或已损坏。'
            }
        return {'status': 'error', 'message': f'转换失败: {error_msg}'}


def show_caj_info(input_path):
    """显示 CAJ 文件信息"""
    if not os.path.exists(input_path):
        return {'status': 'error', 'message': f'输入文件不存在: {input_path}'}

    try:
        from cajparser import CAJParser
        parser = CAJParser(input_path)
        return {
            'status': 'success',
            'info': {
                'type': parser.type if hasattr(parser, 'type') else 'unknown',
                'pages': parser.page_num if hasattr(parser, 'page_num') else 0,
            }
        }
    except ImportError:
        return {
            'status': 'error',
            'message': 'CAJ 转换工具未安装'
        }
    except Exception as e:
        return {'status': 'error', 'message': str(e)}


def check_env():
    """检查 CAJ 转换环境"""
    return {
        'caj2pdfInstalled': check_caj2pdf() or shutil.which('caj2pdf') is not None,
        'mutoolInstalled': check_mutool(),
        'pythonPath': sys.executable,
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'status': 'error', 'message': '参数不足'}))
        sys.exit(1)

    action = sys.argv[1]

    # 解析可选的 --mutool 参数
    mutool_path = None
    remaining_args = []
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == '--mutool' and i + 1 < len(sys.argv):
            mutool_path = sys.argv[i + 1]
            i += 2
        else:
            remaining_args.append(sys.argv[i])
            i += 1

    if action == 'convert':
        if len(remaining_args) < 2:
            print(json.dumps({'status': 'error', 'message': '参数不足：convert <input> <output>'}))
            sys.exit(1)
        result = convert_caj2pdf(remaining_args[0], remaining_args[1], mutool_path)
        print(json.dumps(result, ensure_ascii=False))

    elif action == 'info':
        if len(remaining_args) < 1:
            print(json.dumps({'status': 'error', 'message': '参数不足：info <input>'}))
            sys.exit(1)
        result = show_caj_info(remaining_args[0])
        print(json.dumps(result, ensure_ascii=False))

    elif action == 'check':
        result = check_env()
        print(json.dumps(result, ensure_ascii=False))

    else:
        print(json.dumps({'status': 'error', 'message': f'未知操作: {action}'}))
        sys.exit(1)
