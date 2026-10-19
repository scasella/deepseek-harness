"""SDK readers preserve continuation attribution on the existing turn event."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from deepseek_harness import DeepSeekHarness


def test_continuation_attribution_survives_results_and_notifications(tmp_path: Path) -> None:
    expected = json.loads((Path(__file__).parent / "expected" / "continuation-projection.json").read_text(encoding="utf-8"))
    script = tmp_path / "continuation_runtime.py"
    script.write_text("""
import json
import os
import sys

def notify(method, params):
    print(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}), flush=True)

for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "initialize":
        result = {"serverInfo": {"name": "continuation-fixture"}}
    elif request["method"] == "session/prompt":
        session_id = request["params"]["sessionId"]
        expected = json.loads(os.environ["CONTINUATION_EXPECTED"])
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "agent/inbox/spliced", "seq": 0, "time": 0,
            "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "receipt"}]}}})
        notify("session.status", {"sessionId": session_id, "status": "running"})
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"messageId": "receipt"}}), flush=True)
        notify("session.event", {"sessionId": session_id, "event": expected["turnStart"]})
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "assistant/message", "seq": 2, "time": 0,
            "data": {"message": {"role": "assistant", "content": [{"type": "text", "text": expected["finalResponse"]}]}}}})
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "turn/end", "seq": 3, "time": 0, "data": {"turn": 0, "reason": {"kind": "completed"}}}})
        notify("session.status", {"sessionId": session_id, "status": "idle"})
        continue
    elif request["method"] == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {}}), flush=True)
        break
    else:
        raise RuntimeError("Unexpected protocol method")
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
""".strip(), encoding="utf-8")
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)), cwd=str(tmp_path),
        env={"CONTINUATION_EXPECTED": json.dumps(expected)},
    ) as harness:
        result = harness.run("Observe the recorded turn.", session_id="continuation-projection")
    turn_start = next(event for event in result.events if event["type"] == "turn/start")
    assert {"finalResponse": result.final_response, "turnStart": turn_start} == expected
    notification = next(item for item in result.notifications
                        if item.method == "session.event" and item.payload["event"]["type"] == "turn/start")
    assert notification.payload["event"] == turn_start
