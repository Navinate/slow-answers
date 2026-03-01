# Slow Answers

An asynchronous question-answering web app. Ask questions via voice or text, and check back later for AI-researched answers.

## Features

- **Voice-first input** - Tap to speak on mobile, or type your question
- **Async processing** - Questions are answered in the background while you're away
- **Multiple AI providers** - Supports Anthropic Claude and OpenAI GPT
- **Quick or deep research** - Choose concise answers or thorough analysis

## Tech Stack

- **Frontend**: Astro 5.x SSR
- **Database**: PostgreSQL with Drizzle ORM
- **Auth**: Google OAuth
- **AI**: Anthropic Claude / OpenAI GPT

## Local Development

### Prerequisites

- [Bun](https://bun.sh/) runtime
- PostgreSQL database
- Google OAuth credentials
- Anthropic or OpenAI API key

### Setup

1. Install dependencies:
   ```sh
   bun install
   ```

2. Copy environment variables:
   ```sh
   cp .env.example .env
   ```

3. Fill in your `.env`:
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/slow_answers
   GOOGLE_CLIENT_ID=your_google_client_id
   GOOGLE_CLIENT_SECRET=your_google_client_secret
   GOOGLE_REDIRECT_URI=http://localhost:4321/auth/google/callback
   ANTHROPIC_API_KEY=your_anthropic_api_key
   ```

4. Push database schema:
   ```sh
   bun db:push
   ```

5. Start the dev server:
   ```sh
   bun dev
   ```

   Open http://localhost:4321

## Commands

| Command | Action |
|---------|--------|
| `bun dev` | Start dev server at localhost:4321 |
| `bun build` | Build for production |
| `bun start` | Run production build |
| `bun db:push` | Push schema to database |
| `bun db:generate` | Generate migrations |
| `bun db:studio` | Open Drizzle Studio |

## Deploy to Railway

### 1. Create Railway Project

- Go to [railway.app](https://railway.app) and create a new project
- Add a **PostgreSQL** database from the Railway dashboard

### 2. Connect Repository

- Connect your GitHub repository to Railway
- Railway will auto-detect the project configuration

### 3. Set Environment Variables

In your Railway service settings, add these environment variables:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Click "Connect" on your Railway Postgres to get this |
| `GOOGLE_CLIENT_ID` | From [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `https://your-app.up.railway.app/auth/google/callback` |
| `ANTHROPIC_API_KEY` | From [Anthropic Console](https://console.anthropic.com/) |

**Or use OpenAI instead:**

| Variable | Value |
|----------|-------|
| `OPENAI_API_KEY` | From [OpenAI Platform](https://platform.openai.com/api-keys) |
| `OPENAI_MODEL` | Optional, defaults to `gpt-4o-mini` |

### 4. Configure Google OAuth

In Google Cloud Console:

1. Go to **APIs & Services > Credentials**
2. Create or edit your OAuth 2.0 Client ID
3. Add your Railway URL to **Authorized redirect URIs**:
   ```
   https://your-app.up.railway.app/auth/google/callback
   ```

### 5. Deploy

Railway will automatically:
1. Build the project with `bun build`
2. Run `bun db:push` to sync the database schema
3. Start the server with `bun start`

Your app will be live at `https://your-app.up.railway.app`

## License

MIT
