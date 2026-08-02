// Step 1 of the GitHub OAuth handshake used by Decap CMS (public/admin).
// Redirects the editor to GitHub's authorize screen. GITHUB_OAUTH_ID is a
// public value (safe to expose); the matching secret lives only in
// callback.js via the GITHUB_OAUTH_SECRET env var.
export default async (req) => {
  const clientId = process.env.GITHUB_OAUTH_ID;
  const site = process.env.URL || "https://mutaremores.com";
  const redirectUri = `${site}/.netlify/functions/callback`;

  if (!clientId) {
    return new Response("Missing GITHUB_OAUTH_ID environment variable", {
      status: 500,
    });
  }

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "repo,user");

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl.toString() },
  });
};
