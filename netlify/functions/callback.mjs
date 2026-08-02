// Step 2 of the GitHub OAuth handshake used by Decap CMS (public/admin).
// Exchanges the ?code= GitHub sends back for an access token, then hands
// that token to the Decap CMS popup window via postMessage, using the
// exact message format Decap's github backend listens for.
export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const clientId = process.env.GITHUB_OAUTH_ID;
  const clientSecret = process.env.GITHUB_OAUTH_SECRET;

  if (!code) {
    return new Response("Missing ?code from GitHub", { status: 400 });
  }
  if (!clientId || !clientSecret) {
    return new Response(
      "Missing GITHUB_OAUTH_ID / GITHUB_OAUTH_SECRET environment variables",
      { status: 500 }
    );
  }

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

  const tokenData = await tokenResp.json();

  if (tokenData.error || !tokenData.access_token) {
    const message = tokenData.error_description || tokenData.error || "unknown error";
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
};

function htmlResponse(script) {
  return new Response(
    `<!doctype html><html><body><script>${script}</script></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  );
}
