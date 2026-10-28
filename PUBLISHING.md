# Publishing / Distribution

This repository is **GitHub-ready** and Marketplace-ready. No remote is configured in the
source checkout, and nothing has been published yet.

## 0. What is already prepared

- `package.json`: `publisher: xliang`, `version: 0.9.0`, `license: MIT`,
  `icon: media/icon.png` (128×128 PNG generated from the official whale mark).
- `README.md` / `README.en.md`: feature overview, install commands, configuration table.
- `CHANGELOG.md`: release history; the newest section must match `package.json` version
  (`test/package-manifest.test.ts` enforces this).
- `.github/workflows/ci.yml`: typecheck + tests + build + VSIX artifact on pushes to `main`
  and pull requests.
- `.github/workflows/release.yml`: on a `v*` tag, builds and attaches
  `deepseek-harness-vX.Y.Z.vsix` to a GitHub Release.
- The source branch is named `main` (the CI workflow triggers on `main`).

## 1. Push to GitHub

Create an empty repository on github.com (no README/license), then from the repo root:

```powershell
git remote add origin https://github.com/bridge000/deepseek-harness-vscode.git
git push -u origin main
git push origin v0.9.0
```

`git push origin v0.9.0` triggers the Release workflow; the VSIX is attached to the
release automatically. Friends can install it with:

```powershell
code --install-extension deepseek-harness-v0.9.0.vsix
```

Then update the placeholder metadata in `package.json` (and `README*.md` install
commands if the extension id changes):

- `repository.url`: `https://github.com/bridge000/deepseek-harness-vscode.git`
- `homepage`: `https://github.com/bridge000/deepseek-harness-vscode#readme`
- `bugs.url`: `https://github.com/bridge000/deepseek-harness-vscode/issues`
- `publisher` / `author`: your Marketplace publisher id / GitHub handle

## 2. VS Code Marketplace (yes, publishing is open to anyone)

1. **Create a publisher** at <https://marketplace.visualstudio.com/manage>.
   The publisher **id is globally unique** and must equal `publisher` in
   `package.json` (currently `xliang`; if it is taken, pick another id and update
   `package.json` + the extension id in the READMEs).
2. **Create a Personal Access Token** in Azure DevOps
   (<https://dev.azure.com> → User settings → Personal access tokens) with the
   **Marketplace → Manage** scope. Copy it once.
3. **Log in and publish** (from the repo root, after `npm run package`):

   ```powershell
   npx @vscode/vsce login xliang
   npx @vscode/vsce publish --no-dependencies
   ```

   Or non-interactive:

   ```powershell
   $env:VSCE_PAT = "<token>"
   npx @vscode/vsce publish --no-dependencies
   ```

   `--no-dependencies` is correct here: there are no runtime npm dependencies
   (`dist/` is the bundled output).
4. **After the first publish**: bump `version` for every subsequent upload (a
   released version cannot be overwritten), run `npm test`, then
   `npm run package` and `npx @vscode/vsce publish --no-dependencies`.

Marketplace checks to keep green:

- `icon` is a 128×128 PNG (`media/icon.png`) — done.
- README, CHANGELOG and LICENSE are included automatically by `vsce`.
- A valid `repository` URL avoids the "repository missing" warning; update the
  placeholder before publishing.
- `engines.vscode` (`^1.100.0`) and `activationEvents` are already set.

### Optional: publish from GitHub Actions

Add a repository secret `VSCE_PAT` and append a publish step to the release
workflow, e.g.:

```yaml
- run: npx @vscode/vsce publish --no-dependencies -p ${{ secrets.VSCE_PAT }}
  if: startsWith(github.ref, 'refs/tags/v')
```

## 3. Open VSX (alternative, no Microsoft account)

Open VSX is the registry used by VSCodium and some other VS Code-compatible
editors. An account at <https://open-vsx.org> plus a token is enough:

```powershell
npx ovsx publish deepseek-harness-0.9.0.vsix -p <token>
```

## 4. Naming / brand disclaimer

“DeepSeek Harness” is the name of the upstream project. This extension is an
**unofficial community client**; keep that disclaimer in `README.md`,
`README.en.md` and the extension description. Do not present it as an official
DeepSeek product.
