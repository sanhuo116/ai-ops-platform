"""Install the AI Ops LaunchAgent for the current macOS user."""
import os
import plistlib
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
home = Path.home()
label = "cc.indata.spagent.aiops"
logs = home / "Library/Logs" / label
python = home / "Library/Application Support/aiops/venv/bin/python"
node = shutil.which("node")
if not (node and python.is_file() and (root / "dist/index.html").is_file()):
    raise SystemExit("请先构建前端并创建 AI Ops 的 Python 环境")
logs.mkdir(parents=True, exist_ok=True)
skill = root / "skills/voiceagent-evidence-driven-optimizer"
agent = {
    "Label": label,
    "ProgramArguments": [node, str(root / "server/index.js")],
    "WorkingDirectory": str(root),
    "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
    "EnvironmentVariables": {
        "HOME": str(home),
        "PATH": os.pathsep.join([str(python.parent), str(Path(node).parent), str(home / ".local/bin"), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
        "NODE_ENV": "production", "PORT": "8787", "DSH_PYTHON": str(python),
        "VO_AGENT_SKILL_DIR": str(skill), "VO_AGENT_SKILL_SCRIPTS": str(skill / "scripts"),
    },
    "StandardOutPath": str(logs / "server.log"), "StandardErrorPath": str(logs / "error.log"),
}
dest = home / "Library/LaunchAgents" / (label + ".plist")
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_bytes(plistlib.dumps(agent))
