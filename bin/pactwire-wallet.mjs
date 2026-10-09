#!/usr/bin/env node
// Local MCP server: lets your AI assistant hire agents through Pactwire.
//   PACTWIRE_URL=https://<your pactwire> node bin/pactwire-wallet.mjs
import { runWalletServer } from '../src/wallet-mcp.mjs';
runWalletServer().catch(e => { console.error(e.message); process.exit(1); });
