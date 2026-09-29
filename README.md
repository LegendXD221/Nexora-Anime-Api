# NEXORA Anime API

A unified anime API built by combining multiple provider engines into one deployment-ready service.

## The simple rule

**I don't care how you use this project. Do whatever you want with it.**

There is only one request:

> **Change the project name before using or redistributing it.**

Don't present **NEXORA Anime API** as the original name of your own project. Rename it to whatever you want and make it your own.

## Features

### Unified streaming API
- One gateway for multiple anime engines
- Unified `/api/watch` endpoint
- Automatic provider fallback
- Provider failure isolation
- Stream validation before a source is accepted
- HLS validation
- MP4/video source handling
- Sub / Dub / Raw support where the provider supports it

### Provider engines
- Kuhi native provider engine
- Anivexa provider/aggregator engine
- anime-sdk provider framework
- Multiple providers available across the combined engines
- AniList-based identity and mapping support
- Episode aggregation
- Provider-specific resolution

### Reliability
- Automatic retries
- Provider fallback when a source fails
- Request timeouts
- In-memory caching
- Rate limiting
- Health monitoring
- `/health` endpoint
- `/ready` endpoint
- Graceful shutdown

### Deployment
- Render-ready
- Docker-ready
- Node.js + Python runtime support
- Render `$PORT` support
- `render.yaml` Blueprint configuration
- `.dockerignore` included
- Environment-variable configuration
- No database required for the basic setup

### API structure

```text
/api/watch
/api/stream
/health
/ready
/kuhi/*
/anivexa/*
/sdk/*
```

The main workflow is:

```text
                    /api/watch
                         |
                         v
              +---------------------+
              | Unified Source      |
              | Manager             |
              +----------+----------+
                         |
             +-----------+-----------+
             |           |           |
             v           v           v
           Kuhi       Anivexa     anime-sdk
             |           |           |
             +-----------+-----------+
                         |
                         v
                 Validate source
                         |
                  +------+------+
                  |             |
                Valid         Failed
                  |             |
                  v             v
               Return       Try next
               source       provider
```

## Quick deployment on Render

1. Rename the project first.
2. Upload the project to GitHub.
3. Open Render.
4. Create a **Blueprint** from the repository.
5. Render will use `render.yaml`.
6. Deploy.
7. Check `/health` and `/ready` after startup.

For detailed deployment instructions, see `DEPLOY_RENDER.md`.

## Configuration

Copy `.env.example` to `.env` for local development and adjust the values you need.

The service is designed to work without a database in its basic configuration.

## Local development

The project contains both Node.js and Python components. Docker is the recommended way to run the complete stack because it keeps both runtimes together.

## Important

This project is an aggregation/stream-resolution framework. Availability depends on the upstream providers and their current status. A fallback system can move to another provider when one fails, but it cannot create a working source when every upstream provider is unavailable.

You are responsible for complying with the laws, terms of service, and content rights applicable to the providers and content you access.

## Credits

This project combines code and/or functionality from the included upstream projects.

If you redistribute a modified version, keep the applicable third-party notices required by their licenses or permissions.
