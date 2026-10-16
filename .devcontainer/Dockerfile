FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fonts-noto-color-emoji fonts-noto-core \
    && curl --fail --show-error --location https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*
USER vscode
