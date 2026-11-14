# GROQGPT

GROQGPT is a public, ChatGPT-style AI workspace powered by Groq’s **GPT OSS 120B** (openai/gpt-oss-120b). Visitors can start chatting as guests without creating an account or entering an API key. The site owner supplies the private service key once in the server host.

## What is included

- Responsive chat with streaming, stop, regenerate, edit, copy, read-aloud, and voice input.
- Guest workspaces and optional email/password accounts.
- Private projects, saved memory, conversations, file library, and image history.
- Explore catalog with featured assistants, community assistant publishing, featured projects, models, and tools.
- PDF, DOCX, TXT, CSV, and image file storage; text extraction is used for supported chat documents. The selected Groq chat model accepts text, not image input.
- Calculator, web search, weather, translator, and summarizer tools.
- Scheduled AI tasks, personal calendar, and an owner console for usage and announcements.
- A separate optional image-generation provider. GROQGPT never claims Groq generated an image.
- Server-side request limits and private provider credentials.

## Publish for anyone to use

This repository includes render.yaml for a Render web service that redeploys when you push changes to the connected GitHub branch.

1. Create a Supabase project. Open its SQL Editor and run all of schema.sql once. This creates the private workspaces, account/session tables, task and calendar tables, usage records, and private file bucket.
2. In Supabase, copy the project URL and create a server-side secret API key (sb_secret…). Keep it private.
3. In the Groq Console, create a key with access to openai/gpt-oss-120b. Do not paste it into this repository or into the website.
4. Push this folder to a GitHub repository. Confirm .env is not part of the commit; .gitignore excludes it.
5. In Render, create a new Blueprint from that GitHub repository and follow the prompts for SUPABASE_URL, SUPABASE_SECRET_KEY, GROQ_API_KEY, ADMIN_EMAIL, and ADMIN_PASSWORD. Use a long, unique owner password.
6. Wait for the service to deploy, then open its onrender.com address. Visitors can use the site right away as guests. The owner can sign in under Settings → Data & privacy → Owner sign in.

The Supabase secret key and Groq key belong only in Render’s private environment settings. A visitor never needs to see, copy, or configure either one. Render’s Blueprint flow supports prompting for secret values declared with sync: false; see the [Render Blueprint guide](https://render.com/docs/blueprint-spec).

### Optional providers

- **Images:** set IMAGE_API_KEY and, if needed, IMAGE_API_BASE and IMAGE_MODEL in Render. This must be a separate OpenAI-compatible image service. The Images page stays disabled until configured.
- **Enhanced web search:** set TAVILY_API_KEY in Render. Without it, GROQGPT uses DuckDuckGo instant-answer results as a fallback.

## Local setup

Requires Node.js 20 or newer.

1. Copy .env.example to .env.
2. Put your Supabase URL, Supabase server secret key, and Groq key in .env.
3. Run npm install, then npm start, and open http://localhost:3000.

On Windows, start-groqgpt.bat can install the packages and open the local site. It will create a starter .env if one is missing; fill in the private values first.

## Service and privacy notes

- Every chat uses only openai/gpt-oss-120b; the model selector is intentionally fixed.
- Guests receive a private workspace without signing in. Guest workspaces expire after 30 days. Creating an account saves that workspace for later sign-in.
- Publishing an assistant to the public Explore catalog requires an account; guest-created assistants remain private to that workspace.
- Uploaded files use private Supabase Storage and signed download links. Each file is limited to 10 MB.
- The server allows up to 10 AI requests per IP per minute. Public visitors use the site owner’s Groq quota, so the owner should monitor usage in Groq and set provider limits appropriate to the deployment.
- Scheduled tasks run from the server’s background loop. Hosting plans that suspend while idle can delay them; use an always-on service if tasks must run on time.
- Never commit .env, paste service keys into browser code, or reuse an API key that appeared in a screenshot. Revoke exposed keys and create replacements.
