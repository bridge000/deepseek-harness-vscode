# Publishing / Distribution

This repository is currently a **local, GitHub-ready** repository. No remote is configured, and no Marketplace/Open VSX publishing has been performed.

## 1. Publish the GitHub repository

```powershell
# create an empty repository on github.com first, then:
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

Then update `package.json` metadata:

- `repository`: `{ "type": "git", "url": "https://github.com/<owner>/<repo>.git" }`
- `homepage`: `https://github.com/<owner>/<repo>#readme`
- `bugs`: `https://github.com/<owner>/<repo>/issues`
- `author` / `publisher`: your GitHub handle or organization
- Add `"icon": "media/icon.png"` if you provide a 128×128 PNG.

## 2. Release a VSIX via GitHub Releases

Tagging triggers `.github/workflows/release.yml`:

```powershell
git tag v0.3.0
git push origin v0.3.0
```

The workflow builds and attaches `deepseek-harness-v0.3.0.vsix` to the release. Friends can install it with:

```powershell
code --install-extension deepseek-harness-v0.3.0.vsix
```

## 3. Optional: VS Code Marketplace

```powershell
npx @vscode/vsce login <publisher>
npx @vscode/vsce publish --no-dependencies
```

> If the package uses a placeholder repository field, keep `--allow-missing-repository` for local packaging. Once the GitHub URL is filled in, the warning disappears.

## 4. Optional: Open VSX

```powershell
npx ovsx publish deepseek-harness.vsix -p <token>
```

## Naming disclaimer

“DeepSeek Harness” is the name of the upstream project. This extension is an unofficial community client; keep the disclaimer in `README.md`, `README.en.md`, and the extension description. Do not present it as an official DeepSeek product.
