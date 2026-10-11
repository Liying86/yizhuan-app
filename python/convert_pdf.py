"""
易转 - PDF 转换脚本
支持: PDF -> Word (DOCX), Word -> PDF (通过 LibreOffice)
      PDF -> Excel (XLSX), PDF -> PPT (PPTX)
"""
import sys
import json
import os
import subprocess
import shutil
from pathlib import Path


def convert_pdf_to_docx(pdf_path: str, docx_path: str) -> dict:
    """将 PDF 转换为 Word 文档
    使用 pdf2docx 的 layout 模式保留原始排版，
    并启用 ignore_page_error 避免单页错误导致整体失败
    """
    try:
        from pdf2docx import Converter

        # 验证输入文件
        if not os.path.exists(pdf_path):
            return {"status": "error", "message": f"输入文件不存在: {pdf_path}"}

        # 确保输出目录存在
        output_dir = os.path.dirname(docx_path)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        # 配置 pdf2docx 设置以最大化排版保留
        # 注意：Settings 在不同版本的 pdf2docx 中路径不同，使用兼容方式导入
        # layout: 保留原始布局（文字框定位）
        # float_image_ignorable_threshold: 降低浮动图片忽略阈值，保留更多图片
        # curve_ignorable_threshold: 降低曲线忽略阈值，保留更多形状
        try:
            # 尝试多种导入路径（兼容不同版本）
            Settings = None
            try:
                from pdf2docx.settings import Settings
            except ImportError:
                try:
                    from pdf2docx.converter import Settings
                except ImportError:
                    pass
            if Settings is not None:
                Settings.default_settings['layout'] = True
                Settings.default_settings['float_image_ignorable_threshold'] = 0.1
                Settings.default_settings['curve_ignorable_threshold'] = 0.1
        except Exception:
            pass  # 设置可能因版本不同而不可用，忽略错误

        # 执行转换 - ignore_page_error=True 确保单页失败不影响整体
        cv = Converter(pdf_path)
        cv.convert(
            docx_path,
            start=0,
            end=None,
            ignore_page_error=True
        )
        cv.close()

        # 验证输出
        if os.path.exists(docx_path):
            size = os.path.getsize(docx_path)
            return {
                "status": "success",
                "output": docx_path,
                "size": size,
                "message": f"转换成功，文件大小: {size / 1024:.1f} KB"
            }
        else:
            return {"status": "error", "message": "转换完成但输出文件不存在"}

    except ImportError:
        return {"status": "error", "message": "pdf2docx 未安装，请运行: pip install pdf2docx"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


def find_libreoffice() -> str | None:
    """查找 LibreOffice 可执行文件路径"""
    # 1. 检查 PATH 中的 soffice
    soffice = shutil.which("soffice")
    if soffice:
        return soffice

    # 2. Windows 常见安装路径
    if os.name == "nt":
        candidates = [
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ]
        for path in candidates:
            if os.path.exists(path):
                return path

    # 3. macOS 常见路径
    elif sys.platform == "darwin":
        path = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
        if os.path.exists(path):
            return path

    # 4. Linux 常见路径
    else:
        candidates = [
            "/usr/bin/soffice",
            "/usr/bin/libreoffice",
            "/opt/libreoffice/program/soffice",
        ]
        for path in candidates:
            if os.path.exists(path):
                return path

    return None


def get_pdf_export_filter(input_path: str) -> str:
    """根据输入文件类型返回 PDF 导出过滤器
    使用正确的过滤器名称确保各类型文档排版正确
    对于 PPT 文件，添加字体嵌入选项以减少字体替换导致的排版问题
    """
    ext = Path(input_path).suffix.lower()
    # 根据文件类型选择对应的 PDF 导出过滤器
    if ext in ('.ppt', '.pptx'):
        # PPT 转 PDF：使用 impress 过滤器，嵌入标准字体
        return 'pdf:impress_pdf_Export:{"EmbedStandardFonts":{"type":"boolean","value":"true"}}'
    elif ext in ('.xls', '.xlsx', '.csv'):
        return "pdf:calc_pdf_Export"
    else:
        return 'pdf:writer_pdf_Export:{"EmbedStandardFonts":{"type":"boolean","value":"true"}}'


def kill_soffice_processes():
    """终止已有的 soffice 进程，避免单实例冲突导致转换挂起或字体缓存过期
    仅终止 headless 模式的进程，保留用户正在使用的 GUI 实例
    """
    try:
        if os.name == "nt":
            # Windows: 使用 wmic 查找并终止命令行中包含 --headless 的 soffice 进程
            result = subprocess.run(
                ["wmic", "process", "where",
                 "name='soffice.exe'", "get", "ProcessId,CommandLine"],
                capture_output=True, text=True, timeout=10
            )
            for line in result.stdout.split('\n'):
                if '--headless' in line:
                    parts = line.strip().split()
                    if parts:
                        pid = parts[-1]
                        try:
                            subprocess.run(
                                ["taskkill", "/F", "/PID", pid],
                                capture_output=True, timeout=5
                            )
                        except Exception:
                            pass
        else:
            # Unix: pkill 带 --headless 参数的 soffice
            subprocess.run(
                ["pkill", "-f", "soffice.*--headless"],
                capture_output=True, timeout=5
            )
    except Exception:
        pass  # 忽略错误，继续执行转换


def convert_docx_to_pdf(input_path: str, output_path: str) -> dict:
    """将 Office 文档转换为 PDF（通过 LibreOffice headless 模式）
    支持 Word/PPT/Excel 转 PDF，自动根据文件类型选择过滤器并嵌入字体

    改进：
    - 使用独立用户配置目录避免单实例冲突
    - 终止已有的 headless soffice 进程
    - 添加字体嵌入选项减少字体替换问题
    - 设置正确的环境变量确保中文字体可用
    """
    import tempfile
    import time

    profile_dir = None
    try:
        # 验证输入文件
        if not os.path.exists(input_path):
            return {"status": "error", "message": f"输入文件不存在: {input_path}"}

        # 查找 LibreOffice
        soffice = find_libreoffice()
        if not soffice:
            return {
                "status": "error",
                "message": "未找到 LibreOffice，请安装 LibreOffice 后重试"
            }

        # 确保输出目录存在
        output_dir = os.path.dirname(output_path)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        # 终止已有的 headless soffice 进程
        kill_soffice_processes()
        time.sleep(0.5)

        # 创建独立的用户配置目录，避免与用户正在使用的 LibreOffice 冲突
        profile_dir = tempfile.mkdtemp(prefix="yizhuan_lo_")
        profile_url = f"file:///{profile_dir.replace(chr(92), '/')}"

        # 设置环境变量，确保 LibreOffice 能找到系统安装的中文字体
        env = os.environ.copy()
        # 在 Windows 上确保 SystemRoot 可用（字体定位依赖）
        if os.name == "nt":
            env.setdefault("SystemRoot", os.environ.get("WINDIR", r"C:\Windows"))

        temp_outdir = os.path.dirname(output_path) or "."
        input_name = Path(input_path).stem

        # 根据文件类型获取 PDF 导出过滤器（包含字体嵌入选项）
        pdf_filter = get_pdf_export_filter(input_path)

        # 构建命令 - 使用独立配置目录和完整选项
        cmd = [
            soffice,
            f"-env:UserInstallation={profile_url}",
            "--headless",
            "--norestore",
            "--nodefault",
            "--nofirststartwizard",
            "--nolockcheck",
            "--convert-to", pdf_filter,
            "--outdir", temp_outdir,
            input_path
        ]

        # 执行转换
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=180,  # 3 分钟超时（大文件需要更多时间）
            env=env
        )

        # LibreOffice 输出文件名 = 输入文件名 + .pdf
        expected_output = os.path.join(temp_outdir, f"{input_name}.pdf")

        if os.path.exists(expected_output):
            # 如果目标路径不同，重命名
            if os.path.abspath(expected_output) != os.path.abspath(output_path):
                if os.path.exists(output_path):
                    os.remove(output_path)
                os.rename(expected_output, output_path)

            size = os.path.getsize(output_path)
            return {
                "status": "success",
                "output": output_path,
                "size": size,
                "message": f"转换成功，文件大小: {size / 1024:.1f} KB"
            }
        else:
            stderr = result.stderr or ""
            stdout = result.stdout or ""
            # 如果带过滤器的方式失败，尝试用普通方式重试
            fallback_cmd = [
                soffice,
                f"-env:UserInstallation={profile_url}",
                "--headless",
                "--norestore",
                "--nodefault",
                "--nofirststartwizard",
                "--nolockcheck",
                "--convert-to", "pdf",
                "--outdir", temp_outdir,
                input_path
            ]
            fallback_result = subprocess.run(
                fallback_cmd,
                capture_output=True,
                text=True,
                timeout=180,
                env=env
            )
            if os.path.exists(expected_output):
                if os.path.abspath(expected_output) != os.path.abspath(output_path):
                    if os.path.exists(output_path):
                        os.remove(output_path)
                    os.rename(expected_output, output_path)
                size = os.path.getsize(output_path)
                return {
                    "status": "success",
                    "output": output_path,
                    "size": size,
                    "message": f"转换成功，文件大小: {size / 1024:.1f} KB"
                }
            return {
                "status": "error",
                "message": f"转换失败: {stderr or stdout or '未知错误'}"
            }

    except subprocess.TimeoutExpired:
        return {"status": "error", "message": "转换超时（180秒），文件可能过大或损坏"}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        # 清理临时用户配置目录
        if profile_dir:
            try:
                shutil.rmtree(profile_dir, ignore_errors=True)
            except Exception:
                pass


