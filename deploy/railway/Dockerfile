# syntax=docker/dockerfile:1
# Railway worker image for an always-on CodeWhale Telegram agent.
#
# This intentionally differs from the public CLI image: it includes Node,
# git, a source checkout, and the Telegram bridge so the runtime can operate
# against a real workspace instead of only launching an interactive TUI.

ARG RUST_VERSION=1.88

FROM --platform=$BUILDPLATFORM rust:${RUST_VERSION}-slim-bookworm AS builder
ARG TARGETPLATFORM
ARG TARGETARCH
ARG BUILDPLATFORM
ARG DEEPSEEK_BUILD_SHA

ENV CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_LIBDIR_aarch64_unknown_linux_gnu=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
    DEEPSEEK_BUILD_SHA=${DEEPSEEK_BUILD_SHA}

RUN if [ "${TARGETARCH}" = "arm64" ] && [ "${BUILDPLATFORM}" != "${TARGETPLATFORM}" ]; then \
      dpkg --add-architecture arm64; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      pkg-config libdbus-1-dev \
    && if [ "${TARGETARCH}" = "arm64" ] && [ "${BUILDPLATFORM}" != "${TARGETPLATFORM}" ]; then \
      apt-get install -y --no-install-recommends \
        gcc-aarch64-linux-gnu libc6-dev-arm64-cross libdbus-1-dev:arm64; \
    fi \
    && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETPLATFORM}" in \
      linux/amd64)  echo x86_64-unknown-linux-gnu  > /rust-target ;; \
      linux/arm64)  echo aarch64-unknown-linux-gnu > /rust-target ;; \
      *)            echo "Unsupported platform: ${TARGETPLATFORM}" >&2; exit 1 ;; \
    esac

RUN rustup target add "$(cat /rust-target)"

WORKDIR /build
COPY . .

RUN --mount=type=cache,id=codewhale-railway-target-${TARGETARCH},target=/build/target,sharing=locked \
    --mount=type=cache,id=codewhale-railway-cargo-registry-${TARGETARCH},target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=codewhale-railway-cargo-git-${TARGETARCH},target=/usr/local/cargo/git,sharing=locked \
    cargo build --release --locked --target "$(cat /rust-target)" \
      -p codewhale-cli -p codewhale-tui \
    && mkdir -p /out \
    && cp target/$(cat /rust-target)/release/codewhale /out/ \
    && cp target/$(cat /rust-target)/release/codewhale-tui /out/ \
    && cp target/$(cat /rust-target)/release/deepseek /out/ \
    && cp target/$(cat /rust-target)/release/deepseek-tui /out/

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    libdbus-1-3 \
    nodejs \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 codewhale \
    && useradd --create-home --shell /bin/bash --uid 1000 --gid 1000 codewhale \
    && install -d -m 0700 -o codewhale -g codewhale /home/codewhale/.codewhale \
    && install -d -m 0755 -o codewhale -g codewhale /workspace \
    && install -d -m 0700 -o codewhale -g codewhale /var/lib/codewhale-telegram-bridge

COPY --from=builder --chown=codewhale:codewhale /out/codewhale /usr/local/bin/codewhale
COPY --from=builder --chown=codewhale:codewhale /out/codewhale-tui /usr/local/bin/codewhale-tui
COPY --from=builder --chown=codewhale:codewhale /out/deepseek /usr/local/bin/deepseek
COPY --from=builder --chown=codewhale:codewhale /out/deepseek-tui /usr/local/bin/deepseek-tui

WORKDIR /app
COPY --chown=codewhale:codewhale integrations/telegram-bridge /app/integrations/telegram-bridge
COPY --chown=codewhale:codewhale deploy/railway/start-telegram-agent.sh /usr/local/bin/codewhale-railway-telegram
COPY --chown=codewhale:codewhale . /opt/codewhale-source

RUN chmod +x /usr/local/bin/codewhale-railway-telegram

USER codewhale
ENV HOME=/home/codewhale \
    CODEWHALE_WORKSPACE=/workspace/codewhale \
    CODEWHALE_RUNTIME_PORT=7878 \
    CODEWHALE_RUNTIME_URL=http://127.0.0.1:7878 \
    TELEGRAM_THREAD_MAP_PATH=/var/lib/codewhale-telegram-bridge/thread-map.json

CMD ["codewhale-railway-telegram"]
