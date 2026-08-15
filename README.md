<div align="center">
    <h1>Cloudflare Tunnel for VSCode</h1>
    <a href="https://marketplace.visualstudio.com/items?itemName=IvanArjona.cloudflaretunnel">
        <img src="images/icon.png" width="150px" alt="VSCode Marketplace badge" />
    </a>
    <br>
    <br>
    <em>Expose local development sites through Cloudflare Tunnel with automatic Laravel Herd and Valet routing.</em>
</div>

# Features

- Automatic Laravel Herd site detection from the current VS Code workspace.
- Automatic Laravel Valet site detection when Herd is not available.
- Uses the local virtual host as the origin Host header, so multiple projects can share local port 80/443.
- Named tunnel mode when Cloudflare is authenticated and a base domain is configured.
- Automatic public hostname generation: `crm.test` -> `crm.example.com`.
- Quick Tunnel fallback to a random `*.trycloudflare.com` address when no Cloudflare account/domain is configured.
- DNS route creation with `--overwrite-dns` for named tunnels.
- Last 10 local origins are stored in VS Code global state.
- Generated Cloudflare configuration is removed on stop/deactivation.

# How it works

For a named tunnel the extension follows the same routing model as the `cftunnel` Herd integration:

```text
https://crm.example.com
        |
        v
Cloudflare Tunnel
        |
        | http://127.0.0.1:80
        | Host: crm.test
        v
Laravel Herd / Valet
        |
        v
~/Herd/crm or linked project
```

The public hostname and the local virtual hostname are deliberately separate. Cloudflare sends requests to the local web server while `httpHostHeader` selects the correct Herd/Valet site.

# Automatic public hostnames

Configure a base domain in VS Code settings:

```json
{
  "cloudflaretunnel.tunnel.defaultHostname": "example.com"
}
```

Then open a project served as:

```text
crm.test
```

and run:

```text
Cloudflare Tunnel: Create Tunnel
```

The extension automatically creates and routes:

```text
https://crm.example.com
```

No subdomain prompt is required.

## Without Cloudflare login or a base domain

The same project automatically falls back to a Quick Tunnel:

```text
crm.test
    -> https://random-name.trycloudflare.com
```

Quick Tunnels require no configuration file or Cloudflare account. citeturn108378search4

# Herd detection

The extension first uses:

```bash
herd sites --json
```

and matches the current VS Code workspace path. Herd added the JSON site listing in v1.26.0. citeturn851784search0

It then falls back to `herd links` for linked projects. Herd documents linked sites with their URL and filesystem path. citeturn851784search3

If Herd is installed but the current project is not returned by those commands, the extension falls back to `<folder>.test`.

# Valet detection

When Herd is not available, the extension checks `valet links` and matches the workspace directory. Valet documents `link`/`links` and the conventional `<folder>.test` hostname for parked sites. citeturn108378search6

# Cloudflare origin configuration

Named tunnels use a local configuration equivalent to:

```yaml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: crm.example.com
    service: http://127.0.0.1:80
    originRequest:
      httpHostHeader: crm.test
  - service: http_status:404
```

Cloudflare documents `httpHostHeader` as the origin parameter used to override the HTTP `Host` header sent to the local service. citeturn108378search1turn108378search9

# Commands

```text
Cloudflare Tunnel: Create Tunnel
Cloudflare Tunnel: Stop Tunnel
Cloudflare Tunnel: Open Tunnel in browser
Cloudflare Tunnel: Copy tunnel uri to clipboard
Cloudflare Tunnel: Get version
Cloudflare Tunnel: Login
Cloudflare Tunnel: Logout
Cloudflare Tunnel: Focus on Tunnels View
Cloudflare Tunnel: Open panel
Cloudflare Tunnel: Output channel
```

# Settings

| Setting | Purpose |
|---|---|
| `cloudflaretunnel.tunnel.defaultHostname` | Base public domain, e.g. `example.com` |
| `cloudflaretunnel.tunnel.defaultPort` | Fallback local port when no Herd/Valet site is detected |
| `cloudflaretunnel.tunnel.localHostname` | Local origin address used by named tunnels; normally `localhost` |
| `cloudflaretunnel.gui.showStatusBarItem` | Show running tunnel count in the status bar |

# Development

```bash
npm install
npm run compile
npm run lint
npm test
```
