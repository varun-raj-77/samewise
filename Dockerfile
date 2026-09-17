FROM node:24-trixie

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.19.0

COPY . .

RUN pnpm install --frozen-lockfile \
    && python3 -m venv /opt/samewise-venv \
    && /opt/samewise-venv/bin/python -m pip install --no-cache-dir ./services/matcher

ENV SAMEWISE_PYTHON=/opt/samewise-venv/bin/python

WORKDIR /app/apps/api

CMD ["pnpm", "start"]
