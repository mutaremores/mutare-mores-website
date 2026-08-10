// Worker entry point for mutaremores.com (see wrangler.jsonc).
// Handles the two dynamic routes Decap CMS's GitHub OAuth login needs
// (/auth, /callback) — same logic that used to live in Netlify Functions,
// then briefly in Cloudflare Pages Functions. Everything else falls
// through to the static site files in public/ via the ASSETS binding.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") {
      return handleAuth(request, env);
    }
    if (url.pathname === "/callback") {
      return handleCallback(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

// Step 1 of the GitHub OAuth handshake: redirects the editor to GitHub's
// authorize screen. GITHUB_OAUTH_ID is a public value (safe to expose);
// the matching secret lives only in handleCallback via GITHUB_OAUTH_SECRET.
async function handleAuth(request, env) {
  const clientId = env.GITHUB_OAUTH_ID;
  const redirectUri = `${new URL(request.url).origin}/callback`;

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
}

// Step 2: exchanges the ?code= GitHub sends back for an access token, then
// hands that token to the Decap CMS popup window via postMessage, using
// the exact message format Decap's github backend listens for.
async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const clientId = env.GITHUB_OAUTH_ID;
  const clientSecret = env.GITHUB_OAUTH_SECRET;

  if (!code) {
    return new Response("Missing ?code from GitHub", { status: 400 });
  }
  if (!clientId || !clientSecret) {
    return new Response(
      "Missing GITHUB_OAUTH_ID / GITHUB_OAUTH_SECRET environment variables",
      { status: 500 }
    );
  }

  let tokenData;
  try {
    const tokenResp = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      }
    );

    if (!tokenResp.ok) {
      return oauthErrorResponse(
        `GitHub returned ${tokenResp.status} exchanging the login code`
      );
    }

    tokenData = await tokenResp.json();
  } catch (err) {
    // Network failure reaching GitHub, or a response body that isn't valid
    // JSON (e.g. GitHub serving an HTML error page during an outage) --
    // without this, either throws uncaught and the popup is left on a bare
    // Cloudflare error page with no way for the CMS to know login failed.
    return oauthErrorResponse(
      `Could not reach GitHub to complete login (${err.message || "network error"})`
    );
  }

  if (tokenData.error || !tokenData.access_token) {
    const message = tokenData.error_description || tokenData.error || "unknown error";
    return oauthErrorResponse(message);
  }

  const payload = JSON.stringify({
    token: tokenData.access_token,
    provider: "github",
  });

  return htmlResponse(
    `(function() {
      function receiveMessage(e) {
        window.opener.postMessage(
          'authorization:github:success:${payload.replace(/'/g, "\\'")}',
          e.origin
        );
        window.removeEventListener('message', receiveMessage, false);
      }
      window.addEventListener('message', receiveMessage, false);
      window.opener.postMessage('authorizing:github', '*');
    })();`
  );
}

// Posts Decap's expected error message back to the CMS popup's opener
// window, instead of leaving the popup on a bare error page the CMS has no
// way to react to. Shared by all three ways the token exchange can fail:
// GitHub reporting an OAuth error, a non-2xx HTTP status, or the fetch/JSON
// parse itself throwing (network failure, non-JSON response body).
function oauthErrorResponse(message) {
  return htmlResponse(
    `(function() {
      function receiveMessage(e) {
        window.opener.postMessage(
          'authorization:github:error:' + JSON.stringify({ message: ${JSON.stringify(message)} }),
          e.origin
        );
        window.removeEventListener('message', receiveMessage, false);
      }
      window.addEventListener('message', receiveMessage, false);
      window.opener.postMessage('authorizing:github', '*');
    })();`
  );
}

function htmlResponse(script) {
  return new Response(
    `<!doctype html><html><body><script>${script}</script></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  );
}
