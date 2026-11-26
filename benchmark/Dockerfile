# Reproducible Pi^n *base* for Harbor task images. Does not copy the build
# context (and thus cannot accidentally ship .env, model keys or local edits).
# Build: docker build -f benchmark/Dockerfile --build-arg PI_N_COMMIT=<sha> -t pi-n-harbor:<sha> benchmark
# Task images must retain their own dependencies/files and use the SAME image
# configuration when comparing agent harnesses. User namespaces must also be
# allowed by the outer Harbor environment; an image alone cannot enable them.
FROM node:22.19.0-bookworm

ARG PI_N_REPOSITORY=https://github.com/zhexusun10/pi-n.git
ARG PI_N_COMMIT
ARG RUST_VERSION=1.98.1

RUN apt-get update -qq && apt-get install -y --no-install-recommends \
        bubblewrap git curl ca-certificates build-essential pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}"
ENV PATH="/root/.cargo/bin:${PATH}"

RUN test -n "${PI_N_COMMIT}" \
    && git clone "${PI_N_REPOSITORY}" /installed-agent/pi-n \
    && git -C /installed-agent/pi-n checkout --detach "${PI_N_COMMIT}" \
    && git -C /installed-agent/pi-n submodule update --init --recursive \
    && cd /installed-agent/pi-n \
    && npm run pi:setup \
    && cargo build --release --manifest-path backend/Cargo.toml --bin pi-n \
    && node scripts/pi-baseline.mjs verify \
    && test -x backend/target/release/pi-n \
    && test -x /usr/bin/bwrap \
    && test "$(backend/target/release/pi-n --build-identity)" = "${PI_N_COMMIT}" \
    && test -z "$(git status --porcelain --untracked-files=normal)"

# These checksums bind both supported image architectures to fixed upstream tools.
RUN set -eu; \
    case "$(uname -m)" in \
      aarch64) arch=aarch64; rg_platform=aarch64-unknown-linux-gnu; \
        fd_sha=4e8e596646d047d904f2c5ca74b39dccc69978b6e1fb101094e534b0b59c1bb0; \
        rg_sha=c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f ;; \
      x86_64) arch=x86_64; rg_platform=x86_64-unknown-linux-musl; \
        fd_sha=d9bfa25ec28624545c222992e1b00673b7c9ca5eb15393c40369f10b28f9c932; \
        rg_sha=4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e ;; \
      *) echo 'Unsupported Harbor Pi tool architecture' >&2; exit 1 ;; \
    esac; \
    fd_asset="fd-v10.2.0-${arch}-unknown-linux-musl"; \
    rg_asset="ripgrep-14.1.1-${rg_platform}"; \
    curl -fsSL "https://github.com/sharkdp/fd/releases/download/v10.2.0/${fd_asset}.tar.gz" -o /tmp/pi-n-fd.tar.gz; \
    echo "$fd_sha  /tmp/pi-n-fd.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/pi-n-fd.tar.gz -C /usr/local/bin --strip-components=1 "$fd_asset/fd"; \
    curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/${rg_asset}.tar.gz" -o /tmp/pi-n-rg.tar.gz; \
    echo "$rg_sha  /tmp/pi-n-rg.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/pi-n-rg.tar.gz -C /usr/local/bin --strip-components=1 "$rg_asset/rg"; \
    rm /tmp/pi-n-fd.tar.gz /tmp/pi-n-rg.tar.gz; \
    fd --version | grep -F 'fd 10.2.0'; \
    rg --version | grep -F 'ripgrep 14.1.1'
