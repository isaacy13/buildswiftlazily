/** OTA manifest + install page generation (pure; easy to unit test). */

export type OtaInput = {
  baseUrl: string; // e.g. https://mac.tailnet.ts.net/ota/abc
  title: string;
  bundleId: string;
  bundleVersion: string;
};

function xmlEsc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildManifestPlist(input: OtaInput): string {
  const ipaUrl = `${input.baseUrl.replace(/\/$/, "")}/App.ipa`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${xmlEsc(ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${xmlEsc(input.bundleId)}</string>
        <key>bundle-version</key>
        <string>${xmlEsc(input.bundleVersion)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${xmlEsc(input.title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

export function buildItmsUrl(manifestUrl: string): string {
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
}

export function buildInstallHtml(input: OtaInput): string {
  const base = input.baseUrl.replace(/\/$/, "");
  const manifestUrl = `${base}/manifest.plist`;
  const itms = buildItmsUrl(manifestUrl);
  const title = xmlEsc(input.title);
  const ver = xmlEsc(input.bundleVersion);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Install ${title}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 2rem; background: #0b0b0c; color: #f5f5f7; }
    .card { max-width: 28rem; margin: 0 auto; background: #1c1c1e; border-radius: 16px; padding: 1.5rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { color: #a1a1a6; line-height: 1.4; }
    a.btn { display: block; text-align: center; background: #0a84ff; color: white; text-decoration: none;
            font-weight: 600; padding: 0.9rem 1rem; border-radius: 12px; margin-top: 1.25rem; }
    code { font-size: 0.75rem; word-break: break-all; color: #8e8e93; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Install ${title}</h1>
    <p>Version ${ver}<br/>Open this page in <strong>Safari</strong> on a registered device.</p>
    <a class="btn" href="${xmlEsc(itms)}">Install on this iPhone</a>
    <p style="margin-top:1rem"><code>${xmlEsc(manifestUrl)}</code></p>
  </div>
</body>
</html>
`;
}
