import { getPublicOrigin, metadataCorsOptionsRequestHandler, protectedResourceHandler } from "mcp-handler";
import { authServerUrl } from "@/lib/mcp/auth";

// "Where do I sign in?" for the MCP server (/api/mcp), in the standard format
// Claude looks for (OAuth protected resource metadata, RFC 9728). It says:
// this server is <your app>/api/mcp, and sign-in passes come from this app's
// Supabase project. Served at /.well-known/oauth-protected-resource and at
// /.well-known/oauth-protected-resource/api/mcp, since apps look in either place.
// Public on purpose: it holds no secrets.
export function GET(req: Request) {
  return protectedResourceHandler({
    authServerUrls: [authServerUrl()],
    resourceUrl: `${getPublicOrigin(req)}/api/mcp`,
  })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