def convert_with_libreoffice(input_path: str, output_path: str, target_format: str) -> dict:
    """通用 LibreOffice 转换函数
    使用独立用户配置目录避免单实例冲突
    """
    import tempfile
    import time

    profile_dir = None
    try:
        if not os.path.exists(input_path):
            return {"status": "error", "message": f"输入文件不存在: {input_path}"}

        soffice = find_libreoffice()
        if not soffice:
            return {
                "status": "error",
                "message": "未找到 LibreOffice，请安装 LibreOffice 后重试"
            }

        output_dir = os.path.dirname(output_path)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        # 终止已有的 headless soffice 进程
        kill_soffice_processes()
        time.sleep(0.5)

        # 使用独立用户配置目录
        profile_dir = tempfile.mkdtemp(prefix="yizhuan_lo_")
        profile_url = f"file:///{profile_dir.replace(chr(92), '/')}"

        env = os.environ.copy()
        if os.name == "nt":
            env.setdefault("SystemRoot", os.environ.get("WINDIR", r"C:\Windows"))

        temp_outdir = os.path.dirname(output_path) or "."
        input_name = Path(input_path).stem

        cmd = [
            soffice,
            f"-env:UserInstallation={profile_url}",
            "--headless",
            "--norestore",
            "--nodefault",
            "--nofirststartwizard",
            "--nolockcheck",
            "--convert-to", target_format,
            "--outdir", temp_outdir,
            input_path
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=180,
            env=env
        )

        expected_output = os.path.join(temp_outdir, f"{input_name}.{target_format.split(':')[0]}")

        if os.path.exists(expected_output):
            if os.path.abspath(expected_output) != os.path.abspath(output_path):
                if os.path.exists(output_path):
                    os.remove(output_path)
                os.rename(expected_output, output_path)

            size = os.path.getsize(output_path)
            return {
                "status": "success",
                "output": output_path,
                "size": size,
                "message": f"转换成功，文件大小: {size / 1024:.1f} KB"
            }
        else:
            stderr = result.stderr or ""
            stdout = result.stdout or ""
            return {
                "status": "error",
                "message": f"转换失败: {stderr or stdout or '未知错误'}"
            }

    except subprocess.TimeoutExpired:
        return {"status": "error", "message": "转换超时（180秒），文件可能过大或损坏"}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        if profile_dir:
            try:
                shutil.rmtree(profile_dir, ignore_errors=True)
            except Exception:
                pass


