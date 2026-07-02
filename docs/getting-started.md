# Getting Started with SliceForge

This guide will walk you through setting up and running your first SliceForge automation loop.

## Prerequisites

Ensure you have the following installed on your machine:
- **Node.js** (version >= 18)
- **Git**
- **Docker Desktop** (required if your stack uses containers/databases for previewing)
- One of the supported AI Agent command-line tools:
  - **Cursor CLI** (`cursor`)
  - **Claude Code** (`claude`)
  - Or an API Key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) to run in direct API fallback mode.

## Installation

1. Install the SliceForge package globally:
   ```bash
   npm install -g @zeroltv/sliceforge
   ```

2. Alternatively, clone this repository and link it locally:
   ```bash
   git clone https://github.com/ZeroLTV/SliceForge.git
   cd SliceForge
   npm ci
   npm run build
   npm link
   ```

## Setting Up Your Project

1. Navigate to your project directory and initialize configuration:
   ```bash
   cd /path/to/your/project
   sliceforge init
   ```
   This creates `sliceforge.config.json` and `whole-app-backlog.json`.

2. Setup environment variables:
   Create a `.env` file in your project root containing:
   ```env
   # API Keys
   ANTHROPIC_API_KEY=sk-ant-your-api-key
   
   # Or for local agent execution
   CURSOR_CLI_PATH=cursor
   ```

3. Fill out your backlog:
   Add slices to `whole-app-backlog.json` to define your roadmap.

## Running SliceForge

- **Run test case generator (TestGen Loop):**
  Check drift on specs and generate test cases:
  ```bash
  sliceforge testgen
  ```

- **Run development loop (Ralph Loop):**
  Start implementing slices:
  ```bash
  sliceforge loop
  ```

- **Run a single iteration:**
  Run exactly one slice implementation step:
  ```bash
  sliceforge once
  ```

- **Approve human reviewed slice:**
  If a slice is paused waiting for your review, approve it with:
  ```bash
  sliceforge approve <slice-id>
  ```
