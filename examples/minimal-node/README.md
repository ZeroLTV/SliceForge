# Minimal Node Example Project

This is a minimal demonstration project illustrating how to use SliceForge to automate developmental loops for a Node.js project.

## Setup & Running

1. Build SliceForge locally first:
   ```bash
   cd /path/to/SliceForge
   npm run build
   npm link
   ```

2. Link it inside this directory:
   ```bash
   cd /path/to/SliceForge/examples/minimal-node
   npm link @zeroltv/sliceforge
   ```

3. Setup your API credentials in a `.env` file:
   ```env
   ANTHROPIC_API_KEY=your-api-key
   ```

4. Run the automation loop:
   ```bash
   sliceforge loop
   ```
