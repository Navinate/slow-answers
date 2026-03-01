# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Astro 5.x static site generator project using TypeScript with strict mode.

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
