# Grace Ubuntu browser

This configuration provisions an Ubuntu 24.04 development container with Google
Chrome and a lightweight desktop in GitHub Codespaces. Port 6080 opens the desktop
in a normal browser, including on Android/iOS; no extension is required.

## Access

Create a Codespace for this repository using `.devcontainer/devcontainer.json`.
Wait for the build, then open the **Grace private Ubuntu desktop** forwarded port
6080. GitHub authentication protects the PRIVATE forwarded URL. Keep it private:
the desktop feature allows local connections without a separate VNC password.
Never publish port 6080 or forward port 5901. This configuration is intended for
Codespaces, not an internet-exposed Docker host.

Chrome opens ChatGPT. Account sign-in happens interactively in that browser. No
account credentials are included in the image or repository. The Chrome sandbox
remains enabled; there is no externally accessible DevTools endpoint.

The profile is stored at `/workspaces/.grace-private/chrome`, outside the git
repository. It survives a stop/start or rebuild of this Codespace, but deleting
the Codespace deletes its local data. ChatGPT can expire or revoke a login.

## Scope and limits

This is the remote browser prerequisite, not yet a working website-to-ChatGPT
message bridge. The existing website still uses its current API integration.
There is no authenticated ChatGPT session until interactive login succeeds.
There is no promise of an unlimited plan, perpetual login, or a permanent VM.
Codespaces has idle shutdown and metered compute/storage; account quotas apply.
No keep-alive mechanism bypasses shutdown or billing limits.

To stop compute, use GitHub's **Stop codespace** action. Retained storage can
still count toward your account's allowance. Do not delete the Codespace if you
want to retain its browser profile.

## Validation

The JSON and shell syntax can be checked locally. A real Codespace build and
opening Chrome are required before claiming deployment success. Check that port
6080 is private, the desktop loads, Chrome runs as `vscode`, and the profile lies
outside the repository. No passwords or cookies should appear in logs or git.

Sources: [desktop-lite](https://github.com/devcontainers/features/tree/main/src/desktop-lite),
[Codespaces lifecycle](https://docs.github.com/en/codespaces/about-codespaces/deep-dive),
[port forwarding](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace).
