import json
import os
import urllib.error
import urllib.request
import unittest
from uuid import uuid4


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


class FriendRequestIntegrationTest(unittest.TestCase):
    def test_users_add_each_other_by_unique_id(self) -> None:
        suffix = uuid4().hex
        _, first = request_json("/api/auth/register", {
            "name": "First Friend",
            "email": f"first-{suffix}@example.com",
            "password": "TalkieTest123",
        })
        _, second = request_json("/api/auth/register", {
            "name": "Second Friend",
            "email": f"second-{suffix}@example.com",
            "password": "TalkieTest123",
        })
        first_token = first["access_token"]
        second_token = second["access_token"]
        first_id = first["user"]["id"]
        second_id = second["user"]["id"]
        self.assertNotEqual(first_id, second_id)

        status, sent = request_json(
            "/api/friends/requests", {"friend_id": second_id}, first_token,
        )
        self.assertEqual(status, 201)
        self.assertEqual(sent["status"], "pending")

        _, first_lists = request_json("/api/friends", token=first_token)
        _, second_lists = request_json("/api/friends", token=second_token)
        self.assertEqual(first_lists["outgoing"][0]["id"], second_id)
        self.assertEqual(second_lists["incoming"][0]["id"], first_id)

        request_id = second_lists["incoming"][0]["request_id"]
        accepted_status, accepted = request_json(
            f"/api/friends/requests/{request_id}/accept", {}, second_token,
        )
        self.assertEqual(accepted_status, 200)
        self.assertEqual(accepted["friend"]["id"], first_id)

        _, first_lists = request_json("/api/friends", token=first_token)
        _, second_lists = request_json("/api/friends", token=second_token)
        self.assertEqual(first_lists["friends"][0]["id"], second_id)
        self.assertEqual(second_lists["friends"][0]["id"], first_id)

        duplicate_status, _ = request_json(
            "/api/friends/requests", {"friend_id": second_id}, first_token,
        )
        self.assertEqual(duplicate_status, 409)


if __name__ == "__main__":
    unittest.main()