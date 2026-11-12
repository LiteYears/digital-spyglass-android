# Ghost Search MCP Server

Anonymous Tor search infrastructure for AI agents and RAG systems.

## Quick Start

### Prerequisites

- Node.js >= 20
- Tor running at `127.0.0.1:9050` (Orbot or standalone)
- Optional: NVIDIA NIM API key for LLM features

### MCP Client Configuration

Add to your MCP client config (Claude Desktop, VS Code, etc.):

```json
{
  "mcpServers": {
    "ghost-search": {
      "command": "npx",
      "args": ["@ghost/search-mcp"],
      "env": {
        "GHOST_TOR_HOST": "127.0.0.1",
        "GHOST_TOR_PORT": "9050",
        "NIM_API_KEY": "nvapi-...",
        "NIM_MODEL": "nvidia/nemotron-3-super-120b-a12b"
      }
    }
  }
}
```

### Without LLM features

```json
{
  "mcpServers": {
    "ghost-search": {
      "command": "npx",
      "args": ["@ghost/search-mcp"],
      "env": {
        "GHOST_TOR_PORT": "9050"
      }
    }
  }
}
```

## Tools

### ghost_search

Search 13 onion search engines through Tor with dedup, entity extraction, snippet filtering, and camouflage.

```typescript
ghost_search({
  query: "security tools",
  engines: ["ahmia", "tor66", "notevil"], // optional, default: all healthy
  paranoid: false, // surge shaping + idle decoys
  snippetFilter: true, // liability snippet replacement
  maxResults: 20, // cap results
  refineQuery: false, // NIM query refinement
  summarize: false, // NIM result summary
});
```

### ghost_health

Check circuit breaker status for all engines.

### ghost_engines

List all available engines with capabilities.

### ghost_reset_engine

Reset a failed engine's circuit breaker.

### ghost_classify

NIM-powered result classification (category + risk level).

## Architecture

```
MCP Client (Claude, VS Code, etc.)
    ↓ stdio
Ghost Search MCP Server
    ↓ TransportLayer interface
NodeTorTransport (socks-proxy-agent → Tor SOCKS5)
    ↓ .onion search engines (14)
Results: dedup → entity extraction → snippet filter → optional NIM summary
```

## Legal

See `docs/GHOST_LEGAL_POSTURE.md` for full legal analysis.

- Self-hosted package only — operator is a tool provider, not a service provider
- Snippet filter is an automated safety mechanism, not editorial curation
- Integrators bear responsibility for their own deployment jurisdiction

## License

GPL-3.0-or-later
