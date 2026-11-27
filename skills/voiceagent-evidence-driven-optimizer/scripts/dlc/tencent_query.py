#!/usr/bin/env python3
"""Call a configured Tencent Cloud query API without persisting user credentials.

The script intentionally uses only the Python standard library so the skill can
be distributed to client installations without a package manager step.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import hmac
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import keychain_credentials


class QueryClientError(RuntimeError):
    """An actionable error safe to show to a user."""


def _sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _hmac_sha256(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def _json_bytes(value: Dict[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _canonical_headers(host: str) -> str:
    return f"content-type:application/json; charset=utf-8\nhost:{host}\n"


def build_tc3_authorization(
    secret_id: str,
    secret_key: str,
    service: str,
    host: str,
    uri: str,
    body: bytes,
    timestamp: int,
) -> str:
    """Build the Tencent Cloud TC3-HMAC-SHA256 Authorization header."""
    date = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")
    canonical_headers = _canonical_headers(host)
    signed_headers = "content-type;host"
    canonical_request = "\n".join(
        [
            "POST",
            uri or "/",
            "",
            canonical_headers,
            signed_headers,
            _sha256_hex(body),
        ]
    )
    credential_scope = f"{date}/{service}/tc3_request"
    string_to_sign = "\n".join(
        [
            "TC3-HMAC-SHA256",
            str(timestamp),
            credential_scope,
            _sha256_hex(canonical_request.encode("utf-8")),
        ]
    )
    secret_date = _hmac_sha256(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac_sha256(secret_date, service)
    secret_signing = _hmac_sha256(secret_service, "tc3_request")
    signature = hmac.new(
        secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return (
        "TC3-HMAC-SHA256 "
        f"Credential={secret_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )


def _safe_text(value: Any, secret_id: str, secret_key: str, uin: str = "") -> str:
    text = str(value)
    for secret in (secret_id, secret_key, uin):
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text


def _load_json_file(path: str) -> Dict[str, Any]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise QueryClientError(f"配置文件不存在：{path}") from exc
    except json.JSONDecodeError as exc:
        raise QueryClientError(f"配置文件不是有效 JSON：{path}（{exc.msg}）") from exc


def _get_path(value: Any, path: str) -> Any:
    """Read a dotted path such as Response.Data.Rows, including list indexes."""
    current = value
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit():
            index = int(part)
            if index >= len(current):
                return None
            current = current[index]
        else:
            return None
    return current


def _first_path(value: Any, paths: Iterable[str]) -> Any:
    for path in paths:
        found = _get_path(value, path)
        if found is not None:
            return found
    return None


def _set_path(value: Dict[str, Any], path: str, new_value: Any) -> None:
    """Set a dotted object path, creating intermediate dictionaries."""
    parts = path.split(".")
    current: Dict[str, Any] = value
    for part in parts[:-1]:
        child = current.get(part)
        if not isinstance(child, dict):
            child = {}
            current[part] = child
        current = child
    current[parts[-1]] = new_value


def _as_paths(value: Any, default: Sequence[str] = ()) -> List[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return list(default)


def _normalize_table_name(value: Any) -> str:
    """Normalize a SQL/catalog table identifier for exact comparisons."""
    text = str(value or "").strip()
    if not text:
        return ""
    parts = text.split(".")
    normalized: List[str] = []
    for part in parts:
        part = part.strip()
        if len(part) >= 2 and (
            (part[0] == "`" and part[-1] == "`")
            or (part[0] == '"' and part[-1] == '"')
            or (part[0] == "[" and part[-1] == "]")
        ):
            part = part[1:-1]
        if part:
            normalized.append(part)
    return ".".join(normalized).casefold()


def _normalize_table_names(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, (list, tuple, set)):
        values = list(value)
    else:
        values = [value]
    result: List[str] = []
    seen = set()
    for item in values:
        normalized = _normalize_table_name(item)
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(str(item).strip())
    return result


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(result.get(key), dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _action_config(config: Dict[str, Any], operation: str) -> Dict[str, Any]:
    actions = config.get("actions")
    if not isinstance(actions, dict) or not isinstance(actions.get(operation), dict):
        raise QueryClientError(f"配置缺少 actions.{operation} 定义")
    action = actions[operation]
    if not action.get("action"):
        raise QueryClientError(f"配置缺少 actions.{operation}.action")
    return action


def _catalog_filter_values(
    config: Dict[str, Any], body: Dict[str, Any]
) -> List[str]:
    action = _action_config(config, "catalog")
    table_filter = action.get("table_filter", {})
    filter_field = table_filter.get("field", "Filters")
    filter_name = table_filter.get("name", "table-name")
    filters = body.get(filter_field)
    if not isinstance(filters, list):
        raise QueryClientError(
            "catalog 请求必须包含明确的表名过滤条件；禁止查询全库表元数据"
        )
    for item in filters:
        if not isinstance(item, dict):
            continue
        if str(item.get("Name", "")).casefold() != str(filter_name).casefold():
            continue
        values = _normalize_table_names(item.get("Values"))
        if values:
            return values
    raise QueryClientError(
        "catalog 请求必须包含至少一张明确表名；禁止查询全库表元数据"
    )


def _request_body(
    config: Dict[str, Any],
    operation: str,
    sql: Optional[str],
    task_id: Optional[str],
    max_rows: Optional[int],
    extra: Optional[Dict[str, Any]],
    table_name: Optional[Any] = None,
) -> Dict[str, Any]:
    action = _action_config(config, operation)
    body = copy.deepcopy(config.get("common_request", {}))
    body = _deep_merge(body, action.get("request", {}))
    if extra:
        _validate_extra_json(extra)
        body = _deep_merge(body, extra)

    if operation == "catalog":
        table_names = _normalize_table_names(table_name)
        if not table_names:
            raise QueryClientError(
                "catalog 操作必须明确指定至少一张表；禁止查询全库表元数据"
            )
        table_filter = action.get("table_filter", {})
        filter_field = table_filter.get("field", "Filters")
        filter_name = table_filter.get("name", "table-name")
        filters = body.get(filter_field)
        if not isinstance(filters, list):
            filters = []
        filters.append({"Name": filter_name, "Values": table_names})
        body[filter_field] = filters
    elif operation == "submit":
        if not sql:
            raise QueryClientError("submit 操作需要 --sql")
        sql_field_path = action.get("sql_field_path")
        sql_encoding = action.get("sql_encoding") or config.get("query", {}).get(
            "sql_encoding", "plain"
        )
        sql_value = sql
        if sql_encoding == "base64":
            sql_value = base64.b64encode(sql.encode("utf-8")).decode("ascii")
        elif sql_encoding != "plain":
            raise QueryClientError(f"不支持的 SQL 编码方式：{sql_encoding}")
        if sql_field_path:
            _set_path(body, sql_field_path, sql_value)
        else:
            sql_field = action.get("sql_field") or config.get("query", {}).get(
                "sql_field", "Sql"
            )
            body[sql_field] = sql_value
        if max_rows is None:
            default_max_rows = config.get("query", {}).get("default_max_rows")
            if default_max_rows is not None:
                max_rows = int(default_max_rows)
        if max_rows is not None:
            if "max_rows_field" in action:
                max_rows_field = action.get("max_rows_field")
            elif "max_rows_field" in config.get("query", {}):
                max_rows_field = config.get("query", {}).get("max_rows_field")
            else:
                max_rows_field = "MaxRows"
            if max_rows_field:
                body[max_rows_field] = max_rows
    elif operation in {"status", "result"}:
        if not task_id:
            raise QueryClientError(f"{operation} 操作需要 --task-id")
        task_id_field = action.get("task_id_field") or config.get(
            "query", {}
        ).get("task_id_field", "TaskId")
        body[task_id_field] = task_id
    return body


def _submitted_sql_from_body(
    config: Dict[str, Any], body: Dict[str, Any]
) -> str:
    action = _action_config(config, "submit")
    sql_field_path = action.get("sql_field_path")
    if sql_field_path:
        value = _get_path(body, sql_field_path)
    else:
        sql_field = action.get("sql_field") or config.get("query", {}).get(
            "sql_field", "Sql"
        )
        value = body.get(sql_field)
    if value in (None, ""):
        raise QueryClientError("submit 请求没有包含 SQL")
    encoding = action.get("sql_encoding") or config.get("query", {}).get(
        "sql_encoding", "plain"
    )
    if encoding == "plain":
        return str(value)
    if encoding == "base64":
        try:
            return base64.b64decode(str(value), validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            raise QueryClientError("submit 请求中的 SQL 不是有效 Base64") from exc
    raise QueryClientError(f"不支持的 SQL 编码方式：{encoding}")


def load_credentials(args: argparse.Namespace) -> Tuple[str, str]:
    if not args.credentials_keychain:
        raise QueryClientError(
            "本 Skill 仅允许从 macOS 钥匙串读取凭证；请传入 --credentials-keychain"
        )
    try:
        return keychain_credentials.load_credentials()
    except keychain_credentials.KeychainCredentialsError as exc:
        raise QueryClientError(str(exc)) from exc


def load_uin(args: argparse.Namespace) -> str:
    if not args.credentials_keychain:
        raise QueryClientError(
            "本 Skill 仅允许从 macOS 钥匙串读取 UIN；请传入 --credentials-keychain"
        )
    try:
        return keychain_credentials.load_uin()
    except keychain_credentials.KeychainCredentialsError as exc:
        raise QueryClientError(str(exc)) from exc


def _parse_extra(raw: Optional[str]) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise QueryClientError(f"--extra-json 不是有效 JSON：{exc.msg}") from exc
    if not isinstance(value, dict):
        raise QueryClientError("--extra-json 必须是 JSON 对象")
    _validate_extra_json(value)
    return value


_PROTECTED_REQUEST_FIELDS = {
    "catalog",
    "database",
    "databasename",
    "datasourceconnectionname",
    "dataenginename",
    "resourcegroupname",
}


def _validate_extra_json(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).casefold() in _PROTECTED_REQUEST_FIELDS:
                raise QueryClientError(
                    f"--extra-json 不允许覆盖查询上下文字段：{key}"
                )
            _validate_extra_json(child)
    elif isinstance(value, list):
        for child in value:
            _validate_extra_json(child)


class TencentQueryClient:
    def __init__(
        self,
        config: Dict[str, Any],
        secret_id: str,
        secret_key: str,
        authorized_tables: Optional[Sequence[str]] = None,
    ) -> None:
        self.config = config
        self.secret_id = secret_id
        self.secret_key = secret_key
        self.authorized_tables = _normalize_table_names(authorized_tables)
        self.endpoint = str(config.get("endpoint", "")).rstrip("/")
        self.service = str(config.get("service", ""))
        self.version = str(config.get("version", ""))
        self.region = str(config.get("region", ""))
        if config.get("protocol", "tencent_tc3") != "tencent_tc3":
            raise QueryClientError("当前脚本只支持 protocol=tencent_tc3")
        if not self.endpoint or not self.service or not self.version:
            raise QueryClientError(
                "配置必须包含 endpoint、service 和 version；请先完成公司平台配置"
            )
        if any(
            "REPLACE_ME" in value
            for value in (self.endpoint, self.service, self.version, self.region)
        ):
            raise QueryClientError(
                "查询平台配置仍包含 REPLACE_ME 占位符，请先完成 references/config.json"
            )
        parsed = urlparse(self.endpoint)
        if parsed.scheme != "https" or not parsed.netloc:
            raise QueryClientError("endpoint 必须是带 HTTPS 的完整 URL")
        self.host = parsed.netloc
        self.uri = parsed.path or "/"
        self.timeout = int(config.get("timeout_seconds", 30))

    def call(self, operation: str, body: Dict[str, Any]) -> Dict[str, Any]:
        action = _action_config(self.config, operation)
        if operation == "catalog":
            _catalog_filter_values(self.config, body)
        elif operation == "submit":
            if not self.authorized_tables:
                raise QueryClientError(
                    "submit 请求必须绑定当前账号在 DLC 中授权的表清单"
                )
            _validate_sql(
                _submitted_sql_from_body(self.config, body),
                self.authorized_tables,
                self.config,
            )
        payload = _json_bytes(body)
        timestamp = int(time.time())
        headers = {
            "Authorization": build_tc3_authorization(
                self.secret_id,
                self.secret_key,
                self.service,
                self.host,
                self.uri,
                payload,
                timestamp,
            ),
            "Content-Type": "application/json; charset=utf-8",
            "Host": self.host,
            "X-TC-Action": str(action["action"]),
            "X-TC-Version": self.version,
            "X-TC-Timestamp": str(timestamp),
        }
        if self.region:
            headers["X-TC-Region"] = self.region
        request = Request(self.endpoint, data=payload, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="replace")[:1000]
            raise QueryClientError(
                f"腾讯云接口 HTTP {exc.code}："
                f"{_safe_text(body_text, self.secret_id, self.secret_key)}"
            ) from exc
        except URLError as exc:
            raise QueryClientError(
                f"无法连接腾讯云查询服务："
                f"{_safe_text(exc.reason, self.secret_id, self.secret_key)}"
            ) from exc
        except TimeoutError as exc:
            raise QueryClientError("连接腾讯云查询服务超时") from exc
        try:
            result = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise QueryClientError("查询服务返回的不是有效 JSON") from exc
        if not isinstance(result, dict):
            raise QueryClientError("查询服务返回的 JSON 顶层结构不是对象")
        return result


def _response_error(response: Dict[str, Any]) -> Optional[str]:
    payload = response.get("Response", response)
    error = payload.get("Error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        code = error.get("Code", "UnknownError")
        message = error.get("Message", "腾讯云接口返回错误")
        return f"{code}: {message}"
    return None


def _request_id(response: Dict[str, Any]) -> Optional[str]:
    return _first_path(response, ["Response.RequestId", "RequestId"])


def _require_success(response: Dict[str, Any]) -> Dict[str, Any]:
    error = _response_error(response)
    if error:
        raise QueryClientError(error)
    return response


def _extract_task_id(config: Dict[str, Any], response: Dict[str, Any]) -> Optional[str]:
    action = _action_config(config, "submit")
    paths = _as_paths(
        action.get("task_id_paths"),
        ["Response.TaskId", "Response.JobId", "Response.Data.TaskId"],
    )
    task_id = _first_path(response, paths)
    return str(task_id) if task_id is not None else None


def _extract_status(config: Dict[str, Any], response: Dict[str, Any]) -> Optional[str]:
    action = _action_config(config, "status")
    paths = _as_paths(
        action.get("status_paths"),
        ["Response.Status", "Response.Data.Status", "Status"],
    )
    status = _first_path(response, paths)
    return str(status).upper() if status is not None else None


def _normalize_rows(
    config: Dict[str, Any], response: Dict[str, Any], task_id: Optional[str], status: str
) -> Dict[str, Any]:
    action = _action_config(config, "result")
    data = _first_path(
        response,
        _as_paths(action.get("data_paths"), ["Response.Data", "Response.Result"]),
    )
    if data is None:
        data = response.get("Response", response)

    columns = _first_path(
        response,
        _as_paths(
            action.get("columns_paths"),
            ["Response.Columns", "Response.Data.Columns", "Response.Result.Columns"],
        ),
    )
    rows = _first_path(
        response,
        _as_paths(
            action.get("rows_paths"),
            ["Response.Rows", "Response.Data.Rows", "Response.Result.Rows"],
        ),
    )
    if rows is None and isinstance(data, list):
        rows = data
    if rows is None and isinstance(data, dict):
        rows = data.get("rows") or data.get("Rows") or data.get("data")
        columns = columns or data.get("columns") or data.get("Columns")

    if rows is None:
        rows = []
    if isinstance(columns, str):
        try:
            columns = json.loads(columns) if columns.strip() else []
        except json.JSONDecodeError as exc:
            raise QueryClientError(
                "结果接口返回的 ResultSchema 不是有效 JSON"
            ) from exc
    if isinstance(rows, str):
        try:
            rows = json.loads(rows) if rows.strip() else []
        except json.JSONDecodeError as exc:
            raise QueryClientError(
                "结果接口返回的 ResultSet 不是有效 JSON"
            ) from exc
    if not isinstance(rows, list):
        raise QueryClientError("结果接口返回的 rows 不是数组，请检查 result.rows_paths")

    normalized_columns: List[str] = []
    normalized_rows: List[Dict[str, Any]] = []
    if isinstance(columns, list):
        normalized_columns = [
            str(item.get("Name") if isinstance(item, dict) else item)
            for item in columns
        ]
    for row in rows:
        if isinstance(row, dict):
            normalized_rows.append(row)
        elif isinstance(row, list) and normalized_columns:
            normalized_rows.append(
                {
                    column: row[index] if index < len(row) else None
                    for index, column in enumerate(normalized_columns)
                }
            )
        else:
            normalized_rows.append({"value": row})
    if not normalized_columns and normalized_rows:
        normalized_columns = list(normalized_rows[0].keys())

    return {
        "ok": True,
        "operation": "query_result",
        "task_id": task_id,
        "status": status,
        "columns": normalized_columns,
        "rows": normalized_rows,
        "row_count": len(normalized_rows),
        "request_id": _request_id(response),
        "raw_data": data if not normalized_rows else None,
    }


def _summarize_catalog(
    data: Any, include_columns: bool = False
) -> List[Dict[str, Any]]:
    """Keep catalog output useful without exposing storage or audit metadata."""
    if isinstance(data, dict):
        data = data.get("TableList") or data.get("tables") or []
    if not isinstance(data, list):
        return []

    summaries: List[Dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        base = item.get("TableBaseInfo")
        if not isinstance(base, dict):
            base = item
        columns = item.get("Columns")
        summary: Dict[str, Any] = {
            "database_name": base.get("DatabaseName"),
            "table_name": base.get("TableName") or item.get("TableName"),
            "comment": base.get("TableComment")
            or item.get("Comment")
            or item.get("TableComment"),
            "table_type": base.get("Type") or item.get("Type"),
            "table_format": base.get("TableFormat") or item.get("TableFormat"),
            "column_count": len(columns) if isinstance(columns, list) else None,
        }
        if include_columns:
            safe_columns: List[Dict[str, Any]] = []
            if isinstance(columns, list):
                for column in columns:
                    if not isinstance(column, dict):
                        continue
                    safe_columns.append(
                        {
                            "name": column.get("Name"),
                            "type": column.get("Type"),
                            "comment": column.get("Comment"),
                            "is_partition": column.get("IsPartition"),
                        }
                    )
            summary["columns"] = safe_columns
        summaries.append(summary)
    return summaries


def _fetch_result_pages(
    client: TencentQueryClient,
    config: Dict[str, Any],
    task_id: str,
) -> Dict[str, Any]:
    """Fetch and combine all pages from DLC DescribeTaskResult."""
    action = _action_config(config, "result")
    next_token_paths = _as_paths(
        action.get("next_token_paths"), ["Response.NextToken"]
    )
    next_token_field = action.get("next_token_field", "NextToken")
    max_results_field = action.get("max_results_field", "MaxResults")
    max_results = action.get("max_results")
    if max_results is None:
        max_results = config.get("query", {}).get("default_max_rows")
    max_total_rows = int(config.get("query", {}).get("max_total_rows", 5000))
    next_token: Optional[str] = None
    all_rows: List[Dict[str, Any]] = []
    columns: List[str] = []
    request_id: Optional[str] = None
    status = "SUCCEEDED"
    truncated = False

    while True:
        body = _request_body(config, "result", None, task_id, None, None)
        if max_results is not None and max_results_field:
            body[max_results_field] = int(max_results)
        if next_token:
            _set_path(body, next_token_field, next_token)
        response = _require_success(client.call("result", body))
        # DescribeTaskResult also returns HTTP success for pending/failed tasks.
        # Their null ResultSet must never be reported as a successful empty query.
        if action.get("action") == "DescribeTaskResult":
            task_state = _first_path(response, ["Response.TaskInfo.State"])
            allowed_states = {
                str(value).upper() for value in config.get("success_statuses", ["2"])
            }
            if task_state is None or str(task_state).upper() not in allowed_states:
                raise QueryClientError(
                    f"查询任务 {task_id} 尚未成功完成，当前状态：{task_state}；"
                    "请使用 status 核实，不能将空返回解释为零条记录"
                )
        page = _normalize_rows(config, response, task_id, status)
        if page["columns"] and not columns:
            columns = page["columns"]
        remaining = max_total_rows - len(all_rows)
        if remaining <= 0:
            truncated = True
            break
        all_rows.extend(page["rows"][:remaining])
        if len(page["rows"]) > remaining:
            truncated = True
            break
        request_id = page.get("request_id") or request_id
        token_value = _first_path(response, next_token_paths)
        if token_value in (None, ""):
            break
        token_value = str(token_value)
        # DLC Spark uses a stateful FETCH_NEXT cursor that can repeat across pages.
        # Preserve the hard row limit and reject empty pages with a stuck cursor.
        if token_value == next_token and not page["rows"]:
            raise QueryClientError("结果接口返回无数据的重复游标，已停止分页")
        next_token = token_value

    return {
        "ok": True,
        "operation": "query_result",
        "task_id": task_id,
        "status": status,
        "columns": columns,
        "rows": all_rows,
        "row_count": len(all_rows),
        "request_id": request_id,
        "truncated": truncated,
    }


def submit_and_wait(
    client: TencentQueryClient,
    config: Dict[str, Any],
    body: Dict[str, Any],
    wait: bool,
    max_wait_seconds: Optional[int],
) -> Dict[str, Any]:
    submit_response = _require_success(client.call("submit", body))
    task_id = _extract_task_id(config, submit_response)
    if not task_id:
        submit_action = _action_config(config, "submit")
        data = _first_path(
            submit_response,
            _as_paths(submit_action.get("data_paths"), ["Response.Data", "Response.Result"]),
        )
        if data is None:
            raise QueryClientError(
                "提交接口未返回 task_id；请检查 actions.submit.task_id_paths"
            )
        return {
            "ok": True,
            "operation": "query_result",
            "task_id": None,
            "status": "SUCCEEDED",
            "columns": [],
            "rows": data if isinstance(data, list) else [],
            "row_count": len(data) if isinstance(data, list) else None,
            "request_id": _request_id(submit_response),
            "raw_data": data if not isinstance(data, list) else None,
        }

    result = {
        "ok": True,
        "operation": "query_submitted",
        "task_id": task_id,
        "status": "SUBMITTED",
        "request_id": _request_id(submit_response),
    }
    if not wait:
        return result
    if "status" not in config.get("actions", {}) or "result" not in config.get(
        "actions", {}
    ):
        return result

    max_wait = max_wait_seconds or int(config.get("max_poll_seconds", 120))
    interval = float(config.get("poll_interval_seconds", 2))
    deadline = time.monotonic() + max_wait
    success_statuses = {
        str(item).upper()
        for item in config.get(
            "success_statuses",
            ["SUCCESS", "SUCCEEDED", "COMPLETED", "FINISHED", "DONE"],
        )
    }
    failure_statuses = {
        str(item).upper()
        for item in config.get(
            "failure_statuses",
            ["FAILED", "FAILURE", "CANCELED", "CANCELLED", "ERROR"],
        )
    }
    status_body = _request_body(config, "status", None, task_id, None, None)
    while True:
        status_response = _require_success(client.call("status", status_body))
        status = _extract_status(config, status_response)
        if not status:
            raise QueryClientError(
                "状态接口未返回 status；请检查 actions.status.status_paths"
            )
        if status in failure_statuses:
            raise QueryClientError(f"查询任务 {task_id} 失败，状态：{status}")
        if status in success_statuses:
            return _fetch_result_pages(client, config, task_id)
        if time.monotonic() >= deadline:
            return {
                **result,
                "status": status,
                "warning": f"等待超过 {max_wait} 秒，请使用 status/result 继续查询",
            }
        time.sleep(max(0.1, interval))


def _tokenize_sql(sql: str) -> List[Tuple[str, str]]:
    """Tokenize enough SQL syntax to inspect FROM/JOIN sources safely."""
    tokens: List[Tuple[str, str]] = []
    index = 0
    length = len(sql)
    while index < length:
        char = sql[index]
        if char.isspace():
            index += 1
            continue
        if sql.startswith("--", index):
            newline = sql.find("\n", index + 2)
            index = length if newline < 0 else newline + 1
            continue
        if sql.startswith("/*", index):
            end = sql.find("*/", index + 2)
            if end < 0:
                raise QueryClientError("SQL 包含未闭合的块注释")
            index = end + 2
            continue
        if char == "'":
            index += 1
            while index < length:
                if sql[index] == "\\" and index + 1 < length:
                    index += 2
                    continue
                if sql[index] == "'":
                    if index + 1 < length and sql[index + 1] == "'":
                        index += 2
                        continue
                    index += 1
                    break
                index += 1
            else:
                raise QueryClientError("SQL 包含未闭合的字符串")
            tokens.append(("string", ""))
            continue
        if char in {'"', "`", "["}:
            closing = "]" if char == "[" else char
            index += 1
            value: List[str] = []
            while index < length:
                if sql[index] == closing:
                    if index + 1 < length and sql[index + 1] == closing:
                        value.append(closing)
                        index += 2
                        continue
                    index += 1
                    break
                value.append(sql[index])
                index += 1
            else:
                raise QueryClientError("SQL 包含未闭合的引用标识符")
            tokens.append(("identifier", "".join(value)))
            continue
        if char.isalpha() or char in {"_", "$"}:
            start = index
            index += 1
            while index < length and (
                sql[index].isalnum() or sql[index] in {"_", "$"}
            ):
                index += 1
            tokens.append(("word", sql[start:index]))
            continue
        if char.isdigit():
            start = index
            index += 1
            while index < length and (
                sql[index].isalnum() or sql[index] in {"_", "$", "."}
            ):
                index += 1
            tokens.append(("literal", sql[start:index]))
            continue
        if char in {".", ",", "(", ")"}:
            tokens.append(("punctuation", char))
        else:
            tokens.append(("operator", char))
        index += 1
    return tokens


def _token_word(token: Tuple[str, str], value: Optional[str] = None) -> bool:
    if token[0] != "word":
        return False
    return value is None or token[1].casefold() == value.casefold()


def _parse_identifier_tokens(
    tokens: Sequence[Tuple[str, str]], index: int
) -> Tuple[Optional[str], int]:
    if index >= len(tokens) or tokens[index][0] not in {"word", "identifier"}:
        return None, index
    parts = [tokens[index][1]]
    index += 1
    while (
        index + 1 < len(tokens)
        and tokens[index] == ("punctuation", ".")
        and tokens[index + 1][0] in {"word", "identifier"}
    ):
        parts.append(tokens[index + 1][1])
        index += 2
    return ".".join(parts), index


def _skip_parenthesized(
    tokens: Sequence[Tuple[str, str]], index: int
) -> int:
    if index >= len(tokens) or tokens[index] != ("punctuation", "("):
        return index
    depth = 0
    while index < len(tokens):
        if tokens[index] == ("punctuation", "("):
            depth += 1
        elif tokens[index] == ("punctuation", ")"):
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    raise QueryClientError("SQL 包含未闭合的括号")


def _extract_cte_names(
    tokens: Sequence[Tuple[str, str]]
) -> Set[str]:
    names: Set[str] = set()
    if not tokens or not _token_word(tokens[0], "WITH"):
        return names
    index = 1
    if index < len(tokens) and _token_word(tokens[index], "RECURSIVE"):
        index += 1
    while index < len(tokens):
        name, next_index = _parse_identifier_tokens(tokens, index)
        if not name:
            break
        names.add(_normalize_table_name(name))
        index = next_index
        if index < len(tokens) and tokens[index] == ("punctuation", "("):
            index = _skip_parenthesized(tokens, index)
        if index >= len(tokens) or not _token_word(tokens[index], "AS"):
            break
        index += 1
        if index >= len(tokens) or tokens[index] != ("punctuation", "("):
            break
        index = _skip_parenthesized(tokens, index)
        if index >= len(tokens) or tokens[index] != ("punctuation", ","):
            break
        index += 1
    return names


_TABLE_FUNCTIONS = {
    "explode",
    "inline",
    "posexplode",
    "range",
    "stack",
    "table",
    "unnest",
    "values",
}
_FROM_CLAUSE_TERMINATORS = {
    "cluster",
    "distribute",
    "group",
    "having",
    "limit",
    "minus",
    "offset",
    "order",
    "qualify",
    "sort",
    "union",
    "where",
    "window",
}


def _extract_sql_table_references(sql: str) -> List[str]:
    """Return physical-looking sources used after FROM/JOIN, including CTEs."""
    tokens = _tokenize_sql(sql)
    references: List[str] = []

    def add_source(index: int) -> int:
        if index >= len(tokens):
            return index
        if _token_word(tokens[index], "LATERAL"):
            index += 1
        if index >= len(tokens):
            return index
        if tokens[index] == ("punctuation", "("):
            return _skip_parenthesized(tokens, index)
        name, next_index = _parse_identifier_tokens(tokens, index)
        if not name:
            raise QueryClientError(
                "无法安全识别 FROM/JOIN 后的表名；请使用明确的物理表名"
            )
        if (
            next_index < len(tokens)
            and tokens[next_index] == ("punctuation", "(")
            and name.casefold() in _TABLE_FUNCTIONS
        ):
            return _skip_parenthesized(tokens, next_index)
        references.append(name)
        return next_index

    index = 0
    while index < len(tokens):
        if _token_word(tokens[index], "FROM") or _token_word(
            tokens[index], "JOIN"
        ):
            source_index = index + 1
            source_end = add_source(source_index)
            scan_index = source_end
            paren_depth = 0
            while scan_index < len(tokens):
                token = tokens[scan_index]
                if token == ("punctuation", "("):
                    paren_depth += 1
                elif token == ("punctuation", ")"):
                    if paren_depth == 0:
                        break
                    paren_depth -= 1
                if paren_depth == 0 and _token_word(token, "JOIN"):
                    break
                if paren_depth == 0 and token[0] == "word" and (
                    token[1].casefold() in _FROM_CLAUSE_TERMINATORS
                ):
                    break
                if paren_depth == 0 and token == ("punctuation", ","):
                    scan_index = add_source(scan_index + 1)
                    continue
                scan_index += 1
            # Continue the outer scan one token at a time so FROM/JOIN inside
            # a parenthesized subquery is also inspected.
            index += 1
            continue
        index += 1
    return references


def _configured_database_name(config: Optional[Dict[str, Any]]) -> str:
    if not config:
        return ""
    for path in (
        "actions.catalog.request.DatabaseName",
        "actions.submit.request.DatabaseName",
    ):
        value = _get_path(config, path)
        if value not in (None, ""):
            return _normalize_table_name(value)
    return ""


def _table_reference_is_authorized(
    reference: str,
    authorized_tables: Sequence[str],
    config: Optional[Dict[str, Any]] = None,
) -> bool:
    reference_name = _normalize_table_name(reference)
    if not reference_name:
        return False
    authorized_names = {
        _normalize_table_name(table)
        for table in authorized_tables
        if _normalize_table_name(table)
    }
    if reference_name in authorized_names:
        return True

    # Permit the configured database prefix for an unqualified Feishu table
    # name, but never infer or accept an arbitrary catalog prefix.
    database_name = _configured_database_name(config)
    if not database_name:
        return False
    reference_parts = reference_name.split(".")
    for authorized_name in authorized_names:
        authorized_parts = authorized_name.split(".")
        if reference_parts[-1] != authorized_parts[-1]:
            continue
        if len(reference_parts) == 2 and reference_parts[0] == database_name:
            if (
                len(authorized_parts) == 1
                or authorized_parts[-2:] == reference_parts
            ):
                return True
        if len(reference_parts) == 1 and len(authorized_parts) >= 2:
            if authorized_parts[-2] == database_name:
                return True
        if len(reference_parts) == 1 and len(authorized_parts) == 1:
            return True
    return False


def _validate_sql(
    sql: Optional[str],
    authorized_tables: Optional[Sequence[str]] = None,
    config: Optional[Dict[str, Any]] = None,
) -> None:
    if not sql:
        return
    compact = re.sub(r"\s+", " ", sql.strip())
    if not re.match(r"^(SELECT|WITH)\b", compact, flags=re.IGNORECASE):
        raise QueryClientError("只允许以 SELECT 或 WITH 开始的只读 SQL")
    if ";" in compact.rstrip(";"):
        raise QueryClientError("不允许执行多条 SQL")
    blocked = (
        r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|"
        r"MERGE|CALL|DESCRIBE|SHOW|USE|EXPLAIN)\b"
    )
    if re.search(blocked, compact, flags=re.IGNORECASE):
        raise QueryClientError("SQL 含有被禁止的写入、管理或元数据语句")
    if authorized_tables is None:
        return
    normalized_authorized_tables = _normalize_table_names(authorized_tables)
    if not normalized_authorized_tables:
        raise QueryClientError(
            "提交 SQL 前必须提供当前账号在 DLC 中授权的表清单"
        )
    references = _extract_sql_table_references(sql)
    cte_names = _extract_cte_names(_tokenize_sql(sql))
    unauthorized = []
    seen = set()
    for reference in references:
        normalized_reference = _normalize_table_name(reference)
        if normalized_reference in cte_names:
            continue
        if _table_reference_is_authorized(
            reference, normalized_authorized_tables, config
        ):
            continue
        if normalized_reference not in seen:
            seen.add(normalized_reference)
            unauthorized.append(reference)
    if unauthorized:
        raise QueryClientError(
            "SQL 引用了 DLC 未授权的表："
            + "、".join(unauthorized)
            + "；只能使用当前账号授权表"
        )


def run_operation(
    config: Dict[str, Any],
    secret_id: str,
    secret_key: str,
    operation: str,
    sql: Optional[str] = None,
    task_id: Optional[str] = None,
    max_rows: Optional[int] = None,
    extra: Optional[Dict[str, Any]] = None,
    wait: bool = True,
    max_wait_seconds: Optional[int] = None,
    table_name: Optional[Any] = None,
    authorized_tables: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    if operation == "catalog":
        requested_table_names = _normalize_table_names(table_name)
        if not requested_table_names:
            raise QueryClientError(
                "catalog 操作必须明确指定至少一张表；禁止查询全库表元数据"
            )
        if not _normalize_table_names(authorized_tables):
            raise QueryClientError(
                "catalog 操作必须提供当前账号在 DLC 中授权的表清单"
            )
        unauthorized_requested = [
            table
            for table in requested_table_names
            if not _table_reference_is_authorized(
                table, authorized_tables, config
            )
        ]
        if unauthorized_requested:
            raise QueryClientError(
                "catalog 请求包含不在当前 DLC 授权目录中的表："
                + "、".join(unauthorized_requested)
            )
    if operation == "submit":
        if not _normalize_table_names(authorized_tables):
            raise QueryClientError(
                "submit 操作必须提供当前账号在 DLC 中授权的表清单"
            )
        _validate_sql(sql, authorized_tables, config)
    client = TencentQueryClient(
        config,
        secret_id,
        secret_key,
        authorized_tables=authorized_tables,
    )
    if operation == "submit":
        return submit_and_wait(
            client,
            config,
            _request_body(config, operation, sql, task_id, max_rows, extra),
            wait,
            max_wait_seconds,
        )
    if operation == "status":
        response = _require_success(
            client.call(
                operation,
                _request_body(config, operation, sql, task_id, max_rows, extra),
            )
        )
        return {
            "ok": True,
            "operation": "query_status",
            "task_id": task_id,
            "status": _extract_status(config, response),
            "request_id": _request_id(response),
        }
    if operation == "result":
        return _fetch_result_pages(client, config, task_id)
    if operation == "catalog":
        response = _require_success(
            client.call(
                operation,
                _request_body(
                    config,
                    operation,
                    sql,
                    task_id,
                    max_rows,
                    extra,
                    table_name=table_name,
                ),
            )
        )
        action = _action_config(config, operation)
        data = _first_path(
            response,
            _as_paths(action.get("data_paths"), ["Response.Tables", "Response.Data"]),
        )
        requested_table_names = _normalize_table_names(table_name)
        raw_tables = _summarize_catalog(data, include_columns=True)
        tables = [
            table
            for table in raw_tables
            if _table_reference_is_authorized(
                str(table.get("table_name") or ""),
                requested_table_names,
                config,
            )
        ]
        returned_names = {
            _normalize_table_name(str(table.get("table_name") or ""))
            for table in tables
        }
        return {
            "ok": True,
            "operation": "catalog",
            "table_count": len(tables),
            "detail": True,
            "tables": tables,
            "requested_table_names": requested_table_names,
            "missing_table_names": [
                table
                for table in requested_table_names
                if not _table_reference_is_authorized(
                    table, returned_names, config
                )
            ],
            "filtered_unexpected_count": max(0, len(raw_tables) - len(tables)),
            "request_id": _request_id(response),
        }
    raise QueryClientError(f"不支持的 operation：{operation}")


def _policy_name(value: Any) -> str:
    text = str(value or "").strip()
    if text in ("*", ""):
        return ""
    return text


def fetch_authorized_tables(
    config: Dict[str, Any],
    secret_id: str,
    secret_key: str,
    uin: str,
) -> List[str]:
    """通过腾讯云 DLC DescribeUserInfo(Type=DataAuth) 查询当前 UIN 授权表清单。"""
    client = TencentQueryClient(config, secret_id, secret_key)
    action = _action_config(config, "authorized-tables")
    page_size = int(action.get("page_size", 100))
    user_id_field = str(action.get("user_id_field", "UserId"))
    limit_field = str(action.get("limit_field", "Limit"))
    offset_field = str(action.get("offset_field", "Offset"))
    policy_set_paths = _as_paths(
        action.get("policy_set_paths"),
        ["Response.UserInfo.DataPolicyInfo.PolicySet"],
    )
    total_count_paths = _as_paths(
        action.get("total_count_paths"),
        ["Response.UserInfo.DataPolicyInfo.TotalCount"],
    )
    db_field = str(action.get("policy_database_field", "Database"))
    catalog_field = str(action.get("policy_catalog_field", "Catalog"))
    table_field = str(action.get("policy_table_field", "Table"))
    view_field = str(action.get("policy_view_field", "View"))
    type_field = str(action.get("policy_type_field", "PolicyType"))
    table_policy_types = set(action.get("table_policy_types", ["TABLE", "VIEW"]))

    tables: List[str] = []
    offset = 0
    total: Optional[int] = None
    while True:
        body: Dict[str, Any] = {
            user_id_field: uin,
            limit_field: page_size,
            offset_field: offset,
        }
        body.update(dict(action.get("request") or {}))
        response = _require_success(client.call("authorized-tables", body))
        policy_set = _first_path(response, policy_set_paths) or []
        if total is None:
            raw_total = _first_path(response, total_count_paths)
            try:
                total = int(raw_total) if raw_total is not None else None
            except (TypeError, ValueError):
                total = None
        page_count = 0
        if isinstance(policy_set, list):
            page_count = len(policy_set)
            for policy in policy_set:
                if not isinstance(policy, dict):
                    continue
                policy_type = str(policy.get(type_field, "") or "")
                if table_policy_types and policy_type not in table_policy_types:
                    continue
                # DLC may encode full-table SELECT as COLUMN / Column=*.
                # Partial-column and non-SELECT grants are not table-wide read access.
                if policy_type == "COLUMN" and (
                    str(policy.get("Column", "")).strip() != "*"
                    or str(policy.get("Operation", "")).strip().upper() != "SELECT"
                ):
                    continue
                table_name = _policy_name(policy.get(table_field))
                if policy_type == "VIEW":
                    table_name = _policy_name(policy.get(view_field)) or table_name
                database = _policy_name(policy.get(db_field))
                catalog = _policy_name(policy.get(catalog_field))
                if not table_name or not database:
                    continue
                full = ".".join(
                    part for part in (catalog, database, table_name) if part
                )
                if full not in tables:
                    tables.append(full)
        if page_count < page_size:
            break
        if total is not None and offset + page_count >= total:
            break
        offset += page_size
    return _normalize_table_names(tables)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="企业自助取数腾讯云 API 调用器")
    parser.add_argument("--config", required=True, help="部署后的 JSON 配置文件路径")
    parser.add_argument(
        "--operation",
        required=True,
        choices=["catalog", "submit", "status", "result", "authorized-tables"],
    )
    parser.add_argument("--sql", help="submit 操作的只读 SQL")
    parser.add_argument("--task-id", help="status/result 操作的任务 ID")
    parser.add_argument(
        "--table-name",
        action="append",
        dest="table_names",
        help="catalog 操作的指定表名；可重复传入，禁止省略",
    )
    parser.add_argument(
        "--authorized-table",
        action="append",
        dest="authorized_tables",
        help="可选的授权表子集；必须属于按当前 UIN 从腾讯云 DLC 查询到的授权表，可重复传入",
    )
    parser.add_argument("--max-rows", type=int, help="本次查询的最大返回行数")
    parser.add_argument("--extra-json", help="合并到请求体的额外 JSON 对象")
    parser.add_argument(
        "--credentials-keychain",
        action="store_true",
        help="从 macOS 钥匙串读取当前用户的 SecretId、SecretKey 和 UIN",
    )
    parser.add_argument(
        "--no-wait",
        action="store_true",
        help="submit 后只返回 task_id，不轮询结果",
    )
    parser.add_argument("--max-wait-seconds", type=int)
    parser.add_argument("--output", help="将 JSON 结果写入该文件；不指定则输出到 stdout")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    secret_id = ""
    secret_key = ""
    uin = ""
    try:
        # Credential collection is intentionally the first operation in the
        # request path, before config probing or network work.
        secret_id, secret_key = load_credentials(args)
        uin = load_uin(args)
        config = _load_json_file(args.config)
        live_authorized_tables: Optional[List[str]] = None
        effective_authorized_tables: Optional[List[str]] = None
        if args.operation in {"catalog", "submit"}:
            live_authorized_tables = fetch_authorized_tables(
                config, secret_id, secret_key, uin
            )
            supplied_tables = _normalize_table_names(args.authorized_tables)
            unauthorized_supplied = [
                table
                for table in supplied_tables
                if not _table_reference_is_authorized(
                    table, live_authorized_tables, config
                )
            ]
            if unauthorized_supplied:
                raise QueryClientError(
                    "--authorized-table 包含当前 UIN 未获授权的表："
                    + "、".join(unauthorized_supplied)
                )
            if args.operation == "catalog":
                requested_tables = _normalize_table_names(args.table_names)
                effective_authorized_tables = live_authorized_tables
                if not requested_tables:
                    raise QueryClientError(
                        "catalog 操作必须明确指定至少一张表；禁止查询全库表元数据"
                    )
                unauthorized_requested = [
                    table
                    for table in requested_tables
                    if not _table_reference_is_authorized(
                        table, live_authorized_tables, config
                    )
                ]
                if unauthorized_requested:
                    raise QueryClientError(
                        "--table-name 包含当前 UIN 未获授权的表："
                        + "、".join(unauthorized_requested)
                    )
            else:
                effective_authorized_tables = (
                    supplied_tables or live_authorized_tables
                )
        if args.operation == "submit":
            _validate_sql(args.sql, effective_authorized_tables, config)
        if args.max_rows is not None and args.max_rows <= 0:
            raise QueryClientError("--max-rows 必须是正整数")
        if args.operation == "authorized-tables":
            result = {
                "ok": True,
                "operation": "authorized-tables",
                "authorized_table_names": fetch_authorized_tables(
                    config, secret_id, secret_key, uin
                ),
            }
        else:
            result = run_operation(
                config,
                secret_id,
                secret_key,
                args.operation,
                sql=args.sql,
                task_id=args.task_id,
                max_rows=args.max_rows,
                extra=_parse_extra(args.extra_json),
                wait=not args.no_wait,
                max_wait_seconds=args.max_wait_seconds,
                table_name=args.table_names,
                authorized_tables=effective_authorized_tables,
            )
        text = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output:
            Path(args.output).write_text(text + "\n", encoding="utf-8")
        else:
            print(text)
        return 0
    except (QueryClientError, OSError, ValueError) as exc:
        print(
            _safe_text(f"取数失败：{exc}", secret_id, secret_key, uin),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
