This is an [assistant-ui](https://github.com/Yonom/assistant-ui) project with provider-agnostic backend routing and repo-backed conversation persistence.

## Getting Started

### 1. Configure Environment Variables

Create a `.env.local` file in the root directory and add your credentials:

```
# Required: Cloudflare Workers AI credentials (backend only)
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token

# Optional: override default/fallback model
# CLOUDFLARE_WORKERS_AI_MODEL=@cf/meta/llama-4-scout-17b-16e-instruct

# Optional: specialized model routing
# VISUAL/UI + animations requests
# CLOUDFLARE_WORKERS_AI_MODEL_VISUAL=@cf/meta/llama-4-scout-17b-16e-instruct
# FUNCTIONS/backend/logic requests
# CLOUDFLARE_WORKERS_AI_MODEL_FUNCTIONS=@cf/meta/llama-4-scout-17b-16e-instruct
# Everything else
# CLOUDFLARE_WORKERS_AI_MODEL_GENERAL=@cf/meta/llama-4-scout-17b-16e-instruct
```

> **Note**: You can copy `.env.example` to `.env.local` and fill in your values.

### 2. Install Dependencies

```bash
npm install
# or
yarn install
# or
pnpm install
# or
bun install
```

### 3. Run the Development Server

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### 4. (Optional) Set Up GitHub Sync

To enable creating projects from existing GitHub repositories:

1. Follow the [GitHub App Setup Guide](../GITHUB_APP_SETUP.md)
2. Create/configure your GitHub App following your platform setup
3. Install the GitHub App on your GitHub repositories
4. Use the "From GitHub" option when creating new projects

See [GITHUB_APP_SETUP.md](../GITHUB_APP_SETUP.md) for detailed instructions.

## Development

You can start customizing the UI by modifying components in the `components/assistant-ui/` directory.

### Key Files

- `app/assistant.tsx` - Renders the chat interface and sets up the assistant runtime
- `app/api/chat/route.ts` - Chat API endpoint
- `lib/llm-provider.ts` - Cloudflare Workers AI provider wrapper
- `components/assistant-ui/thread.tsx` - Chat thread component
- `components/app-sidebar.tsx` - Sidebar with thread list
