"""Small local client for the Blender MCP add-on (127.0.0.1 only)."""

from __future__ import annotations

import argparse
import json
import socket
import sys
from pathlib import Path


def call(command: str, params: dict, port: int = 9876, timeout: float = 60) -> dict:
    payload = json.dumps({"type": command, "params": params}).encode("utf-8")
    with socket.create_connection(("127.0.0.1", port), timeout=10) as connection:
        connection.settimeout(timeout)
        connection.sendall(payload)
        received = bytearray()
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                raise ConnectionError("Blender closed the connection without a complete response")
            received.extend(chunk)
            try:
                return json.loads(received.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--command", default="get_scene_info")
    parser.add_argument("--params", default="{}")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--code")
    source.add_argument("--script", type=Path)
    args = parser.parse_args()
    params = json.loads(args.params)
    command = args.command
    if args.script:
        script_path = args.script.resolve()
        if not script_path.is_file():
            parser.error(f"Script does not exist: {script_path}")
        # The script executes inside Blender, not inside this client process.
        params = {"code": f"import runpy\nrunpy.run_path({str(script_path)!r}, run_name='__main__')"}
        command = "execute_code"
    elif args.code:
        params = {"code": args.code}
        command = "execute_code"
    result = call(command, params, args.port, args.timeout)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("status") != "success":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
