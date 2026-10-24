# Continuous Integration (GitHub Actions)

`github-actions-ci.yml` runs typecheck + tests (Postgres/Redis services) + Docker builds on every push.

It is stored here because the automated uploader was not allowed to create workflow files.
To enable it, run once in PowerShell from the repo folder:

```powershell
New-Item -ItemType Directory -Force .github\workflows | Out-Null
git mv ci\github-actions-ci.yml .github\workflows\ci.yml
.\windows\push-to-github.ps1 "Enable CI"
```
