# tools

- `desktop/`: add the server to Claude Desktop's config (see its README).
- `npm-placeholder/`: a README-only package that reserves the npm name before the first release.
  Publish once, by the owner, from that folder:

  ```
  npm login
  cd tools/npm-placeholder
  npm publish --access public
  ```

  Delete the folder after the first real release (`0.1.0` or later replaces it on npm).
