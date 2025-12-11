# Visual Studio 2026 Build Configuration

## Problem
node-gyp (v10.1.0) doesn't recognize Visual Studio 2026 (version 18) out of the box, causing native module builds to fail.

## Solution
Patched node-gyp to add VS 2026 support by modifying:
`C:\Users\tellt\AppData\Local\nvm\v20.19.5\node_modules\npm\node_modules\node-gyp\lib\find-visualstudio.js`

### Changes Made

1. **Added 2026 to supported years** (lines 120, 181):
   - `findVisualStudio2019OrNewerUsingSetupModule()`: Added 2026 to array
   - `findVisualStudio2019OrNewer()`: Added 2026 to array

2. **Added version 18 mapping** (lines 347-350):
   ```javascript
   if (ret.versionMajor === 18) {
     ret.versionYear = 2026
     return ret
   }
   ```

3. **Added v145 toolset** (lines 405-407):
   ```javascript
   } else if (versionYear === 2026) {
     return 'v145'
   }
   ```

## Important Notes

- This patch is applied to the npm-bundled node-gyp in your nvm installation
- If you switch Node.js versions or reinstall npm, you'll need to reapply this patch
- The helper script `build-with-vs.ps1` was created but is no longer needed
- You can safely delete `.npmrc` if it exists

## Commands

```bash
# Install dependencies
npm install

# Package for Windows x64
npm run package:win-x64
```

Both commands now work with Visual Studio 2026.
