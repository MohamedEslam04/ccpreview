# Releasing

Releases go to npm from GitHub Actions ([publish.yml](../.github/workflows/publish.yml)) when a `v*` tag is pushed. Authentication is npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token lives in the repo or in GitHub secrets, and every release carries a provenance statement that links it to the commit and workflow run that built it.

## One-time setup

1. The package must exist on npm before a trusted publisher can be added, so the very first version is published by hand: `npm publish --access public`.
2. On npmjs.com open the `marsad` package, then **Settings > Trusted publisher > GitHub Actions**, and enter:
   - Organization or user: `MohamedEslam04`
   - Repository: `marsad`
   - Workflow filename: `publish.yml`
   - Allow `npm publish`.
3. Optional, recommended: in the same settings page, set publishing access to require 2FA and disallow tokens, so only the workflow (or you with 2FA) can publish.

## Every release

```sh
npm version patch --no-git-tag-version   # or minor / major; edits package.json
git commit -am "chore: release v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push origin main --tags
```

The workflow checks that the tag matches `package.json`, runs the tests, skips if that version is already on npm, and publishes with `--provenance`.
