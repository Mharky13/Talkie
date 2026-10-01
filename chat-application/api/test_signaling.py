import json
import os
import unittest
import urllib.request
from uuid import uuid4

from websockets.sync.client import connect


API_URL = os.getenv("TALKIE_API_URL", "http://127.0.0.1:8001")


def request_json(path: str, payload: dict, token: str | None = None) -> dict:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{API_URL}{path}",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST" if path.endswith(("register", "communities", "members")) else "PUT",
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.loads(response.read())


class CallSignalingIntegrationTest(unittest.TestCase):
    def test_two_community_members_can_negotiate_a_call(self) -> None:
        suffix = uuid4().hex
        owner = request_json("/api/auth/register", {
            "name": "Call Owner",
            "email": f"call-owner-{suffix}@example.com",
            "password": "TalkieTest123",
        })
        peer = request_json("/api/auth/register", {
            "name": "Call Peer",
            "email": f"call-peer-{suffix}@example.com",
            "password": "TalkieTest123",
        })
        owner_token = owner["access_token"]
        peer_token = peer["access_token"]
        community = request_json(
            "/api/communities",
            {"name": f"Call test {suffix[:8]}", "description": ""},
            owner_token,
        )
        request_json(
            f"/api/communities/{community['id']}/members",
            {"email": f"call-peer-{suffix}@example.com"},
            owner_token,
        )
        channel_id = community["channels"][0]["id"]
        owner_ws = f"ws://127.0.0.1:8000/ws/{channel_id}?token={owner_token}"
        peer_ws = f"ws://127.0.0.1:8000/ws/{channel_id}?token={peer_token}"

        with connect(owner_ws, open_timeout=8) as owner_socket, connect(peer_ws, open_timeout=8) as peer_socket:
            owner_socket.send(json.dumps({"type": "call-start", "mode": "audio"}))
            started = json.loads(owner_socket.recv(timeout=8))
            incoming = json.loads(peer_socket.recv(timeout=8))
            self.assertEqual(started["type"], "call-started")
            self.assertEqual(incoming["type"], "call-start")
            self.assertEqual(incoming["from_user_id"], owner["user"]["id"])

            peer_socket.send(json.dumps({
                "type": "call-accept",
                "call_id": started["call_id"],
                "target_user_id": owner["user"]["id"],
            }))
            accepted = json.loads(owner_socket.recv(timeout=8))
            self.assertEqual(accepted["type"], "call-accept")
            self.assertEqual(accepted["from_user_id"], peer["user"]["id"])

            offer = {"type": "offer", "sdp": "test-offer"}
            owner_socket.send(json.dumps({
                "type": "call-offer",
                "call_id": started["call_id"],
                "target_user_id": peer["user"]["id"],
                "description": offer,
            }))
            received_offer = json.loads(peer_socket.recv(timeout=8))
            self.assertEqual(received_offer["type"], "call-offer")
            self.assertEqual(received_offer["description"], offer)

            peer_socket.send(json.dumps({
                "type": "call-answer",
                "call_id": started["call_id"],
                "target_user_id": owner["user"]["id"],
                "description": {"type": "answer", "sdp": "test-answer"},
            }))
            answer = json.loads(owner_socket.recv(timeout=8))
            self.assertEqual(answer["type"], "call-answer")


if __name__ == "__main__":
    unittest.main()