def convert_pdf_to_xlsx(pdf_path: str, xlsx_path: str) -> dict:
    """将 PDF 转换为 Excel 表格
    第一步：PDF → DOCX（pdf2docx 保留表格结构）
    第二步由 Node.js 处理：解析 DOCX 表格 → 生成 XLSX
    返回中间 DOCX 路径供 Node.js 后续处理
    """
    temp_docx = xlsx_path + ".tmp.docx"
    try:
        # 第一步：PDF → DOCX（pdf2docx 保留表格结构）
        docx_result = convert_pdf_to_docx(pdf_path, temp_docx)
        if docx_result.get("status") != "success":
            return {
                "status": "error",
                "message": f"PDF 转 DOCX 失败: {docx_result.get('message', '未知错误')}"
            }

        # 验证中间产物
        if not os.path.exists(temp_docx):
            return {
                "status": "error",
                "message": "PDF 转 DOCX 成功但中间文件未生成，请重试"
            }

        # 返回中间 DOCX 路径，Node.js 将解析表格并生成 XLSX
        return {
            "status": "success",
            "output": temp_docx,
            "intermediate_docx": temp_docx,
            "message": "PDF 转 DOCX 成功，等待生成 XLSX"
        }

    except Exception as e:
        # 清理临时文件
        try:
            if os.path.exists(temp_docx):
                os.remove(temp_docx)
        except:
            pass
        return {"status": "error", "message": f"PDF 转 Excel 失败: {str(e)}"}


