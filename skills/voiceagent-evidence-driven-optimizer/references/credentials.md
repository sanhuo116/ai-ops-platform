# 本机数仓凭据

凭据服务名 `com.byai.tencent-business-data-query`，字段 `tencent-secret-id`、`tencent-secret-key`、`tencent-uin`。均由脚本在内存读取，不出现在SQL、日志、环境变量或命令行值中。

macOS首次录入（每条会安全提示输入）：
```sh
/usr/bin/security add-generic-password -U -a tencent-secret-id -s com.byai.tencent-business-data-query -w
/usr/bin/security add-generic-password -U -a tencent-secret-key -s com.byai.tencent-business-data-query -w
/usr/bin/security add-generic-password -U -a tencent-uin -s com.byai.tencent-business-data-query -w
python3 scripts/dlc/keychain_credentials.py check
```

本机已有值直接check，不重复录入或覆盖。区分不存在与进程无读取权限；后者检查当前运行环境，不能当缺失。不要要求用户发送明文凭据。

Windows凭据后端已随包提供，初始化示例：
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dlc\win_credentials.ps1 set -TargetName 'com.byai.tencent-business-data-query:tencent-secret-id' -UserName 'tencent-secret-id'
```
另外两个字段同理。Windows整个星球登录流程未在本次验证，不能据凭据后端存在声称跨平台全部通过。
