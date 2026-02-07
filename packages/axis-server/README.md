# @virsanghavi/axis-server

The official Axis Shared Context MCP Server. This server mirrors your project structure and metadata to AI agents via the Model Context Protocol (MCP).

## Installation

```bash
npm install -g @virsanghavi/axis-server
```

## Usage

Start the server:

```bash
axis-server
```

## Configuration

The server expects standard Axis environment variables:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`

These can be provided via a `.env` file in the current directory or as environment variables.
