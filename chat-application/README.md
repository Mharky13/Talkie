# Talkie

Talkie is a React chat client with a FastAPI backend. Users start with no communities, create their own, and invite other existing Talkie accounts.

## Run locally

Install the frontend and backend dependencies once:

```sh
npm install
python -m pip install -r requirements.txt
```

Start the API in one terminal:

```sh
python -m uvicorn api.main:app --reload --host 127.0.0.1 --port 8001
```

To use MySQL instead of the local SQLite file, set a MySQL connection URL before starting the API. Keep the real URL private and do not commit it:

```powershell
$env:TALKIE_DATABASE_URL = "mysql://USER:PASSWORD@HOST:3306/DATABASE"
```

The app switches to MySQL when this variable is set. If it is unset, it uses the local SQLite database at `api/talkie.db`.

Start the React app in another terminal:

```sh
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. The frontend defaults to the API at `http://localhost:8001`; set `VITE_API_URL` before starting Vite to use another API URL. The SQLite database is created at `api/talkie.db` on the first API startup. Set `TALKIE_TOKEN_SECRET` to a private random value before deploying anywhere shared, and set `TALKIE_ALLOWED_ORIGINS` to the comma-separated frontend origins allowed to call the API.

## Deploying the frontend

Netlify hosts the Vite frontend, but the FastAPI service and MySQL database must be hosted separately. In Netlify, set the base directory to `chat-application` when the repository root is `Talkie`, the build command to `npm run build`, and the publish directory to `dist`. Set the `VITE_API_URL` environment variable to the public FastAPI URL. Set `TALKIE_DATABASE_URL`, `TALKIE_TOKEN_SECRET`, and `TALKIE_ALLOWED_ORIGINS` on the API host; use the Netlify site URL in `TALKIE_ALLOWED_ORIGINS`. Never use `localhost` as the production API or database host.

## Using Talkie

1. Register an account or sign in.
2. Open **Communities** and create a space. Each new space starts with a `general` text channel and is private to its owner and invited members.
3. Use **Invite people** in the channel list to add an existing Talkie account by email.
4. Add friends from the **Friends** page using their unique Talkie ID. Find and copy your ID in **Settings**; incoming requests appear on the notification bell.
5. Use the phone or camera button in a channel to start a one-to-one audio or video call. The other member must be online in the same channel and accept the call.
6. Set or remove a profile picture in **Settings**. PNG, JPEG, and WebP files up to 2 MB are supported.

Calls use browser WebRTC and a public STUN server. Microphone/camera permission is required; some restrictive networks need a TURN relay server, which is not configured in this local prototype.

## Check friend and call flows

With the API running, run the two-member signaling integration test:

```sh
python -m unittest api.test_friends api.test_signaling -v
```

The tests create temporary accounts and exercise friend requests and call signaling in the local database.