def convert_pdf_to_ppt(pdf_path: str, pptx_path: str) -> dict:
    """将 PDF 转换为 PPT 演示文稿（通过 LibreOffice）"""
    return convert_with_libreoffice(pdf_path, pptx_path, "pptx")


def encrypt_pdf(pdf_path: str, output_path: str, user_password: str, owner_password: str = None) -> dict:
    """加密 PDF 文件
    使用 PyMuPDF (fitz) 进行加密，支持 AES-256 加密
    处理同路径覆盖问题：先保存到临时文件再重命名
    """
    try:
        import fitz  # PyMuPDF

        if not os.path.exists(pdf_path):
            return {"status": "error", "message": f"输入文件不存在: {pdf_path}"}

        if not user_password or len(user_password) < 1:
            return {"status": "error", "message": "密码不能为空"}

        owner_pwd = owner_password or user_password

        # 确保输出目录存在
        output_dir = os.path.dirname(output_path)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        # 如果输入和输出路径相同，先保存到临时文件再覆盖
        same_path = os.path.abspath(pdf_path) == os.path.abspath(output_path)
        actual_output = output_path
        if same_path:
            import tempfile
            fd, actual_output = tempfile.mkstemp(suffix='.pdf', prefix='yizhuan-enc-')
            os.close(fd)

        # 权限：允许打印和复制，禁止修改
        # fitz.PDF_PERM_PRINT = 4, fitz.PDF_PERM_COPY = 8, fitz.PDF_PERM_ACCESSIBILITY = 256
        permissions = fitz.PDF_PERM_PRINT | fitz.PDF_PERM_COPY | fitz.PDF_PERM_ACCESSIBILITY

        # 尝试 AES-256 加密，失败则尝试 RC4-128
        # 每次尝试都重新打开文档，避免上次失败后文档状态不一致
        encryption_methods = [
            (fitz.PDF_ENCRYPT_AES_256, "AES-256"),
            (fitz.PDF_ENCRYPT_RC4_128, "RC4-128"),
        ]

        last_error = ""
        for enc_method, enc_name in encryption_methods:
            try:
                doc = fitz.open(pdf_path)
                # 清理可能存在的旧输出文件
                if os.path.exists(actual_output):
                    os.remove(actual_output)
                doc.save(
                    actual_output,
                    encryption=enc_method,
                    owner_pw=owner_pwd,
                    user_pw=user_password,
                    permissions=permissions
                )
                doc.close()

                # 验证输出文件
                if os.path.exists(actual_output) and os.path.getsize(actual_output) > 0:
                    # 如果是同路径，替换原文件
                    if same_path:
                        import shutil
                        shutil.move(actual_output, output_path)
                    return {
                        "status": "success",
                        "output": output_path,
                        "message": f"PDF 加密成功（{enc_name}）"
                    }
            except Exception as e:
                last_error = str(e)
                # 清理失败的临时文件
                if os.path.exists(actual_output):
                    try:
                        os.remove(actual_output)
                    except:
                        pass
                continue

        # 清理临时文件
        if same_path and os.path.exists(actual_output):
            try:
                os.remove(actual_output)
            except:
                pass

        return {"status": "error", "message": f"所有加密方式均失败: {last_error}"}

    except ImportError:
        return {"status": "error", "message": "PyMuPDF (fitz) 未安装"}
    except Exception as e:
        return {"status": "error", "message": f"PDF 加密失败: {str(e)}"}


