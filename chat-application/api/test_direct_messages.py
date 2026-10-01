import json
import os
import urllib.error
import urllib.request
import unittest
from uuid import uuid4

from websockets.sync.client import connect


API_URL = os.getenv("TALKIE_API_URL", "http://127.0.0.1:8001")


def request_json(path: str, payload: dict | None = None, token: str | None = None, method: str | None = None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        f"{API_URL}{path}", data=data, headers=headers,
        method=method or ("POST" if payload is not None else "GET"),
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


class DirectMessageIntegrationTest(unittest.TestCase):
    def test_friends_can_chat_privately_without_a_community(self) -> None:
        suffix = uuid4().hex
        _, first = request_json("/api/auth/register", {
            "name": "Private Chat One",
            "email": f"dm-one-{suffix}@example.com",
            "password": "TalkieTest123",
        })
        _, second = request_json("/api/auth/register", {
            "name": "Private Chat Two",
            "email": f"dm-two-{suffix}@example.com",
            "password": "TalkieTest123",
        })
        first_token = first["access_token"]
        second_token = second["access_token"]
        first_id = first["user"]["id"]
        second_id = second["user"]["id"]

        _, sent_request = request_json(
            "/api/friends/requests", {"friend_id": second_id}, first_token,
        )
        incoming_status, incoming = request_json("/api/friends", token=second_token)
        self.assertEqual(incoming_status, 200)
        request_id = incoming["incoming"][0]["request_id"]
        self.assertEqual(sent_request["status"], "pending")
        self.assertEqual(request_json(f"/api/friends/requests/{request_id}/accept", {}, second_token)[0], 200)

        create_status, conversation = request_json(
            f"/api/dms/{second_id}", token=first_token, method="POST",
        )
        self.assertEqual(create_status, 201)
        self.assertEqual(conversation["friend"]["id"], second_id)
        _, second_conversations = request_json("/api/dms", token=second_token)
        self.assertEqual(second_conversations[0]["id"], conversation["id"])

        first_ws = f"ws://127.0.0.1:8000/ws/dm/{conversation['id']}?token={first_token}"
        second_ws = f"ws://127.0.0.1:8000/ws/dm/{conversation['id']}?token={second_token}"
        with connect(first_ws, open_timeout=8) as first_socket, connect(second_ws, open_timeout=8) as second_socket:
            message_status, sent_message = request_json(
                f"/api/dms/{conversation['id']}/messages",
                {"text": "A private hello"}, first_token,
            )
            self.assertEqual(message_status, 201)
            live_message = json.loads(second_socket.recv(timeout=8))
            self.assertEqual(live_message["id"], sent_message["id"])
            self.assertEqual(live_message["text"], "A private hello")
            self.assertEqual(live_message["sender_id"], first_id)

            image_data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2ioAAAAASUVORK5CYII="
            attachment_status, attachment_message = request_json(
                f"/api/dms/{conversation['id']}/messages",
                {"text": "", "attachment_data": image_data, "attachment_name": "tiny.png"},
                first_token,
            )
            self.assertEqual(attachment_status, 201)
            live_attachment = json.loads(second_socket.recv(timeout=8))
            self.assertEqual(live_attachment["id"], attachment_message["id"])
            self.assertEqual(live_attachment["attachment_data"], image_data)
            self.assertEqual(live_attachment["attachment_name"], "tiny.png")

        _, history = request_json(
            f"/api/dms/{conversation['id']}/messages", token=second_token,
        )
        self.assertEqual(history[0]["text"], "A private hello")
        self.assertEqual(history[1]["attachment_name"], "tiny.png")


if __name__ == "__main__":
    unittest.main()