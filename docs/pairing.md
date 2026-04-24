# Owner website login
ssh anishalle.com 'cd ~/codex-remote && docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T t3 bun apps/server/src/bin.ts auth pairing create --base-dir /data/t3 --base-url https://codex.anishalle.com --role owner --label "Owner browser" --ttl 2h'

# Generic client key
ssh anishalle.com 'cd ~/codex-remote && docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T t3 bun apps/server/src/bin.ts auth pairing create --base-dir /data/t3 --base-url https://codex.anishalle.com --role client --label "Client session" --ttl 2h'

# t3r key
ssh anishalle.com 'cd ~/codex-remote && docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T t3 bun apps/server/src/bin.ts auth pairing create --base-dir /data/t3 --base-url https://codex.anishalle.com --role client --label "t3r MacBook" --ttl 2h'