def decrypt_pdf(pdf_path: str, output_path: str, password: str) -> dict:
    """解密 PDF 文件
    使用 PyMuPDF (fitz) 移除 PDF 加密，需要提供正确的密码
    处理同路径覆盖问题：先保存到临时文件再重命名
    """
    try:
        import fitz  # PyMuPDF

        if not os.path.exists(pdf_path):
            return {"status": "error", "message": f"输入文件不存在: {pdf_path}"}

        if not password:
            return {"status": "error", "message": "密码不能为空"}

        # 确保输出目录存在
        output_dir = os.path.dirname(output_path)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        # 如果输入和输出路径相同，先保存到临时文件再覆盖
        same_path = os.path.abspath(pdf_path) == os.path.abspath(output_path)
        actual_output = output_path
        if same_path:
            import tempfile
            fd, actual_output = tempfile.mkstemp(suffix='.pdf', prefix='yizhuan-dec-')
            os.close(fd)

        # 打开 PDF
        doc = fitz.open(pdf_path)

        # 检查是否已加密
        if not doc.is_encrypted:
            doc.close()
            if same_path and os.path.exists(actual_output):
                os.remove(actual_output)
            return {"status": "error", "message": "该 PDF 文件未加密，无需解密"}

        # 使用密码进行认证（返回 0 表示密码错误）
        if doc.authenticate(password) == 0:
            doc.close()
            if same_path and os.path.exists(actual_output):
                os.remove(actual_output)
            return {"status": "error", "message": "密码错误，无法解密 PDF"}

        # 保存为无加密的 PDF
        if os.path.exists(actual_output):
            os.remove(actual_output)
        doc.save(actual_output, encryption=fitz.PDF_ENCRYPT_NONE)
        doc.close()

        # 如果是同路径，替换原文件
        if same_path:
            import shutil
            shutil.move(actual_output, output_path)

        # 验证输出文件
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            return {
                "status": "success",
                "output": output_path,
                "message": "PDF 解密成功"
            }
        else:
            return {"status": "error", "message": "PDF 解密失败: 输出文件无效"}

    except ImportError:
        return {"status": "error", "message": "PyMuPDF (fitz) 未安装"}
    except Exception as e:
        return {"status": "error", "message": f"PDF 解密失败: {str(e)}"}


def main():
    if len(sys.argv) < 4:
        print(json.dumps({
            "status": "error",
            "message": "用法: python convert_pdf.py <action> <input> <output>"
        }))
        sys.exit(1)

    action = sys.argv[1]
    input_path = sys.argv[2]
    output_path = sys.argv[3]

    if action == "pdf2docx":
        result = convert_pdf_to_docx(input_path, output_path)
    elif action == "docx2pdf":
        result = convert_docx_to_pdf(input_path, output_path)
    elif action == "pdf2xlsx":
        result = convert_pdf_to_xlsx(input_path, output_path)
    elif action == "pdf2ppt":
        result = convert_pdf_to_ppt(input_path, output_path)
    elif action == "encrypt":
        # 用法: python convert_pdf.py encrypt <input> <output> <user_password> [owner_password]
        user_pwd = sys.argv[4] if len(sys.argv) > 4 else ""
        owner_pwd = sys.argv[5] if len(sys.argv) > 5 else None
        result = encrypt_pdf(input_path, output_path, user_pwd, owner_pwd)
    elif action == "decrypt":
        # 用法: python convert_pdf.py decrypt <input> <output> <password>
        if len(sys.argv) < 5:
            result = {"status": "error", "message": "用法: python convert_pdf.py decrypt <input> <output> <password>"}
        else:
            result = decrypt_pdf(input_path, output_path, sys.argv[4])
    else:
        result = {"status": "error", "message": f"不支持的操作: {action}"}

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
