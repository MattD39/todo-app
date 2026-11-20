import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyMcpToken } from "@/lib/mcp/auth";
import { registerChangeTools, registerTools } from "@/lib/mcp/tools";

// /api/mcp: the MCP server. This is the address you give Claude (claude.ai,
// the Claude iPhone app, Claude Desktop or Claude Code) to connect it to your
// To-Do list. MCP (Model Context Protocol) is the standard way to give Claude
// extra tools; Claude does the thinking on its side, so this costs no Claude
// money here.
//
// Every request must carry a login pass (see src/lib/mcp/auth.ts). Without
// one the answer is "401: sign in first", plus where to find the sign-in
// details (/.well-known/oauth-protected-resource/api/mcp), which is how
// Claude knows to send you to the "Allow Claude?" page.
const handler = createMcpHandler(
  (server) => {
    registerTools(server);
    registerChangeTools(server);
  },
  {
    serverInfo: { name: "todo", version: "0.1.0" },
  },
);

const authHandler = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
