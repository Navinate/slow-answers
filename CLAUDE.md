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

## Architecture

**File-based routing**: Files in `src/pages/` become routes automatically. Each `.astro` or `.md` file maps to a URL path.

**Project structure**:
- `src/pages/` - Route components (index.astro → /)
- `src/components/` - Reusable Astro/framework components (create as needed)
- `public/` - Static assets copied as-is to dist/

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

**Phase 1: Foundation**
- [ ] Configure Astro for SSR (`output: 'server'`)
- [ ] Set up PostgreSQL connection (drizzle-orm or similar)
- [ ] Create database schema and migrations
- [ ] Implement Google OAuth flow
- [ ] Basic session management

**Phase 2: Core Features**
- [ ] Question submission page with text input
- [ ] Add Web Speech API voice recording
- [ ] Questions list page (user's history)
- [ ] Question detail page (shows answer when ready)
- [ ] API endpoints for questions CRUD

**Phase 3: AI Processing**
- [ ] Background job runner (simple setInterval or separate process)
- [ ] AI provider abstraction (start with one, design for multiple)
- [ ] Quick summary prompt template
- [ ] Deep research prompt template (multi-step)
- [ ] Error handling and retry logic

**Phase 4: Polish**
- [ ] Loading states and status indicators
- [ ] Mobile-friendly voice recording UX
- [ ] Basic error pages
- [ ] Railway deployment config

### Key Design Decisions

1. **Voice-first UX**: Large, obvious record button. Minimal friction to ask.
2. **No notifications**: Users bookmark or remember to check back. Keeps MVP simple.
3. **Depth toggle**: Default "quick" (cheap, fast). Optional "deep" (thorough, slower).
4. **Multi-provider AI**: Abstract the AI call so we can swap/fallback between providers.
5. **Simple job processing**: No Redis/queue complexity. Poll `pending` questions on interval.
