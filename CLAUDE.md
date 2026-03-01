# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Slow Answers** - An asynchronous question-answering web app. Users speak or type questions, which are processed in the background by AI. Users check back later for answers. Optimized for easy question submission using cheap/slow resources for async processing.

Built with Astro 5.x SSR, TypeScript strict mode, hosted on Railway.

## Commands

All commands use Bun as the package manager:

- `bun install` - Install dependencies
- `bun dev` - Start dev server at localhost:4321
- `bun build` - Build production site to ./dist/
- `bun preview` - Preview production build locally
- `bun astro check` - Run Astro type checking
- `bun db:generate` - Generate database migrations from schema changes
- `bun db:push` - Push schema changes directly to database (dev)
- `bun db:migrate` - Run migrations (production)
- `bun db:studio` - Open Drizzle Studio to browse database

## Architecture

**File-based routing**: Files in `src/pages/` become routes automatically. Each `.astro` or `.md` file maps to a URL path.

**Project structure**:
- `src/pages/` - Route components and API endpoints
- `src/pages/api/` - API routes (JSON endpoints)
- `src/pages/auth/` - OAuth routes (Google login/callback/logout)
- `src/layouts/` - Shared page layouts
- `src/components/` - Reusable Astro/framework components
- `src/lib/` - Shared utilities (db, auth, ai)
- `src/lib/db/` - Database schema and connection (Drizzle ORM)
- `src/lib/ai/` - AI provider abstraction and job processor
- `public/` - Static assets copied as-is to dist/
- `drizzle/` - Generated database migrations

**Astro components** (`.astro` files) use a frontmatter script section (between `---` fences) for server-side logic, followed by an HTML template. Components render to static HTML at build time by default.

---

## Implementation Plan

### Core Concept
Users ask questions via voice (Web Speech API) or text. Questions go into a queue and are answered asynchronously by AI. Users log in with Google OAuth and check back later for answers.

### Tech Stack
- **Frontend**: Astro SSR with vanilla JS/TypeScript for interactivity
- **Backend**: Astro API routes (`src/pages/api/`)
- **Database**: PostgreSQL on Railway
- **Auth**: Google OAuth only (via arctic + lucia or similar)
- **Voice**: Browser Web Speech API (free, client-side transcription)
- **AI**: Multiple providers (Claude, OpenAI, etc.) - use cheapest available
- **Job processing**: Simple polling (cron/interval checks pending questions table)
- **Hosting**: Railway (web app + PostgreSQL)

### Database Schema

```
users
├── id (uuid, pk)
├── google_id (string, unique)
├── email (string)
├── name (string)
├── created_at (timestamp)

questions
├── id (uuid, pk)
├── user_id (uuid, fk → users)
├── content (text) - the question
├── depth (enum: 'quick' | 'deep') - default 'quick'
├── status (enum: 'pending' | 'processing' | 'complete' | 'failed')
├── created_at (timestamp)
├── completed_at (timestamp, nullable)

answers
├── id (uuid, pk)
├── question_id (uuid, fk → questions, unique)
├── content (text) - the answer
├── model_used (string) - which AI model answered
├── created_at (timestamp)
```

### Pages & Routes

```
/ .......................... Landing page (login prompt if not authed)
/ask ....................... Main question input page (voice + text)
/questions ................. List of user's questions with status
/questions/[id] ............ View question + answer (if ready)
/auth/google ............... Initiate Google OAuth
/auth/google/callback ...... OAuth callback handler
/api/questions ............. POST: submit question
/api/questions/[id] ........ GET: question status/answer
```

### Implementation Phases

**Phase 1: Foundation** ✓
- [x] Configure Astro for SSR (`output: 'server'`)
- [x] Set up PostgreSQL connection (drizzle-orm)
- [x] Create database schema and migrations
- [x] Implement Google OAuth flow
- [x] Basic session management

**Phase 2: Core Features** ✓
- [x] Question submission page with text input
- [x] Add Web Speech API voice recording
- [x] Questions list page (user's history)
- [x] Question detail page (shows answer when ready)
- [x] API endpoints for questions CRUD

**Phase 3: AI Processing** ✓
- [x] Background job runner (setInterval polling every 30s)
- [x] AI provider abstraction (Anthropic + OpenAI support)
- [x] Quick summary prompt template
- [x] Deep research prompt template
- [x] Error handling and retry logic (3 retries with backoff)

**Phase 4: Polish** ✓
- [x] Loading states and status indicators (auto-refresh on pending/processing)
- [x] Mobile-friendly voice recording UX (large tap-to-speak button)
- [x] Basic error pages (404, 500)
- [x] Railway deployment config (railway.toml + start script)

### Key Design Decisions

1. **Voice-first UX**: Large, obvious record button. Minimal friction to ask.
2. **No notifications**: Users bookmark or remember to check back. Keeps MVP simple.
3. **Depth toggle**: Default "quick" (cheap, fast). Optional "deep" (thorough, slower).
4. **Multi-provider AI**: Abstract the AI call so we can swap/fallback between providers.
5. **Simple job processing**: No Redis/queue complexity. Poll `pending` questions on interval.
