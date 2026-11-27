#!/usr/bin/env python3
"""Read Tencent credentials from the current user's OS credential store.

macOS  -> login keychain via ``/usr/bin/security``.
Windows -> Credential Manager (generic credentials) via ``win_credentials.ps1``
           which calls ``CredRead`` to recover the plaintext value.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from typing import Optional, Sequence, Tuple


KEYCHAIN_SERVICE = "com.byai.tencent-business-data-query"
SECRET_ID_ACCOUNT = "tencent-secret-id"
SECRET_KEY_ACCOUNT = "tencent-secret-key"
UIN_ACCOUNT = "tencent-uin"
SECURITY_CLI = "/usr/bin/security"

IS_WINDOWS = sys.platform == "win32"

_CREDENTIALS: Tuple[Tuple[str, str], ...] = (
    (SECRET_ID_ACCOUNT, "SecretId"),
    (SECRET_KEY_ACCOUNT, "SecretKey"),
    (UIN_ACCOUNT, "UIN"),
)

_PS1_PATH = Path(__file__).resolve().with_name("win_credentials.ps1")


class KeychainCredentialsError(RuntimeError):
    """An actionable error that never includes credential contents."""


# --------------------------------------------------------------------------- #
# Darwin (macOS login keychain)
# --------------------------------------------------------------------------- #
def _darwin_probe_entry_exists(account: str):
    """Check whether a keychain entry exists without reading/decrypting its value.

    Returns:
        True  -> entry exists.
        False -> entry is genuinely missing ("could not be found").
        None  -> could not determine (some other security/keychain error).
    """
    try:
        completed = subprocess.run(
            [
                SECURITY_CLI,
                "find-generic-password",
                "-a",
                account,
                "-s",
                KEYCHAIN_SERVICE,
            ],
            check=False,
            capture_output=True,
            encoding="utf-8",
            text=True,
            timeout=30,
        )
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        return None

    if completed.returncode == 0:
        return True

    detail = (completed.stderr or "").strip() or (completed.stdout or "").strip()
    if "could not be found" in detail:
        return False
    return None


def _darwin_read_credential(account: str, label: str) -> str:
    exists = _darwin_probe_entry_exists(account)
    if exists is False:
        raise KeychainCredentialsError(
            f"钥匙串中缺少 {label} 凭证（未录入）。"
            "请先在 macOS Terminal 中录入凭证："
            f"/usr/bin/security add-generic-password -U -a {account} "
            f"-s {KEYCHAIN_SERVICE} -w"
        )

    try:
        completed = subprocess.run(
            [
                SECURITY_CLI,
                "find-generic-password",
                "-a",
                account,
                "-s",
                KEYCHAIN_SERVICE,
                "-w",
            ],
            check=False,
            capture_output=True,
            encoding="utf-8",
            text=True,
            timeout=30,
        )
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise KeychainCredentialsError(
            "无法读取 macOS 钥匙串。请确认在 macOS 本机运行，并检查钥匙串访问授权。"
        ) from exc

    if completed.returncode != 0:
        raise KeychainCredentialsError(
            f"{label} 已录入，但当前进程无法读取其值（security 退出码 "
            f"{completed.returncode}）。请以提权方式重试或允许钥匙串访问，"
            "不要重录或覆盖已有凭证。"
        )

    return _strip_one_trailing_newline(completed.stdout)


def _strip_one_trailing_newline(value: str) -> str:
    if value.endswith("\n"):
        value = value[:-1]
        if value.endswith("\r"):
            value = value[:-1]
    return value


# --------------------------------------------------------------------------- #
# Windows (Credential Manager)
# --------------------------------------------------------------------------- #
def _win_target(account: str) -> str:
    return f"{KEYCHAIN_SERVICE}:{account}"


def _win_call(command: str, target: str) -> Optional[subprocess.CompletedProcess]:
    try:
        return subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(_PS1_PATH),
                command,
                "-TargetName",
                target,
            ],
            check=False,
            capture_output=True,
            encoding="utf-8",
            text=True,
            timeout=30,
        )
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        return None


def _win_probe_entry_exists(account: str):
    result = _win_call("exists", _win_target(account))
    if result is None:
        return None
    out = (result.stdout or "").strip()
    if out == "true":
        return True
    if out == "false":
        return False
    return None


def _win_read_credential(account: str, label: str) -> str:
    target = _win_target(account)
    result = _win_call("get", target)
    if result is None:
        raise KeychainCredentialsError(
            "无法调用 Windows 凭据管理器读取脚本，请确认可在 PowerShell 中运行 "
            f"{_PS1_PATH.name}。"
        )
    if result.returncode == 2:
        raise KeychainCredentialsError(
            f"凭据管理器中缺少 {label} 凭证（未录入）。请在 PowerShell 中录入凭证："
            f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{_PS1_PATH}" '
            f'set -TargetName "{target}" -UserName "{account}"'
        )
    if result.returncode != 0:
        raise KeychainCredentialsError(
            f"{label} 已录入，但当前会话无法读取其值（凭据读取退出码 "
            f"{result.returncode}）。请确认以当前 Windows 用户身份运行并在"
            "同一用户上下文中读取；不要重录或覆盖已有凭证。"
        )
    value = _strip_one_trailing_newline(result.stdout)
    if not value:
        raise KeychainCredentialsError(
            f"凭据管理器中的 {label} 为空。请重新保存该凭证。"
        )
    return value


# --------------------------------------------------------------------------- #
# Platform dispatch
# --------------------------------------------------------------------------- #
def _probe_entry_exists(account: str):
    return (
        _win_probe_entry_exists(account)
        if IS_WINDOWS
        else _darwin_probe_entry_exists(account)
    )


def _read_credential(account: str, label: str) -> str:
    return (
        _win_read_credential(account, label)
        if IS_WINDOWS
        else _darwin_read_credential(account, label)
    )


def load_secret_id() -> str:
    return _read_credential(SECRET_ID_ACCOUNT, "SecretId")


def load_uin() -> str:
    return _read_credential(UIN_ACCOUNT, "UIN")


def load_credentials() -> Tuple[str, str]:
    secret_id = load_secret_id()
    secret_key = _read_credential(SECRET_KEY_ACCOUNT, "SecretKey")
    return secret_id, secret_key


def _add_commands() -> str:
    if IS_WINDOWS:
        return "\n".join(
            'powershell.exe -NoProfile -ExecutionPolicy Bypass -File '
            f'"{_PS1_PATH}" set -TargetName "{_win_target(account)}" '
            f'-UserName "{account}"'
            for account, _ in _CREDENTIALS
        )
    return (
        f"/usr/bin/security add-generic-password -U -a {SECRET_ID_ACCOUNT} "
        f"-s {KEYCHAIN_SERVICE} -w\n"
        f"/usr/bin/security add-generic-password -U -a {SECRET_KEY_ACCOUNT} "
        f"-s {KEYCHAIN_SERVICE} -w\n"
        f"/usr/bin/security add-generic-password -U -a {UIN_ACCOUNT} "
        f"-s {KEYCHAIN_SERVICE} -w"
    )


def _delete_commands() -> str:
    if IS_WINDOWS:
        return "\n".join(
            'powershell.exe -NoProfile -ExecutionPolicy Bypass -File '
            f'"{_PS1_PATH}" delete -TargetName "{_win_target(account)}"'
            for account, _ in _CREDENTIALS
        )
    return (
        f"/usr/bin/security delete-generic-password -a {SECRET_ID_ACCOUNT} "
        f"-s {KEYCHAIN_SERVICE}\n"
        f"/usr/bin/security delete-generic-password -a {SECRET_KEY_ACCOUNT} "
        f"-s {KEYCHAIN_SERVICE}\n"
        f"/usr/bin/security delete-generic-password -a {UIN_ACCOUNT} "
        f"-s {KEYCHAIN_SERVICE}"
    )


_STORE_NAME = "Windows 凭据管理器" if IS_WINDOWS else "macOS 钥匙串"
_TERMINAL_NAME = "PowerShell" if IS_WINDOWS else "macOS Terminal"
_PROMPT_HINT = (
    "（set 会通过 Read-Host 交互式提示输入值，值不会出现在命令行）"
    if IS_WINDOWS
    else "（security 会弹出提示输入值，不要把值发到聊天里）"
)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="检查本机凭据存储中的腾讯云凭证"
    )
    parser.add_argument("operation", choices=["check"])
    parser.parse_args(argv)

    missing: list[str] = []
    unreadable: list[str] = []

    for account, label in _CREDENTIALS:
        exists = _probe_entry_exists(account)
        if exists is False:
            missing.append(label)
            continue
        try:
            _read_credential(account, label)
        except KeychainCredentialsError:
            unreadable.append(label)

    if missing:
        names = ", ".join(missing)
        print(f"凭证未录入：{_STORE_NAME}中缺少 {names}。", file=sys.stderr)
        print(f"请在 {_TERMINAL_NAME} 中运行以下命令录入凭证", file=sys.stderr)
        print(_PROMPT_HINT, file=sys.stderr)
        print(_add_commands(), file=sys.stderr)
        return 1

    if unreadable:
        names = ", ".join(unreadable)
        print(
            f"凭证已录入但当前会话无法读取：{names}。请以提权方式重跑 check，"
            f"或在 {_TERMINAL_NAME} 系统界面允许访问；不要重录或覆盖已有凭证。",
            file=sys.stderr,
        )
        return 1

    print(f"{_STORE_NAME}凭证已录入且可读取。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())