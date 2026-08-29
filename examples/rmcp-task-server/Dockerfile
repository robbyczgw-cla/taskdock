FROM rust:1.88-bookworm AS build
WORKDIR /src
COPY Cargo.toml .
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/rmcp-task-server /usr/local/bin/rmcp-task-server
EXPOSE 8000
CMD ["rmcp-task-server"]
