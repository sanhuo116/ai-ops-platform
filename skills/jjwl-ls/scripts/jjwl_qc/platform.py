# -*- coding: utf-8 -*-
"""百应平台通话记录导出。

两种取数通道：
1. HTTP 接口（推荐，可无人值守）：复用浏览器登录态 Cookie，调用导出接口拿 xlsx。
2. 浏览器 CDP（备用）：由已登录的 Chrome 打开导出页并下载。

因平台导出接口随版本变化，本模块把「接口细节」集中在一处，
并提供 dry_run 用于在没有登录态时验证流程。
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_TIMEOUT = 120


class PlatformError(RuntimeError):
    pass


def _post_json(url, payload, cookie, timeout=DEFAULT_TIMEOUT):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Cookie", cookie)
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def export_calls(slot, out_path: Path, cfg: dict):
    """按时间段导出通话记录。

    cfg 字段：
        base_url    必填，平台域名
        cookie      必填，登录态
        company_id  必填，租户ID
        robot_ids   可选，机器人ID列表
        endpoint    可选，导出接口路径
    """
    base = cfg.get("base_url", "").rstrip("/")
    cookie = cfg.get("cookie", "")
    if not base or not cookie:
        raise PlatformError(
            "缺少 base_url 或 cookie。请先在平台登录，再把 Cookie 写入 config.json，"
            "或使用 --login 通过浏览器 CDP 自动同步登录态。")

    endpoint = cfg.get("endpoint", "/bygw/call/api/callRecord/export")
    payload = {
        "companyId": cfg.get("company_id"),
        "robotIds": cfg.get("robot_ids") or [],
        "startTime": slot.start.strftime("%Y-%m-%d %H:%M:%S"),
        "endTime": slot.end.strftime("%Y-%m-%d %H:%M:%S"),
        "page": 1,
        "pageSize": cfg.get("page_size", 5000),
        "withTranscript": True,
    }
    raw = _post_json(base + endpoint, payload, cookie)

    # 常见两种返回：直接是文件字节，或 {code,data:{url}} 下载链接
    if raw[:2] == b"PK":
        out_path.write_bytes(raw)
        return out_path
    try:
        j = json.loads(raw)
    except Exception:
        raise PlatformError(f"导出接口返回非预期内容：{raw[:200]!r}")

    if str(j.get("code")) not in ("0", "200", "None"):
        raise PlatformError(f"导出接口报错：{json.dumps(j, ensure_ascii=False)[:400]}")

    url = ((j.get("data") or {}).get("url") or (j.get("data") or {}).get("fileUrl"))
    if not url:
        raise PlatformError(f"导出接口未返回下载地址：{json.dumps(j, ensure_ascii=False)[:400]}")

    req = urllib.request.Request(url)
    req.add_header("Cookie", cookie)
    with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as r:
        out_path.write_bytes(r.read())
    return out_path
