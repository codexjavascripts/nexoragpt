# NEXORAGPT

A self-hosted AI chat and image workspace powered by [AI Horde](https://aihorde.net/). The project includes the browser app, a Node.js backend, a local SQLite database, account and session handling, real email verification, conversation history, image generation, file analysis, plugins, and a Windows setup flow.

## Quick start on Windows

1. Install **Node.js 22.13 or later** from [nodejs.org](https://nodejs.org/).
2. Extract this ZIP to a folder you can write to.
3. Double-click `setup.bat`. It installs the mail and document-reading packages and creates `.env` from `.env.example`.
4. Open `.env` in Notepad and configure the settings below. Real account registration requires working SMTP settings.
5. Double-click `start.bat`, then open [http://localhost:3000](http://localhost:3000).
6. Create an account. NEXORAGPT sends a six-digit code to your email; enter it to verify the address.

To stop the local server, press **Ctrl+C** in its console window. Start it again with `start.bat`.

## Configuration

### Required before registration: email delivery

Set these fields in `.env` using your mail provider's SMTP settings:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
SMTP_FROM=NEXORAGPT <no-reply@your-domain.example>
```

For port 465, set `SMTP_SECURE=true`. Many email providers require an app password or a verified sender address. Credentials stay in the backend `.env` file. Registration reports a failure if delivery fails; the app does not claim a code was sent.

### AI Horde

The default API key `0000000000` uses anonymous access. It is free to try, but anonymous work has lower priority, shared rate limits, and may wait longer or be rejected when the public queue is busy. An AI Horde account key can be set in `AI_HORDE_API_KEY` to use your own account. Free access does not mean unlimited capacity. Image generation depends on available volunteer workers and may take time.

The chat API uses AI Horde's [OpenAI-compatible chat front](https://haidra-org.github.io/AI-Horde/how-to/send_chat_completions/). Image requests use the [AI Horde v2 asynchronous generation flow](https://github.com/Haidra-Org/AI-Horde/blob/main/README_integration.md). Available chat models are fetched from AI Horde and can be selected in Settings. To replace the chat endpoint with another OpenAI-compatible provider, set `AI_CHAT_BASE_URL` and `AI_CHAT_API_KEY`; image generation continues to use AI Horde.

### Optional plugin: Translator

Set `LIBRETRANSLATE_URL` to a LibreTranslate-compatible service URL. Set `LIBRETRANSLATE_API_KEY` if that service requires a key. The Translator plugin stays unavailable until configured.

### Local deployment settings

Change `SESSION_SECRET` to a unique long random string before exposing this server beyond your own computer. If changing `PORT`, also update `APP_ORIGIN` to the full URL and port. `DATA_DIR` is where the SQLite database and private uploads/generated images are stored.

## What is included

- **AI chat:** real AI Horde model responses, conversation context, saved chats, search, rename, delete, copy, retry/regenerate, model selection, loading states, and readable errors.
- **Email accounts:** six-digit verification and reset codes expire after 10 minutes. Resend and login attempts are rate-limited. Passwords use scrypt hashing, and sessions are random HTTP-only cookies.
- **Image studio:** submit real AI Horde image jobs in square, landscape, portrait, or wide dimensions, choose a prompt style, see queue status, save results locally, revisit history, and download completed images.
- **File analysis:** attach images (up to 5 MB for AI Horde), PDF, Word `.docx`, text, Markdown, CSV, and JSON files (up to 8 MB). Text is extracted locally; text and images are sent to AI Horde when included in a chat request.
- **Plugins:** calculator runs locally; Weather uses Open-Meteo; Web search uses DuckDuckGo Instant Answers; Summarizer uses AI Horde; Translator uses a configured LibreTranslate server. File and code helpers open the relevant built-in feature.
- **Explore and settings:** category-filtered prompt starters, profile settings, appearance, available model selection, privacy information, password change, logout, and account deletion.
- **Storage and privacy:** SQLite stores account data and conversations. Uploads and generated images are kept in per-account folders on this server. Account deletion removes the account's stored files and database records.

## Privacy and limitations

NEXORAGPT is self-hosted. It has no central sign-up service; you run the server and control its `.env` and `data` folder. The database and file folders contain private account data and should not be served or shared.

When you ask the AI a question, the conversation context and any attached file content are sent to AI Horde community workers. Image prompts are sent to AI Horde image workers. The calculator runs locally. Weather and Web search send the entered location/query to their named services. Do not submit passwords, API keys, or sensitive personal information to AI prompts.

Queue times, available models, rate limits, image quality, and whether any worker is available are controlled by AI Horde and can change. A generation may fail or remain queued. NEXORAGPT does not promise unlimited requests. This project has not been deployed as a public multi-tenant service; if you expose it publicly, configure HTTPS, a strong session secret, mail delivery, firewall rules, backups, and operational monitoring first.

## Project layout

```text
server.js          Node.js server, API routes, SQLite, AI Horde integration
public/            Browser interface, styles, icon
data/              Created at runtime for the database, uploads, and images
.env.example       Environment variable template
setup.bat          Windows setup and dependency installation
start.bat          Windows launch script
```

## Development checks

From this folder, run:

```powershell
npm run check
```

The server stores its SQLite database at `data/nexoragpt.sqlite` by default. Back up the whole `data` folder to preserve conversation and image history.
