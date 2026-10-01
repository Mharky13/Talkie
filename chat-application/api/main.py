import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

try:
    import mysql.connector
except ImportError:  # pragma: no cover - optional dependency for MySQL deployments
    mysql = None
else:
    mysql = mysql.connector

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field


BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.getenv("TALKIE_DATABASE", BASE_DIR / "talkie.db"))
TOKEN_SECRET = os.getenv("TALKIE_TOKEN_SECRET", "local-development-secret-change-me").encode()
TOKEN_TTL = timedelta(days=7)

app = FastAPI(title="Talkie API", version="0.1.0")
allowed_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
allowed_origins.extend(
    origin.strip()
    for origin in os.getenv("TALKIE_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_database_kind() -> str:
    database_url = os.getenv("TALKIE_DATABASE_URL", "").strip()
    if not database_url:
        return "sqlite"
    return "mysql" if urlparse(database_url).scheme.startswith("mysql") else "sqlite"


def normalize_query_for_database(query: str, params, database_kind: str = "mysql"):
    if database_kind.lower() != "mysql":
        return query, params
    if params is None or isinstance(params, dict):
        return query, params
    return query.replace("?", "%s"), params


class MySQLConnectionAdapter:
    def __init__(self, connection) -> None:
        self._connection = connection

    def __getattr__(self, name):
        return getattr(self._connection, name)

    def execute(self, query: str, params=None):
        normalized_query, normalized_params = normalize_query_for_database(query, params, "mysql")
        cursor = self._connection.cursor(dictionary=True)
        cursor.execute(normalized_query, normalized_params or ())
        return cursor

    def executescript(self, script: str) -> None:
        for statement in [part.strip() for part in script.split(";") if part.strip()]:
            self.execute(statement)

    def __enter__(self):
        self._connection.__enter__()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        try:
            if exc_type is None:
                self._connection.commit()
            else:
                self._connection.rollback()
        finally:
            self._connection.close()


def parse_mysql_url(database_url: str) -> dict:
    parsed = urlparse(database_url)
    query = parse_qs(parsed.query)
    config = {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 3306,
        "user": parsed.username or "root",
        "password": parsed.password or "",
        "database": parsed.path.lstrip("/") or "talkie",
        "autocommit": False,
        "charset": query.get("charset", ["utf8mb4"])[0],
        "collation": query.get("collation", ["utf8mb4_unicode_ci"])[0],
    }
    if parsed.path.startswith("/") and config["database"] == "":
        config["database"] = "talkie"
    return config


def connect_db():
    if get_database_kind() == "mysql":
        if mysql is None:
            raise RuntimeError("MySQL support requires the mysql-connector-python package to be installed.")
        connection = mysql.connect(**parse_mysql_url(os.environ["TALKIE_DATABASE_URL"]))
        return MySQLConnectionAdapter(connection)
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def database_integrity_error():
    if get_database_kind() == "mysql":
        return mysql.IntegrityError
    return sqlite3.IntegrityError


def create_index_if_missing(connection, index_name: str, table_name: str, columns: str) -> None:
    if get_database_kind() != "mysql":
        return
    schema_name = parse_mysql_url(os.environ["TALKIE_DATABASE_URL"])["database"]
    row = connection.execute(
        "SELECT 1 FROM information_schema.statistics WHERE table_schema = %s AND table_name = %s AND index_name = %s LIMIT 1",
        (schema_name, table_name, index_name),
    ).fetchone()
    if row is None:
        connection.execute(f"CREATE INDEX `{index_name}` ON `{table_name}` ({columns})")


def initialize_database() -> None:
    if get_database_kind() == "mysql":
        with connect_db() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id VARCHAR(36) PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    email VARCHAR(255) NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    avatar_url TEXT,
                    created_at DATETIME NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS communities (
                    id VARCHAR(36) PRIMARY KEY,
                    owner_id VARCHAR(36) NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    description TEXT NOT NULL,
                    image_url TEXT,
                    created_at DATETIME NOT NULL,
                    CONSTRAINT fk_communities_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS memberships (
                    user_id VARCHAR(36) NOT NULL,
                    community_id VARCHAR(36) NOT NULL,
                    PRIMARY KEY (user_id, community_id),
                    CONSTRAINT fk_memberships_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    CONSTRAINT fk_memberships_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS friend_requests (
                    id VARCHAR(36) PRIMARY KEY,
                    sender_id VARCHAR(36) NOT NULL,
                    recipient_id VARCHAR(36) NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    created_at DATETIME NOT NULL,
                    UNIQUE (sender_id, recipient_id),
                    CONSTRAINT fk_friend_requests_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
                    CONSTRAINT fk_friend_requests_recipient FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
                    CHECK (status IN ('pending', 'accepted')),
                    CHECK (sender_id <> recipient_id)
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS direct_conversations (
                    id VARCHAR(36) PRIMARY KEY,
                    user_low_id VARCHAR(36) NOT NULL,
                    user_high_id VARCHAR(36) NOT NULL,
                    created_at DATETIME NOT NULL,
                    UNIQUE (user_low_id, user_high_id),
                    CONSTRAINT fk_direct_conversations_low FOREIGN KEY (user_low_id) REFERENCES users(id) ON DELETE CASCADE,
                    CONSTRAINT fk_direct_conversations_high FOREIGN KEY (user_high_id) REFERENCES users(id) ON DELETE CASCADE,
                    CHECK (user_low_id < user_high_id)
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS direct_messages (
                    id VARCHAR(36) PRIMARY KEY,
                    conversation_id VARCHAR(36) NOT NULL,
                    sender_id VARCHAR(36) NOT NULL,
                    text TEXT NOT NULL,
                    attachment_data TEXT,
                    attachment_name TEXT,
                    attachment_type TEXT,
                    created_at DATETIME NOT NULL,
                    CONSTRAINT fk_direct_messages_conversation FOREIGN KEY (conversation_id) REFERENCES direct_conversations(id) ON DELETE CASCADE,
                    CONSTRAINT fk_direct_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            create_index_if_missing(connection, "direct_messages_conversation_created", "direct_messages", "conversation_id, created_at")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS channels (
                    id VARCHAR(36) PRIMARY KEY,
                    community_id VARCHAR(36) NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    category VARCHAR(255) NOT NULL DEFAULT 'TEXT CHANNELS',
                    created_at DATETIME NOT NULL,
                    UNIQUE (community_id, name),
                    CONSTRAINT fk_channels_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id VARCHAR(36) PRIMARY KEY,
                    channel_id VARCHAR(36) NOT NULL,
                    user_id VARCHAR(36) NOT NULL,
                    text TEXT NOT NULL,
                    created_at DATETIME NOT NULL,
                    CONSTRAINT fk_messages_channel FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
                    CONSTRAINT fk_messages_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
                """
            )
            create_index_if_missing(connection, "messages_channel_created", "messages", "channel_id, created_at")
            columns = [row["Field"] for row in connection.execute("SHOW COLUMNS FROM users")]
            if "avatar_url" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT")
            direct_message_columns = [row["Field"] for row in connection.execute("SHOW COLUMNS FROM direct_messages")]
            for column_name in ("attachment_data", "attachment_name", "attachment_type"):
                if column_name not in direct_message_columns:
                    connection.execute(f"ALTER TABLE direct_messages ADD COLUMN {column_name} TEXT")
        return

    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect_db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                avatar_url TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS communities (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                image_url TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memberships (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, community_id)
            );
            CREATE TABLE IF NOT EXISTS friend_requests (
                id TEXT PRIMARY KEY,
                sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
                created_at TEXT NOT NULL,
                UNIQUE (sender_id, recipient_id),
                CHECK (sender_id != recipient_id)
            );
            CREATE TABLE IF NOT EXISTS direct_conversations (
                id TEXT PRIMARY KEY,
                user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                UNIQUE (user_low_id, user_high_id),
                CHECK (user_low_id < user_high_id)
            );
            CREATE TABLE IF NOT EXISTS direct_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
                sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                attachment_data TEXT,
                attachment_name TEXT,
                attachment_type TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS direct_messages_conversation_created ON direct_messages(conversation_id, created_at);
            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'TEXT CHANNELS',
                created_at TEXT NOT NULL,
                UNIQUE (community_id, name)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS messages_channel_created ON messages(channel_id, created_at);
            """
        )
        user_columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
        if "avatar_url" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT")
        direct_message_columns = {row["name"] for row in connection.execute("PRAGMA table_info(direct_messages)")}
        for column_name, column_type in (
            ("attachment_data", "TEXT"),
            ("attachment_name", "TEXT"),
            ("attachment_type", "TEXT"),
        ):
            if column_name not in direct_message_columns:
                connection.execute(f"ALTER TABLE direct_messages ADD COLUMN {column_name} {column_type}")


@app.on_event("startup")
def startup() -> None:
    initialize_database()


def encode_part(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def decode_part(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def make_token(user_id: str) -> str:
    payload = encode_part(json.dumps({
        "sub": user_id,
        "exp": int((datetime.now(timezone.utc) + TOKEN_TTL).timestamp()),
    }).encode())
    signature = encode_part(hmac.new(TOKEN_SECRET, payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}"


def user_id_from_token(token: str) -> str:
    try:
        payload, signature = token.split(".", 1)
        expected = encode_part(hmac.new(TOKEN_SECRET, payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("Invalid token signature")
        claims = json.loads(decode_part(payload))
        if claims["exp"] < int(datetime.now(timezone.utc).timestamp()):
            raise ValueError("Expired token")
        return claims["sub"]
    except (ValueError, KeyError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=401, detail="Your session is invalid or expired. Please sign in again.") from error


def current_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    user_id = user_id_from_token(authorization[7:].strip())
    with connect_db() as connection:
        user = connection.execute("SELECT id, name, email, avatar_url FROM users WHERE id = ?", (user_id,)).fetchone()
    if user is None:
        raise HTTPException(status_code=401, detail="Account not found.")
    return dict(user)


CurrentUser = Annotated[dict, Depends(current_user)]


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"{encode_part(salt)}.{encode_part(digest)}"


def password_matches(password: str, stored_hash: str) -> bool:
    try:
        salt_part, digest_part = stored_hash.split(".", 1)
        salt = decode_part(salt_part)
        expected = decode_part(digest_part)
    except ValueError:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return hmac.compare_digest(actual, expected)


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class CommunityRequest(BaseModel):
    name: str = Field(min_length=2, max_length=50)
    description: str = Field(default="", max_length=180)
    image_data: str | None = Field(default=None, max_length=2_800_000)


class InviteRequest(BaseModel):
    email: EmailStr


class FriendRequestCreate(BaseModel):
    friend_id: str = Field(min_length=36, max_length=36)


class ChannelRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50, pattern=r"^[a-z0-9][a-z0-9-]*$")


class MessageRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class DirectMessageRequest(BaseModel):
    text: str = Field(default="", max_length=4000)
    attachment_data: str | None = Field(default=None, max_length=2_800_000)
    attachment_name: str | None = Field(default=None, max_length=120)


class ProfileUpdateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class ProfilePictureRequest(BaseModel):
    image_data: str | None = Field(default=None, max_length=2_800_000)


class ConnectionManager:
    def __init__(self) -> None:
        self.channels: dict[str, dict[WebSocket, str]] = {}

    async def connect(self, channel_id: str, socket: WebSocket, user_id: str) -> None:
        await socket.accept()
        self.channels.setdefault(channel_id, {})[socket] = user_id

    def disconnect(self, channel_id: str, socket: WebSocket) -> None:
        sockets = self.channels.get(channel_id)
        if sockets is not None:
            sockets.pop(socket, None)
            if not sockets:
                self.channels.pop(channel_id, None)

    async def broadcast(
        self,
        channel_id: str,
        message: dict,
        exclude_user_id: str | None = None,
        target_user_id: str | None = None,
        also_exclude_user_id: str | None = None,
    ) -> None:
        sockets = list(self.channels.get(channel_id, {}).items())
        for socket, user_id in sockets:
            if user_id in {exclude_user_id, also_exclude_user_id} or (target_user_id and target_user_id != user_id):
                continue
            try:
                await socket.send_json(message)
            except Exception:
                self.disconnect(channel_id, socket)


manager = ConnectionManager()


def user_payload(user: dict) -> dict:
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "avatar_url": user.get("avatar_url"),
    }


def auth_response(user: dict) -> dict:
    return {"access_token": make_token(user["id"]), "token_type": "bearer", "user": user_payload(user)}


def get_community(connection: sqlite3.Connection, community_id: str, user_id: str) -> dict:
    community = connection.execute(
        "SELECT id, owner_id, name, description, image_url FROM communities WHERE id = ?",
        (community_id,),
    ).fetchone()
    if community is None:
        raise HTTPException(status_code=404, detail="Community not found.")
    membership = connection.execute(
        "SELECT 1 FROM memberships WHERE user_id = ? AND community_id = ?",
        (user_id, community_id),
    ).fetchone()
    if membership is None:
        raise HTTPException(status_code=403, detail="You are not a member of this community.")
    channels = connection.execute(
        "SELECT id, name, category FROM channels WHERE community_id = ? ORDER BY created_at, name",
        (community_id,),
    ).fetchall()
    members = connection.execute(
        "SELECT users.id, users.name, users.avatar_url FROM users JOIN memberships ON users.id = memberships.user_id WHERE memberships.community_id = ? ORDER BY users.name",
        (community_id,),
    ).fetchall()
    palette = ["coral", "blue", "green"]
    return {
        "id": community["id"],
        "owner_id": community["owner_id"],
        "name": community["name"],
        "description": community["description"],
        "image_url": community["image_url"],
        "initials": community["name"][:1].upper(),
        "color": palette[sum(community["name"].encode()) % len(palette)],
        "channels": [dict(channel) for channel in channels],
        "members": [
            {"id": member["id"], "name": member["name"], "avatar": member["name"][:2].upper(), "avatar_url": member["avatar_url"], "color": "yellow" if member["id"] == user_id else "mint", "status": "Online"}
            for member in members
        ],
    }


def message_payload(row: sqlite3.Row) -> dict:
    created_at = datetime.fromisoformat(row["created_at"])
    return {
        "id": row["id"],
        "author": row["name"],
        "avatar": row["name"][:2].upper(),
        "avatar_url": row["avatar_url"],
        "color": "yellow",
        "time": created_at.astimezone().strftime("%I:%M %p").lstrip("0"),
        "text": row["text"],
        "reactions": [],
    }


def require_channel_member(connection: sqlite3.Connection, channel_id: str, user_id: str) -> sqlite3.Row:
    channel = connection.execute(
        "SELECT channels.id, channels.community_id FROM channels WHERE channels.id = ?",
        (channel_id,),
    ).fetchone()
    if channel is None:
        raise HTTPException(status_code=404, detail="Channel not found.")
    membership = connection.execute(
        "SELECT 1 FROM memberships WHERE user_id = ? AND community_id = ?",
        (user_id, channel["community_id"]),
    ).fetchone()
    if membership is None:
        raise HTTPException(status_code=403, detail="You cannot access this channel.")
    return channel


def require_direct_conversation(
    connection: sqlite3.Connection, conversation_id: str, user_id: str
) -> sqlite3.Row:
    conversation = connection.execute(
        "SELECT * FROM direct_conversations WHERE id = ?", (conversation_id,)
    ).fetchone()
    if conversation is None:
        raise HTTPException(status_code=404, detail="Direct conversation not found.")
    if user_id not in {conversation["user_low_id"], conversation["user_high_id"]}:
        raise HTTPException(status_code=403, detail="You cannot access this conversation.")
    return conversation


def direct_conversation_payload(
    connection: sqlite3.Connection, conversation_id: str, user_id: str
) -> dict:
    conversation = require_direct_conversation(connection, conversation_id, user_id)
    friend_id = conversation["user_high_id"] if conversation["user_low_id"] == user_id else conversation["user_low_id"]
    friend = connection.execute(
        "SELECT id, name, avatar_url FROM users WHERE id = ?", (friend_id,)
    ).fetchone()
    latest = connection.execute(
        "SELECT text, attachment_data, created_at, sender_id FROM direct_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
        (conversation_id,),
    ).fetchone()
    last_message = None
    if latest:
        last_message = {
            "text": latest["text"] or ("Photo attachment" if latest["attachment_data"] else ""),
            "time": datetime.fromisoformat(latest["created_at"]).astimezone().strftime("%I:%M %p").lstrip("0"),
            "from_me": latest["sender_id"] == user_id,
        }
    return {
        "id": conversation_id,
        "friend": dict(friend),
        "last_message": last_message,
    }


def direct_message_payload(row: sqlite3.Row) -> dict:
    created_at = datetime.fromisoformat(row["created_at"])
    return {
        "id": row["id"],
        "sender_id": row["sender_id"],
        "author": row["name"],
        "avatar_url": row["avatar_url"],
        "avatar": row["name"][:2].upper(),
        "text": row["text"],
        "attachment_data": row["attachment_data"],
        "attachment_name": row["attachment_name"],
        "attachment_type": row["attachment_type"],
        "time": created_at.astimezone().strftime("%I:%M %p").lstrip("0"),
    }


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/auth/register", status_code=201)
def register(request: RegisterRequest) -> dict:
    user_id = str(uuid4())
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name cannot be blank.")
    try:
        with connect_db() as connection:
            connection.execute(
                "INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (user_id, name, request.email.lower(), hash_password(request.password), datetime.now(timezone.utc).isoformat()),
            )
    except database_integrity_error() as error:
        raise HTTPException(status_code=409, detail="An account with that email already exists.") from error
    return auth_response({"id": user_id, "name": name, "email": request.email.lower()})


@app.post("/api/auth/login")
def login(request: LoginRequest) -> dict:
    with connect_db() as connection:
        user = connection.execute(
            "SELECT id, name, email, password_hash, avatar_url FROM users WHERE LOWER(email) = LOWER(?)",
            (request.email,),
        ).fetchone()
    if user is None or not password_matches(request.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    return auth_response(dict(user))


@app.get("/api/me")
def me(user: CurrentUser) -> dict:
    return user_payload(user)


@app.put("/api/me")
def update_profile(request: ProfileUpdateRequest, user: CurrentUser) -> dict:
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Display name cannot be blank.")
    with connect_db() as connection:
        connection.execute("UPDATE users SET name = ? WHERE id = ?", (name, user["id"]))
        updated_user = connection.execute(
            "SELECT id, name, email, avatar_url FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
    return user_payload(dict(updated_user))


@app.put("/api/me/profile-picture")
def update_profile_picture(request: ProfilePictureRequest, user: CurrentUser) -> dict:
    image_data = request.image_data
    if image_data is not None:
        header, separator, encoded_image = image_data.partition(",")
        allowed_headers = {"data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"}
        if not separator or header not in allowed_headers:
            raise HTTPException(status_code=415, detail="Choose a PNG, JPEG, or WebP image.")
        try:
            image_bytes = base64.b64decode(encoded_image, validate=True)
        except (binascii.Error, ValueError) as error:
            raise HTTPException(status_code=400, detail="That image file could not be read.") from error
        if not image_bytes or len(image_bytes) > 2_000_000:
            raise HTTPException(status_code=413, detail="Profile pictures must be smaller than 2 MB.")
    with connect_db() as connection:
        connection.execute("UPDATE users SET avatar_url = ? WHERE id = ?", (image_data, user["id"]))
        updated_user = connection.execute(
            "SELECT id, name, email, avatar_url FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
    return user_payload(dict(updated_user))


@app.get("/api/friends")
def list_friends(user: CurrentUser) -> dict:
    with connect_db() as connection:
        friends = connection.execute(
            """
            SELECT users.id, users.name, users.avatar_url
            FROM friend_requests
            JOIN users ON users.id = CASE
                WHEN friend_requests.sender_id = ? THEN friend_requests.recipient_id
                ELSE friend_requests.sender_id
            END
            WHERE friend_requests.status = 'accepted'
              AND (friend_requests.sender_id = ? OR friend_requests.recipient_id = ?)
            ORDER BY LOWER(users.name)
            """,
            (user["id"], user["id"], user["id"]),
        ).fetchall()
        incoming = connection.execute(
            """
            SELECT friend_requests.id AS request_id, users.id, users.name, users.avatar_url
            FROM friend_requests JOIN users ON users.id = friend_requests.sender_id
            WHERE friend_requests.recipient_id = ? AND friend_requests.status = 'pending'
            ORDER BY friend_requests.created_at
            """,
            (user["id"],),
        ).fetchall()
        outgoing = connection.execute(
            """
            SELECT friend_requests.id AS request_id, users.id, users.name, users.avatar_url
            FROM friend_requests JOIN users ON users.id = friend_requests.recipient_id
            WHERE friend_requests.sender_id = ? AND friend_requests.status = 'pending'
            ORDER BY friend_requests.created_at
            """,
            (user["id"],),
        ).fetchall()
    return {
        "friends": [dict(friend) for friend in friends],
        "incoming": [dict(request) for request in incoming],
        "outgoing": [dict(request) for request in outgoing],
    }


@app.post("/api/friends/requests", status_code=201)
def create_friend_request(request: FriendRequestCreate, user: CurrentUser) -> dict:
    try:
        friend_id = str(UUID(request.friend_id))
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Enter a valid Talkie user ID.") from error
    if friend_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot add yourself as a friend.")
    with connect_db() as connection:
        friend = connection.execute(
            "SELECT id, name, avatar_url FROM users WHERE id = ?", (friend_id,)
        ).fetchone()
        if friend is None:
            raise HTTPException(status_code=404, detail="No Talkie account was found with that ID.")
        existing = connection.execute(
            "SELECT id, sender_id, recipient_id, status FROM friend_requests WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)",
            (user["id"], friend_id, friend_id, user["id"]),
        ).fetchone()
        if existing:
            if existing["status"] == "accepted":
                raise HTTPException(status_code=409, detail="You are already friends.")
            if existing["sender_id"] == user["id"]:
                raise HTTPException(status_code=409, detail="Your friend request is already pending.")
            connection.execute(
                "UPDATE friend_requests SET status = 'accepted' WHERE id = ?", (existing["id"],)
            )
            return {"status": "accepted", "friend": dict(friend)}
        request_id = str(uuid4())
        connection.execute(
            "INSERT INTO friend_requests (id, sender_id, recipient_id, created_at) VALUES (?, ?, ?, ?)",
            (request_id, user["id"], friend_id, datetime.now(timezone.utc).isoformat()),
        )
    return {"status": "pending", "request_id": request_id, "friend": dict(friend)}


@app.post("/api/friends/requests/{request_id}/accept")
def accept_friend_request(request_id: str, user: CurrentUser) -> dict:
    with connect_db() as connection:
        request = connection.execute(
            "SELECT id, sender_id, recipient_id, status FROM friend_requests WHERE id = ?",
            (request_id,),
        ).fetchone()
        if request is None:
            raise HTTPException(status_code=404, detail="Friend request not found.")
        if request["recipient_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="Only the recipient can accept this request.")
        if request["status"] != "pending":
            raise HTTPException(status_code=409, detail="This friend request was already handled.")
        connection.execute(
            "UPDATE friend_requests SET status = 'accepted' WHERE id = ?", (request_id,)
        )
        friend = connection.execute(
            "SELECT id, name, avatar_url FROM users WHERE id = ?", (request["sender_id"],)
        ).fetchone()
    return {"status": "accepted", "friend": dict(friend)}


@app.get("/api/dms")
def list_direct_conversations(user: CurrentUser) -> list[dict]:
    with connect_db() as connection:
        rows = connection.execute(
            """
            SELECT direct_conversations.id
            FROM direct_conversations
            WHERE direct_conversations.user_low_id = ? OR direct_conversations.user_high_id = ?
            ORDER BY COALESCE(
                (SELECT created_at FROM direct_messages WHERE conversation_id = direct_conversations.id ORDER BY created_at DESC LIMIT 1),
                direct_conversations.created_at
            ) DESC
            """,
            (user["id"], user["id"]),
        ).fetchall()
        return [direct_conversation_payload(connection, row["id"], user["id"]) for row in rows]


@app.post("/api/dms/{friend_id}", status_code=201)
def open_direct_conversation(friend_id: str, user: CurrentUser) -> dict:
    try:
        friend_id = str(UUID(friend_id))
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Enter a valid Talkie user ID.") from error
    if friend_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot start a conversation with yourself.")
    user_low_id, user_high_id = sorted((user["id"], friend_id))
    with connect_db() as connection:
        friend = connection.execute(
            "SELECT id FROM users WHERE id = ?", (friend_id,)
        ).fetchone()
        if friend is None:
            raise HTTPException(status_code=404, detail="Talkie user not found.")
        friendship = connection.execute(
            "SELECT 1 FROM friend_requests WHERE status = 'accepted' AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))",
            (user["id"], friend_id, friend_id, user["id"]),
        ).fetchone()
        if friendship is None:
            raise HTTPException(status_code=403, detail="Add this person as a friend before messaging them.")
        connection.execute(
            "INSERT IGNORE INTO direct_conversations (id, user_low_id, user_high_id, created_at) VALUES (?, ?, ?, ?)",
            (str(uuid4()), user_low_id, user_high_id, datetime.now(timezone.utc).isoformat()),
        )
        conversation = connection.execute(
            "SELECT id FROM direct_conversations WHERE user_low_id = ? AND user_high_id = ?",
            (user_low_id, user_high_id),
        ).fetchone()
        return direct_conversation_payload(connection, conversation["id"], user["id"])


@app.get("/api/dms/{conversation_id}/messages")
def list_direct_messages(conversation_id: str, user: CurrentUser) -> list[dict]:
    with connect_db() as connection:
        require_direct_conversation(connection, conversation_id, user["id"])
        rows = connection.execute(
            "SELECT direct_messages.id, direct_messages.sender_id, direct_messages.text, direct_messages.attachment_data, direct_messages.attachment_name, direct_messages.attachment_type, direct_messages.created_at, users.name, users.avatar_url FROM direct_messages JOIN users ON users.id = direct_messages.sender_id WHERE direct_messages.conversation_id = ? ORDER BY direct_messages.created_at LIMIT 300",
            (conversation_id,),
        ).fetchall()
    return [direct_message_payload(row) for row in rows]


@app.post("/api/dms/{conversation_id}/messages", status_code=201)
async def create_direct_message(
    conversation_id: str, request: DirectMessageRequest, user: CurrentUser
) -> dict:
    text = request.text.strip()
    attachment_data = request.attachment_data
    attachment_type = None
    if attachment_data:
        header, separator, encoded_data = attachment_data.partition(",")
        allowed_types = {
            "data:image/png;base64": "image/png",
            "data:image/jpeg;base64": "image/jpeg",
            "data:image/webp;base64": "image/webp",
        }
        attachment_type = allowed_types.get(header)
        if not separator or attachment_type is None:
            raise HTTPException(status_code=415, detail="Choose a PNG, JPEG, or WebP image.")
        try:
            attachment_bytes = base64.b64decode(encoded_data, validate=True)
        except (binascii.Error, ValueError) as error:
            raise HTTPException(status_code=400, detail="That attachment could not be read.") from error
        if not attachment_bytes or len(attachment_bytes) > 2_000_000:
            raise HTTPException(status_code=413, detail="Attachments must be smaller than 2 MB.")
    elif request.attachment_name:
        raise HTTPException(status_code=422, detail="Attachment data is required.")
    if not text and not attachment_data:
        raise HTTPException(status_code=422, detail="Add a message or an image attachment.")
    message_id = str(uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    with connect_db() as connection:
        require_direct_conversation(connection, conversation_id, user["id"])
        connection.execute(
            "INSERT INTO direct_messages (id, conversation_id, sender_id, text, attachment_data, attachment_name, attachment_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (message_id, conversation_id, user["id"], text, attachment_data, request.attachment_name if attachment_data else None, attachment_type, created_at),
        )
        row = connection.execute(
            "SELECT direct_messages.id, direct_messages.sender_id, direct_messages.text, direct_messages.attachment_data, direct_messages.attachment_name, direct_messages.attachment_type, direct_messages.created_at, users.name, users.avatar_url FROM direct_messages JOIN users ON users.id = direct_messages.sender_id WHERE direct_messages.id = ?",
            (message_id,),
        ).fetchone()
    payload = direct_message_payload(row)
    await manager.broadcast(f"dm:{conversation_id}", payload)
    return payload


@app.get("/api/communities")
def list_communities(user: CurrentUser) -> list[dict]:
    with connect_db() as connection:
        rows = connection.execute(
            "SELECT communities.id FROM communities JOIN memberships ON memberships.community_id = communities.id WHERE memberships.user_id = ? ORDER BY communities.created_at DESC",
            (user["id"],),
        ).fetchall()
        return [get_community(connection, row["id"], user["id"]) for row in rows]


@app.post("/api/communities", status_code=201)
def create_community(request: CommunityRequest, user: CurrentUser) -> dict:
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Community name cannot be blank.")
    image_data = request.image_data
    if image_data is not None:
        header, separator, encoded_image = image_data.partition(",")
        allowed_headers = {"data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"}
        if not separator or header not in allowed_headers:
            raise HTTPException(status_code=415, detail="Choose a PNG, JPEG, or WebP image.")
        try:
            image_bytes = base64.b64decode(encoded_image, validate=True)
        except (binascii.Error, ValueError) as error:
            raise HTTPException(status_code=400, detail="That image file could not be read.") from error
        if not image_bytes or len(image_bytes) > 2_000_000:
            raise HTTPException(status_code=413, detail="Community pictures must be smaller than 2 MB.")
    community_id = str(uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with connect_db() as connection:
        connection.execute(
            "INSERT INTO communities (id, owner_id, name, description, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (community_id, user["id"], name, request.description.strip(), image_data, now),
        )
        connection.execute("INSERT INTO memberships (user_id, community_id) VALUES (?, ?)", (user["id"], community_id))
        connection.execute(
            "INSERT INTO channels (id, community_id, name, category, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid4()), community_id, "general", "TEXT CHANNELS", now),
        )
        return get_community(connection, community_id, user["id"])


@app.post("/api/communities/{community_id}/channels", status_code=201)
def create_channel(community_id: str, request: ChannelRequest, user: CurrentUser) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    channel_id = str(uuid4())
    with connect_db() as connection:
        community = get_community(connection, community_id, user["id"])
        if community["owner_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="Only the community owner can add channels.")
        try:
            connection.execute(
                "INSERT INTO channels (id, community_id, name, category, created_at) VALUES (?, ?, ?, ?, ?)",
                (channel_id, community_id, request.name, "TEXT CHANNELS", now),
            )
        except database_integrity_error() as error:
            raise HTTPException(status_code=409, detail="That channel already exists.") from error
    return {"id": channel_id, "name": request.name, "category": "TEXT CHANNELS"}


@app.post("/api/communities/{community_id}/members", status_code=201)
def invite_member(community_id: str, request: InviteRequest, user: CurrentUser) -> dict:
    with connect_db() as connection:
        community = get_community(connection, community_id, user["id"])
        if community["owner_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="Only the community owner can invite members.")
        invited_user = connection.execute(
            "SELECT id FROM users WHERE LOWER(email) = LOWER(?)", (request.email,)
        ).fetchone()
        if invited_user is None:
            raise HTTPException(status_code=404, detail="That email does not have a Talkie account yet.")
        try:
            connection.execute(
                "INSERT INTO memberships (user_id, community_id) VALUES (?, ?)",
                (invited_user["id"], community_id),
            )
        except database_integrity_error() as error:
            raise HTTPException(status_code=409, detail="That person is already in this community.") from error
        return get_community(connection, community_id, user["id"])


@app.get("/api/channels/{channel_id}/messages")
def list_messages(channel_id: str, user: CurrentUser) -> list[dict]:
    with connect_db() as connection:
        require_channel_member(connection, channel_id, user["id"])
        rows = connection.execute(
            "SELECT messages.id, messages.text, messages.created_at, users.name, users.avatar_url FROM messages JOIN users ON users.id = messages.user_id WHERE messages.channel_id = ? ORDER BY messages.created_at LIMIT 200",
            (channel_id,),
        ).fetchall()
    return [message_payload(row) for row in rows]


@app.post("/api/channels/{channel_id}/messages", status_code=201)
async def create_message(channel_id: str, request: MessageRequest, user: CurrentUser) -> dict:
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Message cannot be blank.")
    message_id = str(uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    with connect_db() as connection:
        require_channel_member(connection, channel_id, user["id"])
        connection.execute(
            "INSERT INTO messages (id, channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
            (message_id, channel_id, user["id"], text, created_at),
        )
        row = connection.execute(
            "SELECT messages.id, messages.text, messages.created_at, users.name, users.avatar_url FROM messages JOIN users ON users.id = messages.user_id WHERE messages.id = ?",
            (message_id,),
        ).fetchone()
    payload = message_payload(row)
    await manager.broadcast(channel_id, payload)
    return payload


@app.websocket("/ws/{channel_id}")
async def channel_socket(websocket: WebSocket, channel_id: str, token: str = "") -> None:
    try:
        user_id = user_id_from_token(token)
        with connect_db() as connection:
            require_channel_member(connection, channel_id, user_id)
            user = connection.execute(
                "SELECT id, name, avatar_url FROM users WHERE id = ?", (user_id,)
            ).fetchone()
    except HTTPException:
        await websocket.close(code=1008)
        return
    await manager.connect(channel_id, websocket, user_id)
    try:
        while True:
            raw_event = await websocket.receive_text()
            if len(raw_event) > 64_000:
                await websocket.close(code=1009)
                break
            try:
                event = json.loads(raw_event)
            except json.JSONDecodeError:
                continue
            event_type = event.get("type") if isinstance(event, dict) else None
            if event_type == "call-start":
                if event.get("mode") not in {"audio", "video"}:
                    continue
                call_id = str(uuid4())
                await websocket.send_json({"type": "call-started", "call_id": call_id})
                await manager.broadcast(
                    channel_id,
                    {
                        "type": "call-start",
                        "call_id": call_id,
                        "mode": event["mode"],
                        "from_user_id": user_id,
                        "from_name": user["name"],
                        "from_avatar_url": user["avatar_url"],
                    },
                    exclude_user_id=user_id,
                )
                continue
            if event_type not in {
                "call-accept", "call-decline", "call-offer", "call-answer", "call-ice", "call-end"
            }:
                continue
            target_user_id = event.get("target_user_id")
            signal = {
                key: event[key]
                for key in ("type", "call_id", "description", "candidate")
                if key in event
            }
            signal["from_user_id"] = user_id
            signal["from_name"] = user["name"]
            signal["from_avatar_url"] = user["avatar_url"]
            if event_type == "call-end" and not target_user_id:
                await manager.broadcast(channel_id, signal, exclude_user_id=user_id)
            elif target_user_id:
                await manager.broadcast(
                    channel_id,
                    signal,
                    exclude_user_id=user_id,
                    target_user_id=target_user_id,
                )
                if event_type == "call-accept":
                    await manager.broadcast(
                        channel_id,
                        {"type": "call-taken", "call_id": event.get("call_id"), "from_user_id": user_id},
                        exclude_user_id=user_id,
                        also_exclude_user_id=target_user_id,
                    )
    except WebSocketDisconnect:
        manager.disconnect(channel_id, websocket)


@app.websocket("/ws/dm/{conversation_id}")
async def direct_message_socket(websocket: WebSocket, conversation_id: str, token: str = "") -> None:
    try:
        user_id = user_id_from_token(token)
        with connect_db() as connection:
            require_direct_conversation(connection, conversation_id, user_id)
    except HTTPException:
        await websocket.close(code=1008)
        return
    socket_group = f"dm:{conversation_id}"
    await manager.connect(socket_group, websocket, user_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(socket_group, websocket)
